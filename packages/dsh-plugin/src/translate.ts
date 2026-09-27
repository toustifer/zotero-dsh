/**
 * dsh-zotero — host-side shared translation used by the panel 划词即时翻译
 * route (`POST /translate`) and potentially by the agent tools.
 *
 * Single LLM path (ml.ts streamText + DSH model adapter), paper-context
 * injection (Paper Title + Abstract, cf. zotero-pdf-translate llmPrompt.ts),
 * and a disk cache keyed by sha1(targetLang + sourceLang + text) in cacheDir.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type LlmService from '@deepseek-ai/dsh-llm'
import type { ZoteroClient } from './zotero/client.ts'
import type { Config } from './config.ts'
import type { ResolvedModel } from './ml.ts'
import { resolveModel, streamText } from './ml.ts'
import { resolveCacheDir } from './mineru/cache.ts'
import { currentConfig } from './runtime.ts'

/** 与 tools-m2.ts 的 DEFAULT_TRANSLATE_PROMPT 保持一致（学术界通用措辞）。 */
export const DEFAULT_TRANSLATE_PROMPT = `你是学术文献翻译助手。把用户提供的文献文本翻译为目标语言：
- 忠实于原文语义与术语；公式/代码/符号保持原样；数字不得改动。
- 保留 Markdown 结构（标题层级、列表、引用块标记）。
- 只输出译文本身，不要附加解释或“以下是翻译”之类的开头。`

const MAX_CACHE_ENTRIES = 2000

export interface TranslateOpts {
  llm: LlmService
  agentDefaultModel?: { currentSelection(): ResolvedModel } | undefined
  client?: ZoteroClient
  text: string
  itemKey?: string
  targetLang?: string
  sourceLang?: string
  signal?: AbortSignal
}

export interface TranslateResult {
  ok: boolean
  text: string
  cached: boolean
  sourceLang: string
  targetLang: string
  chars: number
  error: string
  hint: string
}

interface TranslationEntry { text: string; at: number }

function cacheFile(cfg: Config): string {
  const dir = resolveCacheDir(cfg)
  try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  return join(dir, 'translations.json')
}

type TranslationCache = Record<string, TranslationEntry>

function loadCache(cfg: Config): TranslationCache {
  try {
    const f = cacheFile(cfg)
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as TranslationCache
  } catch { /* corrupt cache → 重建 */ }
  return {}
}

function saveCache(cfg: Config, cache: TranslationCache): void {
  const keys = Object.keys(cache)
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys
      .sort((a, b) => (cache[a]?.at ?? 0) - (cache[b]?.at ?? 0))
      .slice(0, keys.length - MAX_CACHE_ENTRIES)
      .forEach((k) => { delete cache[k] })
  }
  try {
    const f = cacheFile(cfg)
    const tmp = `${f}.tmp`
    writeFileSync(tmp, JSON.stringify(cache), 'utf8')
    renameSync(tmp, f)
  } catch { /* best-effort */ }
}

export function translationCacheKey(text: string, targetLang: string, sourceLang: string): string {
  return createHash('sha1').update(`${targetLang}\u0000${sourceLang}\u0000${text}`).digest('hex')
}

/** 单块翻译（不负责分块；分块决策在调用方/client）。 */
export async function translateText(opts: TranslateOpts): Promise<TranslateResult> {
  const cfg = currentConfig()
  const fail = (error: string): TranslateResult => ({
    ok: false, text: '', cached: false, sourceLang: opts.sourceLang?.trim() || 'auto',
    targetLang: opts.targetLang?.trim() || cfg.translateTargetLang || 'zh', chars: 0, error, hint: '',
  })
  const text = String(opts.text ?? '').trim()
  if (!text) return fail('空文本')
  const targetLang = opts.targetLang?.trim() || cfg.translateTargetLang || 'zh'
  const sourceLang = opts.sourceLang?.trim() || ''

  const key = translationCacheKey(text, targetLang, sourceLang)
  const cache = loadCache(cfg)
  const hit = cache[key]
  if (hit) {
    return {
      ok: true, text: hit.text, cached: true, sourceLang: sourceLang || 'auto',
      targetLang, chars: text.length, error: '', hint: '',
    }
  }

  try {
    const model = resolveModel(opts.agentDefaultModel)
    const system = cfg.translatePrompt.trim() || DEFAULT_TRANSLATE_PROMPT
    let payload = text
    if (opts.itemKey && opts.client) {
      // 论文上下文注入（cf. zotero-pdf-translate llmPrompt.ts）：标题+摘要调术语感。
      let context = ''
      try {
        const got = await opts.client.scoped().getItem(opts.itemKey)
        const item = ((got as { item?: unknown })?.item ?? got) as { title?: string; abstractNote?: string }
        if (item?.title) context += `Paper Title: ${item.title}`
        if (item?.abstractNote) context += (context ? '\n\n' : '') + `Paper Abstract: ${item.abstractNote}`
      } catch { /* 拿不到上下文不影响翻译 */ }
      if (context) payload = `Context from the academic paper:\n${context}\n\nText to translate: ${payload}`
    }
    const user = `源语言: ${sourceLang || '自动识别'}\n目标语言: ${targetLang}\n\n待翻译文本：\n---\n${payload}\n---`
    const translation = await streamText(opts.llm, model, { system, user, signal: opts.signal, maxTokens: 8192 })
    if (!translation) return fail('模型返回空结果')
    cache[key] = { text: translation, at: Date.now() }
    saveCache(cfg, cache)
    return {
      ok: true, text: translation, cached: false, sourceLang: sourceLang || 'auto',
      targetLang, chars: text.length, error: '', hint: '',
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err
    return fail(String(err?.message ?? err))
  }
}
