/**
 * dsh-zotero — pdf2zh 一键全文翻译集成（直接调用官方 CLI，产出标准双语 PDF）。
 *
 * 链路：Zotero 附件路径 → spawn `pdf2zh <pdf> -s openai:<model> -o <cacheDir>/pdf2zh/<key>`
 *       → 输出 `<name>-dual.pdf`（双语对照：原文+译文，即"一边中文一边英文"）
 *       → 面板渲染/下载该产物。
 * 配置：OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL（设置页；API Key 打点存储，
 *       不落仓库）。依赖：`uv tool install --python 3.12 pdf2zh`。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ZoteroClient } from './zotero/client.ts'
import type { Config } from './config.ts'
import { currentConfig } from './runtime.ts'
import { resolveCacheDir } from './mineru/cache.ts'

export interface Pdf2zhJob {
  state: 'running' | 'done' | 'error' | 'cancelled' | 'not-configured'
  attachmentKey: string
  itemKey: string
  title: string
  /** 最近 stdout/stderr 片段（进度）。 */
  progress: string
  error: string
  /** 产出物绝对路径（done 后填充）。 */
  files: { mono: string; dual: string }
  startedAt: number
  updatedAt: number
}

const jobs = new Map<string, Pdf2zhJob>()
const procs = new Map<string, { kill(signal?: NodeJS.Signals): void }>()

export function outDir(cfg: Config, attachmentKey: string): string {
  const dir = join(resolveCacheDir(cfg), 'pdf2zh', String(attachmentKey))
  try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  return dir
}

export function findOutput(cfg: Config, attachmentKey: string): { mono: string; dual: string } | null {
  try {
    const dir = outDir(cfg, attachmentKey)
    const files = readdirSync(dir)
    const dual = files.find((f) => /-dual\.pdf$/i.test(f))
    const mono = files.find((f) => /-mono\.pdf$/i.test(f))
    if (!dual && !mono) return null
    return { mono: mono ? join(dir, mono) : '', dual: dual ? join(dir, dual) : '' }
  } catch {
    return null
  }
}

/** uv tool 安装的 pdf2zh 可执行文件（Windows 候选路径）。 */
export function pdf2zhBinPath(): string | null {
  const candidates = [
    join(homedir(), '.local', 'bin', 'pdf2zh.exe'),
    join(homedir(), '.local', 'bin', 'pdf2zh'),
    join(homedir(), 'AppData', 'Roaming', 'uv', 'tools', 'pdf2zh', 'bin', 'pdf2zh.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'uv', 'tools', 'pdf2zh', 'bin', 'pdf2zh.exe'),
  ]
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch { /* keep looking */ }
  }
  return null
}

export function pdf2zhConfigured(cfg: Config): boolean {
  return Boolean(cfg.pdf2zhApiKey.trim())
}

export function statusPdf2zh(attachmentKey: string): Pdf2zhJob | null {
  const live = jobs.get(attachmentKey)
  if (live) return live
  const cfg = currentConfig()
  const files = findOutput(cfg, attachmentKey)
  if (files?.dual) {
    const j: Pdf2zhJob = {
      state: 'done', attachmentKey, itemKey: '', title: '', progress: '完成（产物已缓存）',
      error: '', files, startedAt: 0, updatedAt: Date.now(),
    }
    jobs.set(attachmentKey, j)
    return j
  }
  return null
}

