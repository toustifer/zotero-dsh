/**
 * dsh-zotero — 全文翻译引擎（pdf2zh 实施逻辑的插件化映射）：
 *
 * 提取(MinerU markdown, 公式=LaTeX 天然占位) → 分块(段落边界≥800字符)
 * → 并发翻译(4路, 走 /translate 的 sha1 缓存) → 进度/暂停/取消/续传
 * → 结果持久化 <cacheDir>/fulltranslate/<attachmentKey>.json
 *
 * 与 pdf2zh 的差异：回填(pdf2zh 用 PyMuPDF 插 textbox) 在我们是 client 端
 * 双语对照视图（阶段2 若做页内叠加需 MinerU middle_json 坐标）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type LlmService from '@deepseek-ai/dsh-llm'
import type { ZoteroClient } from './zotero/client.ts'
import type { Config } from './config.ts'
import type { ResolvedModel } from './ml.ts'
import { translateText } from './translate.ts'
import { ensureParsed } from './tools-m2.ts'
import { resolveCacheDir } from './mineru/cache.ts'
import { currentConfig } from './runtime.ts'

export interface FullChunk {
  /** 在全文中的序号（0-based）。 */
  id: number
  /** 原文（markdown 片段）。 */
  src: string
  /** 译文（空 = 未译）。 */
  dst: string
}

export interface FullTranslateJob {
  state: 'idle' | 'running' | 'paused' | 'done' | 'error'
  attachmentKey: string
  itemKey?: string
  title: string
  /** 分块维度（CHUNK_SIZE-CONCURRENCY），不一致时作废重译。 */
  schema: string
  total: number
  done: number
  error: string
  chunks: FullChunk[]
  /** 节选起点（日志用：全文第 N 段起）。 */
  startedAt: number
  updatedAt: number
  abort: AbortController | null
}

const CONCURRENCY = 8
const CHUNK_SIZE = 1500
/** 分块+并发 schema（变化时旧任务作废重译，防止 chunk id 错位）。 */
const SCHEMA = `${CHUNK_SIZE}-${CONCURRENCY}-v2`

/* ── 分块（pdf2zh 块聚合的 md 版：空行分段，段内超长再按句切） ── */

export function splitMdChunks(md: string, maxLen = CHUNK_SIZE): string[] {
  const paragraphs = md
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const out: string[] = []
  // 相邻短段合并（pdf2zh 块聚合策略：减少 chunk 数、保持段落边界语义）
  let buf = ''
  for (const p of paragraphs) {
    const merged = buf ? `${buf}\n\n${p}` : p
    if (merged.length > maxLen) {
      if (buf) out.push(buf)
      buf = p
      if (p.length > maxLen) {
        // 超长段：按句聚合切块
        let cur = ''
        const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' })
        for (const s of seg.segment(p)) {
          cur += s.segment
          if (cur.length >= maxLen) {
            out.push(cur)
            cur = ''
          }
        }
        if (cur) buf = cur
      }
    } else {
      buf = merged
    }
  }
  if (buf) out.push(buf)
  return out
}

/* ── 持久化 ── */

function storePath(cfg: Config, attachmentKey: string): string {
  const dir = join(resolveCacheDir(cfg), 'fulltranslate')
  try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  return join(dir, `${attachmentKey}.json`)
}

function loadStore(cfg: Config, attachmentKey: string): FullTranslateJob | null {
  try {
    const p = storePath(cfg, attachmentKey)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as FullTranslateJob
    if (!Array.isArray(j.chunks)) return null
    return j
  } catch {
    return null
  }
}

function saveStore(cfg: Config, job: FullTranslateJob): void {
  try {
    const p = storePath(cfg, attachmentKey0(job))
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(job), 'utf8')
    renameSync(tmp, p)
  } catch { /* best-effort */ }
}

function attachmentKey0(job: FullTranslateJob): string {
  return String(job.attachmentKey)
}

/* ── 任务注册表（进程内存；跨重启由 store 恢复为 paused 状态） ── */

const jobs = new Map<string, FullTranslateJob>()

