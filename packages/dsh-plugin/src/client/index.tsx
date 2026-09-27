/**
 * @dsh-external/dsh-zotero — client 面板（conversation.view tab，React）。
 *
 * 库（检索/收藏夹/详情/PDF 内嵌预览/读全文/概述/开读直达）
 * · 产出物区 · 设置（MinerU 等，settings.json 热生效）。
 * 「开读」与「送入」都走 /inject-context & /start-read（host agent.inject/followup）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
import { CSS } from './theme'
import { ChatWindow, dispatchChatOpen } from './ChatWindow'
import { PdfReader } from './PdfReader'

/** ClientContext 需要的最小签名（sessions.create/list 见 dsh-api-session-controller/client）。 */
type ClientContext = {
  slots: SlotsService
  sessions: {
    create(opts?: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
    list: {
      getSnapshot(): { byId: Record<string, { cwd?: string }> }
    }
  }
}

export const inject = ['slots', 'sessions']

/** 浮动文献聊天窗的独立 React root（挂 document.body；不占面板 tab）。 */
let WIN_ROOT: Root | null = null
/** apply() 注入的 client sessions 服务（dispatch 时取父会话 cwd）。 */
let SESSIONS: ClientContext['sessions'] | null = null

/** 当前面板会话的 cwd（文献会话创建时作为 meta.cwd，persona 提示词变量需要）。 */
function currentCwd(sessionId: string): string {
  try {
    return SESSIONS?.list?.getSnapshot()?.byId?.[sessionId]?.cwd ?? ''
  } catch {
    return ''
  }
}

const API = '/@dsh-external/dsh-zotero/api'
/** 设置分组展开状态的 localStorage key。 */
const CFG_OPEN_KEY = 'dshz-cfg-open'
/** 构建标识（每轮改版递增；设置页可见，帮助识别浏览器是否加载新 bundle）。 */
export const BUILD_TAG = 'b19-action-bar-annotations'

async function apiGet(path: string): Promise<any> {
  return (await fetch(`${API}${path}`)).json()
}

async function apiPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return res.json()
}

interface TreeNode { key: string; name: string; depth: number; itemCount?: number }
interface RecentItem { key: string; title: string; itemType: string; year?: number }
interface Artifact { type: string; title: string; payload: string; at: string }

/** 设置折叠分组：0fr↔1fr 平滑开合（无测高、无抖动）；chevron 旋转由 .open 控制。 */
function Sec(props: { label: string; open: boolean; onToggle: () => void; children: ReactNode }): JSX.Element {
  return (
    <div className={`dshz-sec-card ${props.open ? 'open' : ''}`}>
      <div
        className="dshz-sec-head"
        role="button"
        tabIndex={0}
        onClick={props.onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            props.onToggle()
          }
        }}
      >
        <span className="chev">▸</span>
        <span className="lbl">{props.label}</span>
        <span className="hint">{props.open ? '收起' : '展开'}</span>
      </div>
      <div className="dshz-sec-body">
        <div className="inner">{props.children}</div>
      </div>
    </div>
  )
}

