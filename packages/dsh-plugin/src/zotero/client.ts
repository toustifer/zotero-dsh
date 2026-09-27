/**
 * dsh-zotero — Zotero API client (Local API primary, Web API fallback).
 *
 * Local API   : http://<host>:<port> on the Zotero desktop HTTP server
 *               (Zotero 7/8, loopback-trusted by default, no key required).
 * Web API     : https://api.zotero.org/users/<userId> (Bearer key) — used
 *               only when the desktop is unreachable AND credentials exist.
 *
 * Both speak the same v3 JSON; responses are normalized into zotero/types.
 * This layer never throws for domain outcomes (offline, empty, not found):
 * those are canonical values. Transport faults are surfaced as ZoteroApiError
 * only for programming errors (bad base, malformed response).
 */
import type { Config } from '../config.ts'
import type {
  ZoteroAttachment,
  ZoteroCollection,
  ZoteroCreator,
  ZoteroHealthResult,
  ZoteroItemDetail,
  ZoteroItemSummary,
  ZoteroSearchParams,
  ZoteroSource,
} from './types.ts'

const FULLTEXT_QMODE = 'everything'

/** 工具返回值必须是 lossless JSON：递归删除 undefined/NaN/非 JSON 值（防工具校验失败）。 */
export function cleanJson<T>(value: T): T {
  if (value === undefined) return undefined as unknown as T
  if (typeof value === 'number' && !Number.isFinite(value)) return null as unknown as T
  if (typeof value === 'bigint') return String(value) as unknown as T
  if (value instanceof Date) return value.toISOString() as unknown as T
  if (Array.isArray(value)) return value.map((v) => cleanJson(v)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k] = cleanJson(v)
    }
    return out as unknown as T
  }
  return value
}

/** 按声明字段裁剪（dsh-tools schema 校验 strict：未声明属性会被拒）。 */
export function pickFields<T>(value: T, keys: readonly string[]): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    if (Object.hasOwn(value, k)) out[k] = (value as Record<string, unknown>)[k]
  }
  return out as unknown as T
}

const HINT_LOCAL_API_DISABLED =
  'Zotero 正在运行但本地 API 未开启（Zotero 9+ 默认关闭）。开启方法：Zotero → Settings（设置）→ Advanced（高级）→ 打开「Config Editor（配置编辑器）」→ 搜索 httpServer.localAPI.enabled → 双击/设为 true；部分版本直接在 Advanced 有「Enable Local API」勾选框。开启后无需重启即可使用；或不开启，改在插件设置里配置 Web API userId/apiKey 以启用降级。'

export class ZoteroApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'ZoteroApiError'
  }
}

export interface ZoteroClientOptions {
  config: Config
  /** Tool-level abort signal (exec.signal) — merged with the request timeout. */
  signal?: AbortSignal
}

interface RawItem {
  key: string
  version: number
  data: Record<string, any>
  library?: { type: string; id: number; name?: string }
  meta?: { numChildren?: number; numNotes?: number; numCollections?: number }
}

interface RawCollection {
  key: string
  version: number
  data: {
    key: string
    name: string
    parentCollection?: string
    childCollections?: string[]
  }
  meta?: { numItems?: number }
}

function firstYear(date?: string): number | undefined {
  if (!date) return undefined
  const m = /(1[89]\d{2}|20\d{2})/.exec(date)
  return m ? Number(m[1]) : undefined
}

function fullName(c: Partial<ZoteroCreator>): string {
  if (c.name) return c.name
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || '(unknown)'
}

function normalizeCreator(raw: any): ZoteroCreator {
  const firstName = typeof raw?.firstName === 'string' ? raw.firstName : ''
  const lastName = typeof raw?.lastName === 'string' ? raw.lastName : ''
  const name = typeof raw?.name === 'string' ? raw.name : ''
  return {
    creatorType: typeof raw?.creatorType === 'string' ? raw.creatorType : 'author',
    firstName,
    lastName,
    name: name || undefined,
    fullName: fullName({ firstName, lastName, name }) as string,
  }
}

function normalizeTags(raw: any): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((t: any) => (t && typeof t.tag === 'string' ? t.tag : ''))
    .filter((t: string) => t !== '')
}

