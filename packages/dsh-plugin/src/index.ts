/**
 * @dsh-external/dsh-zotero — hybrid plugin host entry.
 *
 * M1: Zotero Local API connection layer + health detection + three tools
 *     (zotero_library_search / zotero_get_item / zotero_collections).
 * M2: MinerU parsing + zotero_read_pdf / zotero_summarize / zotero_translate
 *     (LLM 复用 DSH 模型适配器与默认模型，prompt 可由配置覆盖).
 * M3: panel bridge routes (library tree / item detail / read / summarize /
 *     inject-context / artifacts) consumed by the conversation.view tab.
 *
 * Architecture (see ../docs/M0-audit.md):
 *   Zotero Local API (127.0.0.1:23119, primary) → Web API fallback
 *   → MinerU parsing → disk cache; prompts/LLM reuse DSH adapters.
 */
import type { Context } from 'cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { ZoteroClient } from './zotero/client.ts'
import { registerZoteroTools } from './tools.ts'
import { registerM2Tools } from './tools-m2.ts'
import { Config } from './config.ts'
import type { Config as ZoteroConfig } from './config.ts'
import type { ResolvedModel } from './ml.ts'
import {
  API_PREFIX,
  PLUGIN_ID,
  focusContextText,
  panelApiHandler,
  pushChatLog,
  settleRunning,
} from './panel-api.ts'
import { composeConfig, setActiveConfig, setBaseConfig } from './runtime.ts'

type HostContext = Context & {
  tools: { register(tool: unknown): void }
  llm: LlmService
  /**
   * dsh 0.1.2-alpha.1（cordis 4.0.1）：可选服务经 ctx.get 取不到（隔离作用域），
   * 官方姿势（见 dsh-cae-agent index.d.ts 注释）是把 webServer 声明进 inject，
   * 作为 ctx 上下文属性使用（"a nested ctx.inject was not firing"）。
   */
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: unknown, res: unknown) => void | Promise<void>
    }): () => void
  }
  get(name: string): unknown
  /**
   * 提示词注册表（host plane，来自 @deepseek-ai/dsh-system-prompt）。
   * 和 webServer 同样的理由写进 inject：可选服务经 ctx.get 在隔离作用域里取不到。
   */
  systemPrompt: {
    context(c: { name: string; order: number; text: () => string }): unknown
  }
}

export const name = PLUGIN_ID
export const inject = ['tools', 'llm', 'webServer', 'systemPrompt']

export { Config }

