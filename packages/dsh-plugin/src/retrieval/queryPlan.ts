/**
 * dsh-zotero — retrieval/queryPlan.ts：查询改写（移植 llm-for-zotero
 * `modules/contextPanel/retrievalQueryPlan.ts` 的确定性部分;AGPL-3.0 出处见 docs/M0-audit.md）。
 *
 * 两级：
 *   1. buildRetrievalQueryPlan — 纯确定性：规范化原查询 + 术语切分 + 引用解析，
 *      不依赖 LLM，总是可用（离线兜底）。
 *   2. resolveQueryPlanWithLLM — 用 DSH 模型适配器生成查询变体（同义/缩写/notation，
 *      如 "CNN" ↔ "convolutional neural network" ↔ 中文术语），失败自动降级确定性版。
 *
 * 变体进入检索 → BM25 按变体 terms 联合打分 (rank.ts)，扩大同义/缩写召回。
 */

import { createHash } from 'node:crypto'

export interface RetrievalQueryPlan {
  originalQuery: string
  /** LLM/规则产出的查询变体（不含原查询）。 */
  variants: string[]
  /** 有效查询集合 = 原查询 + 变体。 */
  effectiveQueries: string[]
  /** 全部有效查询去重后的词法 terms（BM25 用）。 */
  lexicalTerms: string[]
  /** 变体是否触顶（默认 6，硬顶 8）。 */
  variantLimitHit: boolean
}

export const QUERY_VARIANT_DEFAULT_LIMIT = 6
export const QUERY_VARIANT_HARD_LIMIT = 8
const QUERY_VARIANT_MAX_CHARS = 160

function normalizeQueryText(value: unknown, maxChars = 0): string {
  const normalized = `${value ?? ''}`.replace(/\s+/g, ' ').trim()
  if (!maxChars || normalized.length <= maxChars) return normalized
  return normalized.slice(0, maxChars).trim()
}

/** 查询词法切分（与 retrievalTokenizer 降级路径等价：英文词 + CJK 连续串）。 */
export function tokenizeRetrievalQuery(query: string): string[] {
  const tokens: string[] = []
  for (const m of String(query ?? '').toLowerCase().matchAll(/[a-z0-9]+(?:[-_][a-z0-9]+)*|[\u4e00-\u9fff]{2,}/g)) {
    const t = m[0]
    if (t.length >= 2) tokens.push(t)
  }
  return tokens
}

/** 判断是否像纯精读指令（避免为 "请通读全文" 这类无检索意图的查询白白调用 LLM）。 */
export function isPlainReadCommand(query: string): boolean {
  const q = query.trim()
  if (!q || q.length < 12) return false
  return /(请)?(通读|精读|阅读).{0,24}(全文|论文|PDF)|结构化精读|Key Points|概述这篇|一句话主线/.test(q)
}

/** 确定性查询计划（零 LLM，离线总是可用）。 */
export function buildRetrievalQueryPlan(query: string, params: { variants?: string[]; maxVariants?: number } = {}): RetrievalQueryPlan {
  const originalQuery = normalizeQueryText(query)
  const maxVariants = clampLimit(params.maxVariants)
  const seen = new Set<string>(originalQuery ? [originalQuery.toLowerCase()] : [])
  const variants: string[] = []
  let variantLimitHit = false
  for (const v of Array.isArray(params.variants) ? params.variants : []) {
    const normalized = normalizeQueryText(v, QUERY_VARIANT_MAX_CHARS)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (variants.length >= maxVariants) { variantLimitHit = true; continue }
    variants.push(normalized)
  }
  const effectiveQueries = [originalQuery, ...variants].filter(Boolean)
  const lexicalTerms = Array.from(new Set(effectiveQueries.flatMap((q) => tokenizeRetrievalQuery(q))))
  return { originalQuery, variants, effectiveQueries, lexicalTerms, variantLimitHit }
}

function clampLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return QUERY_VARIANT_DEFAULT_LIMIT
  return Math.max(1, Math.min(QUERY_VARIANT_HARD_LIMIT, Math.floor(parsed)))
}

/**
 * 用 LLM 生成查询变体（实际调用由调用方注入——DSH 的 LlmRuntime.stream 签名
 * 因 Message 结构差异不便直接传，统一走 ml.ts streamText 封装的 runner）。
 * 失败/超时 → 返回 null（调用方降级 buildRetrievalQueryPlan）。
 *
 * @param runner 生成变体的可调用：入参 question+paperTitle，返回变体数组或 null。
 */
export async function resolveQueryPlanWithLLM(params: {
  runner: (q: { query: string; paperTitle?: string }) => Promise<string[] | null>
  query: string
  paperTitle?: string
}): Promise<string[] | null> {
  const q = String(params.query ?? '').trim()
  if (!q || isPlainReadCommand(q)) return null
  try {
    const variants = await params.runner({ query: q, paperTitle: params.paperTitle })
    return Array.isArray(variants) && variants.length 
      ? variants.map((v) => String(v ?? '').trim()).filter((v) => v.length >= 2).slice(0, QUERY_VARIANT_DEFAULT_LIMIT)
      : null
  } catch {
    return null
  }
}

/** 查询计划磁盘缓存（cacheDir/queryplans.json, key = sha1(query)[:16]）。 */
export function planCacheKey(query: string): string {
  return createHash('sha1').update(query.trim().toLowerCase()).digest('hex').slice(0, 16)
}