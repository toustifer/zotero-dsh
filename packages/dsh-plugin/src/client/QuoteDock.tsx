/**
 * 输入框上方的选段卡：Zotero 阅读器里刚「送入 DSH」的那一段。
 *
 * 两件事：
 *   1. 让用户看见自己刚送了什么（host 端注入会话上下文在 DSH 里只是折叠的一行）
 *   2. **自动**把引用追加进草稿，而不是等用户再点一次
 *
 * setDraft 是 DSH 唯一一个"把外部文本写进输入框"的公开接口
 * （conversation.input.dock 的 SessionStandardProps 注入 inputActions）。
 * 它的契约是无条件替换整份草稿，不看 phase，所以这里不设任何前置门槛。
 *
 * 追加而非覆盖：用户可能已经写了一半问题。× 会把自己加的那段拿回来。
 */
import { useEffect, useRef, useState } from 'react'
import { API } from './api'

interface LatestQuote {
  page: string
  text: string
  ask: boolean
  at: number
  title: string
}

interface DockProps {
  sessionId: string
  useInput: (selector: (state: { draft: string; phase: string }) => unknown) => unknown
  inputActions: { setDraft: (text: string) => void }
}

/** 轮询间隔：Zotero 是另一个进程，没有推送通道，只能拉。 */
const POLL_MS = 2000

/** 引用块正文；也用于判断草稿里是不是已经有这一段。 */
function quoteBlock(quote: LatestQuote): string {
  const body = quote.text.replace(/\s+/g, ' ').trim()
  const head = quote.page ? `> [Zotero 选段 · 第 ${quote.page} 页]` : '> [Zotero 选段]'
  return `${head}\n> ${body}`
}

export function QuoteDock({ sessionId, useInput, inputActions }: DockProps) {
  const draft = String(useInput((s) => s?.draft) ?? '')
  const [quote, setQuote] = useState<LatestQuote | null>(null)
  const applied = useRef(0)
  const seenAt = useRef(0)
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    if (!sessionId) return
    let alive = true
    const load = async () => {
      try {
        const r = await fetch(`${API}/quote/latest?sessionId=${encodeURIComponent(sessionId)}`)
        const j = (await r.json()) as { quote?: LatestQuote | null }
        if (!alive) return
        const next = j?.quote ?? null
        if (next && next.at !== seenAt.current) {
          seenAt.current = next.at
          setQuote(next)
        }
      } catch {
        /* host 没起来时静默重试 */
      }
    }
    void load()
    const t = window.setInterval(load, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [sessionId])

  // 送进来就附进草稿 —— 这才是"选中即引用"。只在每条新选段上做一次，
  // 且草稿里已经有这段时不再重复追加。
  useEffect(() => {
    if (!quote || applied.current === quote.at) return
    const marker = quote.text.replace(/\s+/g, ' ').trim().slice(0, 60)
    const current = draftRef.current
    if (marker && current.replace(/\s+/g, ' ').includes(marker)) {
      applied.current = quote.at
      return
    }
    inputActions.setDraft([current, quoteBlock(quote)].filter(Boolean).join('\n\n'))
    applied.current = quote.at
  }, [quote, inputActions])

  if (!quote) return null

  const body = quote.text.replace(/\s+/g, ' ').trim()
  const attached = applied.current === quote.at

  const onDetach = () => {
    // 把自己加的那一段从草稿里摘掉，别动用户自己写的部分。
    const block = quoteBlock(quote)
    const next = draftRef.current.split(block).join('').replace(/\n{3,}/g, '\n\n').trim()
    inputActions.setDraft(next)
    applied.current = 0
    setQuote(null)
  }

  return (
    <div className="dshz-quote-dock">
      <div className="dshz-quote-head">
        <span className="dshz-quote-tag">Zotero 选段{quote.page ? ` · 第 ${quote.page} 页` : ''}</span>
        {quote.title ? <span className="dshz-quote-src" title={quote.title}>{quote.title}</span> : null}
        <span className="dshz-quote-state">{attached ? '已附到输入框' : '正在附…'}</span>
        <button type="button" className="dshz-quote-x" aria-label="从输入框移除这段引用" title="从输入框移除" onClick={onDetach}>×</button>
      </div>
      <div className="dshz-quote-body" title={quote.text}>{body}</div>
    </div>
  )
}

/** 组件自带的样式，不依赖宿主 CSS 变量之外的任何东西。 */
export const QUOTE_DOCK_CSS = `
.dshz-quote-dock{margin:0 12px 6px;padding:8px 10px;border-radius:8px;background:rgba(64,114,229,.10);border-inline-start:3px solid #4072e5;font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;}
.dshz-quote-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}
.dshz-quote-tag{font-weight:600;font-size:11px;opacity:.85;white-space:nowrap;}
.dshz-quote-src{flex:1 1 auto;min-width:0;font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshz-quote-state{flex:0 0 auto;font-size:10.5px;opacity:.6;white-space:nowrap;}
.dshz-quote-x{flex:0 0 auto;font:12px system-ui;padding:0 4px;border:0;background:transparent;color:inherit;opacity:.5;cursor:pointer;}
.dshz-quote-x:hover{opacity:.9;}
.dshz-quote-body{font-size:11.5px;opacity:.8;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
`
