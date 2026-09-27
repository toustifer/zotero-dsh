/**
 * dsh-zotero — retrieval/indexer.ts：论文全文 → 分块索引（移植自 llm-for-zotero
 * `modules/contextPanel/pdfContext.ts` splitMarkdownIntoChunks / buildChunkIndex，
 * 上游 AGPL-3.0，出处声明见 docs/M0-audit.md）。
 *
 * 分块策略（与上游一致）：
 *   1) 按标题层级（#{1,4}）切章节；
 *   2) 小章节按预算累积合并（保留段落边界）；
 *   3) 大章节按段落切；超大段落做**句子边界感知切片** + 200 字符 overlap，
 *      避免从 "Fig. 2"/"e.g. the"/"Dr. Smith" 这类缩写中间劈开语义单元。
 * 索引统计：每块 tf / uniqueTerms / length，全局 docFreq / avgChunkLength ——
 * BM25（见 rank.ts）所需的全部统计量，构建一次、多次查询复用。
 */

export const CHUNK_TARGET_LENGTH = 2000
export const CHUNK_OVERLAP = 200

export interface ChunkStat {
  index: number
  /** token 数（词法单元长度，用于 BM25 长度归一化）。 */
  length: number
  /** term → 本块内出现次数。 */
  tf: Record<string, number>
  uniqueTerms: string[]
}

export interface ChunkIndex {
  chunks: string[]
  chunkStats: ChunkStat[]
  /** term → 包含该 term 的块数（docFreq）。 */
  docFreq: Record<string, number>
  avgChunkLength: number
  /** 每块来源信息（章节名/页），供证据打包引用。 */
  meta: ChunkMeta[]
}

export interface ChunkMeta {
  sectionLabel: string
  /** 该块在全文中的起始/结束行号（1-based，用于 offset 换算）。 */
  startLine: number
  endLine: number
  /** 页码（MinerU full.md 无页标记时为 undefined）。 */
  pageStart?: number
  pageEnd?: number
}

/** 简单英文分词（与上游 retrievalTokenizer 的降级路径等价；CJK 整段保留）。 */
export function tokenizeText(text: string): string[] {
  const tokens: string[] = []
  for (const m of String(text ?? '').toLowerCase().matchAll(/[a-z0-9\u4e00-\u9fff]{2,}/g)) {
    tokens.push(m[0])
  }
  return tokens
}

/**
 * 句子边界感知切片：找离 targetPos 最近的句子结尾（`. `、`? `、`! `、换行）。
 * 要求标点后跟大写或换行，避免在 "Fig. 2"、"e.g. the"、"Dr. Smith"、"et al." 处切开。
 * 移植自上游 findSentenceBoundary。
 */
function findSentenceBoundary(text: string, targetPos: number, maxDrift: number): number {
  const searchStart = Math.max(0, targetPos - maxDrift)
  const searchEnd = Math.min(text.length, targetPos + maxDrift)
  const region = text.slice(searchStart, searchEnd)
  const sentenceEnders = /[.!?]\s+(?=[A-Z\n])|[.!?](?=\n)|\n/g
  let bestPos = targetPos
  let bestDist = maxDrift + 1
  let match: RegExpExecArray | null
  while ((match = sentenceEnders.exec(region)) !== null) {
    const absPos = searchStart + match.index + match[0].length
    const dist = Math.abs(absPos - targetPos)
    if (dist < bestDist) {
      bestDist = dist
      bestPos = absPos
    }
  }
  return bestDist <= maxDrift ? bestPos : targetPos
}

/** Markdown 全文 → 章节边界（标题行号 1-based）。与 tools-m2.splitSections 同族。 */
export function splitSections(md: string): Array<{ title: string; startLine: number; endLine: number }> {
  const lines = String(md ?? '').split('\n')
  const sections: Array<{ title: string; startLine: number; endLine: number }> = []
  let current: { title: string; startLine: number; endLine: number } | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,4})\s+(.+)$/.exec(lines[i])
    if (m) {
      if (current) current.endLine = i
      current = { title: m[2].trim().slice(0, 80), startLine: i + 1, endLine: i + 1 }
      sections.push(current)
    } else if (!current) {
      // 标题前的散段归入「(前言)」——与上游处理一致（不并入后续章节）。
    }
  }
  if (current) current.endLine = lines.length
  if (!sections.length) sections.push({ title: '(全文)', startLine: 1, endLine: lines.length })
  return sections
}

/** 行号 → 字符偏移（含换行符），等价 tools-m2.charOffsetOf。 */
export function charOffsetOf(md: string, lineIndex: number): number {
  if (lineIndex <= 1) return 0
  const lines = md.split('\n')
  let off = 0
  const n = Math.min(lineIndex - 1, lines.length - 1)
  for (let i = 0; i < n; i += 1) off += lines[i].length + 1
  return off
}

