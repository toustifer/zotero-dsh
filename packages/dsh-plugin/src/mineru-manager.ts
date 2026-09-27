/**
 * dsh-zotero — MD 解析可视化管理（参考原项目设置页的解析管理组件）。
 *
 * overview：库内全部带 PDF 的条目 + 解析状态（缓存来源/大小）
 * job：批量解析队列（全部开始 / 修复缓存；并发 2，进度/错误可查）
 * 管理：删除所有缓存；测试连接（local health / cloud key 探测）
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type LlmService from '@deepseek-ai/dsh-llm'
import type { ZoteroClient } from './zotero/client.ts'
import type { ResolvedModel } from './ml.ts'
import { ensureParsed } from './tools-m2.ts'
import { readManifest, resolveCacheDir } from './mineru/cache.ts'
import { currentConfig } from './runtime.ts'

export interface MOverviewItem {
  key: string
  attachmentKey: string
  title: string
  parsed: boolean
  source?: string
  sizeKb?: number
  at?: string
}

export interface MOverview {
  ok: boolean
  total: number
  parsed: number
  items: MOverviewItem[]
  error: string
  hint: string
}

export interface MJob {
  state: 'idle' | 'running' | 'done' | 'cancelled' | 'error'
  total: number
  done: number
  current: string
  errors: string[]
  startedAt: number
}

const job: MJob = { state: 'idle', total: 0, done: 0, current: '', errors: [], startedAt: 0 }
let cancelFlag = false

/** 概览（快路径）：已解析 = 扫描缓存目录；total = 库内顶层条目数（1 页拿 total）。 */
export async function mineruOverview(client: ZoteroClient): Promise<MOverview> {
  const cfg = currentConfig()
  try {
    const cacheRoot = join(resolveCacheDir(cfg), 'mineru')
    let dirs: string[] = []
    try { dirs = readdirSync(cacheRoot) } catch { dirs = [] }
    const items: MOverviewItem[] = dirs.map((d) => {
      const mf = readManifest(cfg, d)
      const mdPath = join(cacheRoot, d, 'full.md')
      const sizeKb = existsSync(mdPath) ? Math.round(statSync(mdPath).size / 1024) : undefined
      return {
        key: '',
        attachmentKey: d,
        title: (mf?.title || d).slice(0, 90),
        parsed: Boolean(mf),
        source: mf?.source,
        sizeKb,
        at: mf?.parsedAtUtc,
      }
    })
    items.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    let total = items.length
    try {
      const r = await client.scoped().search({ query: '', limit: 1, qmode: 'titleCreatorYear' })
      total = Math.max(items.length, Number(r.total ?? 0))
    } catch { /* 统计尽力而为 */ }
    return { ok: true, total, parsed: items.length, items, error: '', hint: 'total = 库内条目数（含无 PDF）' }
  } catch (err: any) {
    return { ok: false, total: 0, parsed: 0, items: [], error: String(err?.message ?? err), hint: '请确认 Zotero Local API 可用' }
  }
}

/** 批量队列：目标 = 库内顶层条目 key 列表；无 PDF/失败条目跳过计入 errors。 */
async function runQueue(client: ZoteroClient, llm: LlmService, agentDefaultModel: { currentSelection(): ResolvedModel } | undefined, keys: string[]): Promise<void> {
  const cfg = currentConfig()
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < keys.length) {
      if (cancelFlag) return
      const key = keys[cursor++]
      try {
        const parsed = await ensureParsed(client, cfg, 'auto', key, undefined, undefined)
        job.done += 1
        job.current = ''
      } catch (e: any) {
        const m = String(e?.message ?? e)
        if (!/没有 PDF|无 PDF|附件/.test(m)) job.errors.push(`${key}: ${m.slice(0, 120)}`)
        job.done += 1
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  job.state = cancelFlag ? 'cancelled' : 'done'
  job.current = ''
}

/** 全部开始（批量解析库内条目，含未解析与已缓存——已缓存命中秒过）/ 修复缓存（强制重解析）。 */
export async function startMineruBatch(
  client: ZoteroClient,
  llm: LlmService,
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined,
  repair = false,
): Promise<{ ok: boolean; job: MJob; error?: string }> {
  if (job.state === 'running') return { ok: true, job }
  const keys: string[] = []
  let start = 0
  try {
    for (let guard = 0; guard < 30; guard += 1) {
      const r = await client.scoped().search({ query: '', limit: 100, start, qmode: 'titleCreatorYear' })
      const rows = r.items
      keys.push(...rows.map((i) => i.key))
      if (rows.length < 100 || keys.length >= Number(r.total ?? 0)) break
      start += 100
    }
  } catch (err: any) {
    return { ok: false, job, error: `读取条目失败: ${String(err?.message ?? err)}` }
  }
  if (!keys.length) return { ok: false, job, error: '库内无条目' }
  cancelFlag = false
  job.state = 'running'
  job.total = keys.length
  job.done = 0
  job.errors = []
  job.current = ''
  job.startedAt = Date.now()
  void runQueue(client, llm, agentDefaultModel, keys)
  return { ok: true, job }
}

export function mineruJob(): MJob {
  return job
}

export function cancelMineruBatch(): { ok: boolean } {
  cancelFlag = true
  return { ok: true }
}

/** 删除全部 MD 缓存（保留目录）。 */
export function clearMineruCache(): { ok: boolean; error?: string } {
  try {
    const dir = join(resolveCacheDir(currentConfig()), 'mineru')
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) }
  }
}

/** 测试连接：local 探 health；cloud 探授权（batch 空请求）。 */
export async function testMineruConnection(): Promise<{ ok: boolean; mode: string; message: string }> {
  const cfg = currentConfig()
  try {
    if (cfg.mineruMode === 'cloud') {
      if (!cfg.mineruCloudApiKey.trim()) return { ok: false, mode: 'cloud', message: '未配置云端 API Key（mineru.net）' }
      const res = await fetch('https://mineru.net/api/v4/file-urls/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.mineruCloudApiKey}` },
        body: JSON.stringify({ enable_formula: true, enable_table: true, language: 'ch', files: [] }),
      })
      if (res.status === 200) return { ok: true, mode: 'cloud', message: '云端 API Key 有效（mineru.net）' }
      if (res.status === 401 || res.status === 403) return { ok: false, mode: 'cloud', message: `云端认证失败（HTTP ${res.status}）：请检查 API Key` }
      return { ok: true, mode: 'cloud', message: `云端可达（HTTP ${res.status}，配额/参数提示请忽略）` }
    }
    const base = cfg.mineruLocalApiBase?.trim() || 'http://127.0.0.1:8000'
    const res = await fetch(`${base.replace(/\/+$/, '')}/health`, { method: 'GET' })
    if (res.ok) return { ok: true, mode: 'local', message: `本地 mineru-api 可达（${base}）` }
    return { ok: false, mode: 'local', message: `本地服务响应异常（HTTP ${res.status}）` }
  } catch (err: any) {
    return { ok: false, mode: cfg.mineruMode, message: `连接失败：${String(err?.message ?? err)}` }
  }
}
