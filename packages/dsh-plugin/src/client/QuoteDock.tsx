/**
 * Composer 上方的选段卡：Zotero 阅读器里刚「送入 DSH」的那一段。
 *
 * 为什么需要它：host 端的 /quote 把选段注入了会话上下文，但那在 DSH 里只是一条
 * 折叠的「上下文注入」行，用户看不出来自己刚送了什么。这里把同一段话摆到输入框
 * 正上方，点一下经 inputActions.setDraft 追加进草稿 ——
 * 那是 DSH 唯一一个"把外部文本写进草稿"的公开接口，语义等同 VSCode 聊天里的
 * "Add to Chat"：只加引用，不替你发送。
 *
 * 挂在 conversation.input.dock（list 槽），多个插件共存，不抢任何人的位置。
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

export function QuoteDock({ sessionId, useInput, inputActions }: DockProps) {
  const draft = String(useInput((s) => s?.draft) ?? '')
  const phase = String(useInput((s) => s?.phase) ?? '')
  const [quote, setQuote] = useState<LatestQuote | null>(null)
  const [attachedAt, setAttachedAt] = useState(0)
  const seenAt = useRef(0)

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
          setAttachedAt(0)
          setQuote(next)
        } else if (!next) {
          setQuote(null)
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

  if (!quote) return null

  const normalized = quote.text.replace(/\s+/g, ' ').trim()
  const attached = attachedAt === quote.at && draft.replace(/\s+/g, ' ').includes(normalized.slice(0, 60))
  const canAttach = phase === 'plain' && !attached

  const onAttach = () => {
    // 追加而不是覆盖：用户可能已经写了一半问题。
    inputActions.setDraft([draft, `> [Zotero 选段${quote.page ? ` · 第 ${quote.page} 页` : ''}]\n> ${normalized}`].filter(Boolean).join('\n\n'))
    setAttachedAt(quote.at)
  }

  return (
    <div className="dshz-quote-dock">
      <div className="dshz-quote-head">
        <span className="dshz-quote-tag">Zotero 选段{quote.page ? ` · 第 ${quote.page} 页` : ''}</span>
        {quote.title ? <span className="dshz-quote-src" title={quote.title}>{quote.title}</span> : null}
        <button
          type="button"
          className="dshz-quote-btn"
          disabled={!canAttach}
          title={attached ? '已附到你正在写的问题' : '把这段引用追加到输入框'}
          onClick={onAttach}
        >
          {attached ? '已附到问题' : '附到问题'}
        </button>
        <button type="button" className="dshz-quote-x" aria-label="忽略这段选段" onClick={() => setQuote(null)}>×</button>
      </div>
      <div className="dshz-quote-body" title={quote.text}>{normalized}</div>
    </div>
  )
}

/** 组件自带的样式，避免依赖宿主 CSS 变量之外的任何东西。 */
export const QUOTE_DOCK_CSS = `
.dshz-quote-dock{margin:0 12px 6px;padding:8px 10px;border-radius:8px;background:rgba(64,114,229,.10);border-inline-start:3px solid #4072e5;font:12px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;}
.dshz-quote-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}
.dshz-quote-tag{font-weight:600;font-size:11px;opacity:.85;white-space:nowrap;}
.dshz-quote-src{flex:1 1 auto;min-width:0;font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshz-quote-btn{flex:0 0 auto;font:11px system-ui;padding:2px 8px;border-radius:5px;border:1px solid rgba(64,114,229,.5);background:transparent;color:inherit;cursor:pointer;}
.dshz-quote-btn:disabled{opacity:.5;cursor:default;}
.dshz-quote-x{flex:0 0 auto;font:12px system-ui;padding:0 4px;border:0;background:transparent;color:inherit;opacity:.5;cursor:pointer;}
.dshz-quote-body{font-size:11.5px;opacity:.8;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
`
