/**
 * dsh-zotero — M2 model-facing tools: PDF 全文阅读 / 文献总结 / 翻译.
 *
 * zotero_read_pdf   附件 → MinerU（cloud/local）→ 缓存 → 结构化返回（含章节与预览）
 * zotero_summarize  全文窗口 → DSH LLM（复用模型适配器+默认模型）→ 概述/定向总结
 * zotero_translate  （节选文本 | 全文窗口）→ DSH LLM 翻译
 *
 * 解析失败时自动降级 pdftotext（环境已装），并在结果 source 标注。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type LlmService from '@deepseek-ai/dsh-llm'
import type { Config } from './config.ts'
import { MineruClient, MineruError } from './mineru/client.ts'
import { attachmentCacheDir, readCachedMd, writeCache } from './mineru/cache.ts'
import { fetchAttachmentPdf } from './zotero/pdf.ts'
import type { ZoteroClient } from './zotero/client.ts'
import { resolveModel, streamText } from './ml.ts'
import type { ResolvedModel } from './ml.ts'
import { currentConfig } from './runtime.ts'
import { retrieveEvidence } from './retrieval/service.ts'

const renderJson = (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: JSON.stringify(value, null, 2) },
]

const DEFAULT_SUMMARY_PROMPT = `你是文献精读助手。基于用户提供的论文全文（MinerU/pdftotext 提取，可能含版式噪声、错字、乱序），回答用户的阅读请求。

规则（源自 llm-for-zotero 的阅读纪律，务必遵守）：
- 回答要“有据可查”：结论落在原文之上，不要编造作者没有的观点、数据、数字。
- 区分“原文直接陈述”和“你的归纳/推断”：推断部分明确说明是你的解读。
- 引用原文关键句时保留原文语言，如需翻译放到引文之外。
- 输出用中文（除非用户指明其它语言）；先给结论，再给支撑。
- 若全文片段不足以回答（如只看到摘要），明确说明覆盖范围与局限。

结构化输出约定（概述模式）：用以下小节组织，忠于原文：
1. **一句话贡献**：这篇论文用一句话解决了什么问题。
2. **研究背景与动机**：为什么做（≤3 句）。
3. **方法**：方法途径与关键设计（含求解/验证手段）。
4. **关键结果**：带数字的结果（数值必须来自原文，注明条件）。
5. **局限与争议**：作者自述局限；若无，标注“未见作者明确自述”。
6. **对你的启发**：若与你关注的领域有关，点出可迁移之处。`

const DEFAULT_TRANSLATE_PROMPT = `你是学术文献翻译助手。把用户提供的文献文本翻译为目标语言：
- 忠实于原文语义与术语；公式/代码/符号保持原样；数字不得改动。
- 保留 Markdown 结构（标题层级、列表、引用块标记）。
- 只输出译文本身，不要附加解释或“以下是翻译”之类的开头。`

/** Error projection helper: domain outcomes in canonical values. */
function domainError(err: unknown): { error: string; hint: string } {
  if (err instanceof MineruError) {
    return { error: err.message, hint: err.hint ?? '请检查 MinerU 配置或改用本机 pdftotext 降级' }
  }
  const e = err as { message?: string; hint?: string }
  return { error: String(e?.message ?? err), hint: e?.hint ?? '' }
}

interface ParsedPaper {
  attachmentKey: string
  title: string
  md: string
  source: string
  cacheDir: string
  textChars: number
}