function toSummary(item: RawItem, source: ZoteroSource): ZoteroItemSummary {
  const d = item.data ?? {}
  const creators = Array.isArray(d.creators) ? d.creators.map(normalizeCreator) : []
  const collections = Array.isArray(d.collections) ? d.collections : []
  return {
    key: item.key,
    version: item.version ?? 0,
    itemType: typeof d.itemType === 'string' ? d.itemType : 'unknown',
    title: typeof d.title === 'string' ? d.title : '',
    creators,
    date: typeof d.date === 'string' ? d.date : '',
    year: firstYear(typeof d.date === 'string' ? d.date : undefined),
    abstractNote: typeof d.abstractNote === 'string' ? d.abstractNote : '',
    doi: typeof d.DOI === 'string' ? d.DOI : '',
    url: typeof d.url === 'string' ? d.url : '',
    publicationTitle: typeof d.publicationTitle === 'string' ? d.publicationTitle : '',
    journalAbbreviation:
      typeof d.journalAbbreviation === 'string' ? d.journalAbbreviation : '',
    extra: typeof d.extra === 'string' ? d.extra : '',
    tags: normalizeTags(d.tags),
    collections,
    numChildren:
      typeof item.meta?.numChildren === 'number' ? item.meta.numChildren : 0,
    numNotes: typeof item.meta?.numNotes === 'number' ? item.meta.numNotes : 0,
    dateAdded: typeof d.dateAdded === 'string' ? d.dateAdded : '',
    dateModified:
      typeof item.data?.dateModified === 'string'
        ? item.data.dateModified
        : typeof d.dateModified === 'string'
          ? d.dateModified
          : '',
    library: item.library
      ? { type: item.library.type, id: item.library.id, name: item.library.name }
      : { type: 'user', id: 0 },
    source,
  }
}

function toCollection(raw: RawCollection, depth: number): ZoteroCollection {
  const parent = raw.data?.parentCollection
  return {
    key: raw.key,
    name: raw.data?.name ?? '',
    parentKey: typeof parent === 'string' && parent !== '' ? parent : null,
    itemCount: typeof raw.meta?.numItems === 'number' ? raw.meta.numItems : undefined,
    depth,
  }
}

interface JsonFetchResult {
  status: number
  ok: boolean
  json: any
  total: number
  headers: Headers
}

/** zotero_library_search / zotero_get_item 的 item 总结字段集（与工具 output schema 对齐）。 */
const ITEM_SUMMARY_FIELDS = [
  'key', 'version', 'itemType', 'title', 'creators', 'date', 'year', 'abstractNote',
  'doi', 'url', 'publicationTitle', 'journalAbbreviation', 'extra', 'tags', 'collections',
  'numChildren', 'numNotes', 'dateAdded', 'dateModified', 'library', 'source',
] as const

const CREATOR_FIELDS = ['creatorType', 'firstName', 'lastName', 'name', 'fullName'] as const

export class ZoteroClient {
  private cfg: Config
  /** Zotero-Server-ID cached from the last response (writes must echo it). */
  private serverId: string | null = null

  constructor(private readonly opts: ZoteroClientOptions) {
    this.cfg = opts.config
  }

  /** Hot-applied config (runtime overlay); subsequent calls see it. */
  updateConfig(cfg: Config): void {
    this.cfg = cfg
  }

  /** The Zotero-Server-ID observed from the server (null until first response). */
  getServerId(): string | null {
    return this.serverId
  }

  /** Local API base URL, e.g. http://127.0.0.1:23119 */
  localBase(): string {
    return `http://${this.cfg.localApiHost}:${this.cfg.localApiPort}`
  }

  /** A client scoped to an additional abort signal (per tool call). */
  scoped(signal?: AbortSignal): ZoteroClient {
    if (!signal) return this
    return new ZoteroClient({ config: this.cfg, signal })
  }

  private webUserId(): string | undefined {
    const id = this.cfg.webUserId.trim()
    return id ? id : undefined
  }

  private webBase(userId: string): string {
    return `https://api.zotero.org/users/${encodeURIComponent(userId)}`
  }

  private mergeSignal(): AbortSignal | undefined {
    const parts: AbortSignal[] = []
    if (this.opts.signal) parts.push(this.opts.signal)
    parts.push(AbortSignal.timeout(this.cfg.requestTimeoutMs))
    return parts.length === 1 ? parts[0] : AbortSignal.any(parts)
  }

