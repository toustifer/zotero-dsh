/**
 * dsh-zotero — MinerU parsing client (cloud v4 + local mineru-api), faithful
 * port of the upstream llm-for-zotero contract (see docs/M0-audit.md §3.5).
 *
 * Cloud : POST https://mineru.net/api/v4/file-urls/batch → presigned PUT →
 *         poll /extract-results/batch/{id} → zip.
 * Local : POST {base}/file_parse (multipart, synchronous) → zip bytes;
 *         HTTP 409 = busy → retry [5,15,30,60,120]s.
 */
import type { Config } from '../config.ts'
import { unpackMineruZip, type MinerUZipEntry } from './zip.ts'

const CLOUD_BASE = 'https://mineru.net/api/v4'
const CLIENT_BLOB = { type: 'application/pdf' } as const
type BodyInitLike = NonNullable<RequestInit['body']>
const CLOUD_INITIAL_POLL_MS = 3000
const CLOUD_MEDIUM_POLL_MS = 15_000
const CLOUD_LONG_POLL_MS = 60_000
const CLOUD_NO_STATUS_TIMEOUT_MS = 10 * 60 * 1000
const CLOUD_PRE_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000
const LOCAL_BUSY_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000]
const LOCAL_REQUEST_TIMEOUT_MS = 0 // synchronous; rely on explicit abort

export class MineruError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'MineruError'
  }
}

export interface MineruParseResult {
  md: string
  imageFiles: MinerUZipEntry[]
  source: 'mineru-cloud' | 'mineru-local'
  elapsedMs: number
  /** Total characters of the markdown. */
  mdChars: number
}

export interface MineruParseOptions {
  pdfBytes: Uint8Array
  fileName: string
  signal?: AbortSignal
  onStage?: (stage: string) => void
}

function cleanFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() || 'paper.pdf'
  const ascii = base.replace(/[^\x20-\x7E]/g, '_') || 'paper.pdf'
  // reject path-ish junk
  return ascii.replace(/[/\\]/g, '_')
}

export class MineruClient {
  constructor(private readonly cfg: Config) {}

  private localBase(): string {
    return this.cfg.mineruLocalApiBase.replace(/\/+$/, '')
  }