/** Resolve item → PDF attachment → (cache | parse) → markdown. */
export async function ensureParsed(
  client: ZoteroClient,
  _cfg: Config,
  mode: 'auto' | 'mineru' | 'text',
  itemKey: string,
  attachmentKey?: string,
  exec?: { signal?: AbortSignal },
): Promise<ParsedPaper> {
  const cfg = currentConfig()
  const got = itemKey ? await client.scoped(exec?.signal).getItem(itemKey) : null
  if (itemKey && got && (!got.found || !got.item)) {
    throw new Error(`条目不存在: ${itemKey}（${got.error}）`)
  }
  // 附件直解析模式（itemKey 可空）：attachmentKey 必填，标题回退到附件名。
  const item = (got?.item ?? null) as { title?: string; attachments?: Array<{ key: string; isPdf: boolean; title?: string }> } | null
  const atts = item?.attachments ?? []
  const attachment = item
    ? (attachmentKey ? atts.find((a) => a.key === attachmentKey) : undefined) ?? atts.filter((a) => a.isPdf)[0]
    : null
  if (item && !attachment) {
    throw new Error(`条目 ${itemKey} 没有 PDF 附件（共 ${atts.length} 个附件）`)
  }
  if (!item && !attachmentKey) {
    throw new Error('需要 attachmentKey（附件直解析模式）')
  }
  const attKey = attachment?.key ?? String(attachmentKey ?? '')
  const attTitle = attachment?.title ?? String(attKey)

  const cached = readCachedMd(cfg, attKey)
  if (cached && mode !== 'text') {
    return {
      attachmentKey: attKey,
      title: item?.title || attTitle,
      md: cached,
      source: 'cache',
      cacheDir: attachmentCacheDir(cfg, attKey),
      textChars: cached.length,
    }
  }

  const pdf = await fetchAttachmentPdf(client, attKey, cfg, exec?.signal)

  if (mode === 'text') {
    const md = await pdfToText(pdf.bytes)
    const { dir } = writeCache(cfg, attKey, md, [], 'pdftotext', 'pdftotext', item?.title || attTitle)
    return { attachmentKey: attKey, title: item?.title || attTitle, md, source: 'pdftotext', cacheDir: dir, textChars: md.length }
  }

  try {
    const mineru = new MineruClient(cfg)
    const parsed = await mineru.parse({
      pdfBytes: pdf.bytes,
      fileName: pdf.fileName,
      signal: exec?.signal,
    })
    const { dir } = writeCache(cfg, attKey, parsed.md, parsed.imageFiles, cfg.mineruMode === 'cloud' ? 'cloud' : cfg.mineruLocalBackend, parsed.source, item?.title || attTitle)
    return {
      attachmentKey: attKey,
      title: item?.title || attTitle,
      md: parsed.md,
      source: parsed.source,
      cacheDir: dir,
      textChars: parsed.mdChars,
    }
  } catch (err) {
    // MinerU 失败 → pdftotext 降级（显式标注）。
    const md = await pdfToText(pdf.bytes)
    const { dir } = writeCache(cfg, attKey, md, [], 'pdftotext', `pdftotext(降级:${domainError(err).error})`, item?.title || attTitle)
    return {
      attachmentKey: attKey,
      title: item?.title || attTitle,
      md,
      source: `pdftotext(降级:${domainError(err).error})`,
      cacheDir: dir,
      textChars: md.length,
    }
  }
}

/** pdftotext -layout <bytes> - (poppler; present via MiKTeX/TeXLive). */
function pdfToText(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!bytes.length) return reject(new Error('PDF 字节为空'))
    const tmp = mkdtempSync(join(tmpdir(), 'dsh-zotero-'))
    const pdfPath = join(tmp, 'paper.pdf')
    writeFileSync(pdfPath, bytes)
    const child = spawn('pdftotext', ['-layout', pdfPath, '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      rmSync(tmp, { recursive: true, force: true })
      reject(new Error(`pdftotext 不可用: ${e.message}`))
    })
    child.on('close', (code) => {
      rmSync(tmp, { recursive: true, force: true })
      if (code !== 0) return reject(new Error(`pdftotext 退出码 ${code}: ${err.slice(0, 160)}`))
      resolve(out.replace(/\r\n/g, '\n').trim())
    })
  })
}

interface Section { title: string; start: number; end: number }

function splitSections(md: string): Section[] {
  const lines = md.split('\n')
  const sections: Section[] = []
  let current: Section | null = null
  let plainStart = 0
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,3})\s+(.+)$/.exec(lines[i])
    if (m) {
      if (current) current.end = i
      current = { title: m[2].slice(0, 80), start: i, end: i }
      sections.push(current)
    } else if (!current) {
      plainStart = i
      void plainStart
    }
  }
  if (current) current.end = lines.length
  if (!sections.length) sections.push({ title: '(全文)', start: 0, end: lines.length })
  return sections
}

function textOf(md: string, s: Section): string {
  return md.split('\n').slice(s.start, s.end).join('\n')
}

/** 行号 → 字符偏移（含换行符）。 */
function charOffsetOf(md: string, lineIndex: number): number {
  if (lineIndex <= 0) return 0
  const lines = md.split('\n')
  let off = 0
  const n = Math.min(lineIndex, lines.length - 1)
  for (let i = 0; i < n; i += 1) off += lines[i].length + 1
  return off
}

/** Head window plus (when query given) top matching sections, honoring a char budget. */
function buildWindow(md: string, query: string | undefined, charBudget: number): { text: string; sections: string[] } {
  const budget = Math.max(charBudget, 4000)
  if (!query || !query.trim()) {
    return { text: md.slice(0, budget), sections: splitSections(md).slice(0, 12).map((s) => s.title) }
  }
  const terms = query.split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t.length > 1)
  const sections = splitSections(md)
  const ranked = sections
    .map((s, idx) => {
      const text = textOf(md, s).toLowerCase()
      const score = terms.reduce((acc, t) => acc + (text.includes(t) ? text.split(t).length - 1 : 0), 0)
      return { s, idx, score }
    })
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
  const picked = ranked
    .filter((r) => r.score >= 1)
    .slice(0, 5)
    .sort((a, b) => a.idx - b.idx)
  if (!picked.length) {
    return { text: md.slice(0, budget), sections: sections.slice(0, 12).map((s) => s.title) }
  }
  let text = ''
  for (const { s } of picked) {
    if (text.length >= budget) break
    text += `\n\n## ${s.title}\n${textOf(md, s)}`
  }
  return { text: text.slice(0, budget), sections: picked.map((p) => p.s.title) }
}