function recoveryJobs(): FullTranslateJob[] {
  try {
    const dir = join(resolveCacheDir(currentConfig()), 'fulltranslate')
    if (!existsSync(dir)) return []
    const out: FullTranslateJob[] = []
    for (const f of readdirSafe(dir)) {
      if (!f.endsWith('.json')) continue
      const j = loadStore(currentConfig(), f.slice(0, -5))
      if (j) out.push(j)
    }
    return out
  } catch {
    return []
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 从持久化恢复任务（会合点：重启后状态从 store 恢复为 done/paused）。 */
function ensureJob(attachmentKey: string): FullTranslateJob | null {
  const live = jobs.get(attachmentKey)
  if (live) return live // 内存中的活任务不动（status 轮询不得改变 running）
  const stored = loadStore(currentConfig(), attachmentKey)
  if (stored) {
    if (stored.state === 'running') stored.state = 'paused' // 仅磁盘恢复的任务（上次进程中断）
    jobs.set(attachmentKey, stored)
    return stored
  }
  return null
}

/* ── 公开 API ── */

export function fullTranslateStatus(attachmentKey: string): { job: FullTranslateJob | null } {
  return { job: ensureJob(attachmentKey) }
}

export interface StartResult {
  ok: boolean
  job?: FullTranslateJob
  error?: string
}

export async function startFullTranslate(
  client: ZoteroClient,
  llm: LlmService,
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined,
  itemKey: string,
  attachmentKey: string,
): Promise<StartResult> {
  const cfg = currentConfig()
  const existing = ensureJob(attachmentKey)
  if (existing?.state === 'running') return { ok: true, job: existing }
  if (existing && existing.state === 'done') return { ok: true, job: existing }

  let md: string
  let title: string
  try {
    const parsed = await ensureParsed(client, cfg, 'auto', itemKey, attachmentKey, undefined)
    md = parsed.md
    title = parsed.title
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) }
  }

  const srcChunks = splitMdChunks(md)
  const old = existing && existing.schema === SCHEMA ? existing.chunks : []
  const oldMap = new Map<number, FullChunk>()
  for (const c of old) oldMap.set(c.id, c)

  const chunks: FullChunk[] = srcChunks.map((text, id) => {
    const prev = oldMap.get(id)
    return { id, src: text, dst: prev?.dst ?? '' }
  })

  const job: FullTranslateJob = {
    state: 'running',
    attachmentKey,
    itemKey,
    title,
    schema: SCHEMA,
    total: chunks.length,
    done: chunks.filter((c) => c.dst).length,
    error: '',
    chunks,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    abort: new AbortController(),
  }
  jobs.set(attachmentKey, job)
  saveStore(cfg, job)

  void runQueue(job, client, cfg, llm, agentDefaultModel)
  return { ok: true, job }
}

async function runQueue(
  job: FullTranslateJob,
  client: ZoteroClient,
  cfg: Config,
  llm: LlmService,
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined,
): Promise<void> {
  const signal = job.abort!.signal
  const todo: number[] = []
  for (const c of job.chunks) if (!c.dst) todo.push(c.id)

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < todo.length) {
      if (signal.aborted) return
      if (job.state === 'paused' || job.state === 'idle') return
      const id = todo[cursor++]
      const c = job.chunks[id]
      if (!c || c.dst) continue
      try {
        const r = await translateText({
          llm,
          agentDefaultModel,
          client,
          text: c.src,
          itemKey: job.itemKey,
          targetLang: cfg.translateTargetLang || 'zh',
          signal,
        })
        if (r.ok) {
          c.dst = r.text
          job.done++
          job.updatedAt = Date.now()
          job.chunks[id] = c
          if (job.done % 8 === 0 || job.done === job.total) saveStore(cfg, job)
        } else if (!signal.aborted) {
          job.error = r.error || '翻译失败'
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return
        job.error = String(e?.message ?? e)
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker())
  await Promise.all(workers)
  if (signal.aborted) {    job.state = 'paused'
  } else if (job.done >= job.total) {
    job.state = 'done'
  } else {
    job.state = 'error'
  }
  job.updatedAt = Date.now()
  job.abort = null
  saveStore(cfg, job)
}

export function pauseFullTranslate(attachmentKey: string): { ok: boolean; error?: string } {
  const job = ensureJob(attachmentKey)
  if (!job) return { ok: false, error: '任务不存在' }
  if (job.state === 'running') {
    job.abort?.abort()
  }
  job.state = 'paused'
  saveStore(currentConfig(), job)
  return { ok: true }
}

export function cancelFullTranslate(attachmentKey: string): { ok: boolean; error?: string } {
  return pauseFullTranslate(attachmentKey)
}

export function resumeFullTranslate(attachmentKey: string): { ok: boolean; error?: string } {
  const job = ensureJob(attachmentKey)
  if (!job) return { ok: false, error: '任务不存在' }
  if (job.state === 'running') return { ok: true }
  if (job.state === 'done') return { ok: true }
  job.state = 'running'
  job.error = ''
  const cfg = currentConfig()
  jobs.set(attachmentKey, job)
  saveStore(cfg, job)
  const client = currentClient()
  const llm = currentLlm()
  const agentDefaultModel = currentModel()
  if (!llm || !client) return { ok: false, error: '运行时服务未就绪' }
  void runQueue(job, client, cfg, llm, agentDefaultModel)
  return { ok: true }
}

/* 运行时上下文 setter（panel-api 启动时注入，避免模块循环依赖）。 */
let LLM: LlmService | null = null
let CLIENT: ZoteroClient | null = null
let MODEL: { currentSelection(): ResolvedModel } | undefined
export function setFullTranslateRuntime(
  client: ZoteroClient | null,
  llm: LlmService | null,
  model: { currentSelection(): ResolvedModel } | undefined,
): void {
  LLM = llm
  CLIENT = client
  MODEL = model
}
function currentLlm(): LlmService | null {
  return LLM
}
function currentClient(): ZoteroClient | null {
  return CLIENT
}
function currentModel(): { currentSelection(): ResolvedModel } | undefined {
  return MODEL
}

/** 测试用 reset。 */
export function _fullTranslateReset(): void {
  jobs.clear()
}