export function ZoteroPanel(props: { sessionId?: string } & Record<string, unknown>): JSX.Element {
  const [sessionId, setSessionId] = useState<string>(String(props.sessionId ?? ''))
  const [status, setStatus] = useState<Record<string, unknown> | null>(null)
  const [tab, setTab] = useState<'lib' | 'out' | 'cfg'>('lib')
  /** 面板整体收起：只留头部一行（露出主对话），点「展开」恢复。 */
  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [collectionKey, setCollectionKey] = useState('')
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [collections, setCollections] = useState<TreeNode[]>([])
  const [detail, setDetail] = useState<any>(null)
  const [busy, setBusy] = useState('')
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [form, setForm] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  /** MD 解析管理：overview 统计 / 批量任务 / 消息。 */
  const [mo, setMo] = useState<{ ok?: boolean; total: number; parsed: number; items: any[] } | null>(null)
  const [mj, setMj] = useState<{ state: string; total: number; done: number; current: string; errors: string[] } | null>(null)
  const [mgMsg, setMgMsg] = useState('')
  /** MinerU 配置分组内的测试连接结果。 */
  const [mguTestMsg, setMguTestMsg] = useState('')
  /** 阅读模式：{论文 key, 标题, PDF 附件 key}；非空时面板主体 = PDF 阅读器。 */
  const [reading, setReading] = useState<{ key: string; title: string; attachmentKey: string } | null>(null)
  /** 设置分组展开状态（localStorage 持久化）。 */
  const [openSec, setOpenSec] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(CFG_OPEN_KEY)
      if (raw) return { conn: true, ...JSON.parse(raw) }
    } catch { /* best-effort */ }
    return { conn: true, mineru: false, pdf2zh: false, mgu: false, read: false }
  })
  const sessionRef = useRef(props.sessionId)
  useEffect(() => {
    if (props.sessionId && props.sessionId !== sessionRef.current) {
      sessionRef.current = props.sessionId
      setSessionId(String(props.sessionId))
    }
  }, [props.sessionId])

  /** 设置分组开合（同步 localStorage）。 */
  function toggleSec(id: string): void {
    setOpenSec((s) => {
      const next = { ...s, [id]: !s[id] }
      try { localStorage.setItem(CFG_OPEN_KEY, JSON.stringify(next)) } catch { /* best-effort */ }
      return next
    })
  }
  function setAllSec(open: boolean): void {
    const next = { conn: open, mineru: open, pdf2zh: open, mgu: open, read: open }
    try { localStorage.setItem(CFG_OPEN_KEY, JSON.stringify(next)) } catch { /* best-effort */ }
    setOpenSec(next)
  }

  async function loadBasics(): Promise<void> {
    setBusy('连接检测…')
    try {
      const [v, tree] = await Promise.all([apiGet('/verify'), apiGet('/tree')])
      setStatus(v.health)
      setRecent((tree.recent ?? []).filter((i: RecentItem) => i.itemType !== 'attachment'))
      setCollections(tree.collections ?? [])
    } catch (err: any) {
      setNote(`加载失败: ${String(err?.message ?? err)}`)
    }
    setBusy('')
  }

  useEffect(() => {
    void loadBasics()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tab === 'out') void apiGet('/artifacts').then((r) => setArtifacts(r.artifacts ?? [])).catch(() => {})
    if (tab === 'cfg') {
      void apiGet('/config').then((r) => {
        setConfig(r ?? {})
        const f: Record<string, string> = {}
        for (const [k, v] of Object.entries(r ?? {})) {
          if (typeof v === 'object') continue
          if (String(v).startsWith('•••')) continue
          f[k] = String(v ?? '')
        }
        // MD 解析管理：统计 + 任务状态
        void apiGet('/mineru/overview').then((v) => setMo(v)).catch(() => {})
        void apiGet('/mineru/job').then((r) => setMj(r.job ?? null)).catch(() => {})
        setForm(f)
      }).catch(() => {})
    }
  }, [tab])

  /** MD 批量解析运行中：2s 轮询，结束后自动刷新统计。 */
  useEffect(() => {
    if (!mj || mj.state !== 'running') return
    const t = setInterval(() => {
      void apiGet('/mineru/job').then((r) => {
        setMj(r.job ?? null)
        if (r.job && r.job.state !== 'running') {
          clearInterval(t)
          void apiGet('/mineru/overview').then((v) => setMo(v)).catch(() => {})
        }
      }).catch(() => {})
    }, 2000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mj?.state])

  /** 检索（参数显式传入，避免 setState 闭包读到旧值）。 */
  async function runSearch(q: string, coll: string): Promise<void> {
    setBusy('检索…')
    try {
      const qs = new URLSearchParams()
      if (q.trim()) qs.set('q', q.trim())
      if (coll) qs.set('collection', coll)
      const tree = await apiGet(`/tree${qs.size ? `?${qs.toString()}` : ''}`)
      setRecent((tree.recent ?? []).filter((i: RecentItem) => i.itemType !== 'attachment'))
    } catch (err: any) {
      setNote(`检索失败: ${String(err?.message ?? err)}`)
    }
    setBusy('')
  }

  async function doSearch(): Promise<void> {
    await runSearch(query, collectionKey)
  }

  /** 点论文 → 整页进入 PDF 阅读模式（有 PDF 附件时）。 */
  async function openItem(key: string): Promise<void> {
    setBusy('打开条目…')
    try {
      const got = await apiGet(`/item?key=${encodeURIComponent(key)}`)
      setBusy('')
      setDetail(got)
      const pdf = (got.item?.attachments ?? []).find((a: any) => a.isPdf)
      if (pdf) {
        setReading({ key, title: got.item?.title ?? '', attachmentKey: pdf.key })
      }
    } catch (err: any) {
      setBusy('')
      setDetail({ error: String(err?.message ?? err) })
    }
  }

  /** 文献 CHAT → 文献聊天（M3.2：独立会话，不碰主对话；点开只注入全文，不自动发精读指令）。 */
  async function openReadChat(key: string, title: string): Promise<void> {
    dispatchChatOpen({ target: 'paper', itemKey: key, title, parent: sessionId, cwd: currentCwd(sessionId) })
    setNote(`💬 已打开《${title.slice(0, 30)}…》的文献 Chat（全文已注入）——在浮窗里点快捷操作或直接提问即可。`)
  }

  async function saveConfig(): Promise<void> {
    setBusy('保存设置…')
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(form)) {
      if (String(v) === String(config[k] ?? '')) continue
      if (v === '') {
        // 秘钥留空=不改（沿用）；其它字段允许清空。
        if (['localApiKey', 'webApiKey', 'mineruCloudApiKey', 'pdf2zhApiKey'].includes(k)) continue
      }
      patch[k] = v
    }
    const r = await apiPost('/config', patch)
    setBusy('')
    if (r.ok) {
      setConfig(r.config ?? {})
      setNote('✅ 设置已保存并热生效（MinerU/端口等下次调用即用新值；重载插件后依然保留）。')
    } else {
      setNote(`❌ ${r.error ?? '保存失败'}`)
    }
  }

  const detailItem = detail?.item
  const dot = status ? (status.ok ? '#2ecc71' : '#e6a23c') : '#e74c3c'
  const statusText = status
    ? status.ok
      ? `已连接 Zotero（${String(status.source ?? '')}）`
      : `未连接 — ${String(status.hint ?? '').slice(0, 50)}`
    : '检测中…'

  const field = (key: string, label: string, kind: 'text' | 'password' | 'number' = 'text') => {
    const val = form[key] ?? ''
    const isSecret = kind === 'password'
    return (
      <div className="dshz-field" key={key}>
        <label>{label}</label>
        <input
          className="dshz-input"
          type={kind}
          value={val}
          placeholder={isSecret && (config as any)[key] ? '••• 已设置，留空不改' : ''}
          onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        />
      </div>
    )
  }

  return (
    <div className={`dshz${collapsed ? ' collapsed' : ''}`} style={{ background: 'var(--dshz-panel)' }} data-dshz-root>
      <style>{CSS}</style>
      <div className="dshz-h">
        <span className="dot" style={{ background: dot }} />
        <b>Zotero</b>
        <span className="st" title={statusText}>{statusText}</span>
        <button
          className="dshz-btn"
          title={collapsed ? '展开面板' : '收起面板（只留这一行）'}
          onClick={() => setCollapsed((c) => !c)}
        >{collapsed ? '▸ 展开' : '▾ 收起'}</button>
        {!collapsed ? (
          <>
            <button
              className="dshz-btn primary"
              onClick={() => {
                if (reading) void openReadChat(reading.key, reading.title)
                else if (detailItem?.key) void openReadChat(String(detailItem.key), String(detailItem.title ?? ''))
                else setNote('⚠️ 请先选中一篇论文（点开条目进入阅读），或直接使用「文献库 CHAT」。')
              }}
            >📄 文献 CHAT</button>
            <button className="dshz-btn" onClick={() => void dispatchChatOpen({ target: 'library', parent: sessionId, cwd: currentCwd(sessionId) })}>📚 文献库 CHAT</button>
            <button className="dshz-btn" onClick={() => void loadBasics()}>刷新</button>
          </>
        ) : null}
      </div>
      <div className="dshz-tabs" style={reading ? { display: 'none' } : undefined}>
        <div className={`dshz-tab ${tab === 'lib' ? 'on' : ''}`} onClick={() => setTab('lib')}>库</div>
        <div className={`dshz-tab ${tab === 'out' ? 'on' : ''}`} onClick={() => setTab('out')}>产出物 ({artifacts.length})</div>
        <div className={`dshz-tab ${tab === 'cfg' ? 'on' : ''}`} onClick={() => setTab('cfg')}>设置</div>
      </div>
      <div className="dshz-b">
        <div key={tab} className="dshz-fade">
        {busy ? <div className="dshz-banner ok"><span className="dshz-spin" />{busy}</div> : null}
        {note ? (
          <div className="dshz-banner ok">
            <span style={{ minWidth: 0, overflow: 'hidden' }}>{note}</span>
            <button className="dshz-banner-x" onClick={() => setNote('')} title="关闭">×</button>
          </div>
        ) : null}
        {tab === 'lib' && (
          <>
            {reading ? (
              /* ── 沉浸阅读：正文 + PdfReader 工具行占满；退出/回列表在工具行上 ── */
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="dshz-pdf-wrap">
                  <PdfReader attachmentKey={reading.attachmentKey} itemKey={reading.key} title={reading.title} onBack={() => setReading(null)} />
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input
                    className="dshz-input"
                    placeholder="检索标题/作者/标签/全文…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void doSearch() }}
                  />
                  <button className="dshz-btn primary" onClick={() => void doSearch()}>检索</button>
                </div>
                <select
                  className="dshz-sel"
                  style={{ marginBottom: 6 }}
                  value={collectionKey}
                  onChange={(e) => {
                    const v = e.target.value
                    setCollectionKey(v)
                    void runSearch(query, v)
                  }}
                >
                  <option value="">全部收藏夹</option>
                  {collections.map((c) => (
                    <option key={c.key} value={c.key}>
                      {'│ '.repeat(Math.min(c.depth, 8))}{c.name} ({c.itemCount ?? '?'})
                    </option>
                  ))}
                </select>
                <div className="dshz-note" style={{ marginBottom: 6 }}>
                  点击条目 = 进入 PDF 阅读（列页面切换）；无 PDF 的条目显示详情卡；「开读」一键唤起 Chat 精读。
                </div>
                {recent.length === 0 && <div className="dshz-null">暂无数据 — 点右上「刷新」</div>}
                {recent.map((i) => (
                  <div className="dshz-row" key={i.key} onClick={() => void openItem(i.key)}>
                    <div className="t">{i.title || '(无标题)'}</div>
                    <div className="m">
                      <span className="dshz-badge">{i.itemType}</span>
                      {i.year ? <span>{i.year}</span> : null}
                    </div>
                  </div>
                ))}
                {detail && (
                  <div className="dshz-row" style={{ cursor: 'default', background: '#1e232a' }}>
                    {detail.loading ? <div className="dshz-null">加载条目…</div> : !detailItem ? (
                      <div className="dshz-null">{String(detail.error ?? '加载失败')}</div>
                    ) : (
                      <>
                        <div className="t">{detailItem.title || '(无标题)'}</div>
                        <div className="dshz-kv" style={{ marginTop: 6, lineHeight: 1.7 }}>
                          {detailItem.creators?.length ? (
                            <div>作者：<b>{detailItem.creators.map((c: any) => c.fullName).join(', ')}</b></div>
                          ) : null}
                          {(detailItem.year || detailItem.publicationTitle || detailItem.doi) ? (
                            <div>
                              {detailItem.year ? <b>{detailItem.year}</b> : null}
                              {detailItem.publicationTitle ? ` · ${detailItem.publicationTitle}` : ''}
                              {detailItem.doi ? ` · DOI ${detailItem.doi}` : ''}
                            </div>
                          ) : null}
                          {detailItem.tags?.length ? <div>标签：{detailItem.tags.join(', ')}</div> : null}
                          {detailItem.abstractNote ? (
                            <div style={{ maxHeight: 96, overflow: 'auto' }}>
                              摘要：{detailItem.abstractNote.slice(0, 900)}
                            </div>
                          ) : null}
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {detailItem.attachments?.length ? (
                            <div className="dshz-note" style={{ marginTop: 8 }}>
                              附件 {detailItem.attachments.length}：
                              {detailItem.attachments.map((a: any) => (
                                <span
                                  key={a.key}
                                  className={`dshz-badge ${a.isPdf ? 'pdf' : ''}`}
                                  style={a.isPdf ? { cursor: 'pointer' } : undefined}
                                  title={a.isPdf ? '面板内预览' : undefined}
                                  onClick={a.isPdf ? () => setReading({ key: detailItem.key, title: detailItem.title || '', attachmentKey: a.key }) : undefined}
                                >
                                  {String(a.title ?? '').slice(0, 26)}{a.isPdf ? ' · PDF▶' : ''}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        {detail.summary ? (
                          <div className="dshz-note" style={{ marginTop: 8, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                            {detail.summary}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                )}
              </>
            )}
            </>
          )}
        {tab === 'out' && (
          <>
            {artifacts.length === 0 ? <div className="dshz-null">暂无产出物 — 读全文/概述后自动沉淀在这里</div> : null}
            {artifacts.map((a, idx) => (
              <div className="dshz-row" key={`${a.at}-${idx}`} style={{ cursor: 'default' }}>
                <div className="m">
                  <span className={`dshz-badge ${a.type === 'summary' ? 'summary' : ''}`}>{a.type}</span>
                  <span>{String(a.at).slice(0, 16).replace('T', ' ')}</span>
                </div>
                <div className="t">{a.title}</div>
                <div className="dshz-kv" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
                  {String(a.payload ?? '').slice(0, 600)}
                </div>
                <button
                  className="dshz-btn"
                  onClick={() => void navigator.clipboard.writeText(String(a.payload ?? '')).catch(() => {})}
                >
                  复制
                </button>
              </div>
            ))}
            {artifacts.length ? (
              <button className="dshz-btn" onClick={() => void apiPost('/artifacts/clear', {}).then((x) => setArtifacts(x.artifacts ?? []))}>清空产出物</button>
            ) : null}
          </>
        )}
        {tab === 'cfg' && (
          <>
            <div className="dshz-note" style={{ marginBottom: 6 }}>
              保存即热生效（写入 <code>settings.json</code>，重启/重载后依然保留；秘钥留空 = 不改）。
              分组可折叠，展开状态自动记住。 <span style={{ opacity: 0.7 }}>· build {BUILD_TAG}</span>
            </div>
            <div className="dshz-sec-tools">
              <button onClick={() => setAllSec(true)}>全部展开</button>
              <button onClick={() => setAllSec(false)}>全部收起</button>
            </div>
            <Sec label="Zotero 连接" open={!!openSec.conn} onToggle={() => toggleSec('conn')}>
            {field('localApiPort', '本地 API 端口（Zotero httpServer，默认 23119）', 'number')}
            {field('localApiKey', '本地 API Key（开启密钥认证时填写）', 'password')}
            {field('webUserId', 'Web API userId（桌面关闭时降级，可留空）')}
            {field('webApiKey', 'Web API Key', 'password')}
            {field('storageDir', '存储目录（可选，PDF 直读兜底）')}
            {field('searchLimit', '检索默认条数', 'number')}
            </Sec>
            <Sec label="MinerU 解析" open={!!openSec.mineru} onToggle={() => toggleSec('mineru')}>
            <div className="dshz-field">
              <label>后端模式</label>
              <select className="dshz-sel" value={form.mineruMode ?? 'local'} onChange={(e) => setForm((f) => ({ ...f, mineruMode: e.target.value }))}>
                <option value="local">本地 mineru-api（127.0.0.1:8000）</option>
                <option value="cloud">云端 mineru.net（需 API Key）</option>
              </select>
            </div>
            {(form.mineruMode ?? 'local') === 'local' ? (
              <>
                {field('mineruLocalApiBase', '本地 MinerU 服务地址')}
                <div className="dshz-field">
                  <label>本地后端引擎</label>
                  <select className="dshz-sel" value={form.mineruLocalBackend ?? 'pipeline'} onChange={(e) => setForm((f) => ({ ...f, mineruLocalBackend: e.target.value }))}>
                    <option value="pipeline">pipeline</option>
                    <option value="vlm">vlm（vlm-auto-engine）</option>
                    <option value="hybrid">hybrid（hybrid-auto-engine）</option>
                  </select>
                </div>
              </>
            ) : null}
            {(form.mineruMode ?? 'local') === 'cloud' ? (
              <>
                {field('mineruCloudApiKey', 'MinerU 云端 API Key', 'password')}
                <div className="dshz-field">
                  <label>云端模型</label>
                  <select className="dshz-sel" value={form.mineruCloudModel ?? 'vlm'} onChange={(e) => setForm((f) => ({ ...f, mineruCloudModel: e.target.value }))}>
                    <option value="vlm">vlm（默认）</option>
                    <option value="pipeline">pipeline</option>
                  </select>
                </div>
              </>
            ) : null}
            <div className="dshz-field" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="dshz-btn"
                onClick={() => {
                  setMguTestMsg('')
                  void apiPost('/mineru/test', {})
                    .then((r) => setMguTestMsg(`🔌 ${String(r.message ?? (r.ok ? '连接正常' : '连接失败'))}`))
                    .catch((e) => setMguTestMsg(`测试失败: ${String(e?.message ?? e)}`))
                }}
                title="按上方「后端模式」选择测试本地或云端"
              >测试连接</button>
              {mguTestMsg ? <span className="dshz-kv" style={{ color: mguTestMsg.startsWith('🔌 连接失败') ? '#FF8B84' : undefined }}>{mguTestMsg}</span> : null}
            </div>
            <div className="dshz-field">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={form.mineruForceOcr === 'true'} onChange={(e) => setForm((f) => ({ ...f, mineruForceOcr: String(e.target.checked) }))} />
                强制 OCR
              </label>
            </div>
            {field('mineruMaxAutoPages', '自动解析页数上限（daemon/后台）', 'number')}
            </Sec>
            <Sec label="MD 解析管理" open={!!openSec.mgu} onToggle={() => toggleSec('mgu')}>
              <div className="dshz-note" style={{ marginBottom: 8 }}>
                管理 MinerU 解析产物：统计库内 PDF 解析状态；「全部开始」批量解析未解析论文，
                「修复缓存」强制重解析全部、「删除所有缓存」清空。解析结果存本地 <code>cache/mineru/</code>。
              </div>
              <div className="dshz-field">
                <label>库内解析进度</label>
                <div className="dshz-ft-progress" style={{ marginBottom: 4 }}>
                  <div className="fill" style={{ width: `${mo && mo.total > 0 ? Math.round((mo.parsed / mo.total) * 100) : 0}%` }} />
                </div>
                <div className="dshz-kv">{mo ? `已解析 ${mo.parsed} / ${mo.total} 篇` : '统计中…'}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                <button className="dshz-btn" onClick={() => { setMgMsg(''); void apiPost('/mineru/test', {}).then((r) => setMgMsg(`🔌 ${String(r.message ?? (r.ok ? '连接正常' : '连接失败'))}`)).catch((e) => setMgMsg(`测试失败: ${String(e?.message ?? e)}`)) }}>测试连接</button>
                {mj?.state === 'running' ? (
                  <button className="dshz-btn" onClick={() => void apiPost('/mineru/cancel', {}).then(() => setMgMsg('已请求取消'))}>取消进度（{mj.done}/{mj.total ?? '?'}）</button>
                ) : (
                  <>
                    <button className="dshz-btn primary" onClick={() => { setMgMsg(''); void apiPost('/mineru/start', {}).then((r) => { setMj(r.job); if (!r.ok) setMgMsg(`⚠ ${r.error ?? '启动失败'}`) }).catch((e) => setMgMsg(String(e?.message ?? e))) }}>全部开始</button>
                    <button className="dshz-btn" onClick={() => { if (!window.confirm('强制重解析全部论文（含已有缓存的）？耗时较长。')) return; void apiPost('/mineru/start', { repair: true }).then((r) => { setMj(r.job); if (!r.ok) setMgMsg(`⚠ ${r.error ?? '启动失败'}`) }).catch((e) => setMgMsg(String(e?.message ?? e))) }}>修复缓存</button>
                    <button className="dshz-btn" onClick={() => { if (!window.confirm('删除全部 MD 解析缓存？之后将重新解析。')) return; void apiPost('/mineru/clear', {}).then(async () => { setMgMsg('🗑 缓存已清空'); const v = await apiGet('/mineru/overview'); setMo(v) }).catch(() => {}) }}>删除所有缓存</button>
                  </>
                )}
              </div>
              {mj?.state === 'running' || mj?.state === 'cancelled' || mj?.state === 'done' ? (
                <div className="dshz-note" style={{ marginBottom: 6 }}>
                  {mj.state === 'running' ? `运行中：${mj.done}/${mj.total} · ${mj.current?.slice(0, 40) ?? ''}` : mj.state === 'cancelled' ? '已取消' : `完成：${mj.done}/${mj.total}${mj.errors?.length ? `（${mj.errors.length} 个错误）` : ''}`}
                </div>
              ) : null}
              {mj?.errors?.length ? <div className="dshz-note" style={{ color: '#FF8B84', marginBottom: 6 }}>{mj.errors.slice(0, 3).join('；')}</div> : null}
              {mgMsg ? <div className="dshz-note" style={{ marginBottom: 6 }}>{mgMsg}</div> : null}
              {mo ? (
                <div style={{ maxHeight: 240, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {mo.items.slice(0, 40).map((i) => (
                    <div key={i.key} className="dshz-row" style={{ cursor: 'default', padding: '8px 11px', marginBottom: 0 }}>
                      <div className="t" style={{ fontSize: 12.5 }}>{i.title}</div>
                      <div className="m">
                        <span className={`dshz-badge ${i.parsed ? 'summary' : ''}`}>{i.parsed ? '已解析' : '未解析'}</span>
                        {i.parsed && i.sizeKb ? <span>{i.sizeKb}KB</span> : null}
                        {i.parsed && i.source ? <span style={{ opacity: 0.7 }}>{String(i.source).slice(0, 26)}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </Sec>
            <Sec label="PDF2ZH 翻译引擎（一键全文）" open={!!openSec.pdf2zh} onToggle={() => toggleSec('pdf2zh')}>
              <div className="dshz-note" style={{ marginBottom: 8 }}>
                一键「全文翻译」调用 pdf2zh 官方 CLI（uv tool install --python 3.12 pdf2zh），
                产出双语 PDF（原文+译文同页）。翻译使用 OpenAI 兼容接口（如 DeepSeek：https://api.deepseek.com/v1）。
              </div>
              {field('pdf2zhBaseUrl', 'OpenAI 兼容 Base URL')}
              {field('pdf2zhApiKey', 'LLM API Key（如 DeepSeek）', 'password')}
              {field('pdf2zhModel', '模型名（如 deepseek-chat）')}
              {field('pdf2zhThreads', '翻译线程数', 'number')}
            </Sec>
            <Sec label="精读" open={!!openSec.read} onToggle={() => toggleSec('read')}>
            {field('fullTextTokenBudget', '单次全文 token 预算', 'number')}
            {field('translateTargetLang', '划词翻译目标语言（如 zh / en）')}
            {field('cacheDir', '缓存目录（留空=默认）')}
            <div className="dshz-field">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={form.ragEnabled === 'true'} onChange={(e) => setForm((f) => ({ ...f, ragEnabled: String(e.target.checked) }))} />
                RAG 库级检索（M4，先保持关）
              </label>
            </div>
            <div className="dshz-field">
              <label>概述 prompt 覆盖（留空=默认）</label>
              <textarea className="dshz-input" rows={3} value={form.summaryPrompt ?? ''} onChange={(e) => setForm((f) => ({ ...f, summaryPrompt: e.target.value }))} />
            </div>
            <div className="dshz-field">
              <label>翻译 prompt 覆盖</label>
              <textarea className="dshz-input" rows={3} value={form.translatePrompt ?? ''} onChange={(e) => setForm((f) => ({ ...f, translatePrompt: e.target.value }))} />
            </div>
            <div className="dshz-field">
              <label>开读/精读指引 prompt 覆盖（注入式）</label>
              <textarea className="dshz-input" rows={3} value={form.chatWithPdfPrompt ?? ''} onChange={(e) => setForm((f) => ({ ...f, chatWithPdfPrompt: e.target.value }))} />
            </div>
            </Sec>
            <button className="dshz-btn primary" style={{ marginTop: 4 }} onClick={() => void saveConfig()}>保存设置（热生效）</button>
          </>
        )}
        </div>
        </div>
      </div>
  )
}

export function apply(ctx: ClientContext): void {
  SESSIONS = ctx.sessions
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: '@dsh-external/dsh-zotero-panel',
            order: 80,
            label: () => 'Zotero',
            inject: (sessionId: unknown) => ({ sessionId: String(sessionId ?? '') }),
          },
          ZoteroPanel,
        ),
      ),
    '@dsh-external/dsh-zotero: panel',
  )

  // 浮动文献聊天窗：独立 React root（不占面板 tab；关闭=隐藏、会话保留）。
  ctx.effect(() => {
    const host = document.createElement('div')
    host.setAttribute('data-dshz-chat-window', '')
    document.body.appendChild(host)
    WIN_ROOT = createRoot(host)
    WIN_ROOT.render(<ChatWindow />)
    return () => {
      try { WIN_ROOT?.unmount() } catch { /* best-effort */ }
      WIN_ROOT = null
      host.remove()
    }
  }, '@dsh-external/dsh-zotero: chat window')
}
