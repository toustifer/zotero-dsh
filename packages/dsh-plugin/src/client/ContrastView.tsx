/**
 * dsh-zotero — ContrastView：左右对照阅读（左英文原文 / 右中文译文）。
 *
 * 数据：原文 = 附件原 PDF（/pdf?key=）；译文 = pdf2zh mono.pdf（版面同构）。
 * 渲染：两个 pdf.js 文档，每页渲染一个页面；页码共享（‹ › 翻页），
 *       两栏内滚动按比例同步（同版式 → 基本 1:1）。
 */
import { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import { API } from './api'

GlobalWorkerOptions.workerSrc = `${API}/pdfjs-worker`

interface ContrastViewProps {
  originalUrl: string
  monoUrl: string
  itemKey?: string
}

function pickDoc(src: string, onDoc: (d: PDFDocumentProxy) => void, onErr: (m: string) => void, signal: AbortSignal): void {
  if (!src) return
  void (async () => {
    try {
      const res = await fetch(src, { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.arrayBuffer()
      const d = await getDocument({ data }).promise
      onDoc(d)
    } catch (e: any) {
      if (e?.name !== 'AbortError') onErr(String(e?.message ?? e))
    }
  })()
}

export function ContrastView(props: ContrastViewProps): JSX.Element {
  const [page, setPage] = useState(1)
  const [numPages, setNumPages] = useState(0)
  const [err, setErr] = useState('')
  const origRef = useRef<HTMLCanvasElement | null>(null)
  const monoRef = useRef<HTMLCanvasElement | null>(null)
  const origScroll = useRef<HTMLDivElement | null>(null)
  const monoScroll = useRef<HTMLDivElement | null>(null)
  const syncLock = useRef(false)

  const [origDoc, setOrigDoc] = useState<PDFDocumentProxy | null>(null)
  const [monoDoc, setMonoDoc] = useState<PDFDocumentProxy | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    const ready = (n: number): void => setNumPages((prev) => Math.max(prev, n))
    pickDoc(props.originalUrl, (d) => { setOrigDoc(d); ready(d.numPages) }, setErr, ctrl.signal)
    pickDoc(props.monoUrl, (d) => { setMonoDoc(d); ready(d.numPages) }, setErr, ctrl.signal)
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.originalUrl, props.monoUrl])

  /** 渲染一侧页面（canvas，按容器宽度 fit）。容器宽首次测量后定死：
   *  避免滚动/滚动条抖动导致的宽度波动（"越滚越大"来源）。 */
  const cwRef = useRef(0)
  function renderSide(doc: PDFDocumentProxy | null, pageNo: number, canvas: HTMLCanvasElement | null, el: HTMLDivElement | null): void {
    if (!doc || !canvas || !el) return
    void (async () => {
      try {
        const p = await doc.getPage(pageNo)
        if (!cwRef.current) cwRef.current = el.clientWidth || 400
        const containerW = cwRef.current
        const base = p.getViewport({ scale: 1 })
        const scale = containerW / base.width
        const vp = p.getViewport({ scale })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(vp.width * dpr)
        canvas.height = Math.floor(vp.height * dpr)
        canvas.style.width = `${vp.width}px`
        canvas.style.height = `${vp.height}px`
        el.style.height = `${vp.height}px`
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        try {
          await p.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise
        } catch (e: any) {
          if (e?.name !== 'RenderingCancelledException') throw e
        }
      } catch (e: any) {
        console.warn('[dsh-zotero ContrastView] render failed', pageNo, String(e?.message ?? e))
      }
    })()
  }

  useEffect(() => {
    renderSide(origDoc, page, origRef.current, origScroll.current)
    renderSide(monoDoc, page, monoRef.current, monoScroll.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origDoc, monoDoc, page])

  function goPage(n: number): void {
    setPage(Math.min(Math.max(1, n), numPages || 1))
    origScroll.current?.scrollTo({ top: 0 })
    monoScroll.current?.scrollTo({ top: 0 })
  }

  /** 双栏内部滚动比例同步（同版式 → 近似 1:1）。 */
  function syncScroll(from: 'left' | 'right'): void {
    if (syncLock.current) return
    syncLock.current = true
    const src = from === 'left' ? origScroll.current : monoScroll.current
    const dst = from === 'left' ? monoScroll.current : origScroll.current
    if (src && dst) {
      const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight)
      dst.scrollTop = ratio * Math.max(0, dst.scrollHeight - dst.clientHeight)
    }
    requestAnimationFrame(() => { syncLock.current = false })
  }

  /** 滚轮翻页：容器滚到顶/底继续滚动时翻页（内部可滚动时保留默认滚动）。 */
  const wheelGuard = useRef(0)
  function onWheelField(e: ReactWheelEvent, side: 'left' | 'right'): void {
    const el = side === 'left' ? origScroll.current : monoScroll.current
    if (!el) return
    const atTop = el.scrollTop <= 0
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
    const now = Date.now()
    if (now - wheelGuard.current < 280) return
    if (e.deltaY > 0 && atBottom) {
      wheelGuard.current = now
      goPage(page + 1)
    } else if (e.deltaY < 0 && atTop) {
      wheelGuard.current = now
      goPage(page - 1)
    }
  }

  if (err) {
    return <div className="dshz-null" style={{ paddingTop: 40 }}>对照加载失败：{err}</div>
  }

  return (
    <div className="dshz-cv" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="dshz-pdf-toolbar">
        <button className="dshz-btn" disabled={page <= 1} onClick={() => goPage(page - 1)} title="上一页">‹</button>
        <span className="pg">{numPages ? `${page} / ${numPages}` : '…'}</span>
        <button className="dshz-btn" disabled={page >= numPages} onClick={() => goPage(page + 1)} title="下一页">›</button>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 0 }}>
        <div
          ref={origScroll}
          className="dshz-cv-col"
          style={{ flex: 1, minWidth: 0, overflow: 'auto', background: '#111', padding: 8 }}
          onScroll={() => syncScroll('left')}
          onWheel={(e) => onWheelField(e, 'left')}
        >
          <canvas ref={origRef} style={{ display: 'block', margin: '0 auto' }} />
        </div>
        <div style={{ flex: '0 0 2px', background: 'var(--ios-sep)' }} />
        <div
          ref={monoScroll}
          className="dshz-cv-col"
          style={{ flex: 1, minWidth: 0, overflow: 'auto', background: '#111', padding: 8 }}
          onScroll={() => syncScroll('right')}
          onWheel={(e) => onWheelField(e, 'right')}
        >
          <canvas ref={monoRef} style={{ display: 'block', margin: '0 auto' }} />
        </div>
      </div>
      <div className="dshz-note" style={{ textAlign: 'center', padding: 4, borderTop: '1px solid var(--ios-sep)' }}>
        左：英文原文 · 右：中文译文（版面对齐）
      </div>
    </div>
  )
}