  private cloudHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.mineruCloudApiKey}` }
  }

  private backendValue(): string {
    return this.cfg.mineruLocalBackend === 'vlm'
      ? 'vlm-auto-engine'
      : this.cfg.mineruLocalBackend === 'hybrid'
        ? 'hybrid-auto-engine'
        : 'pipeline'
  }

  async parse(options: MineruParseOptions): Promise<MineruParseResult> {
    const started = Date.now()
    const fileName = cleanFileName(options.fileName)
    if (this.cfg.mineruMode === 'cloud' && this.cfg.mineruCloudApiKey) {
      try {
        const r = await this.parseViaCloud({ ...options, fileName })
        return { ...r, source: 'mineru-cloud', elapsedMs: Date.now() - started }
      } catch (err) {
        // Cloud failure (bad key/quota) — no silent local fallback; surface it.
        throw err
      }
    }
    options.onStage?.('本地 MinerU 解析…')
    const r = await this.parseViaLocal({ ...options, fileName })
    return { ...r, source: 'mineru-local', elapsedMs: Date.now() - started }
  }

  /* ── local mineru-api ─────────────────────────────────────────────── */

  private async parseViaLocal(
    options: MineruParseOptions & { fileName: string },
  ): Promise<Omit<MineruParseResult, 'source' | 'elapsedMs'>> {
    const form = new FormData()
    form.append('files', new Blob([options.pdfBytes as unknown as ArrayBuffer], CLIENT_BLOB), options.fileName)
    form.append('backend', this.backendValue())
    form.append('parse_method', this.cfg.mineruForceOcr ? 'ocr' : 'auto')
    form.append('formula_enable', 'true')
    form.append('table_enable', 'true')
    form.append('return_md', 'true')
    form.append('return_content_list', 'true')
    form.append('return_images', 'true')
    form.append('response_format_zip', 'true')
    form.append('return_original_file', 'false')

    const url = `${this.localBase()}/file_parse`
    let lastError = ''
    for (let attempt = 0; attempt < LOCAL_BUSY_RETRY_MS.length + 1; attempt += 1) {
      const res = await this.fetchWithSignal(url, {
        method: 'POST',
        body: form,
      }, options.signal, LOCAL_REQUEST_TIMEOUT_MS, '本地 MinerU 服务')
      if (res.status === 409) {
        const delay = LOCAL_BUSY_RETRY_MS[attempt]
        if (delay === undefined) {
          throw new MineruError('本地 MinerU 服务持续繁忙', '稍后重试；或在设置中切换为 cloud 模式')
        }
        options.onStage?.(`本地 MinerU 繁忙，${Math.round(delay / 1000)}s 后重试…`)
        await sleep(delay, options.signal)
        continue
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200)
        lastError = `HTTP ${res.status}${text ? `: ${text}` : ''}`
        throw new MineruError(`本地 MinerU 解析失败: ${lastError}`, '请确认 mineru-api 服务在运行且后端可用')
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      return unpack(bytes, '本地')
    }
    throw new MineruError(`本地 MinerU 解析失败: ${lastError || 'unknown'}`)
  }

  /* ── mineru.net cloud v4 ──────────────────────────────────────────── */

  private async parseViaCloud(
    options: MineruParseOptions & { fileName: string },
  ): Promise<Omit<MineruParseResult, 'source' | 'elapsedMs'>> {
    options.onStage?.('MinerU cloud: 请求上传地址…')
    const batchRes = await this.fetchWithSignal(`${CLOUD_BASE}/file-urls/batch`, {
      method: 'POST',
      headers: { ...this.cloudHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enable_formula: true,
        enable_table: true,
        language: 'ch',
        model_version: this.cfg.mineruCloudModel,
        files: [{ name: options.fileName, is_ocr: this.cfg.mineruForceOcr }],
      }),
    }, options.signal, 60_000, 'MinerU cloud')
    if (batchRes.status === 429) {
      throw new MineruError('MinerU 每日配额超限 (HTTP 429)', '次日重试或改用本地 mineru-api')
    }
    if (!batchRes.ok) {
      const text = (await batchRes.text().catch(() => '')).slice(0, 200)
      if (/rate.?limit|quota|exceeded/i.test(text)) {
        throw new MineruError(`MinerU 限流/配额: ${text}`, '次日重试或改用本地 mineru-api')
      }
      throw new MineruError(`MinerU batch 失败: HTTP ${batchRes.status}${text ? `: ${text}` : ''}`, '请检查 mineruCloudApiKey 配置')
    }
    const batchJson = (await batchRes.json().catch(() => null)) as {
      data?: { batch_id?: string; file_urls?: string[] }
    } | null
    const batchId = batchJson?.data?.batch_id
    const uploadUrl = batchJson?.data?.file_urls?.[0]
    if (!batchId || !uploadUrl) {
      throw new MineruError('MinerU batch 响应缺 batch_id/file_urls', '可能是 API 契约变更，查看响应确认')
    }

    options.onStage?.('MinerU cloud: 上传 PDF…')
    const uploadRes = await this.fetchWithSignal(uploadUrl, {
      method: 'PUT',
      // 不加 Content-Type：签名 URL 可能不支持，会 403（上游经验）
      body: options.pdfBytes as unknown as BodyInitLike,
    }, options.signal, 120_000, 'MinerU upload')
    if (!uploadRes.ok) {
      throw new MineruError(`MinerU 上传失败: HTTP ${uploadRes.status}`, '重试或改用本地 mineru-api')
    }

    const pollStart = Date.now()
    let lastStatusAt: number | null = null
    let activeStartedAt: number | null = null
    let lastState = ''
    while (true) {
      const now = Date.now()
      const active = activeStartedAt !== null || ['running', 'converting'].includes(lastState)
      const interval = active
        ? now - (activeStartedAt ?? pollStart) >= 30 * 60 * 1000
          ? CLOUD_LONG_POLL_MS
          : now - pollStart >= 5 * 60 * 1000
            ? CLOUD_MEDIUM_POLL_MS
            : CLOUD_INITIAL_POLL_MS
        : CLOUD_INITIAL_POLL_MS
      if (lastStatusAt === null && now - pollStart >= CLOUD_NO_STATUS_TIMEOUT_MS) {
        throw new MineruError('MinerU 等待状态超时 (10min)', '页面过大或服务繁忙，稍后重试')
      }
      if (activeStartedAt === null && now - pollStart >= CLOUD_PRE_PROCESSING_TIMEOUT_MS) {
        throw new MineruError('MinerU 预处理超时 (30min)', '稍后重试')
      }
      await sleep(interval, options.signal)
      const pollRes = await this.fetchWithSignal(`${CLOUD_BASE}/extract-results/batch/${batchId}`, {
        method: 'GET',
        headers: this.cloudHeaders(),
      }, options.signal, 60_000, 'MinerU poll')
      if (!pollRes.ok) continue
      const pollJson = (await pollRes.json().catch(() => null)) as {
        data?: { extract_result?: Array<{ state?: string; full_zip_url?: string }> }
      } | null
      const item = pollJson?.data?.extract_result?.[0]
      if (!item) continue
      lastStatusAt = Date.now()
      const state = (item.state ?? '').trim().toLowerCase()
      if (state === 'running' || state === 'converting') {
        if (activeStartedAt === null) activeStartedAt = lastStatusAt
        lastState = state
        options.onStage?.(`MinerU cloud: 解析中… (${Math.round((lastStatusAt - pollStart) / 1000)}s)`)
        continue
      }
      if (state === 'failed') {
        throw new MineruError('MinerU cloud 解析失败', 'PDF 可能损坏或格式不支持')
      }
      if (state === 'done') {
        if (!item.full_zip_url) throw new MineruError('MinerU 缺少 zip 结果')
        options.onStage?.('MinerU cloud: 下载结果…')
        const zipRes = await this.fetchWithSignal(item.full_zip_url, { method: 'GET' }, options.signal, 180_000, 'MinerU download')
        if (!zipRes.ok) throw new MineruError(`MinerU 下载失败: HTTP ${zipRes.status}`)
        const bytes = new Uint8Array(await zipRes.arrayBuffer())
        return unpack(bytes, '云端')
      }
      // idle / unknown states: keep waiting
    }
  }

  /** Test connectivity of the configured backend. */
  async test(): Promise<{ ok: boolean; message: string }> {
    if (this.cfg.mineruMode === 'cloud') {
      if (!this.cfg.mineruCloudApiKey) {
        return { ok: false, message: '未配置 MinerU cloud API key' }
      }
      try {
        const res = await this.fetchWithSignal(`${CLOUD_BASE}/extract-results/batch/_test`, {
          method: 'GET',
          headers: this.cloudHeaders(),
        }, undefined, 20_000, 'MinerU test')
        if (res.status === 200) return { ok: true, message: 'MinerU cloud 连接成功' }
        const text = (await res.text().catch(() => '')).slice(0, 120)
        return { ok: false, message: `HTTP ${res.status}${text ? `: ${text}` : ''}` }
      } catch (err: any) {
        return { ok: false, message: String(err?.message ?? err) }
      }
    }
    try {
      const res = await this.fetchWithSignal(`${this.localBase()}/file_parse`, {
        method: 'POST',
        body: (() => {
          const f = new FormData()
          return f
        })() as unknown as BodyInitLike,
      }, undefined, 10_000, 'local test')
      // Any HTTP response means the service is up (400/422 expected without file).
      return { ok: true, message: `本地 MinerU 服务可达 (HTTP ${res.status})` }
    } catch (err: any) {
      return { ok: false, message: String(err?.message ?? err) }
    }
  }

  private async fetchWithSignal(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    label: string,
  ): Promise<Response> {
    const parts: AbortSignal[] = []
    if (signal) parts.push(signal)
    if (timeoutMs > 0) parts.push(AbortSignal.timeout(timeoutMs))
    const merged = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : AbortSignal.any(parts)
    try {
      return await fetch(url, { ...init, signal: merged })
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        throw new MineruError(`${label} 请求被中止`)
      }
      throw new MineruError(
        `${label} 连接失败: ${String(err?.message ?? err).slice(0, 160)}`,
        label.includes('本地') ? '请先启动 mineru-api 服务（或把 mineruMode 切为 cloud 并配置 key）' : undefined,
      )
    }
  }
}

function unpack(bytes: Uint8Array, label: string): Omit<MineruParseResult, 'source' | 'elapsedMs'> {
  const result = unpackMineruZip(bytes)
  if (!result.ok) {
    throw new MineruError(`${label} 结果解包失败: ${result.message}`)
  }
  return {
    md: result.md,
    imageFiles: result.files.filter((f) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.relPath)),
    mdChars: result.md.length,
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MineruError('被中止'))
    const t = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new MineruError('被中止'))
    }
    function done(): void {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
