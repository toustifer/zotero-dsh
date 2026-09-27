/**
 * dsh-zotero — retrieval/rank.ts：块级打分与排序（移植自 llm-for-zotero
 * `modules/contextPanel/pdfContext.ts` scoreChunkBM25 / detectQueryIntent /
 * SECTION_BOOST_PROFILES / scoreEvidenceHeuristics；AGPL-3.0 出处见 docs/M0-audit.md）。
 *
 * 打分信号：
 *   1. BM25 词法分（k1=1.2, b=0.75）——支持按查询计划（原查询+变体 terms）联合打分；
 *   2. 查询意图检测 → 章节 boost（问方法→methods +1.5，问数据→results +1.5，
 *      general 时 references -2.4 等）；
 *   3. 引用 boost（论文引用句命中 +10，相邻块 +0.35）；
 *   4. 启发式修正（短块/引用列表/无 anchor 文本减分）。
 * 本实现为纯词法版（无 embedding）；RRF 融合接口 + MMR 多样性去重已内置，
 * 多通道（如后续 wave-rag dense）可接入 HybridRanker。
 */

import type { ChunkIndex, ChunkMeta } from './indexer.ts'
import type { RetrievalQueryPlan } from './queryPlan.ts'

export const RRF_K = 60
export const MMR_LAMBDA = 0.7

/* ── 意图检测（移植上游 detectQueryIntent） ─────────────────────────────── */

export type QueryIntent = 'methodological' | 'visual' | 'comparative' | 'citation' | 'factual' | 'conceptual' | 'general'

export function detectQueryIntent(question: string): QueryIntent {
  if (/\b(?:method|protocol|procedure|algorithm|implementation|pipeline|training|hyperparameter|setup|dataset)\b/i.test(question)) return 'methodological'
  if (/\b(?:figure|fig\.?|table|chart|plot|diagram|caption|image)\b/i.test(question)) return 'visual'
  if (/\b(?:compar|differ|versus|vs\.?|contrast|similar|distinguish)\b/i.test(question)) return 'comparative'
  if (/\b(?:cit(?:e|ation|ed)|refer(?:ence|red)|bibliograph)\b/i.test(question)) return 'citation'
  if (/\b(?:how many|sample size|number of|percentage|ratio|count|statistic)\b/i.test(question)) return 'factual'
  if (/\b(?:mechanism|pathway|relationship|role of|function of|why does|how does|how is|how are|how do|how was|how were)\b/i.test(question)) return 'conceptual'
  return 'general'
}

/** 章节类型识别（由 sectionLabel 猜测块类型）。 */
export function classifyChunkKind(sectionLabel: string): string {
  const s = String(sectionLabel ?? '').toLowerCase()
  if (!s || s === '(全文)' || s === '(前言)') return 'body'
  if (/(abstract|摘要|概述)/.test(s)) return 'abstract'
  if (/(result|finding|数值|结果)/.test(s)) return 'results'
  if (/(discussion|讨论)/.test(s)) return 'discussion'
  if (/(conclusion|conclud|结论)/.test(s)) return 'conclusion'
  if (/(introduction|introd|引言|简介)/.test(s)) return 'introduction'
  if (/(method|methodolog|approach|procedure|实验方法|方法)/.test(s)) return 'methods'
  if (/(figure|fig|图)/.test(s)) return 'figure-caption'
  if (/(table|表)/.test(s)) return 'table-caption'
  if (/(appendix|附录)/.test(s)) return 'appendix'
  if (/(reference|references|参考文献|bibliograph)/.test(s)) return 'references'
  return 'body'
}

