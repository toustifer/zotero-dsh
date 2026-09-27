/**
 * 输入栏的选段附件：Zotero 阅读器里刚「送入 DSH」的那一段，作为一个附件 chip，
 * 而不是铺在输入框正文里。
 *
 * 走的是 DSH 自己的草稿附件通道：
 *   ctx.conversation.createDrafts(sessionId, [File])  →  造运行时 draft 附件
 *   inputActions.addAttachments(ids)                  →  挂到附件栏
 * 非图片文件会走 background 上传，所以这段引用随后在会话里是一个真实可读的附件，
 * 不是一段需要模型自己解析的正文。chip 上只显示文件名与体量，正文收在附件里。
 *
 * addAttachments 不可用时退回 setDraft，至少不丢东西。
 */
import { useEffect, useRef, useState } from 'react'
import { API } from './api'

interface QuoteLocator {
  pageLabel?: string
  pageIndex?: number | null
  totalPages?: number | null
  lines?: number | null
  yTop?: number | null
  yBottom?: number | null
  lineHeight?: number | null
  xLeft?: number | null
  xRight?: number | null
  rects?: number[][] | null
  sortIndex?: string
}

interface LatestQuote {
  page: string
  text: string
  ask: boolean
  at: number
  title: string
  itemKey?: string
  locator?: QuoteLocator | null
}

interface DockProps {
  sessionId: string
  useInput: (selector: (state: { draft: string; phase: string }) => unknown) => unknown
  inputActions: {
    setDraft: (text: string) => void
    addAttachments: (ids: readonly unknown[]) => boolean
  }
}

/** 轮询间隔：Zotero 是另一个进程，没有推送通道，只能拉。 */
const POLL_MS = 2000

/** 引用块正文；退回 setDraft 时用。 */
function quoteBlock(quote: LatestQuote): string {
  const body = quote.text.replace(/\s+/g, ' ').trim()
  const head = quote.page ? `> [Zotero 选段 · 第 ${quote.page} 页]` : '> [Zotero 选段]'
  return `${head}\n> ${body}`
}

/** 附件文件名：短、可辨识，带页码。 */
function fileName(quote: LatestQuote): string {
  const stem = (quote.title || 'zotero').replace(/[\\/:*?"<>|]/g, '').slice(0, 48).trim() || 'zotero'
  return `${stem}${quote.page ? `-p${quote.page}` : ''}.md`
}

/**
 * 附件正文：自带出处与位置。
 *
 * Zotero 的注解**没有行号** —— 它给的是「页 + 一组 PDF 点矩形」，每个矩形正好覆盖
 * 一行。所以这里用三个可复现的量替代行号：页码、选区跨的行数、页内纵向区间；
 * 原始矩形也原样留在末尾，需要精确复现时用它。
 */
function fileBody(quote: LatestQuote): string {
  const loc = quote.locator || {}
  const pageNo = typeof loc.pageIndex === 'number' ? loc.pageIndex + 1 : null
  const pageText = pageNo
    ? `第 ${pageNo} 页${loc.pageLabel && loc.pageLabel !== String(pageNo) ? `（原书标注 ${loc.pageLabel}）` : ''}`
    : quote.page
      ? `第 ${quote.page} 页`
      : ''

  const meta: string[] = []
  if (quote.title) meta.push(`- 论文：${quote.title}`)
  if (quote.itemKey) meta.push(`- Zotero key：${quote.itemKey}`)
  if (pageText) meta.push(`- 页面：${pageText}${loc.totalPages ? ` / 共 ${loc.totalPages} 页` : ''}`)
  if (typeof loc.lines === 'number') {
    meta.push(`- 位置：单次选区覆盖 ${loc.lines} 行`)
  }
  if (typeof loc.yTop === 'number') {
    meta.push(
      `- 页内纵向：y ${loc.yTop} → ${loc.yBottom}${loc.lineHeight ? `（行高 ${loc.lineHeight}）` : ''} · PDF 点，原点在页面左上`,
    )
  }
  if (typeof loc.xLeft === 'number') {
    meta.push(`- 横向：x ${loc.xLeft} → ${loc.xRight}`)
  }
  if (loc.sortIndex) meta.push(`- Zotero 排序键：${loc.sortIndex}`)

  const quoted = quote.text
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n')

  const rects = loc.rects && loc.rects.length
    ? ['', '## 选区矩形（每行一个，PDF 点）', '', ...loc.rects.map((r, i) => `${i + 1}. [${r.join(', ')}]`)]
    : []

  return [
    `# Zotero 选段${pageText ? ` · ${pageText}` : ''}`,
    '',
    ...(meta.length ? [...meta, ''] : []),
    quoted,
    ...rects,
    '',
    '---',
    '由 zotero-dsh 从 Zotero 阅读器送入。',
  ].join('\n')
}

export function QuoteDock({ sessionId, useInput, inputActions }: DockProps) {
  const draft = String(useInput((s) => s?.draft) ?? '')
  const [quote, setQuote] = useState<LatestQuote | null>(null)
  const [state, setState] = useState<'idle' | 'attached' | 'inline' | 'failed'>('idle')
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

  useEffect(() => {
    if (!quote || applied.current === quote.at) return
    applied.current = quote.at
    const getConversation = (globalThis as { __DSHZ_GET_CONVERSATION__?: unknown }).__DSHZ_GET_CONVERSATION__ as
      | (() => { createDrafts(sessionId: string, files: readonly File[]): readonly { id: unknown }[] } | null)
      | undefined
    const conversation = typeof getConversation === 'function' ? getConversation() : null
    // 首选：附件 chip。引用不进正文，只在附件栏占一格。
    if (conversation && typeof conversation?.createDrafts === 'function') {
      try {
        const file = new File([fileBody(quote)], fileName(quote), { type: 'text/markdown' })
        const drafts = conversation.createDrafts(sessionId, [file])
        const ids = drafts.map((d) => d.id)
        if (ids.length && inputActions.addAttachments(ids)) {
          setState('attached')
          return
        }
      } catch {
        /* 落到下面的降级 */
      }
    }
    // 降级：至少把引用塞进正文，别丢。
    try {
      const marker = quote.text.replace(/\s+/g, ' ').trim().slice(0, 60)
      if (!draftRef.current.replace(/\s+/g, ' ').includes(marker)) {
        inputActions.setDraft([draftRef.current, quoteBlock(quote)].filter(Boolean).join('\n\n'))
      }
      setState('inline')
    } catch {
      setState('failed')
    }
  }, [quote, inputActions, sessionId])

  if (!quote) return null
  const body = quote.text.replace(/\s+/g, ' ').trim()
  const label =
    state === 'attached' ? '已作为附件挂上' : state === 'inline' ? '已写入输入框' : state === 'failed' ? '挂载失败' : '正在挂载…'

  return (
    <div className="dshz-quote-dock">
      <div className="dshz-quote-head">
        <span className="dshz-quote-tag">Zotero 选段{quote.page ? ` · 第 ${quote.page} 页` : ''}</span>
        {quote.title ? <span className="dshz-quote-src" title={quote.title}>{quote.title}</span> : null}
        <span className="dshz-quote-state">{label}</span>
        <button type="button" className="dshz-quote-x" aria-label="收起" title="收起" onClick={() => setQuote(null)}>×</button>
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
