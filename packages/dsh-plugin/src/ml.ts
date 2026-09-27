/**
 * dsh-zotero — LLM helper: resolve the platform default model and stream a
 * one-shot completion through the DSH LLM service (reuse the model adapter,
 * no self-built endpoint config — per the aligned plan).
 */
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export interface ResolvedModel {
  provider: string
  model: string
  reasoningEffort?: string
}

export function resolveModel(
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined,
  fallback?: ResolvedModel,
): ResolvedModel {
  if (agentDefaultModel) {
    try {
      const sel = agentDefaultModel.currentSelection()
      if (sel?.provider && sel?.model) {
        return { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort }
      }
    } catch {
      /* fall through */
    }
  }
  if (fallback?.provider && fallback?.model) return fallback
  return { provider: 'deepseek', model: 'deepseek-chat' }
}

/** Stream one completion; returns concatenated text (text-delta chunks). */
export async function streamText(
  llm: LlmService,
  model: ResolvedModel,
  opts: {
    system: string
    user: string
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  },
): Promise<string> {
  let text = ''
  const stream = llm.stream({
    provider: model.provider,
    model: model.model,
    system: opts.system,
    messages: [
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: opts.user }],
      }),
    ],
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 4096,
    signal: opts.signal,
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text.trim()
}