export async function startPdf2zh(
  client: ZoteroClient,
  attachmentKey: string,
  itemKey: string,
): Promise<{ ok: boolean; job?: Pdf2zhJob; error?: string }> {
  const cfg = currentConfig()
  const existing = jobs.get(attachmentKey)
  if (existing?.state === 'running') return { ok: true, job: existing }
  if (!pdf2zhConfigured(cfg)) {
    const j: Pdf2zhJob = {
      state: 'not-configured', attachmentKey, itemKey, title: '', progress: '', error: '未配置 pdf2zh API Key（设置 → PDF2ZH 翻译引擎）',
      files: { mono: '', dual: '' }, startedAt: Date.now(), updatedAt: Date.now(),
    }
    jobs.set(attachmentKey, j)
    return { ok: false, error: j.error, job: j }
  }
  const cached = findOutput(cfg, attachmentKey)
  if (cached?.dual) {
    const j: Pdf2zhJob = {
      state: 'done', attachmentKey, itemKey, title: '', progress: '使用缓存产物', error: '',
      files: cached, startedAt: Date.now(), updatedAt: Date.now(),
    }
    jobs.set(attachmentKey, j)
    return { ok: true, job: j }
  }

  const pdfPath = await client.resolveAttachmentPath(attachmentKey)
  if (!pdfPath) return { ok: false, error: '附件文件不可用（需 Local API 开启）' }

  let title = ''
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const got = await client.scoped().getItem(itemKey) as any
    title = String(got?.item?.title ?? got?.title ?? '')
  } catch { /* best-effort */ }

  const dir = outDir(cfg, attachmentKey)
  const job: Pdf2zhJob = {
    state: 'running', attachmentKey, itemKey, title, progress: '启动 pdf2zh…', error: '',
    files: { mono: '', dual: '' }, startedAt: Date.now(), updatedAt: Date.now(),
  }
  jobs.set(attachmentKey, job)

  const bin = pdf2zhBinPath()
  if (!bin) {
    job.state = 'error'
    job.error = '未找到 pdf2zh 可执行文件。请先安装：uv tool install --python 3.12 pdf2zh'
    return { ok: false, error: job.error, job }
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENAI_BASE_URL: cfg.pdf2zhBaseUrl || 'https://api.deepseek.com/v1',
    OPENAI_API_KEY: cfg.pdf2zhApiKey,
    OPENAI_MODEL: cfg.pdf2zhModel || 'deepseek-chat',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  }
  const args = [
    pdfPath,
    '-s', `openai:${cfg.pdf2zhModel || 'deepseek-chat'}`,
    '-o', dir,
    '-t', String(cfg.pdf2zhThreads || 4),
    '-lo', cfg.translateTargetLang || 'zh',
  ]

  const child = spawn(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  procs.set(attachmentKey, child)
  let errTail = ''
  const tail = (s: string): void => {
    errTail = (errTail + s).slice(-600)
    job.progress = errTail.split(/[\r\n]+/).pop() ?? ''
    job.updatedAt = Date.now()
  }
  child.stdout.on('data', (d: Buffer) => tail(d.toString('utf8')))
  child.stderr.on('data', (d: Buffer) => tail(d.toString('utf8')))

  // 后台等待进程结束（start 立即返回，不阻塞 HTTP 请求）
  void (async () => {
    const code: number | null = await new Promise<number | null>((resolve) => {
      child.on('close', resolve)
      child.on('error', (e) => {
        job.state = 'error'
        job.error = `无法启动 pdf2zh: ${String(e?.message ?? e)}`
        resolve(-1)
      })
    })
    procs.delete(attachmentKey)
    if (job.state === 'error') return
    if (code === 0) {
      const files = findOutput(cfg, attachmentKey)
      if (files?.dual) {
        job.state = 'done'
        job.files = files
        job.progress = '完成'
        job.error = ''
      } else {
        job.state = 'error'
        job.error = 'pdf2zh 已退出但未找到 *-dual.pdf 产物'
      }
      return
    }
    if (job.state === 'running') {
      job.state = 'cancelled'
      job.error = errTail.slice(-200)
    }
  })()

  return { ok: true, job }
}

export function cancelPdf2zh(attachmentKey: string): { ok: boolean; error?: string } {
  const proc = procs.get(attachmentKey)
  if (proc) {
    try { proc.kill() } catch { /* best-effort */ }
  }
  const job = jobs.get(attachmentKey)
  if (job && job.state === 'running') job.state = 'cancelled'
  return { ok: true }
}