  private async fetchJson(url: string, headers: Record<string, string>): Promise<JsonFetchResult> {
    let res: Response
    try {
      res = await fetch(url, {
        headers,
        signal: this.mergeSignal(),
      })
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (msg.includes('abort') || msg.includes('timeout') || err?.name === 'AbortError') {
        throw new ZoteroApiError(
          `请求超时（${this.cfg.requestTimeoutMs}ms）: ${url}`,
          undefined,
          'Zotero 响应超时。若库很大请减小 limit 重试；桌面端繁忙时稍后重试。',
        )
      }
      throw new ZoteroApiError(
        `无法连接 Zotero: ${msg}`,
        undefined,
        'Zotero Desktop 未运行，或 HTTP server 未开启（Zotero > 设置 > 高级 > 文件与文件夹 > HTTP server；或首选项同步）。',
      )
    }
    const text = await res.text()
    // Zotero 9+ 在响应里给稳定的服务器 ID；写请求必须携带（M4 使用）。
    const serverId = res.headers.get('Zotero-Server-ID')
    if (serverId) this.serverId = serverId
    let json: any = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        // 本地 API 关闭时返回 text/plain 403（「Local API is not enabled」）等，
        // 这是领域状态而不是数据损坏——给出精确指引。
        if (
          res.status === 403 &&
          /local api is not enabled/i.test(text)
        ) {
          throw new ZoteroApiError('Local API is not enabled in Zotero', 403, HINT_LOCAL_API_DISABLED)
        }
        throw new ZoteroApiError(
          `Zotero 返回非 JSON 响应 (HTTP ${res.status})${text ? `: ${text.slice(0, 120)}` : ''}`,
          res.status,
        )
      }
    }
    const totalHeader = res.headers.get('Total-Results')
    const total = totalHeader ? Number(totalHeader) : Array.isArray(json) ? json.length : 0
    if (!res.ok) {
      const message =
        typeof json?.error?.message === 'string'
          ? json.error.message
          : `HTTP ${res.status}${text && text.length < 200 ? `: ${text}` : ''}`
      throw new ZoteroApiError(
        message,
        res.status,
        res.status === 403 || res.status === 401
          ? 'Zotero 拒绝了凭据：请检查 localApiKey（或 Web API key/apiKey 配置）。'
          : undefined,
      )
    }
    return { status: res.status, ok: true, json, total, headers: res.headers }
  }

  private localHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Zotero-API-Version': '3' }
    if (this.cfg.localApiKey) {
      headers['Authorization'] = `Bearer ${this.cfg.localApiKey}`
      headers['Zotero-API-Key'] = this.cfg.localApiKey
    }
    if (this.serverId) headers['Zotero-Server-ID'] = this.serverId
    return headers
  }

  private webHeaders(): Record<string, string> {
    return { 'Zotero-API-Version': '3', Authorization: `Bearer ${this.cfg.webApiKey}` }
  }

  /** Resolve an attachment's on-disk path (file:// redirect → local path). */
  async resolveAttachmentPath(attachmentKey: string): Promise<string | null> {
    const src = await this.resolveSource().catch(() => null)
    if (!src) return null
    try {
      const res = await fetch(
        `${src.base}${src.libraryPath}/items/${encodeURIComponent(attachmentKey)}/file`,
        {
          headers: src.headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(Math.max(this.cfg.requestTimeoutMs, 15_000)),
        },
      )
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('Location')
        if (location?.startsWith('file://')) {
          const filePath = fileUrlToWindowsPath(location)
          const { existsSync } = await import('node:fs')
          return existsSync(filePath) ? filePath : null
        }
      }
      return null
    } catch {
      return null
    }
  }

  /** Fetch an attachment's raw file bytes (GET /items/{key}/file). */
  async fetchFile(
    attachmentKey: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const src = await this.resolveSource().catch(() => null)
    if (!src) return null
    try {
      const res = await fetch(
        `${src.base}${src.libraryPath}/items/${encodeURIComponent(attachmentKey)}/file`,
        {
          headers: src.headers,
          redirect: 'manual',
          signal: (() => {
            const parts: AbortSignal[] = []
            if (signal) parts.push(signal)
            parts.push(AbortSignal.timeout(Math.max(this.cfg.requestTimeoutMs, 30_000)))
            return parts.length === 1 ? parts[0] : AbortSignal.any(parts)
          })(),
        },
      )
      const serverId = res.headers.get('Zotero-Server-ID')
      if (serverId) this.serverId = serverId
      // Zotero 9+ local API answers file GETs with 302 → file://<storage path>
      // (the intended local-consumer channel). Node fetch cannot follow
      // file:// redirects, so resolve it to a local disk read ourselves.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('Location')
        if (location && location.startsWith('file://')) {
          const filePath = fileUrlToWindowsPath(location)
          const { readFileSync, existsSync } = await import('node:fs')
          if (existsSync(filePath)) {
            const bytes = new Uint8Array(readFileSync(filePath))
            const fileName = location.split('/').pop()?.split('?')[0] ?? `${attachmentKey}.pdf`
            return { bytes, fileName: decodeURIComponent(fileName) }
          }
        }
        return null
      }
      if (!res.ok) return null
      const bytes = new Uint8Array(await res.arrayBuffer())
      const cd = res.headers.get('content-disposition') ?? ''
      const m = /filename="?([^";]+)"?/i.exec(cd)
      const fileName = m?.[1] ?? `${attachmentKey}.pdf`
      return { bytes, fileName }
    } catch {
      return null
    }
  }

  /** Probe both sources; returns which is usable (fast path for tools). */
  async health(): Promise<ZoteroHealthResult> {
    const start = Date.now()
    // Local probe: any 2xx on the items endpoint proves the API is enabled.
    try {
      const r = await this.fetchJson(
        `${this.localBase()}/api/users/0/items?limit=1&format=json`,
        this.localHeaders(),
      )
      return {
        ok: true,
        source: 'local',
        localBase: this.localBase(),
        webUserId: this.webUserId() ?? '',
        latencyMs: Date.now() - start,
        error: '',
        hint: '',
      }
    } catch (err: any) {
      const localErr = err instanceof ZoteroApiError ? err : new ZoteroApiError(String(err))
      const userId = this.webUserId()
      if (userId && this.cfg.webApiKey) {
        try {
          await this.fetchJson(`${this.webBase(userId)}/items?limit=1&format=json`, this.webHeaders())
          return {
            ok: true,
            source: 'web',
            localBase: this.localBase(),
            webUserId: userId,
            latencyMs: Date.now() - start,
            error: '',
            hint: '',
          }
        } catch (webErr: any) {
          return {
            ok: false,
            source: 'none',
            localBase: this.localBase(),
            webUserId: userId,
            latencyMs: Date.now() - start,
            error: `local: ${localErr.message}; web: ${webErr instanceof ZoteroApiError ? webErr.message : String(webErr)}`,
            hint: localErr.hint ?? webErr?.hint ?? '',
          }
        }
      }
      return {
        ok: false,
        source: 'none',
        localBase: this.localBase(),
        webUserId: '',
        latencyMs: Date.now() - start,
        error: localErr.message,
        hint: localErr.hint ?? '',
      }
    }
  }

  /** Pick the working source: local first, web fallback when configured. */
  private async resolveSource(): Promise<{ source: 'local' | 'web'; base: string; headers: Record<string, string>; libraryPath: string }> {
    const local = await this.tryLocal()
    if (local) return local
    const userId = this.webUserId()
    if (userId && this.cfg.webApiKey) {
      return {
        source: 'web',
        base: this.webBase(userId),
        headers: this.webHeaders(),
        libraryPath: `/users/${encodeURIComponent(userId)}`,
      }
    }
    throw new ZoteroApiError(
      'Zotero Local API 不可达且未配置 Web API 降级凭据',
      undefined,
      '请启动 Zotero（并开启 HTTP server），或在设置中配置 Web API userId/apiKey 以启用降级。',
    )
  }

  private async tryLocal(): Promise<{ source: 'local'; base: string; headers: Record<string, string>; libraryPath: string } | null> {
    try {
      await this.fetchJson(
        `${this.localBase()}/api/users/0/items?limit=1&format=json`,
        this.localHeaders(),
      )
      return {
        source: 'local',
        base: this.localBase(),
        headers: this.localHeaders(),
        libraryPath: '/api/users/0',
      }
    } catch {
      return null
    }
  }

  private buildItemsPath(path: string, params: Record<string, string | number | undefined>): string {
    // 手工 encodeURIComponent（避免 URLSearchParams 的 `+`/大小写差异——Zotero 本地 API
    // 对中文 query 有解析兼容问题；显式百分号编码最稳）。
    const parts: string[] = ['format=json']
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') parts.push(`${k}=${encodeURIComponent(String(v))}`)
    }
    return `${path}/items?${parts.join('&')}`
  }

  /** 枚举库内全部附件（itemType=attachment 翻页），返回 key/title/parentItem。 */
  async listAttachments(): Promise<Array<{ key: string; title: string; parentItem: string }>> {
    const src = await this.resolveSource().catch(() => null)
    if (!src) return []
    const out: Array<{ key: string; title: string; parentItem: string }> = []
    let start = 0
    for (let guard = 0; guard < 30; guard += 1) {
      const r = await this.fetchJson(
        this.buildItemsPath(`${src.base}${src.libraryPath}`, { itemType: 'attachment', limit: 100, start }),
        src.headers,
      )
      const rows: Array<{ key?: string; title?: string; parentItem?: string }> = Array.isArray(r.json) ? r.json : []
      for (const it of rows) {
        if (it.key) out.push({ key: it.key, title: it.title ?? '', parentItem: it.parentItem ?? '' })
      }
      if (rows.length < 100 || out.length >= Number(r.total ?? 0)) break
      start += 100
    }
    return out
  }

  /** Search items across the library (metadata + optional fulltext). */
  async search(params: ZoteroSearchParams): Promise<{
    source: ZoteroSource
    total: number
    items: ZoteroItemSummary[]
    library: string
    error: string
    hint: string
    qmode: string
  }> {
    const src = await this.resolveSource().catch((err: ZoteroApiError) => {
      return {
        source: 'none' as const,
        total: 0,
        items: [],
        library: '',
        error: err.message,
        hint: err.hint ?? '',
        qmode: params.qmode ?? 'titleCreatorYear',
      }
    })
    if (src.source === 'none') return src

    const qmode = params.qmode ?? 'titleCreatorYear'
    const limit = Math.max(1, Math.min(100, params.limit ?? this.cfg.searchLimit))
    const query: Record<string, string | number | undefined> = {
      q: params.query,
      qmode,
      tag: params.tag,
      itemType: params.itemType,
      sort: params.sort,
      direction: params.direction,
      limit,
      start: params.start,
    }
    try {
      // Zotero API 的收藏夹过滤走 /collections/{key}/items（items?collection= 不是
      // 官方过滤参数，实测被忽略）。q/qmode/tag 等仍可组合传递。
      // 注意 buildItemsPath 会统一追加 /items，这里传"库根"。
      const basePath = params.collectionKey
        ? `${src.base}${src.libraryPath}/collections/${encodeURIComponent(params.collectionKey)}`
        : `${src.base}${src.libraryPath}`
      const r = await this.fetchJson(
        this.buildItemsPath(basePath, query),
        src.headers,
      )
      const items = (Array.isArray(r.json) ? r.json : []).map((i: RawItem) =>
        pickFields(toSummary(i, src.source), ITEM_SUMMARY_FIELDS),
      )
      return cleanJson({
        source: src.source,
        total: r.total,
        items,
        library: `${src.source} (${src.libraryPath})`,
        error: '',
        hint: '',
        qmode,
      })
    } catch (err: any) {
      const e = err instanceof ZoteroApiError ? err : new ZoteroApiError(String(err))
      return {
        source: src.source,
        total: 0,
        items: [],
        library: `${src.source} (${src.libraryPath})`,
        error: e.message,
        hint: e.hint ?? '',
        qmode,
      }
    }
  }

  /** Fetch one item with all children (attachments / notes / annotations). */
  async getItem(key: string): Promise<{
    found: boolean
    source: ZoteroSource
    item: ZoteroItemDetail | null
    error: string
    hint: string
  }> {
    const src = await this.resolveSource().catch((err: ZoteroApiError) => ({
      found: false,
      source: 'none' as const,
      item: null,
      error: err.message,
      hint: err.hint ?? '',
    }))
    if (src.source === 'none') return src
    try {
      const itemRes = await this.fetchJson(
        `${src.base}${src.libraryPath}/items/${encodeURIComponent(key)}?format=json`,
        src.headers,
      )
      const childRes = await this.fetchJson(
        `${src.base}${src.libraryPath}/items/${encodeURIComponent(key)}/children?format=json&limit=100`,
        src.headers,
      )
      const summary = toSummary(itemRes.json as RawItem, src.source)
      const children: RawItem[] = Array.isArray(childRes.json) ? childRes.json : []
      const attachments: ZoteroAttachment[] = []
      const notes: { key: string; note: string; title: string }[] = []
      const annotations: { key: string; annotationText: string; annotationComment: string; color: string; pageLabel?: string }[] = []
      for (const child of children) {
        const d = child.data ?? {}
        if (d.itemType === 'attachment') {
          const contentType = typeof d.contentType === 'string' ? d.contentType : ''
          const isPdf = contentType === 'application/pdf'
          attachments.push({
            key: child.key,
            title: typeof d.title === 'string' ? d.title : '',
            contentType,
            linkMode: typeof d.linkMode === 'string' ? d.linkMode : '',
            filename:
              typeof d.filename === 'string'
                ? d.filename
                : typeof d.title === 'string'
                  ? d.title
                  : undefined,
            downloadPath: `${src.libraryPath}/items/${encodeURIComponent(child.key)}/file`,
            isPdf,
          })
        } else if (d.itemType === 'note') {
          const note = typeof d.note === 'string' ? d.note : ''
          notes.push({
            key: child.key,
            note,
            title: note.replace(/<[^>]+>/g, '').trim().slice(0, 80) || '(empty note)',
          })
        } else if (d.itemType === 'annotation') {
          annotations.push({
            key: child.key,
            annotationText: typeof d.annotationText === 'string' ? d.annotationText : '',
            annotationComment:
              typeof d.annotationComment === 'string' ? d.annotationComment : '',
            color: typeof d.color === 'string' ? d.color : '',
            pageLabel:
              typeof d.pageLabel === 'string' || typeof d.pageLabel === 'number'
                ? String(d.pageLabel)
                : undefined,
          })
        }
      }
      return cleanJson({
        found: true,
        source: src.source,
        item: {
          ...pickFields(summary, ITEM_SUMMARY_FIELDS),
          attachments: attachments.map((a) => pickFields(a, ['key', 'title', 'contentType', 'linkMode', 'filename', 'downloadPath', 'isPdf'] as const)),
          notes: notes.map((n) => pickFields(n, ['key', 'note', 'title'] as const)),
          annotations: annotations.map((an) => pickFields(an, ['key', 'annotationText', 'annotationComment', 'color', 'pageLabel'] as const)),
        },
        error: '',
        hint: '',
      })
    } catch (err: any) {
      const e = err instanceof ZoteroApiError ? err : new ZoteroApiError(String(err))
      return {
        found: false,
        source: src.source,
        item: null,
        error: e.status === 404 ? `条目不存在: ${key}` : e.message,
        hint: e.hint ?? '',
      }
    }
  }

  /** Create items (e.g. annotations, notes) in Zotero via POST /items */
  async createItems(items: Array<Record<string, unknown>>): Promise<{
    ok: boolean
    source: ZoteroSource
    successKeys: string[]
    failed: Record<string, unknown>
    error: string
    hint: string
    raw: unknown
  }> {
    const src = await this.resolveSource().catch((err: ZoteroApiError) => ({
      source: 'none' as const,
      base: '',
      headers: {} as Record<string, string>,
      libraryPath: '',
      error: err.message,
      hint: err.hint ?? '',
    }))
    if (src.source === 'none') {
      return {
        ok: false,
        source: 'none',
        successKeys: [],
        failed: {},
        error: (src as any).error || 'Zotero source unavailable',
        hint: (src as any).hint || '',
        raw: null,
      }
    }
    const url = `${src.base}${src.libraryPath}/items`
    const headers = {
      ...src.headers,
      'Content-Type': 'application/json',
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(items),
        signal: this.mergeSignal(),
      })
      const text = await res.text()
      const serverId = res.headers.get('Zotero-Server-ID')
      if (serverId) this.serverId = serverId
      let json: any = null
      if (text) {
        try {
          json = JSON.parse(text)
        } catch {
          // non-json response
        }
      }
      if (!res.ok) {
        return {
          ok: false,
          source: src.source,
          successKeys: [],
          failed: json?.failed ?? {},
          error: json?.message || `HTTP ${res.status}${text ? `: ${text.slice(0, 180)}` : ''}`,
          hint: res.status === 403 ? 'Zotero 拒绝了写入请求（检查 localApiKey 或权限）' : '',
          raw: json,
        }
      }
      const successKeys: string[] = []
      if (json?.successful && typeof json.successful === 'object') {
        for (const val of Object.values(json.successful)) {
          if ((val as any)?.key) successKeys.push(String((val as any).key))
        }
      } else if (json?.success && typeof json.success === 'object') {
        for (const key of Object.values(json.success)) {
          if (typeof key === 'string') successKeys.push(key)
        }
      }
      return {
        ok: true,
        source: src.source,
        successKeys,
        failed: json?.failed ?? {},
        error: '',
        hint: '',
        raw: json,
      }
    } catch (err: any) {
      return {
        ok: false,
        source: src.source,
        successKeys: [],
        failed: {},
        error: String(err?.message ?? err),
        hint: '连接 Zotero 异常',
        raw: null,
      }
    }
  }

  /** List collections and build the hierarchy tree. */
  async collections(): Promise<{
    source: ZoteroSource
    total: number
    tree: ZoteroCollection[]
    error: string
    hint: string
  }> {
    const src = await this.resolveSource().catch((err: ZoteroApiError) => ({
      source: 'none' as const,
      total: 0,
      tree: [],
      error: err.message,
      hint: err.hint ?? '',
    }))
    if (src.source === 'none') return src
    try {
      const raw: RawCollection[] = []
      let start = 0
      let total = 0
      const pageSize = 100
      for (let guard = 0; guard < 10; guard += 1) {
        const r = await this.fetchJson(
          `${src.base}${src.libraryPath}/collections?format=json&limit=${pageSize}&start=${start}`,
          src.headers,
        )
        const page = Array.isArray(r.json) ? (r.json as RawCollection[]) : []
        raw.push(...page)
        total = r.total
        if (page.length < pageSize || raw.length >= total) break
        start += page.length
      }
      // Build tree: parentKey → children, walk from roots.
      const byKey = new Map(raw.map((c) => [c.key, toCollection(c, 0)]))
      const childrenOf = new Map<string, string[]>()
      for (const c of raw) {
        const parent = c.data?.parentCollection
        if (typeof parent === 'string' && parent) {
          if (!childrenOf.has(parent)) childrenOf.set(parent, [])
          childrenOf.get(parent)!.push(c.key)
        }
      }
      const ordered: ZoteroCollection[] = []
      const visit = (key: string | null, depth: number) => {
        const kids = key === null
          ? raw.filter((c) => !(typeof c.data?.parentCollection === 'string') || !byKey.has(c.data.parentCollection)).map((c) => c.key)
          : (childrenOf.get(key) ?? [])
        for (const k of kids) {
          const node = byKey.get(k)
          if (!node) continue
          ordered.push({ ...node, depth })
          visit(k, depth + 1)
        }
      }
      visit(null, 0)
      return cleanJson({
        source: src.source,
        total,
        tree: ordered,
        error: '',
        hint: '',
      })
    } catch (err: any) {
      const e = err instanceof ZoteroApiError ? err : new ZoteroApiError(String(err))
      return {
        source: src.source,
        total: 0,
        tree: [],
        error: e.message,
        hint: e.hint ?? '',
      }
    }
  }

  /** True when the configured fulltext qmode is supported by the source. */
  static supportsFulltext(): boolean {
    return true
  }

  static readonly FULLTEXT_QMODE = FULLTEXT_QMODE
}

/** file:///C:/Users/... → C:\Users\... (Windows) or /Users/... (POSIX). */
function fileUrlToWindowsPath(location: string): string {
  const url = new URL(location)
  const raw = decodeURIComponent(url.pathname)
  if (/^\/[A-Za-z]:\//.test(raw)) return raw.slice(1).replace(/\//g, '\\')
  if (raw.startsWith('/')) return raw.replace(/\//g, process.platform === 'win32' ? '\\' : '/')
  return raw
}