/** 章节 boost 表（移植上游 SECTION_BOOST_PROFILES；行/列语义一致）。 */
const SECTION_BOOST_PROFILES: Record<QueryIntent, Partial<Record<string, number>>> = {
  general: { abstract: 0.9, results: 1.2, discussion: 0.95, conclusion: 0.8, introduction: 0.2, methods: -0.2, 'figure-caption': -1.1, 'table-caption': -1.1, appendix: -1.6, references: -2.4, body: 0.1 },
  factual: { results: 1.5, methods: 0.8, abstract: 0.5, discussion: 0.4, 'figure-caption': -0.8, 'table-caption': -0.8, appendix: -1.4, references: -2.4 },
  conceptual: { discussion: 1.4, abstract: 1.0, results: 0.8, introduction: 0.6, 'figure-caption': -0.8, 'table-caption': -0.8, appendix: -1.4, references: -2.4 },
  methodological: { methods: 1.5, abstract: 0.4, results: 0.3, appendix: 0.2, 'figure-caption': -0.5, 'table-caption': -0.5, references: -2.0 },
  comparative: { results: 1.4, discussion: 1.2, abstract: 0.6, methods: 0.2, 'figure-caption': -0.5, 'table-caption': -0.5, appendix: -1.2, references: -2.0 },
  citation: { references: 1.0, introduction: 0.8, discussion: 0.6, abstract: 0.3, 'figure-caption': -0.8, 'table-caption': -0.8, appendix: -0.5 },
  visual: { 'figure-caption': 0.8, 'table-caption': 0.8, results: 0.6, methods: 0.2, appendix: -1.0, references: -2.0 },
}

/* ── BM25（移植上游 scoreChunkBM25，k1=1.2 b=0.75） ─────────────────────── */

export function scoreChunkBM25(
  chunk: { length: number; tf: Record<string, number> },
  terms: string[],
  docFreq: Record<string, number>,
  totalChunks: number,
  avgChunkLength: number,
): number {
  if (!terms.length || !chunk.length) return 0
  const k1 = 1.2
  const b = 0.75
  let score = 0
  for (const term of terms) {
    const tf = chunk.tf[term] || 0
    if (!tf) continue
    const df = docFreq[term] || 0
    const idf = Math.log(1 + (totalChunks - df + 0.5) / (df + 0.5))
    const norm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * chunk.length) / avgChunkLength))
    score += idf * norm
  }
  return score
}

/* ── 启发式打分（移植上游 scoreEvidenceHeuristics 简版） ────────────────── */

function looksLikeCitationList(text: string): boolean {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length < 3) return false
  const citationish = lines.filter((l) => /(^\d+\.|\(19\d{2}|\(20\d{2}|et al\.)/.test(l)).length
  return citationish / lines.length > 0.6
}

interface EvidenceCandidate {
  chunkIndex: number
  sectionLabel: string
  chunkText: string
  bm25Score: number
  meta?: ChunkMeta
}

/**
 * 对块做最终证据排序。
 * @param queryPlan 可选的查询计划：变体 terms 联合打分（原词+同义/缩写/notation）。
 * @param referenceChunkIndexes 命中「论文引用句」的块索引（如 "@Smith2020"），high 置信 +10、相邻 ±1 块 +0.35。
 * @param options.dedupe MMR 多样性去重（默认开）。
 */
export function rankEvidenceCandidates(
  index: ChunkIndex,
  query: string,
  options: {
    topK?: number
    queryPlan?: RetrievalQueryPlan
    referenceChunkIndexes?: number[]
    dedupe?: boolean
  } = {},
): EvidenceCandidate[] {
  const topK = Math.max(1, options.topK ?? 5)
  const plan = options.queryPlan
  // 词法 terms：优先用查询计划（原查询+变体去重），无计划则原查询切词。
  const terms = Array.from(new Set(
    (plan?.lexicalTerms?.length ? plan.lexicalTerms : query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 1)),
  ))
  const intent = detectQueryIntent(query)
  const highConf = new Set(options.referenceChunkIndexes ?? [])
  const neighbors = new Set<number>()
  for (const ci of highConf) {
    if (ci > 0) neighbors.add(ci - 1)
    if (ci + 1 < index.chunks.length) neighbors.add(ci + 1)
  }

  const scored: Array<{ idx: number; score: number }> = []
  for (const stat of index.chunkStats) {
    let score = scoreChunkBM25(stat, terms, index.docFreq, index.chunks.length, index.avgChunkLength)
    if (highConf.has(stat.index)) score += 10
    else if (neighbors.has(stat.index)) score += 0.35

    const meta = index.meta[stat.index]
    const kind = classifyChunkKind(meta?.sectionLabel ?? '')
    const boost = SECTION_BOOST_PROFILES[intent]?.[kind] ?? 0
    score += boost

    const text = index.chunks[stat.index]
    const wordCount = text ? text.split(/\s+/).length : 0
    if (wordCount > 0 && wordCount < 7) score -= 0.7
    else if (wordCount > 0 && wordCount < 12) score -= 0.25
    if (text && looksLikeCitationList(text)) score -= 1.3

    scored.push({ idx: stat.index, score })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.idx - b.idx
  })

  let selected = scored.slice(0, topK)

  // body 保底：evidence 模式下若选中块全是 abstract/figure/table/references 等，
  // 补一个 body 段（上游 isBodyEvidenceSection 语义）。
  if (selected.length && !selected.some((s) => isBodyEvidenceSection(index.meta[s.idx]?.sectionLabel ?? ''))) {
    const bodyEntry = scored.find((s) => isBodyEvidenceSection(index.meta[s.idx]?.sectionLabel ?? ''))
    if (bodyEntry && !selected.includes(bodyEntry)) {
      selected[selected.length - 1] = bodyEntry
    }
  }

  // MMR 多样性去重：选块时惩罚与已选块文本重合度过高的候选（λ=0.7）。
  if (options.dedupe !== false) {
    selected = mmrSelect(selected, scored, index.chunks, topK)
  }

  return selected.map((s) => ({
    chunkIndex: s.idx,
    sectionLabel: index.meta[s.idx]?.sectionLabel ?? '',
    chunkText: index.chunks[s.idx],
    bm25Score: Math.round(s.score * 100) / 100,
    meta: index.meta[s.idx],
  }))
}