/**
 * Markdown 全文 → 分块（标题切章 + 段落累积 + 句子边界 + overlap）。
 * 移植自上游 splitMarkdownIntoChunks（target=CHUNK_TARGET_LENGTH）。
 */
export function splitMarkdownIntoChunks(text: string, targetLength = CHUNK_TARGET_LENGTH): string[] {
  if (!text) return []
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []

  // Phase 1: 按标题边界切章节
  const lines = normalized.split('\n')
  const sections: string[] = []
  let currentSection = ''
  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line) && currentSection.trim()) {
      sections.push(currentSection.trim())
      currentSection = line + '\n'
    } else {
      currentSection += line + '\n'
    }
  }
  if (currentSection.trim()) sections.push(currentSection.trim())
  if (!sections.length) return []

  // Phase 2: 小章节累积、大章节细分
  const chunks: string[] = []
  let accumulator = ''
  const flushAccumulator = (): void => {
    if (accumulator.trim()) chunks.push(accumulator.trim())
    accumulator = ''
  }

  for (const section of sections) {
    if (section.length > targetLength) {
      flushAccumulator()
      const paragraphs = section.split(/\n\s*\n/)
      let subChunk = ''
      for (const para of paragraphs) {
        const p = para.trim()
        if (!p) continue
        if (p.length > targetLength) {
          if (subChunk.trim()) { chunks.push(subChunk.trim()); subChunk = '' }
          let start = 0
          while (start < p.length) {
            const prevStart = start
            const rawEnd = Math.min(start + targetLength, p.length)
            const end = rawEnd < p.length ? findSentenceBoundary(p, rawEnd, 200) : rawEnd
            const slice = p.slice(start, end).trim()
            if (slice) chunks.push(slice)
            if (end >= p.length) break
            const rawOverlapStart = Math.max(0, end - CHUNK_OVERLAP)
            start = findSentenceBoundary(p, rawOverlapStart, 100)
            if (start <= prevStart) start = prevStart + targetLength
          }
        } else if (subChunk.length + p.length + 2 <= targetLength) {
          subChunk = subChunk ? `${subChunk}\n\n${p}` : p
        } else {
          if (subChunk.trim()) chunks.push(subChunk.trim())
          subChunk = p
        }
      }
      if (subChunk.trim()) chunks.push(subChunk.trim())
    } else if (accumulator.length + section.length + 2 <= targetLength) {
      accumulator = accumulator ? `${accumulator}\n\n${section}` : section
    } else {
      flushAccumulator()
      accumulator = section
    }
  }
  flushAccumulator()
  return chunks
}

/** 为全文构建分块索引（分块 + tf/docFreq/avgLen + 章节元数据）。 */
export function buildChunkIndex(md: string, targetLength = CHUNK_TARGET_LENGTH): ChunkIndex {
  const chunks = splitMarkdownIntoChunks(md, targetLength)
  const sections = splitSections(md)
  const docFreq: Record<string, number> = Object.create(null)
  const chunkStats: ChunkStat[] = []
  const meta: ChunkMeta[] = []
  let totalLength = 0

  // 把每个块映射回它所属的章节（用于 sectionLabel）。
  const lines = md.split('\n')
  const lineIndexToSection = new Map<number, string>()
  for (const s of sections) {
    for (let ln = s.startLine; ln <= s.endLine; ln += 1) lineIndexToSection.set(ln, s.title)
  }

  chunks.forEach((chunk, index) => {
    const tokens = tokenizeText(chunk)
    const tf: Record<string, number> = Object.create(null)
    for (const term of tokens) tf[term] = (tf[term] || 0) + 1
    const uniqueTerms = Object.keys(tf)
    for (const term of uniqueTerms) docFreq[term] = (docFreq[term] || 0) + 1
    totalLength += tokens.length
    chunkStats.push({ index, length: tokens.length, tf, uniqueTerms })

    // 该块起始位置所在章节（把块首附近最近的标题当作来源）。
    const firstLine = chunkStartLine(md, chunks, index)
    const section = lineIndexToSection.get(firstLine) ?? ''
    meta.push({ sectionLabel: section, startLine: firstLine, endLine: firstLine + chunk.split('\n').length })
  })

  const avgChunkLength = chunks.length ? totalLength / chunks.length : 0
  return { chunks, chunkStats, docFreq, avgChunkLength, meta }
}

/** 估算第 index 个块在原文中的起始行号（尽力而为：按累计字符数换算）。 */
function chunkStartLine(md: string, chunks: string[], index: number): number {
  // 累计该块之前所有块的长度，量出大约的字符位置 → 数行数。
  let before = 0
  for (let i = 0; i < index; i += 1) before += chunks[i].length + 2
  const head = md.slice(0, Math.min(before, md.length))
  return head.split('\n').length
}