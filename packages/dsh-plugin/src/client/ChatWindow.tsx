/**
 * dsh-zotero — 独立浮动文献聊天窗（M3.2 rev4）。
 *
 * 用户决策（rev4）：文献库历史通用（单实例）；单论文对话历史各自独立
 *   —— 每篇论文可开多个对话实例（seq 1..n），History 按论文分组；
 *   「+ 新建对话」= 当前论文开新实例；CoT 折叠小字显示（默认收起）。
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { CSS } from './theme'

const API = '/@dsh-external/dsh-zotero/api'
const OPEN_EVENT = 'dshz:chat-open'

async function apiGet(path: string, timeoutMs = 30000): Promise<any> {
  return (await fetch(`${API}${path}`, { signal: AbortSignal.timeout(timeoutMs) })).json()
}

async function apiPost(path: string, body: unknown, timeoutMs = 30000): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return res.json()
}

export interface ChatMsg {
  kind: 'user' | 'assistant' | 'tool'
  text: string
  reasoning?: string
  name?: string
  running?: boolean
  ok?: boolean
  at: number
}

interface ChatConv {
  kind: 'paper' | 'library'
  itemKey?: string
  title: string
  sessionId: string
  seq: number
  injectedAt: number
  at: number
}

interface ActiveSession {
  kind: 'paper' | 'library'
  itemKey?: string
  title: string
  sessionId: string
  seq: number
}

interface PaperChip {
  itemKey: string
  title: string
  mode: 'pdf' | 'meta'
}

interface ModelOption {
  provider: string
  model: string
  name: string
}

const PAPER_PILLS: Array<{ label: string; text: string }> = [
  { label: '概述', text: '请用中文概述这篇论文：核心问题、主要方法、关键结果（带数字）、作者解读。' },
  { label: '要点', text: '请列出这篇论文的 Key Points（每个要点 1-2 句，按重要性排序）。' },
  { label: '方法', text: '请详细说明论文的方法：公式/模型/实验设置，以及每一步的作用。' },
  { label: '局限', text: '请指出论文的局限（原文明确的 + 你的推断，并注明区分）。' },
  { label: '读全文', text: '请通读全文并给出结构化精读：一句话主线 + 章节要点 + 3 个可追问问题。' },
  { label: 'Diagram', text: '请列出论文中的主要图/表/公式：每张图说明其展示内容与结论，关键公式给出符号含义与作用（标明所在章节）。' },
]

const LIBRARY_PILLS: Array<{ label: string; text: string }> = [
  { label: '检索示例', text: '我库里有讲述业动力学/近场力学的论文吗？列出 5 篇并各用一句说明。' },
  { label: '库综述', text: '按方法类型分类总结本库文献，每类给出代表工作。' },
  { label: '收藏夹剖析', text: '我收藏夹里最近添加的论文讲了什么？按主题归纳并按重要性排序。' },
]

/** 纯精读/通读指令（无具体问题）→ 保持全文节选注入；带具体问题 → 检索召回。 */
function isPlainReadCommand(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.length < 12) return false
  return /(请)?(通读|精读|阅读).{0,24}(全文|论文|PDF)|结构化精读|Key Points|概述这篇论文|一句话主线/.test(t)
}

/** 浮窗打开请求（面板 dispatch / 本窗监听）。 */
export function dispatchChatOpen(detail:
  | { target: 'paper'; itemKey: string; title: string; sendRead?: boolean; parent?: string; cwd?: string; quote?: { page: number; text: string } }
  | { target: 'library'; parent?: string; cwd?: string }
): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail }))
}

