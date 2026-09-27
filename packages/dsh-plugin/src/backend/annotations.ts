/**
 * dsh-zotero — Annotation & Note bidirectional sync module.
 *
 * Supports:
 * 1. Submitting native Zotero Annotation/Note items to Zotero Local API (/api/users/0/items)
 *    Types: highlight (高亮), note (独立笔记), comment (批注/评注)
 * 2. Exporting & appending structured Markdown cards into the local DSH workspace.
 */
import type { ZoteroClient } from '../zotero/client.ts'
import { appendMarkdownNote, type MarkdownNoteRecord } from './markdown-notes.ts'

export type AnnotationType = 'highlight' | 'note' | 'comment'

export interface AnnotateOptions {
  itemKey: string
  type: AnnotationType
  text?: string
  comment?: string
  color?: string
  pageLabel?: string
  attachmentKey?: string
  tags?: string[]
  markdownPath?: string
  exportMarkdown?: boolean
  syncToZotero?: boolean
  workspaceDir?: string
}

export interface AnnotateResult {
  ok: boolean
  itemKey: string
  type: AnnotationType
  zoteroCreated: boolean
  zoteroItemKey: string
  markdownSaved: boolean
  markdownPath: string
  citation: {
    key: string
    title: string
    doi: string
  }
  error: string
  hint: string
}

/** Construct native Zotero Item payload conforming to Local API v3 spec. */
export function buildZoteroItemPayload(params: {
  itemKey: string
  type: AnnotationType
  parentItem: string
  text?: string
  comment?: string
  color?: string
  pageLabel?: string
  tags?: string[]
  title?: string
}): Record<string, unknown> {
  const { itemKey, type, parentItem, text = '', comment = '', color, pageLabel, tags = [], title = '' } = params
  const tagObjects = tags.map((t) => ({ tag: t }))

  if (type === 'note') {
    // Rich-text HTML Child Note
    const safeTitle = escapeHtml(title || 'Note')
    const safeText = text ? `<blockquote>${escapeHtml(text)}</blockquote>` : ''
    const safeComment = comment ? `<p>${escapeHtml(comment)}</p>` : ''
    const htmlNote = `<p><strong>${safeTitle}</strong></p>${safeText}${safeComment}`

    return {
      itemType: 'note',
      parentItem: itemKey,
      note: htmlNote,
      tags: tagObjects,
    }
  }

  // Annotation item (highlight or comment/annotation note)
  const defaultColors: Record<AnnotationType, string> = {
    highlight: '#ffd400', // Yellow
    comment: '#ff6666',   // Red / Coral
    note: '#2ea8e5',      // Blue
  }
  const assignedColor = color || defaultColors[type] || '#ffd400'

  const annotationType = type === 'highlight' ? 'highlight' : (text ? 'highlight' : 'note')

  const payload: Record<string, unknown> = {
    itemType: 'annotation',
    parentItem,
    annotationType,
    annotationText: text,
    annotationComment: comment,
    annotationColor: assignedColor,
    tags: tagObjects,
  }

  if (pageLabel) {
    payload.annotationPageLabel = String(pageLabel)
  }

  return payload
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/** Execute annotation sync: write to Zotero Local API and append Markdown card. */
export async function annotateItem(
  client: ZoteroClient,
  opts: AnnotateOptions,
): Promise<AnnotateResult> {
  const {
    itemKey,
    type,
    text = '',
    comment = '',
    color,
    pageLabel,
    attachmentKey,
    tags = [],
    markdownPath,
    exportMarkdown = true,
    syncToZotero = true,
    workspaceDir,
  } = opts

  let citation = {
    key: itemKey,
    title: '',
    doi: '',
  }

  let resolvedAttachmentKey = attachmentKey

  // 1. Fetch item metadata to populate citation and resolve PDF attachment if needed
  try {
    const itemRes = await client.getItem(itemKey)
    if (itemRes.found && itemRes.item) {
      citation.title = itemRes.item.title || ''
      citation.doi = itemRes.item.doi || ''
      if (!resolvedAttachmentKey) {
        const pdfAtt = itemRes.item.attachments?.find((a) => a.isPdf)
        if (pdfAtt) {
          resolvedAttachmentKey = pdfAtt.key
        }
      }
    }
  } catch {
    // best-effort item retrieval
  }

  let zoteroCreated = false
  let zoteroItemKey = ''
  let zoteroError = ''
  let zoteroHint = ''

  // 2. Sync to Zotero Local API if requested
  if (syncToZotero) {
    const parentForAnnotation = resolvedAttachmentKey || itemKey
    const payload = buildZoteroItemPayload({
      itemKey,
      type,
      parentItem: type === 'note' ? itemKey : parentForAnnotation,
      text,
      comment,
      color,
      pageLabel,
      tags,
      title: citation.title,
    })

    const writeRes = await client.createItems([payload])
    if (writeRes.ok && writeRes.successKeys.length > 0) {
      zoteroCreated = true
      zoteroItemKey = writeRes.successKeys[0]
    } else {
      zoteroError = writeRes.error || 'Zotero 写入失败'
      zoteroHint = writeRes.hint || '请确认 Zotero 正在运行且本地 API 允许写入'
    }
  }

  // 3. Export & append Markdown note in local DSH workspace
  let markdownSaved = false
  let resolvedMarkdownPath = ''

  if (exportMarkdown) {
    try {
      const record: MarkdownNoteRecord = {
        itemKey,
        title: citation.title || itemKey,
        doi: citation.doi,
        type,
        text,
        comment,
        color,
        pageLabel,
        tags,
        timestamp: new Date().toISOString(),
        zoteroKey: zoteroItemKey,
      }
      const syncRes = appendMarkdownNote(record, {
        workspaceDir,
        markdownPath,
      })
      markdownSaved = true
      resolvedMarkdownPath = syncRes.filePath
    } catch (err: any) {
      if (!zoteroError) {
        zoteroError = `Markdown 写入失败: ${String(err?.message ?? err)}`
      }
    }
  }

  const ok = (!syncToZotero || zoteroCreated) && (!exportMarkdown || markdownSaved)

  return {
    ok,
    itemKey,
    type,
    zoteroCreated,
    zoteroItemKey,
    markdownSaved,
    markdownPath: resolvedMarkdownPath,
    citation,
    error: zoteroError,
    hint: zoteroHint,
  }
}
