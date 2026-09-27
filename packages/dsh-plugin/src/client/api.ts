/**
 * dsh-zotero client — shared API helpers for the PDF reader (划线翻译).
 * Kept separate from index.tsx to avoid import cycles (PdfReader ← index.tsx).
 */
export const API = '/@dsh-external/dsh-zotero/api'

/** 读取设置中的默认划词翻译目标语言（无则 'zh'）。 */
export async function fetchTranslateTargetLang(): Promise<string> {
  try {
    const r = await fetch(`${API}/config`)
    const cfg = await r.json()
    const lang = (cfg as { translateTargetLang?: string })?.translateTargetLang
    return lang ? String(lang) : 'zh'
  } catch {
    return 'zh'
  }
}

/** 单块翻译（host /translate，带缓存）。 */
export async function translateChunk(text: string, itemKey: string | undefined, targetLang: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${API}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, itemKey, targetLang }),
    signal,
  })
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string }
  if (!j?.ok) throw new Error(String(j?.error ?? '翻译失败'))
  return String(j.text ?? '')
}

/** 长文本语义分块：Intl.Segmenter 按句切，≤4 块、每块 ~1000 字符。 */
export function chunkText(text: string): string[] {
  if (text.length <= 2000) return [text]
  const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' })
  const out: string[] = []
  let cur = ''
  for (const s of seg.segment(text)) {
    cur += s.segment
    if (cur.length >= 1000) {
      out.push(cur)
      cur = ''
      if (out.length === 3) break
    }
  }
  if (cur) {
    if (out.length < 4) out.push(cur)
    else out[out.length - 1] += cur
  }
  return out
}

/** 分块并发翻译（结果按原顺序拼接）。 */
export async function translateTextSmart(text: string, itemKey: string | undefined, targetLang: string, signal: AbortSignal): Promise<string> {
  const chunks = chunkText(text)
  const results = await Promise.all(chunks.map((c) => translateChunk(c, itemKey, targetLang, signal)))
  return results.join('\n\n')
}

/* ── 全文翻译（pdf2zh 式 pipeline：分块→并发→进度/暂停/续传） ── */

export interface FullTransJob {
  state: 'idle' | 'running' | 'paused' | 'done' | 'error'
  attachmentKey: string
  itemKey?: string
  title: string
  total: number
  done: number
  error: string
  chunks: Array<{ id: number; src: string; dst: string }>
}

export async function fullTranslateStart(itemKey: string, attachmentKey: string): Promise<{ ok: boolean; job?: FullTransJob; error?: string }> {
  const res = await fetch(`${API}/fulltranslate/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey, attachmentKey }),
  })
  return res.json()
}

export async function fullTranslateStatus(attachmentKey: string): Promise<{ job: FullTransJob | null }> {
  const res = await fetch(`${API}/fulltranslate/status?attachmentKey=${encodeURIComponent(attachmentKey)}`)
  return res.json()
}

export async function fullTranslatePause(attachmentKey: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API}/fulltranslate/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachmentKey }),
  })
  return res.json()
}

export async function fullTranslateResume(attachmentKey: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API}/fulltranslate/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachmentKey }),
  })
  return res.json()
}

/* ── pdf2zh 一键全文翻译（官方 CLI → 双语 PDF，见 src/pdf2zh.ts） ── */

export interface Pdf2zhJob {
  state: 'running' | 'done' | 'error' | 'cancelled' | 'not-configured'
  attachmentKey: string
  itemKey: string
  title: string
  progress: string
  error: string
  files: { mono: string; dual: string }
}

export async function pdf2zhStart(itemKey: string, attachmentKey: string): Promise<{ ok: boolean; job?: Pdf2zhJob; error?: string }> {
  const res = await fetch(`${API}/pdf2zh/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemKey, attachmentKey }),
  })
  return res.json()
}

export async function pdf2zhStatus(attachmentKey: string): Promise<{ ok: boolean; configured: boolean; job: Pdf2zhJob | null }> {
  const res = await fetch(`${API}/pdf2zh/status?attachmentKey=${encodeURIComponent(attachmentKey)}`)
  return res.json()
}

export async function pdf2zhCancel(attachmentKey: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API}/pdf2zh/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ attachmentKey }),
  })
  return res.json()
}

export function pdf2zhFileUrl(attachmentKey: string, type: 'dual' | 'mono' = 'dual'): string {
  return `${API}/pdf2zh/file?attachmentKey=${encodeURIComponent(attachmentKey)}&type=${type}`
}

/* ── 划线高亮 & 批注 / 便签 API ── */

export interface AnnotatePayload {
  itemKey: string
  attachmentKey?: string
  type?: 'highlight' | 'note' | 'comment'
  text?: string
  comment?: string
  color?: string
  pageLabel?: string
  tags?: string[]
  markdownPath?: string
  exportMarkdown?: boolean
  syncToZotero?: boolean
  workspaceDir?: string
}

export async function annotatePost(payload: AnnotatePayload): Promise<any> {
  const res = await fetch(`${API}/annotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

export async function fetchAnnotations(itemKey: string): Promise<any[]> {
  try {
    const res = await fetch(`${API}/annotations?itemKey=${encodeURIComponent(itemKey)}`)
    const j = await res.json()
    return j.annotations ?? []
  } catch {
    return []
  }
}