export function ChatWindow(): JSX.Element {
  const [hidden, setHidden] = useState(true)
  const [booting, setBooting] = useState(false)
  const [note, setNote] = useState('')
  const [convs, setConvs] = useState<ChatConv[]>([])
  const [active, setActive] = useState<ActiveSession | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  /* 当前主会话工作目录（openPaper/openLibrary/send 传参用，保证 agent 工作区归属一致）。 */
  const [activeCwd, setActiveCwd] = useState('')
  /* @论文 引用 */
  const [chips, setChips] = useState<PaperChip[]>([])
  const [atOpen, setAtOpen] = useState(false)
  const [atQuery, setAtQuery] = useState('')
  const [atItems, setAtItems] = useState<Array<{ key: string; title: string; year?: number; itemType?: string }>>([])
  /* 模型选择 */
  const [models, setModels] = useState<ModelOption[]>([])
  const [currentModel, setCurrentModel] = useState('')
  const [modelBusy, setModelBusy] = useState(false)
  const msgsRef = useRef<HTMLDivElement | null>(null)
  const posRef = useRef({ x: 0, y: 0, drag: false, offX: 0, offY: 0 })
  const winRef = useRef<HTMLDivElement | null>(null)
  const atTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeSid = active?.sessionId ?? ''

  /* ── 打开/切换：面板按钮事件 ── */
  useEffect(() => {
    const onOpen = (ev: Event): void => {
      const detail = (ev as CustomEvent).detail as {
        target: string
        itemKey?: string
        title?: string
        sendRead?: boolean
        parent?: string
        cwd?: string
        quote?: { page: number; text: string }
      }
      setHidden(false)
      if (detail.cwd) setActiveCwd(detail.cwd)
      if (detail.target === 'paper' && detail.itemKey) {
        void (async () => {
          const sid = await openPaper(detail.itemKey!, detail.title ?? '', 0, detail.sendRead ?? false, detail.parent ?? '', detail.cwd ?? activeCwd)
          if (detail.quote && sid) {
            const quoteText = `> 📖 **【第 P${detail.quote.page} 页选段精读】**\n> ${detail.quote.text}\n\n请针对上述选段进行深度剖析：\n1. 核心论点与研究背景\n2. 关键公式/推导或实验方法解读\n3. 该选段在全篇论文中的承上启下意义`
            const chip: PaperChip = { itemKey: detail.itemKey!, title: detail.title || detail.itemKey!, mode: 'pdf' }
            void send(quoteText, [chip])
          }
        })()
      } else if (detail.target === 'library') {
        void openLibrary(detail.parent ?? '', detail.cwd ?? activeCwd)
      }
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── History 轮询（5s） ── */
  useEffect(() => {
    const load = (): void => {
      void apiGet('/chat-sessions').then((r) => setConvs(r.conversations ?? [])).catch(() => {})
    }
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  /* ── 消息轮询（1.2s） ── */
  useEffect(() => {
    if (!activeSid) { setMessages([]); return }
    const load = (): void => {
      void apiGet(`/chat-messages?sessionId=${encodeURIComponent(activeSid)}`).then((r) => setMessages(r.messages ?? [])).catch(() => {})
    }
    load()
    const t = setInterval(load, 1200)
    return () => clearInterval(t)
  }, [activeSid])

  /* ── 模型目录：失败自动重试（最多 3 次，间隔 2s×n）；浮窗打开时若仍空再拉一次 ── */
  const modelRetry = useRef(0)
  const loadModels = (): void => {
    void apiGet('/chat-models').then((r) => {
      const opts: ModelOption[] = []
      for (const p of r.providers ?? []) {
        for (const m of p.models ?? []) {
          opts.push({ provider: p.id, model: m.id, name: m.name || m.id })
        }
      }
      setModels(opts)
      const cur = r.current
      if (cur?.provider && cur?.model) setCurrentModel(`${cur.provider} / ${cur.model}`)
      modelRetry.current = 0
    }).catch(() => {
      if (modelRetry.current < 3) {
        modelRetry.current += 1
        setTimeout(loadModels, 2000 * modelRetry.current)
      }
    })
  }
  useEffect(() => {
    loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!hidden && models.length === 0 && currentModel === '') loadModels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden])

  /* 新消息 → 自动滚底（仅当用户接近底部）。 */
  useEffect(() => {
    const el = msgsRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 200
    if (near) el.scrollTop = el.scrollHeight
  }, [messages])

  /** 打开/新建论文对话实例：seq=0 → 新建（max+1）；seq>0 → 复用指定实例。返回 sessionId 或 null。 */
  async function openPaper(itemKey: string, title: string, seq: number, sendRead: boolean, parent: string, cwd: string): Promise<string | null> {
    setBooting(true)
    setNote('')
    try {
      const r = await apiPost('/chat-open', {
        itemKey, title,
        ...(seq > 0 ? { seq } : {}),
        sendRead, parent, cwd,
      }, 180000)
      setBooting(false)
      if (!r.ok) { setNote(`⚠️ ${r.error ?? '打开失败'}`); return null }
      setActive({ kind: 'paper', itemKey, title: title || itemKey, sessionId: r.sessionId, seq: r.seq ?? seq ?? 1 })
      setChips([{ itemKey, title: title || itemKey, mode: 'pdf' }])
      if (r.chars) setNote(`✅ 已载入论文上下文（${r.chars} 字符）。${sendRead ? '已发送精读指令，模型正在阅读…' : ''}`)
      await apiGet('/chat-sessions').then((x) => setConvs(x.conversations ?? [])).catch(() => {})
      return r.sessionId
    } catch (err: any) {
      setBooting(false)
      setNote(`⚠️ ${String(err?.message ?? err)}`)
      return null
    }
  }

  async function openLibrary(parent: string, cwd: string, seq = 0, fresh = false): Promise<string | null> {
    setBooting(true)
    setNote('')
    try {
      const r = await apiPost('/chat-open-library', {
        parent, cwd,
        ...(seq > 0 ? { seq } : {}),
        ...(fresh ? { fresh: true } : {}),
      }, 90000)
      setBooting(false)
      if (!r.ok) { setNote(`⚠️ ${r.error ?? '打开失败'}`); return null }
      setActive({ kind: 'library', title: '文献库对话', sessionId: r.sessionId, seq: r.seq ?? seq })
      setChips([])
      await apiGet('/chat-sessions').then((x) => setConvs(x.conversations ?? [])).catch(() => {})
      return r.sessionId
    } catch (err: any) {
      setBooting(false)
      setNote(`⚠️ ${String(err?.message ?? err)}`)
      return null
    }
  }

  /** 「+ 新建对话」：当前库会话 → 新建库实例；当前论文 → 新建论文实例；都无 → 提示。 */
  async function newChat(): Promise<void> {
    if (active?.kind === 'paper' && active.itemKey) {
      await openPaper(active.itemKey, active.title, 0, false, '', '')
    } else if (active?.kind === 'library') {
      await openLibrary('', '', 0, true)
    } else {
      setNote('ℹ️ 先选中一个对话（论文 或 文献库），再「+ 新建对话」开新对话。')
    }
  }

  /** 停止生成（保留排队，可再发消息继续）。 */
  async function stop(): Promise<void> {
    if (!active) return
    const r = await apiPost('/chat-cancel', { sessionId: active.sessionId })
    if (!r.ok) setNote(`⚠️ ${r.error ?? '停止失败'}`)
  }

  async function send(textArg?: string, chipsArg?: PaperChip[]): Promise<void> {
    const text = (textArg ?? input).trim()
    const useChips = chipsArg ?? chips
    if (!text || sending) return
    // 无激活会话：自动打开文献库会话再发（修复「输入无反应」——发送按钮曾因 !active 永久灰化）。
    let sid = active?.sessionId ?? ''
    let cwd = activeCwd
    if (!sid) {
      const opened = await openLibrary('', '', 0, false)
      if (!opened) { setNote('⚠️ 未选择会话，且自动打开文献库失败。请先点「文献库对话」或打开一篇论文。'); return }
      sid = opened
      cwd = activeCwd
    }
    setSending(true)
    setInput('')
    setAtOpen(false)
    const r = await apiPost('/chat-send', {
      sessionId: sid,
      text,
      ...(cwd ? { cwd } : {}),
      // rag=true：@论文引用且带具体问题时，host 走检索召回模式（zotero_retrieve 同管线）
      // 注入最相关章节证据而非全文头部截断；纯精读指令（mode=pdf 无问题）仍全文节选。
      rag: useChips.some((c) => c.mode === 'pdf') && !isPlainReadCommand(text),
      papers: useChips.map((c) => ({ itemKey: c.itemKey, mode: c.mode })),
    })
    setSending(false)
    if (!r.ok) setNote(`⚠️ ${r.error ?? '发送失败'}`)
  }

  /** @论文 chips 操作（原版：左键=发送 PDF；右键=切换 全文/检索）。 */
  function chipLeftClick(chip: PaperChip): void {
    const pdf = { ...chip, mode: 'pdf' as const }
    setChips((cs) => cs.map((c) => (c.itemKey === chip.itemKey ? { ...c, mode: 'pdf' } : c)))
    void send(`请阅读这篇论文（PDF 全文已附）：\n${chip.title}\n请给出结构化精读。`, [pdf])
  }

  function chipToggleMode(chip: PaperChip): void {
    setChips((cs) => cs.map((c) =>
      c.itemKey === chip.itemKey ? { ...c, mode: c.mode === 'pdf' ? 'meta' : 'pdf' } : c,
    ))
  }

  function chipRemove(chip: PaperChip): void {
    setChips((cs) => cs.filter((c) => c.itemKey !== chip.itemKey))
  }

  /* @ 弹层：防抖检索 */
  function onInputChange(v: string): void {
    setInput(v)
    const idx = v.lastIndexOf('@')
    if (idx >= 0 && v.length - idx <= 30) {
      const q = v.slice(idx + 1).split(/[\s@]/)[0]
      setAtOpen(true)
      setAtQuery(q)
      if (atTimer.current) clearTimeout(atTimer.current)
      atTimer.current = setTimeout(() => {
        void apiGet(`/paper-picker?q=${encodeURIComponent(q)}`).then((r) => {
          setAtItems(r.items ?? [])
          setAtOpen(true)
        }).catch(() => setAtItems([]))
      }, 300)
    } else {
      setAtOpen(false)
    }
  }

  function pickPaper(item: { key: string; title: string }): void {
    setChips((cs) => {
      if (cs.some((c) => c.itemKey === item.key)) return cs
      return [...cs, { itemKey: item.key, title: item.title || item.key, mode: 'meta' }]
    })
    const idx = input.lastIndexOf('@')
    setInput(idx >= 0 ? input.slice(0, idx) : input)
    setAtOpen(false)
    setAtQuery('')
    setAtItems([])
  }

  /* ── 模型选择 ── */
  async function onModelChange(val: string): Promise<void> {
    if (!active || !val) return
    const [provider, model] = val.split(' / ')
    if (!provider || !model) return
    setModelBusy(true)
    const r = await apiPost('/chat-select-model', { sessionId: active.sessionId, provider, model })
    setModelBusy(false)
    if (r.ok) {
      setCurrentModel(val)
      setNote('✅ 已切换模型（下一轮生效）')
    } else {
      setNote(`⚠️ ${r.error ?? '切换失败'}`)
    }
  }

  async function deleteConv(kind: 'paper' | 'library', itemKey?: string, seq?: number): Promise<void> {
    const r = await apiPost('/chat-history-delete', { kind, itemKey, seq: seq ?? 0 })
    setConvs(r.conversations ?? [])
    if (kind === 'library' && active?.kind === 'library') setActive(null)
    if (kind === 'paper' && active?.itemKey === itemKey && active?.seq === seq) {
      setActive(null)
      setChips([])
    }
  }

  /* ── 拖拽 ── */
  function startDrag(ev: ReactMouseEvent): void {
    const win = winRef.current
    if (!win) return
    const rect = win.getBoundingClientRect()
    posRef.current.drag = true
    posRef.current.offX = ev.clientX - rect.left
    posRef.current.offY = ev.clientY - rect.top
    const move = (e: MouseEvent): void => {
      if (!posRef.current.drag || !winRef.current) return
      winRef.current.style.left = `${e.clientX - posRef.current.offX}px`
      winRef.current.style.top = `${Math.max(8, e.clientY - posRef.current.offY)}px`
    }
    const up = (): void => {
      posRef.current.drag = false
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const isPaper = active?.kind === 'paper'
  const paperTitle = isPaper ? (active?.title ?? '') : (active ? '文献库对话' : '')
  const welcomeTip = isPaper ? '论文对话回答关于当前活跃论文的问题，模型将在提问前预加载论文上下文。' : '文献库对话回答全库问题：模型会用 zotero_* 工具检索、深读并给出有据可查的回答。'
  /* History 分组：library 单实例 + 按论文分组（组内按 seq 升序） */
  const libraryConvs = convs.filter((c) => c.kind === 'library').sort((a, b) => a.seq - b.seq)
  const paperGroups: Array<{ itemKey: string; title: string; items: ChatConv[] }> = []
  for (const c of convs) {
    if (c.kind !== 'paper' || !c.itemKey) continue
    let g = paperGroups.find((x) => x.itemKey === c.itemKey)
    if (!g) {
      g = { itemKey: c.itemKey, title: c.title, items: [] }
      paperGroups.push(g)
    }
    g.items.push(c)
  }
  for (const g of paperGroups) g.items.sort((a, b) => a.seq - b.seq)

  return (
    <div ref={winRef} className="dshz dshz-win" data-hidden={hidden ? '1' : '0'} style={{ left: 'auto', right: 16, top: 64, width: 680, height: 'min(70vh, 660px)' }}>
      <style>{CSS}</style>
      <div className="dshz-win-head" onMouseDown={startDrag}>
        <span style={{ fontSize: 13 }}>🧠</span>
        <b>Zotero 文献聊天</b>
        <span style={{ flex: 1 }} />
        <button className="dshz-btn" onClick={() => setHidden(true)} title="最小化">—</button>
        <button className="dshz-btn" onClick={() => setHidden(true)} title="关闭（会话保留）">✕</button>
      </div>
      {/* ── 顶栏：论文标题 + Paper/库 分段切换（原版样式） ── */}
      <div className="dshz-wt">
        <span className="dshz-ttl" title={paperTitle}>{paperTitle || '选择会话…'}</span>
        <div className="dshz-seg">
          <button
            className={isPaper ? 'on' : ''}
            onClick={() => {
              if (active?.kind === 'paper') return
              for (const g of paperGroups) { void openPaper(g.itemKey, g.title, 0, false, '', activeCwd); return }
            }}
          >Paper chat</button>
          <button
            className={active?.kind === 'library' ? 'on' : ''}
            onClick={() => { if (active?.kind === 'library') return; void openLibrary('', '') }}
          >文献库对话</button>
        </div>
      </div>
      <div className="dshz-win-body">
        {/* History 侧栏 */}
        <div className="dshz-win-side">
          <div style={{ padding: '5px 8px', borderBottom: '1px solid #262a30' }}>
            <button className="dshz-btn" style={{ width: '100%' }} onClick={() => void newChat()}>＋ 新建对话</button>
          </div>
          {/* 文献库对话分组（多实例） */}
          <div>
            <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--dshz-dim)', borderBottom: '1px solid #262a30', borderTop: '1px solid #262a30' }}>
              📚 文献库对话（{libraryConvs.length}）
            </div>
            {libraryConvs.length === 0 ? (
              <div className="side-item" onClick={() => void openLibrary('', activeCwd, 0, true)}>
                <span className="side-txt">💬 第1次（没有）— 点击新建</span>
              </div>
            ) : null}
            {libraryConvs.map((c) => (
              <div
                key={c.sessionId}
                className={`side-item ${active?.kind === 'library' && active.seq === c.seq ? 'on' : ''}`}
                onClick={() => void openLibrary('', activeCwd, c.seq, false)}
                title={`文献库对话 · 第${c.seq}次`}
              >
                <span className="side-txt">💬 第{c.seq}次 · {new Date(c.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                <button
                  className="side-del"
                  title="删除此对话（会话数据保留）"
                  onClick={(e) => { e.stopPropagation(); void deleteConv('library', undefined, c.seq) }}
                >🗑</button>
              </div>
            ))}
          </div>
          {paperGroups.map((g) => (
            <div key={g.itemKey}>
              <div style={{ padding: '4px 8px', fontSize: 10, color: 'var(--dshz-dim)', borderBottom: '1px solid #262a30', borderTop: '1px solid #262a30', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.title}>
                📄 {g.title.slice(0, 20)}{g.title.length > 20 ? '…' : ''}（{g.items.length}）
              </div>
              {g.items.map((c) => (
                <div
                  key={c.sessionId}
                  className={`side-item ${active?.kind === 'paper' && active.itemKey === g.itemKey && active.seq === c.seq ? 'on' : ''}`}
                  onClick={() => void openPaper(g.itemKey, c.title, c.seq, false, '', activeCwd)}
                  title={`${c.title} · 第${c.seq}次对话`}
                >
                  <span className="side-txt">💬 第{c.seq}次 · {new Date(c.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                  <button
                    className="side-del"
                    title="删除此对话（会话数据保留）"
                    onClick={(e) => { e.stopPropagation(); void deleteConv('paper', g.itemKey, c.seq) }}
                  >🗑</button>
                </div>
              ))}
            </div>
          ))}
          {paperGroups.length === 0 && libraryConvs.length === 0 ? (
            <div style={{ padding: '6px 8px', fontSize: 10.5, color: 'var(--dshz-dim)' }}>还没有对话 — 在右侧「Zotero」面板点开一篇论文，或点「＋ 新建对话」</div>
          ) : null}
        </div>
        {/* 会话主区 */}
        <div className="dshz-win-main">
          {booting ? <div className="dshz-banner ok" style={{ margin: 6 }}>⏳ 激活会话/加载上下文…</div> : null}
          {note ? <div className="dshz-banner ok" style={{ margin: 6 }}>{note}</div> : null}
          {/* @论文 chips 行 */}
          {chips.length > 0 ? (
            <div className="dshz-chips">
              {chips.map((c) => (
                <span
                  key={c.itemKey}
                  className="dshz-chip"
                  title="左键=发送 PDF 全文；右键=切换 全文/元数据；×=移除"
                  onClick={() => chipLeftClick(c)}
                  onContextMenu={(e) => { e.preventDefault(); chipToggleMode(c) }}
                >
                  📄 {c.title.slice(0, 26)}{c.title.length > 26 ? '…' : ''}
                  <span className="mode">{c.mode === 'pdf' ? '全文' : '元数据'}</span>
                  <button className="x" title="移除" onClick={(e) => { e.stopPropagation(); chipRemove(c) }}>×</button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="dshz-chat-msgs" ref={msgsRef}>
            {!active ? <div className="dshz-null">从左侧选择一个对话，或在面板中打开一篇论文</div> : null}
            {active && messages.length === 0 ? (
              <div className="dshz-welcome">
                <h2>Zotero 文献聊天</h2>
                <p>从这里开始，读懂论文的一切。</p>
                <p>{welcomeTip}</p>
                <p>内联上下文：文本、<b>@论文</b>（发消息自动附带；标签<b>左键</b>=发送 PDF、<b>右键</b>=切换全文/元数据）。</p>
              </div>
            ) : null}
            {messages.map((m, idx) => {
              if (m.kind === 'tool') {
                const icon = m.running ? '⏳' : m.ok === false ? '✗' : m.ok === true ? '✓' : '·'
                return (
                  <div key={idx} className="dshz-msg">
                    <div className="who">⚙ <b>{m.name}</b> {icon}{m.running ? ' …' : ''}</div>
                  </div>
                )
              }
              return (
                <div key={idx} className={`dshz-msg ${m.kind === 'user' ? 'user' : ''}`}>
                  <div className="who">{m.kind === 'user' ? '你' : '文献助手'}</div>
                  {m.kind === 'assistant' && m.reasoning ? (
                    <details className="dshz-cot">
                      <summary>💭 思考过程{m.running ? ' …' : ''}</summary>
                      <div className="dshz-cot-body">{m.reasoning}</div>
                    </details>
                  ) : null}
                  <div className={`bubble ${m.kind === 'assistant' && m.running ? 'run' : ''}`}>{m.text}</div>
                </div>
              )
            })}
          </div>
          <div className="dshz-pills">
            {(isPaper ? PAPER_PILLS : LIBRARY_PILLS).map((p) => (
              <button key={p.label} className="dshz-btn" disabled={!active || sending} onClick={() => void send(p.text)}>{p.label}</button>
            ))}
            {isPaper ? (
              <button className="dshz-btn" disabled={!active || sending} onClick={() => active && active.itemKey && void openPaper(active.itemKey, active.title, 0, false, '', '')}>重新载入全文</button>
            ) : null}
          </div>
          {/* 输入行（含 @ 弹层） */}
          <div className="dshz-inputrow">
            <div className="dshz-inputwrap">
              <input
                className="dshz-input"
                placeholder={isPaper ? `询问关于《${(active?.title ?? '').slice(0, 24)}…》的问题，@ 添加论文…` : '询问库内文献… @ 添加论文，Enter 发送'}
                value={input}
                disabled={!active}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) void send() }}
              />
              {atOpen ? (
                <div className="dshz-pop">
                  {atItems.length === 0 ? <div className="pop-item" style={{ color: 'var(--dshz-dim)' }}>{atQuery ? `未找到“${atQuery}”相关论文` : '输入关键词检索论文…'}</div> : null}
                  {atItems.map((it) => (
                    <div key={it.key} className="pop-item" onClick={() => pickPaper(it)}>
                      {it.title.slice(0, 60)}{it.title.length > 60 ? '…' : ''}
                      <div className="m">{it.itemType ?? ''}{it.year ? ` · ${it.year}` : ''}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <button className="dshz-btn primary" disabled={sending || !input.trim()} onClick={() => void send()}>
              {sending ? '…' : '发送'}
            </button>
            {messages.some((m) => m.running) ? (
              <button className="dshz-btn" onClick={() => void stop()} title="停止当前生成（保留队列）">■ 停止</button>
            ) : null}
          </div>
          {/* 模型行 */}
          <div className="dshz-model-row">
            <label>模型</label>
            <select
              value={currentModel}
              disabled={!active || models.length === 0 || modelBusy}
              onChange={(e) => void onModelChange(e.target.value)}
              title={models.length === 0 ? '模型目录加载中…（会自动重试）' : undefined}
            >
              {models.length === 0 && currentModel ? (
                <option value={currentModel}>{currentModel.split(' / ').pop()}</option>
              ) : null}
              {models.length === 0 && !currentModel ? <option value="">加载中…</option> : null}
              {models.map((m) => (
                <option key={`${m.provider}/${m.model}`} value={`${m.provider} / ${m.model}`}>
                  {m.name}{m.provider !== 'deepseek' ? ` (${m.provider})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  )
}
