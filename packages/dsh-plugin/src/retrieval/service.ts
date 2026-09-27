/**
 * dsh-zotero — retrieval/service.ts：论文内证据检索服务。
 *
 * 组合 indexer（分块索引）+ rank（BM25/意图/章节 boost/启发式/MMR）+ queryPlan（查询改写），
 * 供两类消费者复用：
 *   - 工具层 `zotero_retrieve`（模型按需检索章节证据）
 *   - 注入层 buildPaperContext（qa 打开时检索召回证据片段进上下文）
 *
 * 尽力而为的 evidence cache：同论文同查询规范化 key 缓存结果，
 * 避免模型追问时重复检索（对应上游 RetrievalService.evidenceCache）。
 * 索引本身按 attachmentKey 内存缓存（full.md 读取一次、多次检索）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { buildChunkIndex, charOffsetOf, type ChunkIndex } from './indexer.ts'
import { rankEvidenceCandidates } from './rank.ts'
import { buildRetrievalQueryPlan, isPlainReadCommand, planCacheKey, resolveQueryPlanWithLLM, type RetrievalQueryPlan } from './queryPlan.ts'
import { resolveCacheDir } from '../mineru/cache.ts'
import { currentConfig } from '../runtime.ts'

/** 检索服务只依赖解析产物的最小形状（避免与 tools-m2 的 ParsedPaper 直接耦合）。 */
export interface ParsedForRetrieval {
  itemKey?: string
  attachmentKey: string
  title: string
  md: string
}

export interface RetrievedEvidence {
  paperKey: string
  attachmentKey: string
  title: string
  query: string
  intent: string
  /** 查询改写变体（LLM 生成；确定性 fallback 时为空数组）。 */
  variants: string[]
  /** top 证据块（按序）。 */
  hits: Array<{
    chunkIndex: number
    sectionLabel: string
    text: string
    score: number
    offset: number
    charLen: number
  }>
  /** 本次检索的字符/体积信息（供「是否命中」判断）。 */
  totalChunks: number
  textChars: number
  latencyMs: number
  cached: boolean
}

/** 论文全文（按 attachmentKey）→ 内存索引缓存。 */
const indexCache = new Map<string, ChunkIndex>()
const EVIDENCE_CACHE_LIMIT = 200

/** 规范化查询：小写、去标点、压缩空白、截断 120（上游 buildEvidenceCacheKey 同款）。 */
export function normalizeQueryKey(query: string): string {
  return query.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

function evidenceCacheKey(attachmentKey: string, query: string): string {
  const q = normalizeQueryKey(query)
  if (!q) return ''
  return createHash('sha1').update(`${attachmentKey}\u0000${q}`).digest('hex').slice(0, 16)
}

const evidenceCache = new Map<string, RetrievedEvidence>()

/** 清理缓存（面板「修复缓存」时用；避免 200 条后爆内存）。 */
export function clearRetrievalCaches(): void {
  indexCache.clear()
  evidenceCache.clear()
}

/** 用已解析全文检索证据（不重新解析；解析交给调用方 ensureParsed）。
 * options.runVariantGen 存在时尝试 LLM 查询改写（失败自动确定性 fallback）；否则跳过改写。 */
export async function retrieveEvidence(
  parsed: ParsedForRetrieval,
  query: string,
  options: {
    topK?: number
    /** 查询变体生成器（如 ml.ts streamText 封装；返回变体数组或 null）。 */
    runVariantGen?: (q: { query: string; paperTitle?: string }) => Promise<string[] | null>
    /** 外部传入的查询计划（引用解析/前缀注入等场景复用，避免重复改写）。 */
    queryPlan?: RetrievalQueryPlan
    signal?: AbortSignal
  } = {},
): Promise<RetrievedEvidence> {
  const t0 = Date.now()
  const topK = Math.max(1, Math.min(options.topK ?? 5, 12))
  const md = parsed.md ?? ''
  const attachmentKey = parsed.attachmentKey
  const ck = evidenceCacheKey(attachmentKey, query)
  if (ck && evidenceCache.has(ck)) {
    const hit = evidenceCache.get(ck)!
    return { ...hit, cached: true, latencyMs: Date.now() - t0 }
  }

  // 查询改写：外部计划 > 磁盘缓存计划 > LLM 生成（失败降级）> 确定性计划。
  let plan = options.queryPlan
  if (!plan && query.trim()) {
    plan = loadPlanCache(query) ?? buildRetrievalQueryPlan(query)
    if (options.runVariantGen && !plan.variants.length) {
      if (!isPlainReadCommand(query)) {
        const variants = await resolveQueryPlanWithLLM({
          runner: options.runVariantGen,
          query,
          paperTitle: parsed.title,
        })
        if (variants?.length) {
          plan = buildRetrievalQueryPlan(query, { variants })
          savePlanCache(query, plan)
        }
      }
    }
  }
  if (!plan) plan = buildRetrievalQueryPlan(query)

  let index = indexCache.get(attachmentKey)
  if (!index || index.chunks.length === 0) {
    index = buildChunkIndex(md)
    indexCache.set(attachmentKey, index)
  }

  const ranked = rankEvidenceCandidates(index, query, { topK, queryPlan: plan })
  const hits = ranked.map((r) => {
    const offset = charOffsetOf(md, r.meta?.startLine ?? 1)
    return {
      chunkIndex: r.chunkIndex,
      sectionLabel: r.sectionLabel,
      text: r.chunkText,
      score: Math.round(r.bm25Score * 100) / 100,
      offset,
      charLen: r.chunkText.length,
    }
  })

  const result: RetrievedEvidence = {
    paperKey: parsed.itemKey ?? parsed.attachmentKey,
    attachmentKey,
    title: parsed.title,
    query,
    intent: detectIntentLabel(query),
    variants: plan?.variants ?? [],
    hits,
    totalChunks: index.chunks.length,
    textChars: md.length,
    latencyMs: Date.now() - t0,
    cached: false,
  }
  if (ck) {
    if (evidenceCache.size >= EVIDENCE_CACHE_LIMIT) {
      const first = evidenceCache.keys().next().value
      if (first !== undefined) evidenceCache.delete(first)
    }
    evidenceCache.set(ck, result)
  }
  return result
}

/* ── 查询计划磁盘缓存（cacheDir/queryplans.json） ───────────────────────── */

interface PlanCacheEntry { variants: string[]; at: number }

function planCacheFile(): string {
  return join(resolveCacheDir(currentConfig()), 'queryplans.json')
}

function loadPlanCache(query: string): RetrievalQueryPlan | undefined {
  try {
    const f = planCacheFile()
    if (!existsSync(f)) return undefined
    const all = JSON.parse(readFileSync(f, 'utf8')) as Record<string, PlanCacheEntry>
    const e = all[planCacheKey(query)]
    if (e && Array.isArray(e.variants) && e.variants.length) {
      return buildRetrievalQueryPlan(query, { variants: e.variants })
    }
  } catch { /* best-effort */ }
  return undefined
}

function savePlanCache(query: string, plan: RetrievalQueryPlan): void {
  try {
    const f = planCacheFile()
    let all: Record<string, PlanCacheEntry> = {}
    try { if (existsSync(f)) all = JSON.parse(readFileSync(f, 'utf8')) } catch { /* rebuild */ }
    // 上限 300 条，清最旧的。
    const keys = Object.keys(all)
    if (keys.length >= 300) {
      const sorted = keys.sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
      for (const k of sorted.slice(0, keys.length - 299)) delete all[k]
    }
    all[planCacheKey(query)] = { variants: plan.variants, at: Date.now() }
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify(all), 'utf8')
  } catch { /* best-effort */ }
}