/** Body 类段（正文证据可引用区）；非标题/图注/表格/引用表/附录即视为 body。 */
function isBodyEvidenceSection(sectionLabel: string): boolean {
  const kind = classifyChunkKind(sectionLabel)
  return kind === 'body' || kind === 'results' || kind === 'discussion' || kind === 'methods' || kind === 'conclusion'
}

/** 两个文本的 Jaccard token 重合度（MMR 多样性度量；纯词法，无 embedding）。 */
function jaccardTokens(a: string, b: string): number {
  const ta = new Set((a || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length > 2))
  const tb = new Set((b || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length > 2))
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  return inter / Math.min(ta.size, tb.size)
}

/** 贪心 MMR：每步选「相关性 − λ × 与已选集最大相似度」最高的候选。
 * 返回保持原始相关性得分（bm25Score 展示用），顺序为 MMR 精选序。 */
function mmrSelect(
  candidates: Array<{ idx: number; score: number }>,
  allScored: Array<{ idx: number; score: number }>,
  chunks: string[],
  topK: number,
): Array<{ idx: number; score: number }> {
  const remaining = new Map<number, number>()
  for (const c of candidates) remaining.set(c.idx, c.score)
  // 若候选不够 topK（原始 topK 截断导致），从全量补足。
  for (const c of allScored) {
    if (remaining.size >= topK) break
    if (!remaining.has(c.idx)) remaining.set(c.idx, c.score - 2)
  }
  const rawScores = new Map(remaining)
  const selected: number[] = []
  while (selected.length < topK && remaining.size) {
    let bestIdx = -1
    let bestVal = -Infinity
    for (const [idx] of remaining) {
      const score = rawScores.get(idx) ?? 0
      let simMax = 0
      for (const s of selected) {
        const sim = jaccardTokens(chunks[idx], chunks[s])
        if (sim > simMax) simMax = sim
      }
      const val = score - MMR_LAMBDA * simMax
      if (val > bestVal) { bestVal = val; bestIdx = idx }
    }
    if (bestIdx < 0) break
    selected.push(bestIdx)
    remaining.delete(bestIdx)
  }
  return selected.map((idx) => ({ idx, score: rawScores.get(idx) ?? 0 }))
}

/* ── RRF 融合（与 wave-rag retrieval/bm25.ts rrfFuse 同构，供未来 dense 通道） ── */

export function rrfFuse(
  a: Array<{ key: string }>,
  b: Array<{ key: string }>,
  topK: number,
  k = RRF_K,
): string[] {
  const score = new Map<string, number>()
  a.forEach((hit, i) => score.set(hit.key, (score.get(hit.key) ?? 0) + 1 / (k + i + 1)))
  b.forEach((hit, i) => score.set(hit.key, (score.get(hit.key) ?? 0) + 1 / (k + i + 1)))
  return [...score.entries()].sort((x, y) => y[1] - x[1]).slice(0, topK).map(([key]) => key)
}