export function registerM2Tools(
  ctx: { tools: { register(tool: unknown): void } },
  client: ZoteroClient,
  cfg: Config,
  llm: LlmService,
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined,
): void {
  /* ── zotero_read_pdf ─────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_read_pdf',
      description:
        'Read a paper PDF from the Zotero library: downloads the attachment, parses it with MinerU (local/cloud per config, cached in the plugin cache dir), and returns the full-text markdown structure — total characters, section titles, and a preview window. Use this BEFORE paper QA; zotero_summarize reuses the cache.',
      parameters: {
        itemKey: { type: 'string', required: true, description: 'Zotero item key (paper).' },
        attachmentKey: { type: 'string', description: 'Specific PDF attachment key; default = first PDF attachment.' },
        mode: {
          type: 'string',
          enum: ['auto', 'mineru', 'text'],
          description: "auto = mineru with pdftotext fallback; mineru = MinerU only; text = pdftotext only (fast, low fidelity).",
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            itemKey: { type: 'string', required: true },
            title: { type: 'string', required: true },
            attachmentKey: { type: 'string', required: true },
            source: { type: 'string', required: true },
            textChars: { type: 'integer', required: true },
            sectionTitles: { type: 'array', items: { type: 'string' }, required: true },
            preview: { type: 'string', required: true },
            cacheDir: { type: 'string', required: true },
            images: { type: 'integer', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 300_000,
      execute: async (args, exec) => {
        const a = args as { itemKey: string; attachmentKey?: string; mode?: string }
        try {
          const parsed = await ensureParsed(client, cfg, (a.mode as 'auto' | 'mineru' | 'text') ?? 'auto', a.itemKey, a.attachmentKey, exec)
          const preview = parsed.md.slice(0, 3000)
          return {
            status: 'ok',
            itemKey: a.itemKey,
            title: parsed.title,
            attachmentKey: parsed.attachmentKey,
            source: parsed.source,
            textChars: parsed.textChars,
            sectionTitles: splitSections(parsed.md).slice(0, 20).map((s) => s.title),
            preview,
            cacheDir: parsed.cacheDir,
            images: readImagesCount(parsed),
            error: '',
            hint: '',
          }
        } catch (err: any) {
          const d = { ...domainError(err), status: 'error' as const, itemKey: a.itemKey, title: '', attachmentKey: a.attachmentKey ?? '', source: '', textChars: 0, sectionTitles: [] as string[], preview: '', cacheDir: '', images: 0 }
          return d
        }
      },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: `读论文: ${String((args as { itemKey?: unknown }).itemKey ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_read_fulltext：按区间读取全文 MD（章节定位/关键词定位） ── */
  ctx.tools.register(
    defineTool({
      name: 'zotero_read_fulltext',
      description:
        'Read an arbitrary window of a paper\'s full-text markdown (MinerU/pdftotext disk cache) — ACTUAL text, unlike zotero_read_pdf (preview only). Call once with just itemKey to get `sections` (chapter titles + char offsets), then read any paragraph via offset/limit (8k chars per call, up to 20k). Optional `query` returns match windows. Use for deep reading by sections.',
      parameters: {
        itemKey: { type: 'string', required: true, description: 'Zotero item key (paper).' },
        attachmentKey: { type: 'string', description: 'Specific PDF attachment key; default = first PDF attachment.' },
        offset: { type: 'number', description: 'Char offset into the markdown (default 0).' },
        limit: { type: 'number', description: 'Chars to return (default 8000, max 20000).' },
        query: { type: 'string', description: 'Optional keyword/heading; returns up to 3 match windows (±4000 chars each).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            itemKey: { type: 'string', required: true },
            title: { type: 'string', required: true },
            source: { type: 'string', required: true },
            textChars: { type: 'integer', required: true },
            sections: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  title: { type: 'string', required: true },
                  offset: { type: 'integer', required: true },
                  charLen: { type: 'integer', required: true },
                },
              },
            },
            offset: { type: 'integer', required: true },
            text: { type: 'string', required: true },
            cacheDir: { type: 'string', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 300_000,
      execute: async (args, exec) => {
        const a = args as { itemKey: string; attachmentKey?: string; offset?: number; limit?: number; query?: string }
        try {
          const parsed = await ensureParsed(client, cfg, 'auto', a.itemKey, a.attachmentKey, exec)
          const sections = splitSections(parsed.md).slice(0, 30).map((s) => {
            const off = charOffsetOf(parsed.md, s.start)
            const endOff = charOffsetOf(parsed.md, s.end)
            return { title: s.title, offset: off, charLen: Math.max(0, endOff - off) }
          })
          const limit = Math.min(Math.max(Number(a.limit ?? 8000), 500), 20000)
          let text = ''
          let offset = Math.max(0, Math.floor(Number(a.offset ?? 0)))
          if (a.query && a.query.trim()) {
            const q = a.query.trim().toLowerCase()
            const hay = parsed.md.toLowerCase()
            const hits: number[] = []
            let at = hay.indexOf(q)
            while (at >= 0 && hits.length < 3) {
              hits.push(at)
              at = hay.indexOf(q, at + q.length)
            }
            if (hits.length) {
              offset = Math.max(0, hits[0] - 4000)
              let out = ''
              for (const h of hits) {
                out += '\n\n···\n' + parsed.md.slice(Math.max(0, h - 3000), Math.min(parsed.md.length, h + q.length + 3000))
              }
              text = out.slice(0, limit)
            }
          }
          if (!text) {
            text = parsed.md.slice(offset, offset + limit)
          }
          return {
            status: 'ok',
            itemKey: a.itemKey,
            title: parsed.title,
            source: parsed.source,
            textChars: parsed.textChars,
            sections,
            offset,
            text,
            cacheDir: parsed.cacheDir,
            error: '',
            hint: '',
          }
        } catch (err: any) {
          const d = { ...domainError(err), status: 'error' as const, itemKey: a.itemKey, title: '', source: '', textChars: 0, sections: [] as Array<{ title: string; offset: number; charLen: number }>, offset: 0, text: '', cacheDir: '', error: String(err?.message ?? err), hint: '' }
          return d
        }
      },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: `读全文: ${String((args as { itemKey?: unknown }).itemKey ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_retrieve：论文内证据检索（BM25 + 意图/章节加权，移植 llm-for-zotero） ── */
  ctx.tools.register(
    defineTool({
      name: 'zotero_retrieve',
      description:
        'Retrieve evidence snippets from a parsed paper by relevance (BM25 + query-intent section boosting, ported from llm-for-zotero): splits the full-text cache into ~2000-char chunks, ranks them, and returns top-k hits with section label, char offset and score. Use this instead of zotero_read_fulltext when you need the most relevant passages for a specific question (single paper), not a sequential section read. Answers should cite section labels when quoting.',
      parameters: {
        itemKey: { type: 'string', required: true, description: 'Zotero item key (paper).' },
        query: { type: 'string', required: true, description: 'The question or keywords to find evidence for.' },
        attachmentKey: { type: 'string', description: 'Specific PDF attachment key; default = first PDF attachment.' },
        topK: { type: 'number', description: 'Max hits (default 5, max 12).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            itemKey: { type: 'string', required: true },
            title: { type: 'string', required: true },
            query: { type: 'string', required: true },
            intent: { type: 'string', required: true },
            variants: { type: 'array', required: true, items: { type: 'string' } },
            hits: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  chunkIndex: { type: 'integer', required: true },
                  sectionLabel: { type: 'string', required: true },
                  score: { type: 'number', required: true },
                  offset: { type: 'integer', required: true },
                  charLen: { type: 'integer', required: true },
                  text: { type: 'string', required: true },
                },
              },
            },
            totalChunks: { type: 'integer', required: true },
            textChars: { type: 'integer', required: true },
            latencyMs: { type: 'integer', required: true },
            cached: { type: 'boolean', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 300_000,
      execute: async (args, exec) => {
        const a = args as { itemKey: string; query: string; attachmentKey?: string; topK?: number }
        const fail = (error: string) => ({
          status: 'error' as const, itemKey: a.itemKey, title: '', query: a.query ?? '',
          intent: '', variants: [] as string[], hits: [], totalChunks: 0, textChars: 0, latencyMs: 0, cached: false,
          error, hint: '可先 zotero_read_pdf 确认解析可用，或用 zotero_read_fulltext 顺序精读',
        })
        try {
          if (!a.query?.trim()) return fail('需要 query')
          const parsed = await ensureParsed(client, cfg, 'auto', a.itemKey, a.attachmentKey, exec)
          const res = await retrieveEvidence(parsed, a.query, {
            topK: a.topK,
            runVariantGen: agentDefaultModel
              ? async (q) => {
                  const model = resolveModel(agentDefaultModel)
                  const system = 'You are a retrieval query planner for academic papers. Expand the user question into up to 6 alternative query phrasings for evidence search: synonyms, abbreviations vs full forms (e.g. "PD" ↔ "peridynamics"), notation and English variants of technical terms. Keep each variant a single search query under 120 chars. Output one variant per line, no numbering, no preamble, no quotes.'
                  const out = await streamText(llm, model, {
                    system,
                    user: `Paper: ${String(q.paperTitle ?? '(unknown)')}\nQuestion: ${q.query}`,
                    temperature: 0.2,
                    maxTokens: 400,
                    signal: exec?.signal,
                  })
                  return out
                    .split('\n')
                    .map((l) => l.trim())
                    .filter((l) => l && !/^\d+[.)]/.test(l) && !/^(v\d|variant)/i.test(l))
                    .map((l) => l.replace(/^[-•*]\s*/, '').replace(/^['"]|['"]$/g, ''))
                    .filter((l) => l.length >= 2)
                }
              : undefined,
            signal: exec?.signal,
          })
          return {
            status: 'ok', itemKey: a.itemKey, title: parsed.title, query: res.query,
            intent: res.intent, variants: res.variants, hits: res.hits, totalChunks: res.totalChunks,
            textChars: res.textChars, latencyMs: res.latencyMs, cached: res.cached,
            error: '', hint: '',
          }
        } catch (err: any) {
          return fail(String(err?.message ?? err))
        }
      },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({
        card: 'generic',
        title: `检索证据: ${String((args as { itemKey?: unknown }).itemKey ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'zotero_summarize',
      description:
        'Summarize a paper from the Zotero library using the configured DSH model. mode=overview gives a structured summary (contribution/method/results/limits); mode=deep expands per-chapter; mode=targeted answers one specific question/interest (pass query). depth=brief|standard|deep controls length. Grounded in the parsed full text (MinerU cache preferred).',
      parameters: {
        itemKey: { type: 'string', required: true, description: 'Zotero item key (paper).' },
        attachmentKey: { type: 'string' },
        mode: { type: 'string', enum: ['overview', 'targeted', 'deep'], description: 'overview = whole paper; targeted = answer query; deep = per-chapter.' },
        query: { type: 'string', description: 'For targeted mode: the specific question/interest.' },
        depth: { type: 'string', enum: ['brief', 'standard', 'deep'], description: 'Length: brief (≤250 字速览) / standard / deep.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            title: { type: 'string', required: true },
            mode: { type: 'string', required: true },
            depth: { type: 'string', required: true },
            summary: { type: 'string', required: true },
            source: { type: 'string', required: true },
            textChars: { type: 'integer', required: true },
            sections: { type: 'array', items: { type: 'string' }, required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 600_000,
      execute: async (args, exec) => {
        return runSummary(client, cfg, llm, agentDefaultModel, args as { itemKey: string; attachmentKey?: string; mode?: string; query?: string; depth?: string }, exec)
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `总结: ${String((args as { itemKey?: unknown }).itemKey ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_translate ─────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_translate',
      description:
        'Translate literature text: pass `text` directly, or `itemKey` to translate a window of the parsed paper full text. Uses the configured DSH model. Preserves Markdown structure, keeps formulas/numbers untouched.',
      parameters: {
        text: { type: 'string', description: 'Explicit text to translate (wins over itemKey).' },
        itemKey: { type: 'string', description: 'Zotero item key to translate from its parsed full text.' },
        attachmentKey: { type: 'string' },
        targetLang: { type: 'string', required: true, description: 'Target language, e.g. zh-CN, en, ja.' },
        sourceLang: { type: 'string', description: 'Source language hint (auto-detect when omitted).' },
        query: { type: 'string', description: 'Optional focus: translate only the sections about this topic.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            translation: { type: 'string', required: true },
            sourceLang: { type: 'string', required: true },
            targetLang: { type: 'string', required: true },
            chars: { type: 'integer', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 600_000,
      execute: async (args, exec) => {
        const a = args as { text?: string; itemKey?: string; attachmentKey?: string; targetLang: string; sourceLang?: string; query?: string }
        try {
          const c = currentConfig()
          let text: string
          let sourceLabel = '用户提供'
          if (typeof a.text === 'string' && a.text.trim()) {
            text = a.text.trim()
          } else if (a.itemKey) {
            const parsed = await ensureParsed(client, c, 'auto', a.itemKey, a.attachmentKey, exec)
            const budgetChars = Math.max(c.fullTextTokenBudget * 3, 8000)
            text = buildWindow(parsed.md, a.query || undefined, budgetChars).text
            sourceLabel = `《${parsed.title}》(节选, ${parsed.textChars} 字符)`
          } else {
            throw new Error('要么传 text，要么传 itemKey')
          }
          const model = resolveModel(agentDefaultModel)
          const system = c.translatePrompt.trim() || DEFAULT_TRANSLATE_PROMPT
          const user = `源语言: ${a.sourceLang ?? '自动识别'}\n目标语言: ${a.targetLang}\n来源: ${sourceLabel}\n\n待翻译文本：\n---\n${text}\n---`
          const translation = await streamText(llm, model, { system, user, signal: exec.signal, maxTokens: 8192 })
          return {
            status: 'ok',
            translation,
            sourceLang: a.sourceLang ?? 'auto',
            targetLang: a.targetLang,
            chars: text.length,
            error: '',
            hint: '',
          }
        } catch (err: any) {
          const d = { ...domainError(err), status: 'error' as const, translation: '', sourceLang: a.sourceLang ?? 'auto', targetLang: a.targetLang, chars: 0 }
          return d
        }
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `翻译 → ${String((args as { targetLang?: unknown }).targetLang ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_batch_summarize：多篇批量总结 + 横向对比 ─────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_batch_summarize',
      description:
        'Batch-summarize 2-10 papers from the library (structured overview each), then produce a 300-500 char cross-paper comparison (methods lineage, consensus, divergence, gaps). Grounded in MinerU full-text cache.',
      parameters: {
        itemKeys: { type: 'array', items: { type: 'string' }, description: 'Zotero item keys (2-10).' },
        depth: { type: 'string', enum: ['brief', 'standard'], description: 'Per-paper length (default standard).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            items: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  key: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  year: { type: 'integer' },
                  summary: { type: 'string', required: true },
                },
              },
            },
            comparison: { type: 'string', required: true },
            errors: { type: 'array', items: { type: 'string' }, required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 900_000,
      execute: async (args, exec) => {
        const a = args as { itemKeys?: string[]; depth?: string }
        const keys = (a.itemKeys ?? []).filter(Boolean).slice(0, 10)
        if (keys.length < 2) {
          return { status: 'error', items: [], comparison: '', errors: ['至少提供 2 篇论文'], error: '至少提供 2 篇论文', hint: '' }
        }
        const items: Array<{ key: string; title: string; year?: number; summary: string }> = []
        const errors: string[] = []
        let cursor = 0
        const worker = async (): Promise<void> => {
          while (cursor < keys.length) {
            const k = keys[cursor++]
            try {
              const r = await runSummary(client, cfg, llm, agentDefaultModel, { itemKey: k, mode: 'overview', depth: a.depth ?? 'standard' }, exec)
              if (r.status === 'ok') {
                const got = await client.scoped().getItem(k)
                const item = (got as any)?.item ?? {}
                items.push({ key: k, title: r.title, year: item?.year, summary: r.summary })
              } else {
                errors.push(`${k}: ${r.error || '总结失败'}`)
              }
            } catch (e: any) {
              if (e?.name === 'AbortError') throw e
              errors.push(`${k}: ${String(e?.message ?? e)}`)
            }
          }
        }
        await Promise.all([worker(), worker()])
        if (!items.length) return { status: 'error', items: [], comparison: '', errors, error: errors.join('; '), hint: '' }
        let comparison = ''
        try {
          const model = resolveModel(agentDefaultModel)
          const digest = items.map((it, i) => `[${i + 1}] 《${it.title}》${it.year ? ` (${it.year})` : ''}\n${it.summary.slice(0, 800)}`).join('\n\n')
          comparison = await streamText(llm, model, {
            system: '你是科研文献助理。对下列 N 篇论文做 300-500 字横向对比：共同主题与聚焦点、方法谱系的分叉、核心共识、主要分歧或互补、对你想到的空白。用 [编号] 标注引用。只输出对比文本。',
            user: `论文要点：\n${digest}`,
            signal: exec?.signal,
            maxTokens: 1200,
          })
        } catch { /* comparison 尽力而为 */ }
        return { status: 'ok', items, comparison, errors, error: '', hint: '' }
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `批量总结 ${String((args as { itemKeys?: unknown[] }).itemKeys?.length ?? '')} 篇`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_review：跨篇文献综述（要点提炼 → 综述合成） ─────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_review',
      description:
        'Write a cross-paper literature review from your library: per-paper point extraction (≤500 chars each) then a structured review (research lineage / method families / consensus / disagreements / gaps & outlook, cited with [n]). Pass itemKeys (2-12), or query+n to auto-collect from the library.',
      parameters: {
        itemKeys: { type: 'array', items: { type: 'string' }, description: 'Zotero item keys (2-12); mutex with query.' },
        query: { type: 'string', description: 'Keyword query to collect papers (title/creator/year).' },
        n: { type: 'number', description: 'Max papers when using query (default 6, max 12).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            review: { type: 'string', required: true },
            papers: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  key: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  year: { type: 'integer' },
                  points: { type: 'string', required: true },
                },
              },
            },
            errors: { type: 'array', items: { type: 'string' }, required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 1_200_000,
      execute: async (args, exec) => {
        const a = args as { itemKeys?: string[]; query?: string; n?: number }
        let keys: string[] = (a.itemKeys ?? []).filter(Boolean).slice(0, 12)
        if (keys.length < 2 && a.query?.trim()) {
          try {
            const r = await client.scoped().search({ query: a.query.trim(), limit: Math.min(Math.max(a.n ?? 6, 3), 12), qmode: 'titleCreatorYear' })
            keys = r.items.map((i) => i.key).filter(Boolean)
          } catch (e: any) {
            return { status: 'error', review: '', papers: [], errors: [`检索失败: ${String(e?.message ?? e)}`], error: '检索失败', hint: '' }
          }
        }
        if (keys.length < 2) {
          return { status: 'error', review: '', papers: [], errors: ['至少提供 2 篇论文（或可用 query 检索）'], error: '至少提供 2 篇论文', hint: '' }
        }
        const cfgNow = currentConfig()
        const papers: Array<{ key: string; title: string; year?: number; points: string }> = []
        const errors: string[] = []
        let cursor = 0
        const worker = async (): Promise<void> => {
          while (cursor < keys.length) {
            const k = keys[cursor++]
            try {
              const parsed = await ensureParsed(client, cfgNow, 'auto', k, undefined, exec)
              const window = buildWindow(parsed.md, undefined, 6000)
              const model = resolveModel(agentDefaultModel)
              const points = await streamText(llm, model, {
                system: '你是文献要点提炼器。基于论文片段输出 ≤500 字中文要点：核心问题、方法途径、关键结果（带数字）、局限。只输出要点。',
                user: `论文：《${parsed.title}》\n片段：\n${window.text}`,
                signal: exec?.signal,
                maxTokens: 900,
              })
              const got = await client.scoped().getItem(k)
              const item = (got as any)?.item ?? {}
              papers.push({ key: k, title: parsed.title, year: item?.year, points })
            } catch (e: any) {
              if (e?.name === 'AbortError') throw e
              errors.push(`${k}: ${String(e?.message ?? e)}`)
            }
          }
        }
        await Promise.all([worker(), worker()])
        if (!papers.length) return { status: 'error', review: '', papers: [], errors, error: errors.join('; '), hint: '' }
        const digest = papers.map((p, i) => `[${i + 1}] 《${p.title}》${p.year ? ` (${p.year})` : ''}\n${p.points}`).join('\n\n')
        const model = resolveModel(agentDefaultModel)
        const review = await streamText(llm, model, {
          system: '你是科研文献综述助手。基于下面每篇论文的要点，撰写一篇结构化的中文文献综述：\n1 引言与研究脉络 2 方法谱系（不同技术路径的分叉与传承） 3 重要发现与共识 4 分歧与争议 5 空白与展望\n引用用 [编号]（如 [1][3]）。忠于要点内容，不虚构。输出综述正文（不需要前言后语）。',
          user: `论文要点：\n${digest}`,
          signal: exec?.signal,
          maxTokens: 4096,
        })
        return { status: 'ok', review, papers, errors, error: '', hint: '' }
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: '跨篇综述',
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_related：相关文献（确定性关键词相似度，零 LLM） ─────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_related',
      description:
        'Find related papers in your library by deterministic keyword overlap against the target item (title+abstract), zero-LLM. Returns top matches with a score (0-1).',
      parameters: {
        itemKey: { type: 'string', required: true, description: 'Target Zotero item key.' },
        limit: { type: 'number', description: 'Max results (default 5).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', required: true },
            target: { type: 'string', required: true },
            related: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  key: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  year: { type: 'integer' },
                  score: { type: 'number', required: true },
                },
              },
            },
            totalScanned: { type: 'integer', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      timeoutMs: 120_000,
      execute: async (args) => {
        const a = args as { itemKey: string; limit?: number }
        const limit = Math.min(Math.max(a.limit ?? 5, 1), 10)
        const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'under', 'using', 'based', 'non', 'via', 'its', 'their', 'are', 'was', 'were', 'have', 'has', 'can', 'may', 'any', 'all', 'not', 'but', 'or', 'in', 'on', 'at', 'of', 'to', 'a', 'an', 'is', 'be', 'by', 'as', 'it', 'we', 'our', 'new', 'over', 'such', 'more', 'most', 'between', 'been', 'both', 'each', 'these', 'those'])
        const tokenize = (s: string): Set<string> =>
          new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))
        try {
          const target = await client.scoped().getItem(a.itemKey)
          if (!target.found || !target.item) return { status: 'error', target: '', related: [], totalScanned: 0, error: `条目不存在: ${a.itemKey}`, hint: '' }
          const title = String(target.item.title ?? '')
          const abstract = String(target.item.abstractNote ?? '')
          const tTokens = tokenize(`${title} ${abstract}`)
          const queryTerms = [...tTokens].slice(0, 4).join(' ')
          if (!queryTerms.trim()) return { status: 'error', target: title, related: [], totalScanned: 0, error: '条目缺少可检索文本', hint: '' }
          const search = await client.scoped().search({ query: queryTerms, limit: 30, qmode: 'titleCreatorYear' })
          const scored: Array<{ key: string; title: string; year?: number; score: number }> = []
          for (const cand of search.items) {
            if (cand.key === a.itemKey) continue
            const cItems = await client.scoped().getItem(cand.key).catch(() => null)
            const c = (cItems as any)?.item ?? null
            if (!c) continue
            const cTokens = tokenize(`${c.title ?? ''} ${c.abstractNote ?? ''}`)
            if (!cTokens.size) continue
            let inter = 0
            for (const w of cTokens) if (tTokens.has(w)) inter += 1
            const score = inter / Math.max(1, Math.min(cTokens.size, tTokens.size))
            scored.push({ key: cand.key, title: String(c.title ?? '(无标题)'), year: c.year, score: Math.round(score * 100) / 100 })
          }
          scored.sort((x, y) => y.score - x.score || String(y.title).localeCompare(String(x.title)))
          const related = scored.filter((r) => r.score > 0).slice(0, limit)
          return { status: 'ok', target: title, related, totalScanned: search.items.length - 1, error: '', hint: '基于题名+摘要关键词重叠（确定性，无 LLM）' }
        } catch (err: any) {
          return { status: 'error', target: '', related: [], totalScanned: 0, error: String(err?.message ?? err), hint: '' }
        }
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `相关文献: ${String((args as { itemKey?: unknown }).itemKey ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )
}

function readImagesCount(parsed: ParsedPaper): number {
  try {
    const imgDir = join(parsed.cacheDir, 'images')
    if (!existsSync(imgDir)) return 0
    return readdirSync(imgDir).length
  } catch {
    return 0
  }
}

/** Shared summary orchestration (tool + panel route). */
export async function runSummary(
  client: ZoteroClient,
  _cfg: Config,
  llm: LlmService,
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined,
  a: { itemKey: string; attachmentKey?: string; mode?: string; query?: string; depth?: string },
  exec?: { signal?: AbortSignal },
): Promise<{
  status: string
  title: string
  mode: string
  depth: string
  summary: string
  source: string
  textChars: number
  sections: string[]
  error: string
  hint: string
}> {
  const cfg = currentConfig()
  try {
    const parsed = await ensureParsed(client, cfg, 'auto', a.itemKey, a.attachmentKey, exec)
    const mode = a.mode === 'targeted' ? 'targeted' : a.mode === 'deep' ? 'deep' : 'overview'
    const query = a.query ?? ''
    const depth = a.depth === 'brief' || a.depth === 'deep' ? a.depth : 'standard'
    const budgetMultiplier = depth === 'deep' ? 8 : mode === 'targeted' ? 3 : 4
    const budgetChars = Math.max(cfg.fullTextTokenBudget * budgetMultiplier, 8000)
    const window = buildWindow(parsed.md, mode === 'targeted' && query ? query : undefined, budgetChars)
    const model = resolveModel(agentDefaultModel)
    const system = cfg.summaryPrompt.trim() || DEFAULT_SUMMARY_PROMPT
    const depthHint =
      depth === 'brief'
        ? '用户要速览：全文 ≤250 字，只给一句话贡献、方法与最关键结果。'
        : depth === 'deep'
          ? '用户要深度：按小节完整展开，数字与条件尽量保留；若窗口含多章，逐章给出要点。'
          : '标准长度即可。'
    const user = mode === 'targeted'
      ? `论文：《${parsed.title}》\n用户问题：${query}\n\n全文节选（相关章节）：\n${window.text}`
      : mode === 'deep'
        ? `论文：《${parsed.title}》\n请按概述模式+深度展开：核心问题、主要方法（含关键设计）、带数字的关键结果、作者自述局限、可迁移之处。\n\n全文节选：\n${window.text}`
        : `论文：《${parsed.title}》\n请按概述模式总结：核心问题、主要方法、关键结果（带数字）、局限与作者解读。\n${depthHint}\n\n全文节选：\n${window.text}`
    const summary = await streamText(llm, model, {
      system,
      user,
      signal: exec?.signal,
      maxTokens: depth === 'brief' ? 1200 : mode === 'deep' ? 8192 : 4096,
    })
    return {
      status: 'ok',
      title: parsed.title,
      mode,
      depth: a.depth ?? 'standard',
      summary,
      source: parsed.source,
      textChars: parsed.textChars,
      sections: window.sections,
      error: '',
      hint: '',
    }
  } catch (err: any) {
    const d = { ...domainError(err), status: 'error' as const, title: '', mode: (a.mode === 'targeted' ? 'targeted' : 'overview') as string, depth: a.depth ?? 'standard', summary: '', source: '', textChars: 0, sections: [] as string[] }
    return d
  }
}
