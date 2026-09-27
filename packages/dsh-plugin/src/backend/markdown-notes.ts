/**
 * dsh-zotero — Markdown note card generator & workspace sync.
 *
 * Formats annotation records into structured Markdown cards with:
 * - 条目 key (itemKey)
 * - DOI
 * - 引文标题 (citation title)
 * - 摘录原文 (selected text / quote)
 * - 批注心得 (comment / note)
 * - 时间戳 (timestamp)
 * - 标签与类型 (tags & type)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface MarkdownNoteRecord {
  itemKey: string
  title: string
  doi?: string
  type: 'highlight' | 'note' | 'comment'
  text?: string
  comment?: string
  color?: string
  pageLabel?: string
  tags?: string[]
  timestamp?: string
  zoteroKey?: string
}

export interface MarkdownSyncOptions {
  workspaceDir?: string
  markdownPath?: string
}

/** Format a single annotation into a structured Markdown card block. */
export function formatMarkdownCard(record: MarkdownNoteRecord): string {
  const ts = record.timestamp || new Date().toISOString()
  const doiDisplay = record.doi ? `[${record.doi}](https://doi.org/${record.doi})` : 'N/A'
  const typeIcons: Record<string, string> = {
    highlight: '🖍️ 高亮划线',
    note: '📝 读书笔记',
    comment: '💭 批注心得',
  }
  const typeLabel = typeIcons[record.type] || record.type
  const tagsStr = record.tags && record.tags.length > 0 ? record.tags.map((t) => `\`#${t}\``).join(' ') : '无'
  const pageStr = record.pageLabel ? ` (第 ${record.pageLabel} 页)` : ''
  const colorStr = record.color ? ` \`${record.color}\`` : ''

  const lines: string[] = []
  lines.push(`### ${typeLabel}${pageStr} — ${ts}`)
  lines.push('')
  lines.push(`- **文献条目**: \`${record.itemKey}\``)
  lines.push(`- **引文标题**: ${record.title || '（未命名文献）'}`)
  lines.push(`- **DOI**: ${doiDisplay}`)
  if (record.zoteroKey) {
    lines.push(`- **Zotero Key**: \`${record.zoteroKey}\``)
  }
  if (record.color) {
    lines.push(`- **批注色彩**: ${colorStr}`)
  }
  lines.push(`- **标签分类**: ${tagsStr}`)
  lines.push('')

  if (record.text && record.text.trim()) {
    lines.push('> **摘录原文**:')
    const quoted = record.text
      .trim()
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    lines.push(quoted)
    lines.push('')
  }

  if (record.comment && record.comment.trim()) {
    lines.push('**批注心得**:')
    lines.push(record.comment.trim())
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  return lines.join('\n')
}

/** Format the header for a new paper notes file. */
export function formatPaperHeader(itemKey: string, title: string, doi?: string): string {
  const doiLine = doi ? `- **DOI**: [${doi}](https://doi.org/${doi})\n` : ''
  return `# 📚 文献笔记卡片: ${title || itemKey}\n\n- **条目 Key**: \`${itemKey}\`\n${doiLine}- **创建时间**: ${new Date().toISOString()}\n\n---\n\n`
}

/** Append or create a Markdown note in the local workspace. */
export function appendMarkdownNote(
  record: MarkdownNoteRecord,
  opts?: MarkdownSyncOptions,
): { filePath: string; content: string; created: boolean } {
  const baseDir = opts?.workspaceDir || process.cwd()
  const relPath = opts?.markdownPath || `zotero-notes/${record.itemKey}.md`
  const absPath = resolve(baseDir, relPath)

  mkdirSync(dirname(absPath), { recursive: true })

  const card = formatMarkdownCard(record)
  const isNew = !existsSync(absPath)

  if (isNew) {
    const header = formatPaperHeader(record.itemKey, record.title, record.doi)
    const content = header + card
    writeFileSync(absPath, content, 'utf8')
    return { filePath: relPath, content, created: true }
  } else {
    const existing = readFileSync(absPath, 'utf8')
    const updated = existing.endsWith('\n') ? existing + card : `${existing}\n\n${card}`
    writeFileSync(absPath, updated, 'utf8')
    return { filePath: relPath, content: card, created: false }
  }
}