export function apply(ctx: HostContext, config: ZoteroConfig): void {
  const log = (m: string): void => {
    const line = `[dsh-zotero] ${m}`
    console.log(line)
    try {
      ctx.logger?.info?.(line)
    } catch { /* best-effort */ }
  }
  log('apply start')
  // cordis 组合配置为基底，settings.json 覆盖层在上（面板「设置」可写、热生效）。
  setBaseConfig(config)
  setActiveConfig(composeConfig())
  const active = composeConfig()

  const systemPrompt = ctx.systemPrompt
  const client = new ZoteroClient({ config: active })
  const agentDefaultModel = ctx.get('agentDefaultModel') as { currentSelection(): ResolvedModel } | undefined
  registerZoteroTools(ctx as { tools: { register(tool: unknown): void } }, client, active)
  registerM2Tools(
    ctx as { tools: { register(tool: unknown): void } },
    client,
    active,
    ctx.llm,
    agentDefaultModel,
  )
  log('tools registered')

  // Panel bridge route (host ↔ browser half)。0.1.2 按 cae-agent 范式从 inject 取 webServer。
  const webServer = ctx.webServer as
    | { register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void }
    | undefined
  log(`webServer present=${Boolean(webServer?.register)}`)
  if (webServer?.register) {
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: (req, res) =>
          panelApiHandler({
            client,
            llm: ctx.llm,
            agentDefaultModel,
            agents: ctx.get('agents'),
            sessionPersistence: ctx.get('sessionPersistence'),
            sessionController: ctx.get('sessionController'),
            workspaceController: ctx.get('workspaceController'),
            permissionPresets: ctx.get('permissionPresets'),
          })(req as never, res as never),
      })
      log(`route registered ${API_PREFIX}`)
      return () => {
        dispose()
        log('route disposed')
      }
    }, `${PLUGIN_ID}: panel api route`)
  }

  // ── 当前选中的论文 → 动态提示词上下文 ──
  // systemPrompt.context 的 text 在**每次组装**时重新求值，所以 Zotero 里换一篇
  // 选中的论文，模型下一步就看到了 —— 不需要用户点任何按钮，也不用重开会话。
  // 返回空串时会被组装层过滤掉，于是"没选中任何东西"等于什么都不注入。
  if (systemPrompt?.context) {
    ctx.effect(
      () =>
        systemPrompt.context({
          name: 'zotero:focus',
          order: 40,
          text: () => {
            try {
              return focusContextText()
            } catch {
              // 提示词组装失败会毁掉整轮对话，这里绝不把异常放出去。
              return ''
            }
          },
        }),
      `${PLUGIN_ID}: focus context`,
    )
    log('focus prompt context registered')
  } else {
    log('systemPrompt unavailable — focus context NOT registered')
  }

  // ── 文献会话消息缓存（M3.2「对话」tab 面板渲染源） ──
  // 订阅 session/event：(session, event) 两个参数（session 为对象，用 .id）。
  const toolNames = new Map<string, string>() // `${sid}:${callId}` -> tool name
  ctx.on('session/event', (session: unknown, event: any) => {
    try {
      const sid = String((session as { id?: unknown })?.id ?? '')
      if (!sid) return
      const type = String(event?.type ?? '')
      const data = event?.data ?? {}
      if (type === 'user/message') {
        // 只显示人类消息（注入的 plugin 上下文/续接不刷屏）。
        if (String(data?.source?.kind ?? '') !== 'user') return
        const text = extractText(data?.content)
        if (text) pushChatLog(sid, { kind: 'user', text, at: Date.now() })
      } else if (type === 'assistant/chunk') {
        const chunk = data?.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          pushChatLog(sid, { kind: 'assistant', text: chunk.text, running: true, at: Date.now() })
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
          pushChatLog(sid, { kind: 'assistant', text: '', reasoning: chunk.text, running: true, at: Date.now() })
        }
      } else if (type === 'assistant/message') {
        // content 拆分：reasoning 块 → reasoning 字段（浮窗折叠显示）；text 块 → 正文。
        const text = extractText(data?.message?.content?.filter((b: any) => b?.type === 'text'))
        const reasoning = extractText(data?.message?.content?.filter((b: any) => b?.type === 'reasoning'))
        if (text || reasoning) {
          pushChatLog(sid, {
            kind: 'assistant',
            text,
            ...(reasoning ? { reasoning } : {}),
            running: false,
            at: Date.now(),
          })
        }
      } else if (type === 'tool/call') {
        const callId = String(data?.callId ?? '')
        const name = String(data?.name ?? 'tool')
        if (callId) toolNames.set(`${sid}:${callId}`, name)
        pushChatLog(sid, { kind: 'tool', name, text: '', running: true, ok: undefined, at: Date.now() })
      } else if (type === 'tool/result') {
        const block = data?.message?.content?.[0]
        const callId = String(data?.message?.source?.callId ?? block?.toolCallId ?? '')
        const name = toolNames.get(`${sid}:${callId}`) ?? 'tool'
        const ok = !block?.isError && !data?.error
        pushChatLog(sid, { kind: 'tool', name, text: '', running: false, ok, at: Date.now() })
      } else if (type === 'turn/end') {
        // turn 结束（含 cancel/失败/完成）：复位该会话所有 running 标记，UI 停止闪烁。
        settleRunning(sid)
      }
    } catch { /* 事件缓存是尽力而为 */ }
  })

  ctx.logger?.info?.(`${PLUGIN_ID}: mounted (local API base=${client.localBase()})`)
  log('apply done')
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.text ? String(c.text) : ''))
      .join('')
      .trim()
  }
  return ''
}