function detectIntentLabel(query: string): string {
  // 简短导出意图标签，避免 rank.ts 的类型依赖（保持返回纯 JSON）。
  const q = query.toLowerCase()
  if (/\bmethod\b|\bprotocol\b|\balgorithm\b/.test(q)) return 'methodological'
  if (/\bfigure\b|\btable\b|\bdiagram\b|\bcaption\b/.test(q)) return 'visual'
  if (/\bcompar|\bversus\b|\bvs\.?\b|\bcontrast\b/.test(q)) return 'comparative'
  if (/\bcit|\brefer/.test(q)) return 'citation'
  if (/\bhow many\b|\bpercentage\b|\bratio\b|\bcount\b/.test(q)) return 'factual'
  if (/\bmechanism\b|\bwhy does\b|\bhow does\b/.test(q)) return 'conceptual'
  return 'general'
}

/** 单条证据块的渲染文本（带章节/页码前缀，供注入与工具输出）。
 * P4 证据打包：块头 = sectionLabel + chunk 序号 + score + offset，正文带截断。 */
export function formatEvidenceHit(hit: RetrievedEvidence['hits'][number], budgetChars: number, index = 0): string {
  const head = [
    hit.sectionLabel && hit.sectionLabel !== '(全文)' ? `## ${hit.sectionLabel}` : '',
    `[chunk #${hit.chunkIndex}, score ${hit.score}, offset ${hit.offset}]`,
  ].filter(Boolean).join(' ')
  const body = hit.text.slice(0, Math.max(800, budgetChars))
  return `${head ? `${head}\n` : ''}${body}`
}

/** P4 证据打包：检索结果 → 注入文本（覆盖 ledger + 命中块列表）。 */
export function formatEvidencePack(res: RetrievedEvidence, options: { budgetPerHit?: number; maxHits?: number } = {}): string {
  const budgetPerHit = Math.max(800, options.budgetPerHit ?? 1400)
  const maxHits = Math.max(1, options.maxHits ?? res.hits.length)
  const lines: string[] = []
  lines.push(`【检索证据 · 针对问题「${res.query.slice(0, 120)}」】`)
  lines.push(`(命中 ${res.hits.length}/${res.totalChunks} 块, 意图 ${res.intent}, 用时 ${res.latencyMs}ms${res.cached ? '，缓存' : ''}${res.variants.length ? `，改写变体 ${res.variants.length} 条` : ''})`)
  if (!res.hits.length) {
    lines.push('（无显著命中——可改用 zotero_read_fulltext 顺序精读或 zotero_summarize）')
  }
  for (const [i, h] of res.hits.slice(0, maxHits).entries()) {
    lines.push(`\n${formatEvidenceHit(h, budgetPerHit, i)}`)
  }
  lines.push('\n[检索覆盖说明] 检索基于全部分块(' + res.totalChunks + ' 块, ' + res.textChars + ' 字符)，命中按相关性排序；引用时请标注章节标签。')
  return lines.join('\n')
}