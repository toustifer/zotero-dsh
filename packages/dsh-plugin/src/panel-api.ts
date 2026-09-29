/**
 * dsh-zotero — panel bridge API (host half).
 *
 * Routes under /@dsh-external/dsh-zotero/api used by the browser half (M3):
 *   GET  /status             connection health (M1)
 *   GET  /verify             health + search sample + collections roots
 *   GET  /tree               collections (flat) + recent items
 *   GET  /item?key=          item detail (children included)
 *   GET  /read?itemKey=      parse → cache (pdftotext/MinerU) + preview
 *   GET  /summarize?itemKey= LLM overview/targeted summary (DSH model)
 *   POST /inject-context     push paper context into the current conversation
 *   GET  /config             plugin config snapshot (secrets masked)
 *   GET/POST /artifacts      产出物区（库内 JSON 持久化）
 * M3.2 文献聊天（独立浮动窗口 + 每篇论文一个会话 + History）：
 *   GET  /chat-sessions     History（论文会话 + 文献库会话）
 *   POST /chat-open         打开/复用论文会话（注入全文，可选发精读指令）
 *   POST /chat-open-library 打开/复用文献库会话（注入库级引导）
 *   POST /chat-send         发消息（冷会话自动恢复）
 *   GET  /chat-messages     文献会话消息缓存（host session/event 订阅累积）
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ZoteroClient } from './zotero/client.ts'
import type { Config as ZoteroConfig } from './config.ts'
import type { ResolvedModel } from './ml.ts'
import { ensureParsed, runSummary } from './tools-m2.ts'
import { resolveCacheDir } from './mineru/cache.ts'
import { translateText } from './translate.ts'
import {
  cancelFullTranslate,
  fullTranslateStatus,
  pauseFullTranslate,
  resumeFullTranslate,
  setFullTranslateRuntime,
  startFullTranslate,
} from './fulltranslate.ts'
import { cancelPdf2zh, findOutput, pdf2zhConfigured, startPdf2zh, statusPdf2zh } from './pdf2zh.ts'
import {
  cancelMineruBatch,
  clearMineruCache,
  mineruJob,
  mineruOverview,
  startMineruBatch,
  testMineruConnection,
} from './mineru-manager.ts'
import { retrieveEvidence, formatEvidencePack } from './retrieval/service.ts'
import { resolveModel, streamText } from './ml.ts'
import { composeConfig, currentConfig, setActiveConfig, writeOverlay } from './runtime.ts'
import { annotateItem } from './backend/annotations.ts'
import {
  bindConversation,
  bindMember,
  cwdForSession,
  deleteGroup,
  groupsOfPaper,
  isZone,
  linkPapers,
  membershipsOfPaper,
  neighborsOfPaper,
  projectSnapshot,
  resolveGroup,
  setMemberStatus,
  unbindMember,
  unlinkPapers,
  upsertGroup,
  getWorkspaceTarget,
  setWorkspaceTarget,
} from './project-map.ts'

export const PLUGIN_ID = '@dsh-external/dsh-zotero'
export const API_PREFIX = '/@dsh-external/dsh-zotero/api'

const READ_PROMPT =
  '「Zotero 开读」——请以精读模式阅读上面注入的论文：先一句话概述核心贡献，再按章节提炼要点（方法/关键结果/局限），最后给 3 个可深入追问的问题。信息不足时用 zotero_retrieve 按问题检索最相关章节证据（快、省 token），或 zotero_read_fulltext 分段读取缓存全文（先免参拿 sections 章节偏移，再按 offset 精读各章），或用 zotero_summarize 补定向总结。'

const QUOTE_ASK_PROMPT =
  '请解读我刚刚从 Zotero 里送进来的这段选段：它在说什么，关键概念/公式/数字分别是什么，和本文主旨是什么关系。选段若被截断或缺少上下文，先指出缺什么，再给判断。需要更完整的上下文时用 zotero_retrieve 按问题检索相关章节。'

const LIBRARY_MODE_PROMPT =
  '你是 Zotero 文献库精读助手。用户会问本库文献的问题：先用 zotero_library_search（支持全文 qmode=everything）找到相关论文，再用 zotero_retrieve（按问题检索单篇论文内最相关章节证据，快且省 token）/ zotero_read_fulltext（读取缓存全文——先免参调用拿 sections 章节偏移，再按 offset/limit 分段精读）/ zotero_read_pdf（预览）/ zotero_summarize(zotero_translate) 深读，最后给出结构化回答（引用具体论文标题/年份/关键数字，引文标注章节）。一次不要读取超过 2 篇全文，保持回答有据可查。若库内有 zotero_search 工具（zotero-wave-rag），多篇/语义主题检索优先用它。\n\n分析能力（复刻 llm-for-zotero）：单篇总结 zotero_summarize（mode=overview|targeted|deep，depth=brief|standard|deep）；多篇 zotero_batch_summarize（2-10 篇批量总结+横向对比）；跨篇综述 zotero_review（itemKeys 或 query 自动收论文 → 要点提炼 → 综述）；相关文献 zotero_related（关键词重叠，零 LLM）。遇到“比较/总结这几篇”“写个综述”“找相关文献”类需求优先用它们。'

const SECRET_FIELDS = new Set(['localApiKey', 'webApiKey', 'mineruCloudApiKey', 'pdf2zhApiKey'])

/**
 * 每个会话最近一次从 Zotero 送进来的选段。
 *
 * 面板的 composer 卡（`conversation.input.dock`）读它，再经 `inputActions.setDraft`
 * 追加到输入框 —— 那是 DSH 唯一一个"把外部文本写进草稿"的公开接口。
 * 只留最近一条：这块是"刚送进来的那句话"，不是历史列表。
 */
const lastQuoteBySession = new Map<
  string,
  { page: string; text: string; ask: boolean; at: number; title: string; itemKey: string; locator: Record<string, unknown> | null }
>()

/**
 * Zotero 此刻选中的是哪一条。
 *
 * 这是本模块唯一一个**不按会话分桶**的状态：用户在 Zotero 里点中的那条论文，
 * 对每一个 DSH 会话都成立，拿 sessionId 去分开存反而会让新会话看不到它。
 * 由 host 侧注册的动态提示词上下文读取（见 index.ts 的 zotero:focus），
 * 于是"现在在读哪篇、PDF 落在磁盘哪里"这件事不需要用户点任何按钮。
 */
export interface FocusState {
  itemKey: string
  title: string
  creators: string[]
  year: string
  collection: string
  attachmentPath: string
  page: string
  at: number
}
let lastFocus: FocusState | null = null

/** 当前选中的论文（供 host 侧提示词上下文读取）。 */
export function currentFocus(): FocusState | null {
  return lastFocus
}

/**
 * 待打开的会话：Zotero 那边点了「打开会话」，但这个请求只能告诉**服务端**会话是谁；
 * 真正把界面切过去要用浏览器里的 sessions.open()。所以服务端存一下，前端轮询取走。
 *
 * 只留一个：这是一次点击的一次跳转，不是队列。取走即清 —— 否则下次任何一次轮询
 * 都会把用户从当前会话里再拽出去一次。
 */
let pendingOpenSessionId: string | null = null

/** 供前端轮询：拿到就清。 */
export function takePendingOpen(): string | null {
  const id = pendingOpenSessionId
  pendingOpenSessionId = null
  return id
}

/** 渲染成注入给模型的运行时上下文；没选中时返回空串（空文本会被组装层丢掉）。 */
export function focusContextText(): string {
  const f = lastFocus
  if (!f || !f.itemKey) return ''
  // 超过两小时没动过就当用户已经离开这篇了 —— 免得模型拿着昨天选的那条当"当前"。
  if (Date.now() - f.at > 2 * 60 * 60 * 1000) return ''
  const lines: string[] = []
  lines.push('【当前论文 · 用户在 Zotero 里正选中这一条】')
  lines.push(`- 标题: ${f.title || '(无标题)'}`)
  if (f.creators.length) lines.push(`- 作者: ${f.creators.join(', ')}`)
  if (f.year) lines.push(`- 年份: ${f.year}`)
  if (f.collection) lines.push(`- 所在集合: ${f.collection}`)
  if (f.attachmentPath) lines.push(`- PDF: ${f.attachmentPath}`)
  if (f.page) lines.push(`- 用户当前翻到: 第 ${f.page} 页`)
  lines.push(`- Zotero key: ${f.itemKey}`)
  lines.push(
    '需要读它就走 zotero_read_pdf / zotero_read_fulltext / zotero_retrieve（itemKey 用上面这个），' +
      '不要用文件系统去翻 Zotero 的存储目录 —— 上面的 PDF 路径只是给你核对用的。',
  )
  return lines.join('\n')
}

/* ── 文献聊天（M3.2 rev4）：每篇论文支持多个对话实例 + History 分组 ───
 * conversations[] 平铺：paper 实例 sessionId = zotero-paper-<key>[-<seq>]，
 * seq 从 1 递增；library 单实例（通用）zotero-library。
 * 消息缓存仍由 host session/event 订阅累积；参考 dsh-better-sidebar。
 */

interface ChatConv {
  kind: 'paper' | 'library'
  itemKey?: string
  title: string
  sessionId: string
  seq: number
  injectedAt: number
  at: number
}

interface ChatSessionStore {
  conversations: ChatConv[]
}

const LIBRARY_SESSION_ID = 'zotero-library'

function chatStorePath(): string {
  return join(resolveCacheDir(currentConfig()), 'chat-sessions.json')
}

/** 读 + 旧格式迁移（papers[]/library → conversations[]）。 */
function readChatStore(): ChatSessionStore {
  try {
    const p = chatStorePath()
    if (!existsSync(p)) return { conversations: [] }
    const raw = JSON.parse(readFileSync(p, 'utf8')) as any
    if (Array.isArray(raw.conversations)) {
      return {
        conversations: raw.conversations.filter((x: any): x is ChatConv =>
          Boolean(x && typeof x.sessionId === 'string' && (x.kind === 'paper' || x.kind === 'library'))),
      }
    }
    // 旧格式迁移
    const convs: ChatConv[] = []
    if (Array.isArray(raw.papers)) {
      for (const pp of raw.papers) {
        if (pp && typeof pp.sessionId === 'string' && typeof pp.itemKey === 'string') {
          convs.push({
            kind: 'paper',
            itemKey: pp.itemKey,
            title: pp.title ?? pp.itemKey,
            sessionId: pp.sessionId,
            seq: 1,
            injectedAt: np(pp.injectedAt),
            at: np(pp.at),
          })
        }
      }
    }
    if (raw.library && typeof raw.library.sessionId === 'string') {
      convs.push({
        kind: 'library',
        title: '文献库对话',
        sessionId: raw.library.sessionId,
        seq: 0,
        injectedAt: np(raw.library.injectedAt),
        at: np(raw.library.at),
      })
    }
    return { conversations: convs }
  } catch {
    return { conversations: [] }
  }
  function np(v: unknown): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : Date.now()
  }
}

function writeChatStore(store: ChatSessionStore): void {
  try {
    mkdirSync(dirname(chatStorePath()), { recursive: true })
    writeFileSync(chatStorePath(), JSON.stringify(store, null, 2), 'utf8')
  } catch { /* best-effort */ }
}

/** 某论文已有实例的最大 seq（0 = 尚无）。 */
function maxPaperSeq(store: ChatSessionStore, itemKey: string): number {
  let max = 0
  for (const c of store.conversations) {
    if (c.kind === 'paper' && c.itemKey === itemKey && c.seq > max) max = c.seq
  }
  return max
}

/** 文献会话消息缓存（host session/event 订阅写入；面板轮询读取）。 */
export interface ChatLogMsg {
  kind: 'user' | 'assistant' | 'tool'
  text: string
  /** 思考过程（reasoning），浮窗折叠显示。 */
  reasoning?: string
  name?: string
  running?: boolean
  ok?: boolean
  at: number
}
const chatLogs = new Map<string, ChatLogMsg[]>()

export function pushChatLog(sessionId: string, msg: ChatLogMsg): void {
  const list = chatLogs.get(sessionId) ?? []
  const last = list[list.length - 1]
  // assistant 流式累积：chunk 追加到 running 尾部（text/reasoning 分离）；
  // 完整 message 替换该 running 条（保留流式 reasoning 累积）。
  if (msg.kind === 'assistant' && msg.running && last?.kind === 'assistant' && last.running) {
    if (msg.text) last.text += msg.text
    if (msg.reasoning) last.reasoning = (last.reasoning ?? '') + msg.reasoning
    last.at = msg.at
    chatLogs.set(sessionId, list)
    return
  }
  if (msg.kind === 'assistant' && !msg.running && msg.text && last?.kind === 'assistant' && last.running) {
    last.text = msg.text
    if (msg.reasoning) last.reasoning = msg.reasoning
    last.running = false
    last.at = msg.at
    chatLogs.set(sessionId, list)
    return
  }
  // tool/result 落定：替换同名的 running 工具行（避免重复）。
  if (msg.kind === 'tool' && !msg.running && last?.kind === 'tool' && last.running && last.name === msg.name) {
    last.running = false
    last.ok = msg.ok
    last.at = msg.at
    chatLogs.set(sessionId, list)
    return
  }
  list.push(msg)
  if (list.length > 400) list.splice(0, list.length - 400)
  chatLogs.set(sessionId, list)
}

export function chatMessages(sessionId: string): ChatLogMsg[] {
  return chatLogs.get(sessionId) ?? []
}

/** turn 结束（完成/cancel/失败）：复位该会话所有 running 标记，UI 停止闪烁。 */
export function settleRunning(sessionId: string): void {
  const list = chatLogs.get(sessionId)
  if (!list) return
  let changed = false
  for (const m of list) {
    if (m.running) {
      m.running = false
      changed = true
    }
  }
  if (changed) chatLogs.set(sessionId, list)
}

/* ── agents 服务结构类型（不依赖 @deepseek-ai/dsh-agent 类型） ── */

interface AgentLike {
  inject(msg: unknown): void
  followup(msg: unknown): void
  cancel?(cause?: unknown, opts?: unknown): void
  session?: { header?: { cwd?: string }; id?: string }
}

interface AgentsLike {
  get(id: unknown): AgentLike | undefined
  create(opts: {
    sessionId: string
    meta?: { cwd?: string; parentSession?: string; origin?: 'subagent' }
    signal?: AbortSignal
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>
  resume(opts: {
    resumeSessionId: string
    signal?: AbortSignal
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>
}

function agentsOf(deps: PanelApiDeps): AgentsLike | undefined {
  return deps.agents as AgentsLike | undefined
}

/** 文献会话权限跟随 Full access（danger-full-access），避免 approval/sandbox 拦截工具。 */
function grantFullAccess(deps: PanelApiDeps, agent: AgentLike): void {
  try {
    const svc = deps.permissionPresets as { set?(session: unknown, name: string): void } | undefined
    const session = (agent as any)?.session
    if (svc?.set && session) svc.set(session, 'danger-full-access')
  } catch { /* best-effort */ }
}

/** 文献会话可用工具集：只保留 zotero_*（防模型调用 dev/ego/fs 等环境工具自我修改）。 */
const ZOTERO_TOOL_ALLOW = [
  'zotero_health', 'zotero_library_search', 'zotero_get_item', 'zotero_collections',
  'zotero_read_pdf', 'zotero_read_fulltext', 'zotero_summarize', 'zotero_translate',
]

function restrictTools(agent: AgentLike): void {
  try {
    const tools = (agent as any)?.ctx?.get?.('tools') as
      | { restrict?(filter: { allow: string[] }): () => void }
      | undefined
    console.log(`[dsh-zotero] restrictTools: tools=${Boolean(tools)} restrict=${Boolean(tools?.restrict)} sid=${String((agent as any)?.id ?? '')}`)
    const dispose = tools?.restrict?.({ allow: ZOTERO_TOOL_ALLOW })
    console.log(`[dsh-zotero] restrictTools applied=${Boolean(dispose)}`)
  } catch (err: unknown) {
    console.log(`[dsh-zotero] restrictTools failed: ${String((err as Error)?.message ?? err)}`)
  }
}

/**
 * 激活（或恢复）一个文献会话。优先 **GUI 同款官方路径**：
 *   sessionController.create（adopt/装配 agentPreset·workspace·loop 全套）
 *   → agents.get 取 live；兜底直连 factory create / resume。
 */
async function ensureLiveAgent(
  deps: PanelApiDeps,
  sessionId: string,
  cwd?: string,
  workspaceId?: string,
): Promise<AgentLike> {
  const agents = agentsOf(deps)

  /*
   * 已经有 live agent、又不需要挂工作区时直接返回，根本不碰 controller。
   *
   * controller.create 对已存在的会话会 observe 持久化头再比对 cwd，而它在没有
   * workspaceId 时用的是 defaultCwd（= DSH_HOME）当请求值 —— 于是任何 cwd
   * 不等于 DSH_HOME 的会话（本插件的论文会话全部如此）都会抛
   * ApiSessionCwdConflict。之前每一次 Zotero 选段引用都会撞一次：日志刷满，
   * 装配还白跑。见 dsh-api-session-controller 的 createOrAdopt。
   */
  if (!workspaceId) {
    const already = agents?.get(sessionId)
    if (already) { grantFullAccess(deps, already); restrictTools(already); return already }
  }

  const sc = deps.sessionController as
    | { create?(req: { sessionId: string; cwd?: string; workspaceId?: string }): Promise<unknown> }
    | undefined
  if (sc?.create) {
    try {
      /*
       * 传 workspaceId 而不是 cwd —— sessionController.create 只在拿到 workspaceId 时
       * 才会调 workspace.attachSession()。只给 cwd 的话会话 header 里 cwd 是对的，
       * 但它不在任何工作区的 sessionIds 里，侧栏不显示、界面还会停在「选择工作区」。
       * 两者不能同时传（gateway/bad-request）。
       *
       * 没有 workspaceId 时，cwd 必须用会话**自己**记录的那个：给 defaultCwd 会撞
       * 上面的 ApiSessionCwdConflict，不给等于给 defaultCwd。只有会话还没有持久化头
       * （真的是新建）时才轮到调用方传的 cwd。
       */
      let request: { sessionId: string; cwd?: string; workspaceId?: string }
      if (workspaceId) {
        request = { sessionId, workspaceId }
      } else {
        const effective = (await persistedCwdOf(deps, sessionId)) ?? cwd
        request = { sessionId, ...(effective ? { cwd: effective } : {}) }
      }
      await sc.create(request)
    } catch (err: unknown) {
      console.log(`[dsh-zotero] sessionController.create failed (${sessionId}): ${String((err as Error)?.message ?? err)}`)
    }
  }
  const live = agents?.get(sessionId)
  console.log(`[dsh-zotero] ensureLive ${sessionId} after-controller live=${live ? String((live as any).status ?? '?') : 'none'}`)
  if (live) { grantFullAccess(deps, live); restrictTools(live); return live }
  if (!agents) throw new Error('agents 服务不可用')
  // 工作区归属冲突/已持久化会话：优先 resume（用持久化归属），避免硬 create 与现有状态打架。
  if (agents.resume) {
    try {
      const handle = await agents.resume({ resumeSessionId: sessionId, signal: AbortSignal.timeout(20000) })
      console.log(`[dsh-zotero] ensureLive ${sessionId} resumed status=${String((handle.agent as any).status ?? '?')}`)
      grantFullAccess(deps, handle.agent)
      restrictTools(handle.agent)
      return handle.agent
    } catch (err: unknown) {
      console.log(`[dsh-zotero] ensureLive ${sessionId} resume failed: ${String((err as Error)?.message ?? err)}`)
    }
  }
  if (agents.create) {
    try {
      const handle = await agents.create({
        sessionId,
        ...(cwd ? { meta: { cwd } } : {}),
        signal: AbortSignal.timeout(20000),
      })
      console.log(`[dsh-zotero] ensureLive ${sessionId} created status=${String((handle.agent as any).status ?? '?')}`)
      grantFullAccess(deps, handle.agent)
      restrictTools(handle.agent)
      return handle.agent
    } catch (err: unknown) {
      console.log(`[dsh-zotero] ensureLive ${sessionId} create failed: ${String((err as Error)?.message ?? err)}`)
    }
  }
  throw new Error(`文献会话激活失败: ${sessionId}`)
}

/**
 * 把一段 plugin 上下文注入会话。
 *
 * 必须用 createUserMessage 造完整的 UserMessage —— inject() 的签名就是
 * `inject(message: UserMessage)`，而要落盘成 user/message 事件，DSH 的校验器
 * 会检查 role 与 id（见 dsh-session 的 assertMessageEventShape）。早先这里只传了
 * { content, source }，写出来的事件没有 id 和 role，会话本身当场能用 ——
 * 但下一次重新加载时整条会被判为 corrupt：
 *   `session event at seq N lacks an identified message`
 * 也就是「历史加载失败」。
 */
function injectText(agent: AgentLike, text: string): void {
  agent.inject(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  }))
}

/**
 * 注入一段 plugin 文本，带一次「陈旧 pending」兜底。
 *
 * agent.inject 在会话里压着一条没被消费的用户消息时直接抛
 * "message ... is already pending"。那种残留多半来自上一次 DSH 重启，
 * 或一次中途失败的投递 —— 而 openPaperChatSession 里没有兜底，
 * 于是**整条**打开论文会话的链路就断在这里，面板那边只看到一个 error，
 * 对话框是空的。这里清一次 stale 再试，和 deliverChatMessage 同一套做法。
 */
function injectTextResilient(agent: AgentLike, text: string, deps: PanelApiDeps, sessionId: string): void {
  try {
    injectText(agent, text)
    return
  } catch (err: unknown) {
    console.log(
      `[dsh-zotero] inject failed (${sessionId}): ${String((err as Error)?.message ?? err)} — clearing stale pending and retrying`,
    )
  }
  try {
    const stale = agentsOf(deps)?.get(sessionId)
    if (stale?.cancel) stale.cancel({ kind: 'user' }, { keepInbox: false })
  } catch { /* 清理是尽力而为 */ }
  injectText(agent, text)
}

function followupText(agent: AgentLike, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

/**
 * 发送用户消息到文献会话（GUI 同款路径）：
 *  1) sessionController.prompt（mode:'queue'，进 inbox + wake driver，GUI 输入同语义）
 *  2) 降级：agents.followup（老路径，部分场景不 wake）
 *  @returns 使用的路径名（'controller' | 'agent'）
 */
async function deliverChatMessage(deps: PanelApiDeps, sessionId: string, text: string): Promise<'controller' | 'agent'> {
  const sc = deps.sessionController as
    | { prompt?(req: { sessionId: string; mode: string; content: Array<{ type: string; text: string }>; requestId: string }, signal?: AbortSignal): Promise<unknown> }
    | undefined
  if (sc?.prompt) {
    // 先清一次遗留 pending（历史 stale 消息常导致 "already pending" 卡死）。
    try {
      const existing = agentsOf(deps)?.get(sessionId)
      if (existing?.cancel) existing.cancel({ kind: 'user' }, { keepInbox: false })
    } catch { /* best-effort */ }
    // 首轮可能因 agent 刚 create 仍处初始化锁（"already pending"），短退避后重试一次。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await sc.prompt({
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          requestId: `dshz-${crypto.randomUUID()}`,
        }, AbortSignal.timeout(10000))
        return 'controller'
      } catch (err: unknown) {
        const msg = String((err as Error)?.message ?? err)
        const isPending = /already pending|is pending/i.test(msg)
        console.log(`[dsh-zotero] prompt via controller failed (${sessionId}) attempt=${attempt}: ${msg}`)
        if (!isPending || attempt === 1) break
        await new Promise((r) => setTimeout(r, 400))
      }
    }
  }
  const agents = agentsOf(deps)
  if (!agents) throw new Error('agents 服务不可用')
  const agent = await ensureLiveAgent(deps, sessionId, undefined)
  followupText(agent, text)
  return 'agent'
}

/** 从 body.parent（主会话 id）解析 cwd：live agent 直读，冷会话走 sessionPersistence.inspect。 */
async function parentCwdOf(deps: PanelApiDeps, body: Record<string, unknown>): Promise<string | undefined> {
  const parent = String(body.parent ?? '')
  if (!parent) return undefined
  try {
    const agent = agentsOf(deps)?.get(parent)
    const cwd = agent?.session?.header?.cwd
    if (cwd) return cwd
  } catch { /* fall through */ }
  try {
    const persistence = deps.sessionPersistence as
      | { inspect?(id: string): Promise<{ meta?: { cwd?: string } } | undefined> }
      | undefined
    const inspected = await persistence?.inspect?.(parent)
    if (inspected?.meta?.cwd) return inspected.meta.cwd
  } catch { /* fall through */ }
  return undefined
}

/**
 * 一个会话持久化头里记的 cwd。
 *
 * 存在的理由是 sessionController.create 的 adopt 语义：已存在的会话必须用**它自己**
 * 的 cwd 去 adopt，否则抛 ApiSessionCwdConflict（见 ensureLiveAgent 的注释）。
 * 没有 workspaceId 可传的调用点因此都得先问这里。会话还没落盘时返回 undefined，
 * 由调用方决定新建的 cwd。
 */
async function persistedCwdOf(deps: PanelApiDeps, sessionId: string): Promise<string | undefined> {
  try {
    const cwd = agentsOf(deps)?.get(sessionId)?.session?.header?.cwd
    if (cwd) return String(cwd)
  } catch { /* fall through */ }
  try {
    const persistence = deps.sessionPersistence as
      | { inspect?(id: string): Promise<{ meta?: { cwd?: string } } | undefined> }
      | undefined
    const inspected = await persistence?.inspect?.(sessionId)
    if (inspected?.meta?.cwd) return String(inspected.meta.cwd)
  } catch { /* fall through */ }
  return undefined
}

/** 打开（或新建）某论文的一个对话实例：seq 指定则复用该实例，否则新建（seq=max+1）。
 * 新实例总是注入全文（各实例上下文独立）；sendRead 追加精读指令。 */
export async function openPaperChatSession(
  deps: PanelApiDeps,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; sessionId?: string; seq?: number; chars?: number; error?: string; cwd?: string; isNew?: boolean }> {
  const agents = agentsOf(deps)
  if (!agents?.create && !agents?.resume) return { ok: false, error: 'agents 服务不可用' }
  let itemKey = String(body.itemKey ?? '')
  if (!itemKey) return { ok: false, error: '需要 itemKey' }
  try {
    const normalized = await deps.client.scoped().getItem(itemKey)
    if (normalized.found && normalized.item?.key) itemKey = normalized.item.key
  } catch { /* 下游会给出原始 key 的具体错误 */ }
  const title = String(body.title ?? '') || itemKey
  const store = readChatStore()
  let conv: ChatConv | undefined
  const reqSeq = Number(body.seq ?? 0)
  if (reqSeq > 0) {
    conv = store.conversations.find((c) => c.kind === 'paper' && c.itemKey === itemKey && c.seq === reqSeq)
  }
  const isNew = !conv
  if (!conv) {
    const seq = maxPaperSeq(store, itemKey) + 1
    conv = {
      kind: 'paper',
      itemKey,
      title,
      sessionId: seq === 1 ? `zotero-paper-${itemKey}` : `zotero-paper-${itemKey}-${seq}`,
      seq,
      injectedAt: 0,
      at: Date.now(),
    }
  }
  const sessionId = conv.sessionId

  // ── M4 v2 cwd 解析：显式 → 会话已绑组 → 该论文在指定区的组 → 继承父会话（旧行为）──
  // zone 由调用方给出（Zotero 侧从论文点开时知道自己是调研还是研究），
  // 同一篇论文在两个区各开一次就是两个组、两个 cwd —— 重叠在会话层不冲突。
  const wantZone = isZone(body.zone) ? (body.zone as 'survey' | 'research') : undefined
  const group = resolveGroup({
    sessionId,
    itemKey,
    ...(body.groupId ? { groupId: String(body.groupId) } : {}),
    ...(wantZone ? { zone: wantZone } : {}),
  })
  const cwd = String(body.cwd ?? '')
    || cwdForSession(sessionId)
    || group?.cwd
    || (await parentCwdOf(deps, body))
  // 落到组的会话登记归属，面板据此把会话挂到区/组树下。
  if (group) {
    try { bindConversation({ sessionId, groupId: group.id, itemKey }) } catch { /* 归属是尽力而为 */ }
  }
  console.log(`[dsh-zotero] chat-open itemKey=${itemKey} seq=${conv.seq} parent=${String(body.parent ?? '')} zone=${wantZone ?? '-'} group=${group?.id ?? 'none'} cwd=${JSON.stringify(cwd)}`)

  let agent: AgentLike
  try {
    agent = await ensureLiveAgent(deps, sessionId, cwd)
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }

  let chars = 0
  if (!conv.injectedAt || body.force) {
    const built = await buildPaperContext(deps, { ...body, itemKey })
    if (!built.ok) return { ok: false, sessionId, error: built.error ?? '构建论文上下文失败' }
    injectTextResilient(agent, built.text, deps, sessionId)
    chars = built.text.length
    conv.injectedAt = Date.now()
  }
  conv.at = Date.now()
  if (body.title) conv.title = String(body.title)
  writeChatStore({
    conversations: [
      ...store.conversations.filter((c) => !(c.kind === 'paper' && c.itemKey === itemKey && c.seq === conv.seq)),
      conv,
    ],
  })
  if (body.sendRead) {
    const via = await deliverChatMessage(deps, sessionId, READ_PROMPT)
    console.log(`[dsh-zotero] sendRead via=${via}`)
  }
  return { ok: true, sessionId, seq: conv.seq, chars, cwd: cwd ?? '', isNew }
}

/** 库会话已有实例的最大 seq（旧格式 seq=0 视为 1）。 */
function maxLibrarySeq(store: ChatSessionStore): number {
  let max = 0
  for (const c of store.conversations) {
    if (c.kind === 'library') max = Math.max(max, c.seq === 0 ? 1 : c.seq)
  }
  return max
}

/** 打开「文献库对话」实例：fresh=true 总是新建（seq=max+1）；否则复用最近实例；seq>0 复用指定实例。
 * 新实例总是注入库级引导（LIBRARY_MODE_PROMPT）；sendIntro 追加开场白。 */
export async function openLibraryChatSession(
  deps: PanelApiDeps,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; sessionId?: string; seq?: number; chars?: number; error?: string; isNew?: boolean }> {
  const agents = agentsOf(deps)
  if (!agents?.create && !agents?.resume) return { ok: false, error: 'agents 服务不可用' }
  const cwd = String(body.cwd ?? '') || (await parentCwdOf(deps, body))
  const store = readChatStore()
  let conv: ChatConv | undefined
  const reqSeq = Number(body.seq ?? 0)
  if (reqSeq > 0) {
    conv = store.conversations.find((c) => c.kind === 'library' && c.seq === reqSeq)
  } else if (!body.fresh) {
    const sorted = store.conversations.filter((c) => c.kind === 'library').sort((a, b) => b.seq - a.seq)
    conv = sorted[0]
  }
  const isNew = !conv
  if (!conv) {
    const seq = maxLibrarySeq(store) + 1
    conv = {
      kind: 'library',
      title: '文献库对话',
      sessionId: seq === 1 ? LIBRARY_SESSION_ID : `${LIBRARY_SESSION_ID}-${seq}`,
      seq,
      injectedAt: 0,
      at: Date.now(),
    }
  }
  const sessionId = conv.sessionId

  let agent: AgentLike
  try {
    agent = await ensureLiveAgent(deps, sessionId, cwd)
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }

  let chars = 0
  if (!conv.injectedAt || body.force || isNew) {
    injectText(agent, `【Zotero 文献库对话模式】\n${LIBRARY_MODE_PROMPT}`)
    chars = LIBRARY_MODE_PROMPT.length
    conv.injectedAt = Date.now()
  }
  conv.at = Date.now()
  writeChatStore({
    conversations: [
      ...store.conversations.filter((c) => !(c.kind === 'library' && c.seq === conv.seq)),
      conv,
    ],
  })
  if (body.sendIntro) {
    await deliverChatMessage(deps, sessionId, '你好！请先简单介绍你能做什么，并给我 3 个可立即使用的示例问题。')
  }
  return { ok: true, sessionId, seq: conv.seq, chars, isNew }
}

/** 向文献会话发送一条消息（冷会话自动恢复；@papers 逐个注入元数据/全文）。 */
export async function sendChatMessage(
  deps: PanelApiDeps,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; chars?: number; error?: string }> {
  const agents = agentsOf(deps)
  if (!agents) return { ok: false, error: 'agents 服务不可用' }
  const sessionId = String(body.sessionId ?? '')
  const text = String(body.text ?? '').trim()
  if (!sessionId || !text) return { ok: false, error: '需要 sessionId + text' }
  let agent: AgentLike
  try {
    agent = await ensureLiveAgent(deps, sessionId, String(body.cwd ?? '') || undefined)
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
  try {
    // @论文 引用：发送前逐个注入（pdf=全文精读模式 qa，meta=元数据+摘要；
    // ragEnabled 或带具体问题时用检索召回模式 rag——按用户问题检索证据注入，省 token 且更相关）。
    const papers = Array.isArray(body.papers) ? (body.papers as Array<Record<string, unknown>>) : []
    const text = String(body.text ?? '').trim()
    const useRag = body.rag === true || body.rag === 'true' || Boolean(currentConfig().ragEnabled)
    let chars = 0
    for (const p of papers.slice(0, 4)) {
      const itemKey = String(p?.itemKey ?? '')
      if (!itemKey) continue
      const mode = p.mode === 'pdf' ? (useRag && text ? 'rag' : 'qa') : 'meta'
      const built = await buildPaperContext(deps, { ...body, itemKey, mode, ...(mode === 'rag' ? { query: text } : {}) })
      if (built.ok) {
        // agent.inject 对「正在消费的注入」会报 already pending（open 已注入正文而未消费时二次注入触发）。
        // 此时跳过重复注入，只发用户消息；会话上下文里已有元数据/可调工具。
        try {
          injectText(agent, built.text)
          chars += built.chars
        } catch (err: unknown) {
          const m = String((err as Error)?.message ?? err)
          if (/already pending|is pending/i.test(m)) {
            console.log(`[dsh-zotero] skip inject for ${itemKey} (pending): ${m}`)
          } else {
            throw err
          }
        }
      }
    }
    const via = await deliverChatMessage(deps, sessionId, text)
    console.log(`[dsh-zotero] chat-send via=${via} session=${sessionId}`)
    return { ok: true, chars }
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** 文献会话模型选择（sessionController.selectModel；跟随 GUI 语义）。 */
export async function selectChatModel(
  deps: PanelApiDeps,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const sc = deps.sessionController as
    | { selectModel?(req: Record<string, unknown>): Promise<{ selected: unknown }> }
    | undefined
  if (!sc?.selectModel) return { ok: false, error: '模型切换服务不可用（sessionController）' }
  try {
    await sc.selectModel({
      sessionId: String(body.sessionId ?? ''),
      provider: String(body.provider ?? ''),
      model: String(body.model ?? ''),
      ...(body.reasoningEffort ? { reasoningEffort: String(body.reasoningEffort) } : {}),
    })
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/** 可用模型目录（provider → models）+ 当前选择。 */
export async function chatModels(deps: PanelApiDeps): Promise<{
  providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }>
  current: { provider: string; model: string; reasoningEffort?: string } | null
}> {
  let current: { provider: string; model: string; reasoningEffort?: string } | null = null
  try {
    const sel = deps.agentDefaultModel?.currentSelection()
    if (sel?.provider && sel?.model) {
      current = { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}) }
    }
  } catch { /* ignore */ }
  const providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }> = []
  try {
    const llm = deps.llm as unknown as {
      listProviders?(): Array<{ id: string; name: string }>
      listModels?(provider: string): Promise<Array<{ id: string; name: string; description?: string }>>
    }
    const list = llm?.listProviders?.() ?? []
    // 并发 + 每 provider 5s 超时：单个 provider 挂起不再拖垮整个下拉。
    const withTimeout = <T>(p: Promise<T>): Promise<T | null> =>
      Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 5000))])
    const settled = await Promise.allSettled(list.map(async (p) => {
      let models: Array<{ id: string; name: string; description?: string }> = []
      try {
        const got = await withTimeout(llm.listModels?.(p.id) ?? Promise.resolve([]))
        models = (got ?? []).map((m) => ({ id: m.id, name: m.name, ...(m.description ? { description: m.description } : {}) }))
      } catch { /* provider 不可用则跳过模型 */ }
      return { id: p.id, name: p.name, models }
    }))
    for (const s of settled) {
      if (s.status === 'fulfilled') providers.push(s.value)
    }
  } catch { /* 目录失败返回空 */ }
  return { providers, current }
}

export interface PanelApiDeps {
  client: ZoteroClient
  llm: LlmService
  agentDefaultModel: { currentSelection(): ResolvedModel } | undefined
  /** Host agent service (optional) — used by /inject-context. */
  agents: unknown
  /** Host session persistence (optional) — 冷会话 cwd 解析（chat-open）。 */
  sessionPersistence?: unknown
  /** Host session controller (optional) — 文献会话模型选择（chat-select-model）。 */
  sessionController?: unknown
  /** Host permission presets (optional) — 文献会话权限提升（danger-full-access）。 */
  permissionPresets?: unknown
  /** Host workspace registry (optional) — 把「组」落成真实 DSH 工作区。 */
  workspaceController?: unknown
}

export interface PanelRouteHandler {
  (req: { url?: string; method?: string; body?: string; headers?: Record<string, string | string[] | undefined> }, res: { writeHead(status: number, headers: Record<string, string>): unknown; end(body: string): unknown }): Promise<void> | void
}

export function panelApiHandler(deps: PanelApiDeps): PanelRouteHandler {
  setFullTranslateRuntime(deps.client ?? null, deps.llm ?? null, deps.agentDefaultModel)
  return (req, res) => void handle(req, res, deps)
}

async function handle(
  req: { url?: string; method?: string; body?: string; headers?: Record<string, string | string[] | undefined> },
  res: Res,
  deps: PanelApiDeps,
): Promise<void> {
  const [fullPath, queryString] = (req.url ?? '').split('?')
  const path = fullPath.startsWith(API_PREFIX) ? fullPath.slice(API_PREFIX.length) || '/' : fullPath
  const query = new URLSearchParams(queryString ?? '')
  const { client, llm, agentDefaultModel } = deps
  if (req.method === 'POST') {
    req.body = await readBody(req as never)
  }

  try {
    if (req.method === 'GET') {
      if (path === '/status') return send(res, 200, await healthOf(client))
      if (path === '/verify') return send(res, 200, await verifyOf(client))
      if (path === '/tree') return send(res, 200, await treeOf(client, query))
      if (path === '/item' && query.get('key')) return send(res, 200, await client.scoped().getItem(query.get('key')!))
      if (path === '/read' && query.get('itemKey')) return send(res, 200, await readOf(client, query))
      if (path === '/summarize' && query.get('itemKey')) {
        return send(res, 200, await runSummary(client, currentConfig(), llm, agentDefaultModel, {
          itemKey: query.get('itemKey')!,
          attachmentKey: query.get('attachmentKey') ?? undefined,
          mode: query.get('mode') ?? 'overview',
          query: query.get('query') ?? undefined,
        }, undefined).then((r) => {
          if (r.status === 'ok') appendArtifact(currentConfig(), { type: 'summary', title: r.title || query.get('itemKey')!, payload: r.summary.slice(0, 4000) })
          return r
        }))
      }
      if (path === '/config') return send(res, 200, maskConfig(currentConfig()))
      if (path === '/chat-sessions') {
        const store = readChatStore()
        return send(res, 200, { conversations: store.conversations })
      }
      // ── M4 论文 ↔ 工作区映射（v2：调研区 / 研究区）──
if (path === '/quote/latest') {
        // 刻意不按 sessionId 过滤：选段是在 Zotero 阅读器里产生的，和用户此刻在 DSH
        // 里开的是哪个会话没有关系 —— 面板上正在写问题的那个会话就该看到它。
        const wanted = String(query.get('sessionId') ?? '')
        let best:
          | { sessionId: string; page: string; text: string; ask: boolean; at: number; title: string; itemKey: string; locator: Record<string, unknown> | null }
          | null = null
        for (const [sid, q] of lastQuoteBySession) {
          if (wanted && sid === wanted && !best) best = { sessionId: sid, ...q }
          else if (!best || q.at > best.at) best = { sessionId: sid, ...q }
        }
        return send(res, 200, { ok: true, quote: best })
      }
      // 当前选中的论文。GET 给面板自检用，POST 由 Zotero 半边在选中变化时推上来。
      // 当前论文的复现工作区自检（面板徽章 / 状态行读它）。
      if (path === '/workspace-info') return send(res, 200, await workspaceInfo(deps, query))
      if (path === '/focus') return send(res, 200, { ok: true, focus: currentFocus() })
      // 前端轮询这个：有值就切过去，取走即清。
      if (path === '/pending-open') return send(res, 200, { ok: true, sessionId: takePendingOpen() })
      if (path === '/map') return send(res, 200, projectSnapshot())
      if (path === '/map/workspaces') {
        const list = await listHostWorkspaces(deps)
        const snap = projectSnapshot()
        const byWs = new Map<string, { zone: string; groupId: string; kind: string }>()
        for (const z of snap.zones) {
          for (const g of z.groups) {
            if (g.workspaceId) byWs.set(String(g.workspaceId), { zone: z.zone.id, groupId: g.id, kind: g.kind })
          }
        }
        return send(res, 200, {
          ok: true,
          workspaces: list.map((w) => ({ ...w, ...(byWs.get(String(w.workspaceId)) ?? {}) })),
        })
      }
      if (path === '/map/of-paper' && query.get('itemKey')) {
        const itemKey = query.get('itemKey')!
        return send(res, 200, {
          groups: groupsOfPaper(itemKey),
          memberships: membershipsOfPaper(itemKey),
          neighbors: neighborsOfPaper(itemKey, (query.get('kind') as never) ?? undefined),
        })
      }
      if (path === '/chat-models') return send(res, 200, await chatModels(deps))
      if (path === '/paper-picker') {
        const q = query.get('q') ?? ''
        try {
          const r = await client.scoped().search({ query: q, limit: 8, qmode: 'titleCreatorYear' })
          return send(res, 200, {
            items: r.items.map((i) => ({ key: i.key, title: i.title, year: i.year, itemType: i.itemType })),
          })
        } catch (err: any) {
          return send(res, 200, { items: [], error: String(err?.message ?? err) })
        }
      }
      if (path === '/chat-messages' && query.get('sessionId')) {
        return send(res, 200, { messages: chatMessages(query.get('sessionId')!) })
      }
      if (path === '/annotations' && query.get('itemKey')) {
        const itemKey = query.get('itemKey')!
        try {
          const resData = await client.scoped().getItem(itemKey)
          return send(res, 200, { ok: true, annotations: resData.item?.annotations ?? [] })
        } catch (err: any) {
          return send(res, 200, { ok: false, annotations: [], error: String(err?.message ?? err) })
        }
      }
      if (path === '/pdf' && query.get('key')) {
        await streamPdf(req, res, client, query.get('key')!)
        return
      }
      if (path === '/pdfjs-worker') {
        await sendPdfJsWorker(res)
        return
      }
      if (path === '/open' && query.get('key')) {
        const attachmentKey = query.get('key')!
        const target = query.get('target') === 'system' ? 'system' : 'zotero'
        const p = await client.resolveAttachmentPath(attachmentKey)
        try {
          const { spawn } = await import('node:child_process')
          if (target === 'zotero') {
            // Zotero URL scheme：在 Zotero 内置阅读器打开该附件（正文/注释/文本选择）。
            const uri = `zotero://select/items/${attachmentKey}`
            const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
            const args = process.platform === 'win32' ? ['/c', 'start', '', uri] : [uri]
            spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
            return send(res, 200, { ok: true, target, uri, path: p ?? '' })
          }
          // System default handler (Windows start / macOS open / linux xdg-open).
          if (!p) return send(res, 200, { ok: false, error: '找不到附件文件路径' })
          const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
          const args = process.platform === 'win32' ? ['/c', 'start', '', p] : [p]
          spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          return send(res, 200, { ok: true, target, path: p })
        } catch (err: any) {
          return send(res, 200, { ok: false, error: String(err?.message ?? err), path: p ?? '' })
        }
      }
      if (path === '/artifacts') return send(res, 200, { artifacts: readArtifacts(currentConfig()) })
      if (path === '/fulltranslate/status' && query.get('attachmentKey')) {
        const r = fullTranslateStatus(query.get('attachmentKey')!)
        return send(res, 200, { ok: true, job: r.job })
      }
      if (path === '/pdf2zh/status' && query.get('attachmentKey')) {
        const job = statusPdf2zh(query.get('attachmentKey')!)
        return send(res, 200, { ok: true, configured: pdf2zhConfigured(currentConfig()), job })
      }
      if (path === '/pdf2zh/file' && query.get('attachmentKey')) {
        const files = findOutput(currentConfig(), query.get('attachmentKey')!)
        const p = query.get('type') === 'mono' ? files?.mono : files?.dual
        if (!p || !existsSync(p)) return send(res, 404, { error: '产物不存在（任务可能未完成）' })
        await streamLocalFile(req, res, p)
        return
      }
      if (path === '/mineru/overview') {
        return send(res, 200, await mineruOverview(client))
      }
      if (path === '/mineru/job') {
        return send(res, 200, { ok: true, job: mineruJob() })
      }
    }

    if (req.method === 'POST') {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(req.body ?? '{}') as Record<string, unknown>
      } catch {
        /* empty body ok */
      }
      if (path === '/open-external') {
        const urlToOpen = String(body.url ?? '').trim()
        if (!urlToOpen || !/^https?:\/\//i.test(urlToOpen)) {
          return send(res, 400, { ok: false, error: '非法或空的 URL' })
        }
        try {
          const { spawn } = await import('node:child_process')
          const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
          const args = process.platform === 'win32' ? ['/c', 'start', '', urlToOpen] : [urlToOpen]
          spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          return send(res, 200, { ok: true, url: urlToOpen })
        } catch (err: any) {
          return send(res, 500, { ok: false, error: String(err?.message ?? err) })
        }
      }
      if (path === '/inject-context') return send(res, 200, await injectContext(deps, body))
      // Zotero 集合树 → DSH 工作区（一对一镜像目录）
      if (path === '/collections/sync') return send(res, 200, await syncCollections(deps, body))
      // 单篇论文（有 PDF）→ 记录与复现用的工作区
      if (path === '/papers/workspace') return send(res, 200, await paperWorkspace(deps, body))
      // 只设目标、不建目录：把"这篇论文的复现放哪"先定下来，目录等真要跑时再落地。
      if (path === '/workspace-target') {
        const ik = String(body.itemKey ?? '').trim()
        if (!ik) return send(res, 200, { ok: false, error: '缺少 itemKey' })
        const rec = setWorkspaceTarget({
          itemKey: ik,
          dir: String(body.dir ?? '').trim() || undefined,
          remote: (body.remote as { host?: unknown; path?: unknown } | undefined)?.host
            ? { host: String((body.remote as Record<string, unknown>).host), path: String((body.remote as Record<string, unknown>).path ?? '') }
            : null,
        })
        return send(res, 200, { ok: true, target: rec ?? null })
      }
      // 只查不建：给前端徽章用，避免"看一眼就建出目录"。
      if (path === '/workspace-info') return send(res, 200, await workspaceInfo(deps, new URLSearchParams(), body))
      if (path === '/papers/open-session') return send(res, 200, await openPaperSession(deps, body))
      // Idea 研究区：init / create / list
      if (path === '/ideas') return send(res, 200, await ideasZone(deps, body))
      // 两个分区的相对位置：把谁放到最前，就是谁当主视图
      if (path === '/zones/order') return send(res, 200, await orderZones(deps, body))
      // 「送入 DSH」：Zotero 阅读器里的选区 → 该论文的会话（懒开）
      // Zotero 侧在选中变化 / 翻页时推上来。这里不做 Zotero 查询：推上来的
      // 字段已经够渲染上下文了，再回查一次只会让"选中→模型看到"多一个失败点。
      if (path === '/focus') {
        const itemKey = String(body.itemKey ?? '').trim()
        if (!itemKey) return send(res, 200, { ok: false, error: '缺少 itemKey' })
        lastFocus = {
          itemKey,
          title: String(body.title ?? '').trim(),
          creators: Array.isArray(body.creators) ? body.creators.map((c) => String(c)).filter(Boolean) : [],
          year: String(body.year ?? '').trim(),
          collection: String(body.collection ?? '').trim(),
          attachmentPath: String(body.attachmentPath ?? '').trim(),
          page: String(body.page ?? '').trim(),
          at: Date.now(),
        }
        return send(res, 200, { ok: true, focus: lastFocus })
      }
      if (path === '/quote') return send(res, 200, await quoteIntoSession(deps, body))
      if (path === '/start-read') return send(res, 200, await startRead(deps, body))
      if (path === '/chat-open') return send(res, 200, await openPaperChatSession(deps, body))
      if (path === '/chat-open-library') return send(res, 200, await openLibraryChatSession(deps, body))
      if (path === '/chat-send') return send(res, 200, await sendChatMessage(deps, body))
      if (path === '/chat-cancel') {
        const sid = String(body.sessionId ?? '')
        const agent = agentsOf(deps)?.get(sid)
        if (!agent?.cancel) return send(res, 200, { ok: false, error: '会话未运行（无 cancel）' })
        try {
          agent.cancel({ kind: 'user' }, { keepInbox: true })
          return send(res, 200, { ok: true })
        } catch (err: any) {
          return send(res, 200, { ok: false, error: String(err?.message ?? err) })
        }
      }
      if (path === '/chat-select-model') return send(res, 200, await selectChatModel(deps, body))
      if (path === '/chat-history-delete') {
        const kind = String(body.kind ?? 'paper')
        const itemKey = String(body.itemKey ?? '')
        const seq = Number(body.seq ?? 0)
        const store = readChatStore()
        let next = store.conversations
        if (kind === 'library') {
          next = seq > 0
            ? store.conversations.filter((c) => !(c.kind === 'library' && c.seq === seq))
            : store.conversations.filter((c) => c.kind !== 'library')
        } else if (itemKey) {
          next = store.conversations.filter((c) =>
            !(c.kind === 'paper' && c.itemKey === itemKey && (seq > 0 ? c.seq === seq : true)))
        }
        writeChatStore({ conversations: next })
        return send(res, 200, { ok: true, conversations: next })
      }
      // ── M4 v2 映射（写）：组 = 区下面的工作空间，成员 = 论文↔组的多对多归属 ──
      if (path === '/map/group/save') {
        const name = String(body.name ?? '').trim()
        if (!name) return send(res, 200, { ok: false, error: '需要 name' })
        if (!isZone(body.zone)) return send(res, 200, { ok: false, error: "zone 必须是 'survey' 或 'research'" })
        try {
          const zone = body.zone as 'survey' | 'research'
          const group = upsertGroup({
            ...(body.id ? { id: String(body.id) } : {}),
            zone,
            name,
            ...(body.kind !== undefined ? { kind: body.kind as never } : {}),
            ...(body.cwd !== undefined ? { cwd: String(body.cwd) } : {}),
            ...(body.workspaceId !== undefined ? { workspaceId: String(body.workspaceId) } : {}),
            ...(body.pinned !== undefined ? { pinned: Boolean(body.pinned) } : {}),
            ...(body.note !== undefined ? { note: String(body.note) } : {}),
          })
          return send(res, 200, { ok: true, group, snapshot: projectSnapshot() })
        } catch (err: any) {
          return send(res, 200, { ok: false, error: String(err?.message ?? err) })
        }
      }
      // 把内存里的「组」物化成真实 DSH 工作区，并按区顺序重排。
      // 这一步才是「重构工作区」：工作区列表本身变成区/组结构，而不是另存一棵影子树。
      if (path === '/map/materialize') {
        return send(res, 200, await materializeGroups(deps))
      }
      if (path === '/map/group/delete') {
        return send(res, 200, { ...deleteGroup(String(body.groupId ?? '')), snapshot: projectSnapshot() })
      }
      if (path === '/map/member/bind') {
        const groupId = String(body.groupId ?? '')
        const itemKey = String(body.itemKey ?? '')
        if (!groupId || !itemKey) return send(res, 200, { ok: false, error: '需要 groupId 与 itemKey' })
        try {
          const member = bindMember({
            groupId,
            itemKey,
            ...(body.title !== undefined ? { title: String(body.title) } : {}),
            ...(body.role !== undefined ? { role: body.role as never } : {}),
            ...(body.status !== undefined ? { status: String(body.status) } : {}),
          })
          return send(res, 200, { ok: true, member, snapshot: projectSnapshot() })
        } catch (err: any) {
          return send(res, 200, { ok: false, error: String(err?.message ?? err) })
        }
      }
      if (path === '/map/member/unbind') {
        return send(res, 200, {
          ...unbindMember(String(body.groupId ?? ''), String(body.itemKey ?? '')),
          snapshot: projectSnapshot(),
        })
      }
      if (path === '/map/member/status') {
        const r = setMemberStatus(
          String(body.groupId ?? ''),
          String(body.itemKey ?? ''),
          String(body.status ?? ''),
        )
        return send(res, 200, { ...r, snapshot: projectSnapshot() })
      }
      if (path === '/map/link') {
        const from = String(body.from ?? '')
        const to = String(body.to ?? '')
        if (!from || !to) return send(res, 200, { ok: false, error: '需要 from 与 to（itemKey）' })
        if (from === to) return send(res, 200, { ok: false, error: '不能把论文链到自己' })
        try {
          const edge = linkPapers({
            from,
            to,
            ...(body.kind !== undefined ? { kind: body.kind as never } : {}),
            ...(body.note !== undefined ? { note: String(body.note) } : {}),
            ...(body.sessionId !== undefined ? { sessionId: String(body.sessionId) } : {}),
          })
          return send(res, 200, { ok: true, edge, snapshot: projectSnapshot() })
        } catch (err: any) {
          return send(res, 200, { ok: false, error: String(err?.message ?? err) })
        }
      }
      if (path === '/map/unlink') {
        const kind = body.kind !== undefined ? (body.kind as never) : undefined
        return send(res, 200, {
          ...unlinkPapers(String(body.from ?? ''), String(body.to ?? ''), kind),
          snapshot: projectSnapshot(),
        })
      }
      if (path === '/map/bind-conv') {
        const b = bindConversation({
          sessionId: String(body.sessionId ?? ''),
          groupId: String(body.groupId ?? ''),
          ...(body.itemKey !== undefined ? { itemKey: String(body.itemKey) } : {}),
        })
        return send(res, 200, { ok: true, binding: b, snapshot: projectSnapshot() })
      }
      if (path === '/config') {
        writeOverlay(body as Partial<ZoteroConfig>)
        const next = composeConfig()
        setActiveConfig(next)
        client.updateConfig(next)
        return send(res, 200, { ok: true, config: maskConfig(next) })
      }
      if (path === '/translate') {
        return send(res, 200, await translateOf(deps, body))
      }
      if (path === '/annotate') {
        const itemKey = String(body.itemKey ?? '')
        if (!itemKey) return send(res, 200, { ok: false, error: '需要 itemKey' })
        const result = await annotateItem(client.scoped(), {
          itemKey,
          type: (body.type as any) || 'highlight',
          text: body.text ? String(body.text) : undefined,
          comment: body.comment ? String(body.comment) : undefined,
          color: body.color ? String(body.color) : undefined,
          pageLabel: body.pageLabel !== undefined ? String(body.pageLabel) : undefined,
          attachmentKey: body.attachmentKey ? String(body.attachmentKey) : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
          markdownPath: body.markdownPath ? String(body.markdownPath) : undefined,
          exportMarkdown: body.exportMarkdown !== false,
          syncToZotero: body.syncToZotero !== false,
          workspaceDir: body.workspaceDir ? String(body.workspaceDir) : undefined,
        })
        return send(res, 200, result)
      }
      if (path === '/fulltranslate/start') {
        const itemKey = String(body.itemKey ?? '')
        const attachmentKey = String(body.attachmentKey ?? '')
        if (!itemKey || !attachmentKey) return send(res, 200, { ok: false, error: '需要 itemKey 与 attachmentKey' })
        return send(res, 200, await startFullTranslate(client, llm, agentDefaultModel, itemKey, attachmentKey))
      }
      if (path === '/fulltranslate/pause') {
        return send(res, 200, pauseFullTranslate(String(body.attachmentKey ?? '')))
      }
      if (path === '/fulltranslate/resume') {
        return send(res, 200, resumeFullTranslate(String(body.attachmentKey ?? '')))
      }
      if (path === '/fulltranslate/cancel') {
        return send(res, 200, cancelFullTranslate(String(body.attachmentKey ?? '')))
      }
      if (path === '/pdf2zh/start') {
        const itemKey = String(body.itemKey ?? '')
        const attachmentKey = String(body.attachmentKey ?? '')
        if (!itemKey || !attachmentKey) return send(res, 200, { ok: false, error: '需要 itemKey 与 attachmentKey' })
        return send(res, 200, await startPdf2zh(client, attachmentKey, itemKey))
      }
      if (path === '/pdf2zh/cancel') {
        return send(res, 200, cancelPdf2zh(String(body.attachmentKey ?? '')))
      }
      if (path === '/mineru/start') {
        return send(res, 200, await startMineruBatch(client, llm, agentDefaultModel, Boolean(body.repair)))
      }
      if (path === '/mineru/cancel') {
        return send(res, 200, cancelMineruBatch())
      }
      if (path === '/mineru/clear') {
        return send(res, 200, clearMineruCache())
      }
      if (path === '/mineru/test') {
        return send(res, 200, await testMineruConnection())
      }
      if (path === '/artifacts') {
        const artifact = body as { type?: string; title?: string; payload?: string }
        if (artifact.type && artifact.title) {
          appendArtifact(currentConfig(), { type: artifact.type, title: artifact.title, payload: String(artifact.payload ?? '').slice(0, 4000) })
          return send(res, 200, { ok: true, artifacts: readArtifacts(currentConfig()) })
        }
        return send(res, 400, { ok: false, error: 'artifact needs type+title' })
      }
      if (path === '/artifacts/clear') {
        writeArtifacts(currentConfig(), [])
        return send(res, 200, { ok: true, artifacts: [] })
      }
    }

    send(res, 404, { error: 'unknown dsh-zotero api endpoint', path })
  } catch (err: any) {
    send(res, 200, { error: String(err?.message ?? err), hint: err?.hint ?? '' })
  }
}

/** 宿主工作区注册表的窄化接口（只用到本插件需要的四个动作）。 */
interface HostWorkspaceApi {
  create?(req: { path: string }): Promise<{ workspace?: { workspaceId?: unknown; path?: unknown; title?: unknown }; created?: boolean }>
  rename?(req: { workspaceId: string; title: string }): Promise<unknown>
  insertBefore?(req: { workspaceId: string; beforeWorkspaceId?: string }): Promise<unknown>
  delete?(req: { workspaceId: string }): Promise<unknown>
}

function workspaceApiOf(deps: PanelApiDeps): HostWorkspaceApi | undefined {
  return deps.workspaceController as HostWorkspaceApi | undefined
}

/**
 * 读宿主的工作区注册表。
 * workspaceController 只暴露 create/rename/delete/insertBefore/follow，
 * 没有 list；follow 是「基线 + 增量」的长流且帧形状未公开，所以直读注册表文件最稳。
 * DSH_HOME 优先，回落 ~/.dsh —— 隔离实例（3081）因此读到的是它自己的注册表。
 */
async function listHostWorkspaces(_deps: PanelApiDeps): Promise<Array<{ workspaceId: string; path: string; title: string }>> {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const file = join(home, 'storages', 'workspace.json')
    if (!existsSync(file)) return []
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      global?: { workspaceIds?: unknown }
      tables?: { workspaces?: Record<string, { path?: unknown; title?: unknown }> }
    }
    const order = Array.isArray(doc?.global?.workspaceIds) ? (doc.global!.workspaceIds as unknown[]) : []
    const table = doc?.tables?.workspaces ?? {}
    const out: Array<{ workspaceId: string; path: string; title: string }> = []
    for (const id of order) {
      const key = String(id)
      const w = table[key]
      if (!w) continue
      out.push({ workspaceId: key, path: String(w.path ?? ''), title: String(w.title ?? '') })
    }
    return out
  } catch {
    return []
  }
}

/** 拆路径成段：丢掉尾部分隔符与空段，保留盘符（D:）作为首段。 */
function dirSegments(p: string): string[] {
  return p.replace(/[\\/]+$/, '').split(/[\\/]+/).filter((s) => s.length > 0)
}

/** 所有路径的最长公共目录前缀，按段比较（Windows 大小写不敏感）。 */
function commonDirPrefix(paths: string[]): string[] {
  if (paths.length === 0) return []
  let prefix = dirSegments(paths[0])
  for (const p of paths.slice(1)) {
    const segs = dirSegments(p)
    let i = 0
    while (i < prefix.length && i < segs.length && prefix[i].toLowerCase() === segs[i].toLowerCase()) i += 1
    prefix = prefix.slice(0, i)
  }
  return prefix
}

/**
 * 目标目录在公共根之下的每一级祖先（不含公共根自身，含直接父目录）。
 * 一条「组目录」因此能推出它自己的容器链，不需要任何层级元数据。
 */
function ancestorDirs(target: string, rootSegs: string[]): string[] {
  const segs = dirSegments(target)
  if (segs.length <= rootSegs.length) return []
  const sep = target.includes('\\') ? '\\' : '/'
  const out: string[] = []
  for (let i = rootSegs.length; i < segs.length; i += 1) {
    let p = segs.slice(0, i + 1).join(sep)
    if (sep === '/' && !p.startsWith('/')) p = '/' + p
    out.push(p)
  }
  return out
}

/** 目录末段，用作容器工作区的标题。 */
function dirLabel(p: string): string {
  const segs = dirSegments(p)
  return segs.length > 0 ? segs[segs.length - 1] : p
}

/** 目录名安全化：Windows 不允许的字符换掉，首尾空白与点去掉。 */
function safeSegment(name: string): string {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
}

/**
 * 调整两个分区在列表里的先后。
 *
 * DSH 侧栏是单列，没有 tab —— 谁排在前面，谁就是当下的主视图；排在后面的折叠起来
 * 就是"另一个视图"。ideaFirst=true 把 Idea 研究区提到最前，Zotero 集合整体让位。
 */
async function orderZones(deps: PanelApiDeps, body: Record<string, unknown>) {
  const api = workspaceApiOf(deps)
  if (!api?.insertBefore) return { ok: false, error: 'workspaceController 不支持排序' }
  const ideasFirst = body.ideasFirst !== false
  const ideasRoot = normPath(String(body.ideasRoot ?? '').trim() || defaultIdeasRoot())
  const zoteroRoot = normPath(String(body.zoteroRoot ?? '').trim() || defaultCollectionsRoot())

  const all = await listHostWorkspaces(deps)
  const under = (p: string, root: string) => { const n = normPath(p); return n === root || n.startsWith(root + '/') }
  const ideas = all.filter((w) => under(w.path, ideasRoot))
  const collections = all.filter((w) => under(w.path, zoteroRoot))

  try {
    // insertBefore 省略 anchor = 追加到尾部，所以后挪的那一组落在后面。
    // 想让 A 在前，就把 B 挪到尾部。
    if (ideasFirst) {
      for (const w of ideas) await api.insertBefore({ workspaceId: w.workspaceId })
      for (const w of collections) await api.insertBefore({ workspaceId: w.workspaceId })
    } else {
      for (const w of collections) await api.insertBefore({ workspaceId: w.workspaceId })
      for (const w of ideas) await api.insertBefore({ workspaceId: w.workspaceId })
    }
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
  console.log(`[dsh-zotero] zones/order ideasFirst=${ideasFirst} ideas=${ideas.length} collections=${collections.length}`)
  return { ok: true, ideasFirst, ideas: ideas.length, collections: collections.length }
}

/** Idea 研究区的默认根目录：和 Zotero 集合镜像并列，侧栏里是第二个分区。 */
function defaultIdeasRoot(): string {
  const configured = String(currentConfig().zoteroWorkspaceRoot ?? '').trim()
  if (configured) return join(dirname(configured), '_ideas')
  return join(homedir(), 'zotero-ideas')
}

/**
 * Idea 研究区：自己开的工作空间，不是 Zotero 集合的镜像。
 *
 * action: init 只建根与容器；create 在根下开一个想法目录并注册；list 列出已有的；
 *         path 只返回目标路径（侧栏的"添加一个 idea"走这条 —— 落地交给它的 createWorkspace）。
 */
async function ideasZone(deps: PanelApiDeps, body: Record<string, unknown>) {
  const api = workspaceApiOf(deps)
  if (!api?.create) return { ok: false, error: 'workspaceController 不可用' }
  const root = String(body.root ?? '').trim() || defaultIdeasRoot()
  const action = String(body.action ?? 'create')

  // 注意：不能把 api.create 取出来再调 —— workspaceController 是 cordis Service，
  // 方法脱离宿主后 this.ctx 为空，内部会炸在 reading 'commands'。
  const adopt = async (path: string, title: string) => {
    try { mkdirSync(path, { recursive: true }) } catch (err: unknown) {
      return { error: '建目录失败：' + String((err as Error)?.message ?? err) }
    }
    try {
      const res = await api.create!({ path })
      const wsId = res?.workspace?.workspaceId
      if (typeof wsId !== 'string' || !wsId) return { error: 'create 未返回 workspaceId' }
      try { await api.rename?.({ workspaceId: wsId, title }) } catch { /* 标题失败不阻断 */ }
      try { await api.insertBefore?.({ workspaceId: wsId }) } catch { /* 排序失败不阻断 */ }
      return { workspaceId: wsId, path, created: Boolean(res?.created) }
    } catch (err: unknown) {
      return { error: String((err as Error)?.message ?? err) }
    }
  }

  // 只算路径、不落地：侧栏拿到 path 后走它自己的 createWorkspace，UI 才会当场反映出来。
  // 若这里直接 adopt，host 建完了而前端 store 还没收到推送，用户会看到"点了没反应"。
  if (action === 'path') {
    const raw = String(body.name ?? '').trim()
    if (!raw) return { ok: false, error: '需要 name' }
    const s = safeSegment(raw)
    if (!s) return { ok: false, error: '名字无法用作目录' }
    const targetDir = join(root, s)
    try {
      mkdirSync(targetDir, { recursive: true })
    } catch (err: unknown) {
      return { ok: false, error: '建目录失败：' + String((err as Error)?.message ?? err) }
    }
    // 顺手在这个新的 idea 目录里预置一张干净的空白 canvas.excalidraw 画布
    try {
      const canvasFile = join(targetDir, 'canvas.excalidraw')
      if (!existsSync(canvasFile)) {
        writeFileSync(canvasFile, JSON.stringify({
          type: 'excalidraw',
          version: 2,
          source: 'dsh-canvas',
          elements: [],
          appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
          files: {},
        }, null, 2), 'utf8')
      }
    } catch { /* 预置画布失败不阻断目录使用 */ }
    return { ok: true, root, name: raw, path: targetDir }
  }

  if (action === 'init') {
    const got = await adopt(root, String(body.containerTitle ?? '').trim() || 'Idea 研究区')
    if ('error' in got) return { ok: false, error: got.error }
    console.log(`[dsh-zotero] ideas/init ${root}`)
    return { ok: true, root, containerId: got.workspaceId }
  }

  if (action === 'list') {
    const all = await listHostWorkspaces(deps)
    const norm = (s: string) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const base = norm(root)
    const items = all.filter((w) => { const p = norm(w.path); return p !== base && p.startsWith(base + '/') })
    return { ok: true, root, items }
  }

  const name = String(body.name ?? '').trim()
  if (!name) return { ok: false, error: '需要 name' }
  const seg = safeSegment(name)
  if (!seg) return { ok: false, error: '名字无法用作目录' }
  const dir = join(root, seg)
  const got = await adopt(dir, name)
  if ('error' in got) return { ok: false, error: got.error }
  console.log(`[dsh-zotero] ideas/create ${name} -> ${dir}`)
  return { ok: true, root, name, path: dir, workspaceId: got.workspaceId, created: got.created }
}

/** 集合镜像的默认根目录。 */
function defaultCollectionsRoot(): string {
  const configured = String(currentConfig().zoteroWorkspaceRoot ?? '').trim()
  if (configured) return configured
  return join(homedir(), 'zotero-workspaces')
}

/** 路径归一化：统一分隔符与大小写，尾部斜杠去掉。两处比较路径的地方共用。 */
function normPath(p: string): string {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 集合树 → 镜像目录。返回 key → dir 的映射，供同步与单篇论文共用。 */
function mirrorDirs(
  root: string,
  tree: Array<{ key: string; name: string; parentKey: string | null }>,
): { dirs: Map<string, string>; skipped: Array<{ key: string; name: string; reason: string }> } {
  const dirs = new Map<string, string>()
  const skipped: Array<{ key: string; name: string; reason: string }> = []
  for (const c of tree) {
    const seg = safeSegment(c.name)
    if (!seg) { skipped.push({ key: c.key, name: c.name, reason: '名字无法用作目录' }); continue }
    const parentDir = c.parentKey ? dirs.get(c.parentKey) : root
    if (!parentDir) { skipped.push({ key: c.key, name: c.name, reason: '父集合未同步' }); continue }
    dirs.set(c.key, join(parentDir, seg))
  }
  return { dirs, skipped }
}

/**
 * 为单篇论文开一个工作区 —— 记录与复现的落脚点。
 *
 * 位置是「论文所属集合的镜像目录 / 论文标题」。只对有 PDF 的条目开：没有全文的话
 * 这个目录只是个空壳，既没法记也没法复现。没有集合归属的落到根下的 _未分类。
 */
/**
 * 算一篇论文的工作区目录（不建任何东西）。
 *
 * 抽出来是为了让「建工作区」和「打开这篇论文的会话」用同一套落点规则 ——
 * 两边各算一遍，迟早会在某个集合结构下分叉，然后就出现"工作区在这儿、
 * 会话在那儿"的错位。
 */
/** 远程执行目标的解析结果。 */
export interface RemoteTarget {
  host: string
  path: string
}

/** 显式工作区目标：覆盖自动落点规则。 */
export interface WorkspaceTarget {
  /** 显式本地目录（绝对路径）。给了就跳过后面的所有推导。来自 HTTP body，故为 unknown。 */
  dir?: unknown
  /** 远程目标。给了就按「同名锚点」在本地落点。来自 HTTP body，故为 unknown。 */
  remote?: unknown
}

/** 宽松解析传入的 remote 字段；缺 host 或 path 一律当没给。 */
function parseRemote(raw: unknown): RemoteTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const host = String(o.host ?? '').trim()
  const path = String(o.path ?? '').trim().replace(/\\/g, '/')
  if (!host || !path) return undefined
  return { host, path }
}

/**
 * 远程工作区的本地锚点根目录。
 *
 * 锚点不是远端目录的镜像，只是 DSH 侧的一个真实目录 —— DSH 的工作区必须是
 * 本地已存在的路径。真正的文件在远端，锚点里放脚本、笔记、拉回来的结果。
 */
function defaultRemoteRoot(): string {
  const configured = String(currentConfig().zoteroWorkspaceRoot ?? '').trim()
  if (configured) return join(dirname(configured), '_remote')
  return join(homedir(), 'zotero-remote')
}

/**
 * 远端路径在本地锚点下的落点。
 *
 * 关键约定：**末段名与远端完全一致**。远端 /data/exp/jepa-lewm 对应本地
 * <remoteRoot>/<host>/jepa-lewm —— 侧栏里看到的目录名，和 ssh 过去看到的
 * 目录名是同一个词，不需要做任何心算映射。
 */
function remoteAnchorDir(target: RemoteTarget): string {
  const tail = safeSegment(dirLabel(target.path)) || safeSegment(target.host) || 'remote'
  return join(defaultRemoteRoot(), safeSegment(target.host) || 'remote', tail)
}

/**
 * 当前论文的复现工作区自检。
 *
 * 面板徽章、Zotero 面板状态行、以及"这个工作区到底在哪"的自问都走这一条 ——
 * 路径一律由 resolvePaperDir 现算，不缓存，所以换了落点规则不会出现"显示的是老路径"。
 *
 * 只读：dryRun=true，看一眼不会把目录建出来。
 */
async function workspaceInfo(deps: PanelApiDeps, query: URLSearchParams, body?: Record<string, unknown>) {
  const itemKey = String(query.get('itemKey') ?? body?.itemKey ?? '').trim()
  if (!itemKey) return { ok: false, error: '缺少 itemKey' }

  // 目标优先级：本次请求显式给 > 论文上存过的 > 默认落点规则。
  // 徽章走的是 GET（不带 body），所以它看到的是"这篇论文上次定在哪"，
  // 而不是每次都重新按集合结构推一遍 —— 否则用户设的远程路径一刷新就丢。
  const stored = getWorkspaceTarget(itemKey)
  const effDir = body?.dir !== undefined ? body.dir : stored?.dir
  const effRemote = body?.remote !== undefined ? body.remote : stored?.remote

  const resolved = await resolvePaperDir(deps, itemKey, undefined, {
    dir: effDir,
    remote: effRemote,
  }, true)
  if (!resolved.ok) return { ok: false, error: resolved.error, title: resolved.title }

  const { dir, title, remote } = resolved
  const exists = existsSync(dir)
  const tail = dirLabel(dir)

  // 归属的组：论文可能同时在多个组里，取第一个（面板显示的"当前上下文"）。
  let groupName = ''
  let groupId = ''
  try {
    const mems = membershipsOfPaper(itemKey)
    if (mems.length > 0) {
      groupId = mems[0].groupId
      const g = resolveGroup({ groupId: mems[0].groupId })
      groupName = g?.name ?? ''
    }
  } catch { /* 映射读不到不影响路径展示 */ }

  const ssh = remote ? `ssh ${remote.host}` : ''
  // 一行摘要：面板与徽章直接渲染它，两边不会各写一套拼接逻辑。
  const label = remote
    ? `${remote.host}:${remote.path}`
    : `${dir}`

  return {
    ok: true,
    itemKey,
    title,
    groupId,
    groupName,
    dir,
    tail,
    exists,
    remote: remote ? { ...remote, ssh } : null,
    label,
  }
}

/**
 * 工作区在 DSH 侧栏显示的名字。
 *
 * 侧栏宽度有限，塞不下完整路径，所以只把「能区分出这是哪个工作区」的信息带出来：
 * 远程加 @host，显式路径加目录末段。完整路径由面板与徽章承担。
 */
function workspaceTitle(title: string, remote?: RemoteTarget, dir?: string): string {
  const base = String(title || '').slice(0, 48) || '工作区'
  if (remote) return `${base} @ ${remote.host}`
  const tail = dir ? safeSegment(dirLabel(dir)) : ''
  return tail ? `${base} · ${tail}`.slice(0, 70) : base
}

async function resolvePaperDir(
  deps: PanelApiDeps,
  itemKey: string,
  rootOverride?: unknown,
  target?: WorkspaceTarget,
  dryRun = false,
): Promise<{ ok: true; dir: string; title: string; pdfTitle: string; itemKey: string; remote?: RemoteTarget } | { ok: false; error: string; title?: string }> {
  const got = await deps.client.scoped().getItem(itemKey)
  if (!got.found || !got.item) return { ok: false, error: `条目不存在: ${itemKey}` }
  const it = got.item
  const pdf = (it.attachments ?? []).find((a) => a.isPdf)
  if (!pdf) return { ok: false, error: '这篇没有 PDF 附件，先加全文再建工作区', title: it.title || itemKey }

  const explicitDir = String(target?.dir ?? '').trim()
  const remote = parseRemote(target?.remote)

  // 落点三选一，优先级从高到低：显式目录 > 远程锚点 > 集合镜像推导。
  let dir: string
  if (explicitDir) {
    dir = explicitDir
  } else if (remote) {
    dir = remoteAnchorDir(remote)
  } else {
    const root = String(rootOverride ?? '').trim() || defaultCollectionsRoot()
    let parentDir = join(root, '_未分类')
    try {
      const col = await deps.client.collections()
      const mirrored = mirrorDirs(root, col.tree)
      const owned = (it.collections ?? []).map((k) => mirrored.dirs.get(k)).filter((d): d is string => Boolean(d))
      if (owned.length) {
        // 同一篇可能挂多个集合，取路径最短的那个当落点，避免在不相干的深处建目录。
        owned.sort((a, b) => a.length - b.length)
        parentDir = owned[0]
      }
    } catch { /* 集合读不到就用 _未分类 */ }

    const seg = safeSegment(String(it.title || itemKey).slice(0, 70))
    dir = join(parentDir, seg || itemKey)
  }

  // dryRun：只算路径不落地。查询类调用（workspace-info）不该因为看一眼就建出目录。
  if (!dryRun) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err: unknown) {
      return { ok: false, error: '建目录失败：' + String((err as Error)?.message ?? err) }
    }
  }
  return {
    ok: true,
    dir,
    title: String(it.title || itemKey),
    pdfTitle: pdf.title || pdf.filename || '',
    itemKey: String(it.key || itemKey),
    ...(remote ? { remote } : {}),
  }
}

async function paperWorkspace(deps: PanelApiDeps, body: Record<string, unknown>) {
  const itemKey = String(body.itemKey ?? '').trim()
  if (!itemKey) return { ok: false, error: '缺少 itemKey' }
  const api = workspaceApiOf(deps)
  if (!api?.create) return { ok: false, error: 'workspaceController 不可用' }

  const resolved = await resolvePaperDir(deps, itemKey, body.root, { dir: body.dir, remote: body.remote })
  if (!resolved.ok) return { ok: false, error: resolved.error, title: resolved.title }
  const { dir, title, pdfTitle, remote } = resolved

  try {
    const res = await api.create({ path: dir })
    const wsId = res?.workspace?.workspaceId
    if (typeof wsId !== 'string' || !wsId) return { ok: false, error: 'create 未返回 workspaceId' }
    try { await api.rename?.({ workspaceId: wsId, title: workspaceTitle(title, remote, dir) }) } catch { /* 标题失败不阻断 */ }
    try { await api.insertBefore?.({ workspaceId: wsId }) } catch { /* 排序失败不阻断 */ }
    // 记住这次的目标。徽章、以及下次 open-session，都读它 —— 否则用户设的
    // 远程路径在下一次按默认规则重算时就被覆盖掉了。
    try {
      if (body.dir !== undefined || body.remote !== undefined) {
        setWorkspaceTarget({
          itemKey,
          dir: String(body.dir ?? '').trim() || undefined,
          remote: remote ?? null,
        })
      }
    } catch { /* 目标持久化失败不阻断建工作区 */ }
    console.log(`[dsh-zotero] papers/workspace ${itemKey} -> ${dir}${remote ? ` (remote ${remote.host}:${remote.path})` : ''}`)
    return {
      ok: true, itemKey, path: dir, workspaceId: wsId,
      created: Boolean(res?.created), pdf: pdfTitle,
      ...(remote ? { remote } : {}),
    }
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
}

/**
 * 打开（必要时先建）这篇论文的会话，并让浏览器切过去。
 *
 * 「属于这篇论文的工作区」= resolvePaperDir 算出来的那个目录 —— 和
 * papers/workspace 用的是同一套落点规则，所以两边永远指向同一个地方。
 * 先把工作区 ensure 出来（create 对已存在的路径是幂等的），再在
 * sessionPersistence.list() 里挑 cwd 正好等于它的会话，取 createdAt 最新的那个；
 * 一个都没有就按 zotero-paper-<itemKey> 建一个。
 *
 * 用 list() 而不是去猜 sessions/ 下的目录名：那个名字是 cwd 的自定义转义
 * （`~5B66` 这类），反推规则等于把一个内部实现抄进插件，早晚会错。
 */
async function openPaperSession(deps: PanelApiDeps, body: Record<string, unknown>) {
  let itemKey = String(body.itemKey ?? '').trim()
  if (!itemKey) return { ok: false, error: '缺少 itemKey' }

  const resolved = await resolvePaperDir(deps, itemKey, body.root, { dir: body.dir, remote: body.remote })
  if (!resolved.ok) return { ok: false, error: resolved.error, title: resolved.title }
  const { dir, title, itemKey: canonicalItemKey, remote } = resolved
  itemKey = canonicalItemKey

  // 工作区先落地：没有它，下面建出来的会话就没有归属，侧栏里会掉进「未分组」。
  const api = workspaceApiOf(deps)
  let workspaceId = ''
  let workspaceCreated = false
  if (api?.create) {
    try {
      const res = await api.create({ path: dir })
      workspaceId = String(res?.workspace?.workspaceId ?? '')
      workspaceCreated = Boolean(res?.created)
      if (workspaceId) {
        try { await api.rename?.({ workspaceId, title: workspaceTitle(title, remote, dir) }) } catch { /* 标题失败不阻断 */ }
      }
    } catch (err: unknown) {
      console.log(`[dsh-zotero] open-session workspace ensure failed: ${String((err as Error)?.message ?? err)}`)
    }
  }

  // 找这篇论文已有的会话。路径比较统一走 normPath：注册表里存的是反斜杠，
  // 而 header 里的 cwd 可能是另一侧写的，大小写也不保证一致。
  const wanted = normPath(dir)
  let found: { id: string; createdAt: number } | null = null
  try {
    const sp = deps.sessionPersistence as
      | { list?(opts?: { signal?: AbortSignal }): Promise<readonly { header: { id?: unknown; cwd?: unknown; createdAt?: unknown } }[]> }
      | undefined
    const all = (await sp?.list?.({ signal: AbortSignal.timeout(8000) })) ?? []
    const paperPrefix = `zotero-paper-${itemKey}`
    for (const snap of all) {
      const h = snap?.header
      if (!h) continue
      const id = String(h.id ?? '')
      if (!id || !h.cwd) continue
      if (normPath(String(h.cwd)) !== wanted) continue
      /*
       * 只复用这篇论文自己的会话，不复用工作区里一个泛用聊天。
       * 泛用聊天的 cwd 也许是对的，但它的历史上下文可能属于上一篇论文，
       * 正是「顶部当前论文对了，具体会话里提示词还是上一篇」的来源。
       * zotero-paper-<itemKey>[-N] 是本插件的论文会话命名空间；没有就新建。
       */
      if (id !== paperPrefix && !id.startsWith(paperPrefix + '-')) continue
      const at = Number(h.createdAt ?? 0)
      if (!found || at > found.createdAt) found = { id, createdAt: at }
    }
  } catch (err: unknown) {
    console.log(`[dsh-zotero] open-session list failed: ${String((err as Error)?.message ?? err)}`)
  }

  let sessionId = found?.id ?? ''
  let created = false
  let contextInjectedAt = 0
  let agent: AgentLike | undefined
  if (!sessionId) {
    // 没有就建。id 用 zotero-paper-<itemKey>，和面板「对话」tab 那套保持一致，
    // 这样同一条论文不会因为入口不同攒出两个会话。
    sessionId = `zotero-paper-${itemKey}`
    try {
      agent = await ensureLiveAgent(deps, sessionId, dir, workspaceId || undefined)
      const built = await buildPaperContext(deps, { itemKey, mode: 'meta' })
      if (!built.ok) return { ok: false, error: built.error ?? '构建论文上下文失败' }
      injectTextResilient(agent, built.text, deps, sessionId)
      contextInjectedAt = Date.now()
      created = true
    } catch (err: unknown) {
      return { ok: false, error: '建会话失败：' + String((err as Error)?.message ?? err) }
    }
  }

  // 已经存在的会话也要补挂一次：早先的会话只带了 cwd、没进任何工作区的 sessionIds，
  // 于是侧栏看不到它、切过去也停在「选择工作区」。attachSession 对已挂的是幂等的。
  if (!created && workspaceId) {
    /*
     * 走 sessionController.create 而不是自己去 workspaceController 上找实体：
     * controller 只暴露 create/rename/delete/insertBefore/follow，没有 get，
     * 拿不到那个 workspace 就没法调 attachSession。而 sessionController.create
     * 对已存在的会话是 adopt 语义（幂等），传 workspaceId 时它自己会 attachSession。
     */
    try {
      agent = await ensureLiveAgent(deps, sessionId, dir, workspaceId)
      console.log(`[dsh-zotero] open-session attach via controller ok (${sessionId})`)
    } catch (err: unknown) {
      console.log(`[dsh-zotero] open-session attach failed: ${String((err as Error)?.message ?? err)}`)
    }
  }

  const chatStore = readChatStore()
  const known = chatStore.conversations.find((c) => c.kind === 'paper' && c.itemKey === itemKey && c.sessionId === sessionId)
  /*
   * 关键：复用会话不等于复用它当前的论文上下文。早期版本曾经把上一篇论文
   * 注入进同一个 session，之后只要复用它，历史提示词就一直带着上一篇。
   * chat store 没登记，或登记但 injectedAt=0，都重新注入一次当前条目的 meta；
   * 之后同一篇正常复用，不会每次点击都重复塞上下文。
   */
  if (agent && (!known || !known.injectedAt)) {
    try {
      const built = await buildPaperContext(deps, { itemKey, mode: 'meta' })
      if (built.ok) {
        injectTextResilient(agent, built.text, deps, sessionId)
        contextInjectedAt = Date.now()
      }
    } catch (err: unknown) {
      console.log(`[dsh-zotero] refresh paper context failed (${sessionId}): ${String((err as Error)?.message ?? err)}`)
    }
  }
  const now = Date.now()
  if (!known) {
    const seqMatch = sessionId.match(new RegExp(`^zotero-paper-${itemKey}(?:-(\\d+))?$`))
    const seq = seqMatch ? Number(seqMatch[1] || '1') : 1
    chatStore.conversations.push({ kind: 'paper', itemKey, title, sessionId, seq, injectedAt: contextInjectedAt, at: now })
    writeChatStore(chatStore)
  } else if (contextInjectedAt) {
    known.title = title
    known.injectedAt = contextInjectedAt
    known.at = now
    writeChatStore(chatStore)
  }

  pendingOpenSessionId = sessionId
  console.log(`[dsh-zotero] papers/open-session ${itemKey} -> ${sessionId} (created=${created} wsCreated=${workspaceCreated})`)
  return { ok: true, itemKey, sessionId, dir, workspaceId, created, reused: !created }
}

/**
 * 把 Zotero 的集合树一对一镜像成 DSH 工作区。
 *
 * 每个集合 = 一个工作区，cwd 是根目录下的镜像子目录。层级不靠任何元数据 ——
 * Zotero 的 parentCollection 直接落成目录嵌套，DSH 侧栏再按目录嵌套还原成树。
 * 所以改集合结构后重跑一次这个端点就够了。
 *
 * 集合里的论文不搬：工作区只提供 cwd，读哪篇由会话自己决定。
 */
async function syncCollections(deps: PanelApiDeps, body: Record<string, unknown>) {
  const api = workspaceApiOf(deps)
  if (!api?.create) return { ok: false, error: 'workspaceController 不可用' }

  let col
  try {
    col = await deps.client.collections()
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
  if (col.source === 'none') return { ok: false, error: col.error || 'Zotero 不可达', hint: col.hint }

  const root = String(body.root ?? '').trim() || defaultCollectionsRoot()
  try { mkdirSync(root, { recursive: true }) } catch (err: unknown) {
    return { ok: false, error: '无法创建根目录 ' + root + '：' + String((err as Error)?.message ?? err) }
  }

  // 根自己也注册成容器，侧栏里就是一段可折叠的分区标题。
  let containerId = ''
  if (body.container !== false) {
    const title = String(body.containerTitle ?? '').trim() || 'Zotero 集合'
    try {
      const res = await api.create!({ path: root })
      const wsId = res?.workspace?.workspaceId
      if (typeof wsId === 'string' && wsId) {
        containerId = wsId
        try { await api.rename?.({ workspaceId: wsId, title }) } catch { /* 标题失败不阻断 */ }
      }
    } catch { /* 容器失败不阻断，集合照旧 */ }
  }

  const dirOf = new Map<string, string>()
  const synced: Array<{ key: string; name: string; depth: number; path: string; workspaceId: string }> = []
  const skipped: Array<{ key: string; name: string; reason: string }> = []

  for (const c of col.tree) {
    const seg = safeSegment(c.name)
    if (!seg) { skipped.push({ key: c.key, name: c.name, reason: '名字无法用作目录' }); continue }
    const parentDir = c.parentKey ? dirOf.get(c.parentKey) : root
    if (!parentDir) { skipped.push({ key: c.key, name: c.name, reason: '父集合未同步' }); continue }
    const dir = join(parentDir, seg)
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err: unknown) {
      skipped.push({ key: c.key, name: c.name, reason: '建目录失败：' + String((err as Error)?.message ?? err) })
      continue
    }
    dirOf.set(c.key, dir)
    if (body.__skipCreate) { synced.push({ key: c.key, name: c.name, depth: c.depth, path: dir, workspaceId: '' }); continue }
    try {
      const res = await api.create({ path: dir })
      const wsId = res?.workspace?.workspaceId
      if (typeof wsId !== 'string' || !wsId) { skipped.push({ key: c.key, name: c.name, reason: 'create 未返回 workspaceId' }); continue }
      try { await api.rename?.({ workspaceId: wsId, title: c.name }) } catch { /* 标题失败不阻断 */ }
      synced.push({ key: c.key, name: c.name, depth: c.depth, path: dir, workspaceId: wsId })
    } catch (err: unknown) {
      skipped.push({ key: c.key, name: c.name, reason: String((err as Error)?.message ?? err) })
    }
  }

  // col.tree 已是深度优先，逐条追加到尾部即可还原同级顺序。容器排在自己那棵子树前面。
  try {
    if (containerId) await api.insertBefore?.({ workspaceId: containerId })
    for (const s of synced) { if (s.workspaceId) await api.insertBefore?.({ workspaceId: s.workspaceId }) }
  } catch { /* 排序失败不阻断 */ }

  // 收尾：把 cwd 不在镜像根之下的工作区列出来。默认只报告，confirm 才真删 ——
  // 手动建的工作区也在候选里，误删的代价比多跑一次大。
  const stale: Array<{ workspaceId: string; title: string; path: string }> = []
  if (body.prune) {
    // 两边都要统一分隔符再比 —— root 来自调用方（可能是正斜杠），注册表里的是
    // 反斜杠，直接前缀比较会把整棵树判成 stale。
    const norm = (s: string) => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const rootNorm = norm(root)
    const all = await listHostWorkspaces(deps)
    for (const w of all) {
      const p = String(w.path || '')
      if (!p) continue
      const pn = norm(p)
      if (pn === rootNorm || pn.startsWith(rootNorm + '/')) continue
      stale.push({ workspaceId: w.workspaceId, title: w.title, path: p })
    }
    if (body.confirm === true && api.delete) {
      for (const s of stale) {
        try { await api.delete({ workspaceId: s.workspaceId }) } catch { /* 单条失败不阻断 */ }
      }
    }
  }

  console.log(`[dsh-zotero] collections/sync root=${root} container=${containerId ? 'yes' : 'no'} synced=${synced.length} skipped=${skipped.length} stale=${stale.length}`)
  return { ok: true, root, containerId, total: col.tree.length, synced, skipped, stale, pruned: body.confirm === true && Boolean(api.delete) }
}

/**
 * 把每个「组」物化成真实 DSH 工作区，再按注册表顺序追加到尾部。
 *
 * 侧栏的树形层级不来自任何元数据，而是来自**真实目录嵌套**：把组的公共父目录
 * 也注册成工作区，组就自然成了它的子节点，客户端按路径前缀还原折叠树。
 * 因此标题只写自身名字 —— 层级由缩进表达，不再用「调研区 / 」前缀。
 * cwd 为空的组会被跳过并在结果里报告 —— 工作区必须有真实目录。
 */
async function materializeGroups(deps: PanelApiDeps): Promise<{
  ok: boolean
  synced: Array<{ groupId: string; workspaceId: string; title: string; created: boolean }>
  skipped: Array<{ groupId: string; reason: string }>
  error?: string
}> {
  const api = workspaceApiOf(deps)
  if (!api?.create) return { ok: false, synced: [], skipped: [], error: 'workspaceController 不可用' }
  const snap = projectSnapshot()
  const synced: Array<{ groupId: string; workspaceId: string; title: string; created: boolean }> = []
  const skipped: Array<{ groupId: string; reason: string }> = []
  // 顺序即同级列表顺序：调研区在前，研究区内开发空间置顶。
  const ordered = [...snap.zones[0].groups, ...snap.zones[1].groups]

  const paths = ordered.map((g) => g.cwd).filter((c): c is string => Boolean(c))
  const rootSegs = commonDirPrefix(paths)
  const containers: Array<{ path: string; depth: number }> = []
  const seenContainer = new Set<string>()
  for (const p of paths) {
    for (const dir of ancestorDirs(p, rootSegs)) {
      const key = dir.toLowerCase()
      if (seenContainer.has(key)) continue
      seenContainer.add(key)
      containers.push({ path: dir, depth: dirSegments(dir).length })
    }
  }
  // 浅的在前，深的后 —— 父容器先入表，子容器才排得进它的子树。
  containers.sort((a, b) => a.depth - b.depth)

  /** 建目录 → 注册 → 改名。目录先行，否则 create 会因路径不存在而拒绝。 */
  const adopt = async (path: string, title: string): Promise<{ wsId: string; created: boolean } | undefined> => {
    try { mkdirSync(path, { recursive: true }) } catch { /* 已存在或权限不足，让 create 去报错 */ }
    const res = await api.create!({ path })
    const wsId = res?.workspace?.workspaceId
    if (typeof wsId !== 'string' || !wsId) return undefined
    try { await api.rename?.({ workspaceId: wsId, title }) } catch { /* rename 失败不阻断 */ }
    return { wsId, created: Boolean(res?.created) }
  }

  const attached: string[] = []
  for (const c of containers) {
    try {
      const got = await adopt(c.path, dirLabel(c.path))
      if (!got) { skipped.push({ groupId: c.path, reason: '容器目录未返回 workspaceId' }); continue }
      attached.push(got.wsId)
    } catch (err: any) {
      skipped.push({ groupId: c.path, reason: String(err?.message ?? err) })
    }
  }

  for (const g of ordered) {
    const cwd = g.cwd
    if (!cwd) { skipped.push({ groupId: g.id, reason: '未指定 cwd，工作区必须有真实目录' }); continue }
    try {
      const got = await adopt(cwd, g.name)
      if (!got) { skipped.push({ groupId: g.id, reason: 'create 未返回 workspaceId' }); continue }
      if (g.workspaceId !== got.wsId) upsertGroup({ id: g.id, zone: g.zone, name: g.name, workspaceId: got.wsId })
      attached.push(got.wsId)
      synced.push({ groupId: g.id, workspaceId: got.wsId, title: g.name, created: got.created })
    } catch (err: any) {
      skipped.push({ groupId: g.id, reason: String(err?.message ?? err) })
    }
  }

  // 逐条 insertBefore（省略 anchor = 追加到尾部），让注册表顺序 = 同级显示顺序。
  try {
    for (const wsId of attached) await api.insertBefore?.({ workspaceId: wsId })
  } catch { /* 排序失败不阻断 */ }

  return { ok: true, synced, skipped }
}

type Res = { writeHead(status: number, headers: Record<string, string>): unknown; end(body: string): unknown }

function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req?.on?.('data', (c: Buffer) => chunks.push(c))
    req?.on?.('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req?.on?.('error', () => resolve(''))
    if (!req?.on) resolve('')
  })
}

function send(res: Res, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 提供 pdfjs-dist worker（client 侧 pdf.js 渲染用；失败回退 fake worker）。 */
async function sendPdfJsWorker(res: Res): Promise<void> {
  try {
    const require = createRequire(import.meta.url)
    const workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
    const content = readFileSync(workerPath, 'utf8')
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(content)),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(content)
  } catch (err: any) {
    send(res, 200, { ok: false, error: String(err?.message ?? err) })
  }
}

/** POST /translate — 划词即时翻译（共用 translate.ts：缓存 + 上下文注入）。 */
async function translateOf(deps: PanelApiDeps, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const r = await translateText({
      llm: deps.llm,
      agentDefaultModel: deps.agentDefaultModel,
      client: deps.client,
      text: String(body.text ?? ''),
      itemKey: body.itemKey ? String(body.itemKey) : undefined,
      targetLang: body.targetLang ? String(body.targetLang) : undefined,
      sourceLang: body.sourceLang ? String(body.sourceLang) : undefined,
    })
    return { ...r, ok: r.ok, text: r.text, cached: r.cached }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw err
    return { ok: false, text: '', cached: false, error: String(err?.message ?? err), hint: '', targetLang: '', sourceLang: 'auto', chars: 0 }
  }
}

/** Stream a Zotero attachment PDF (Chromium iframe/pdf viewer friendly, Range supported). */
async function streamPdf(
  req: { headers?: Record<string, string | string[] | undefined> },
  res: Res,
  client: ZoteroClient,
  attachmentKey: string,
): Promise<void> {
  const p = await client.resolveAttachmentPath(attachmentKey)
  if (!p) {
    send(res, 404, { error: '附件文件不可用（需 Local API 开启）' })
    return
  }
  try {
    const size = statSync(p).size
    const mime = /\.pdf$/i.test(p) ? 'application/pdf' : 'application/octet-stream'
    const rawRange = req.headers?.range
    const range = parseByteRange(rawRange, size)
    const base = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${encodeURIComponent(p.split(/[\\/]/).pop() ?? 'file.pdf')}"`,
    }
    if (range) {
      const { start, end } = range
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      })
      createReadStream(p, { start, end }).pipe(res as unknown as NodeJS.WritableStream)
      return
    }
    res.writeHead(200, { ...base, 'Content-Length': String(size) })
    createReadStream(p).pipe(res as unknown as NodeJS.WritableStream)
  } catch (err: any) {
    send(res, 500, { error: String(err?.message ?? err) })
  }
}

/** 流式返回本地文件（pdf2zh 产物等；Range 友好，供 iframe/pdf.js）。 */
async function streamLocalFile(
  req: { headers?: Record<string, string | string[] | undefined> },
  res: Res,
  p: string,
): Promise<void> {
  try {
    const size = statSync(p).size
    const mime = /\.pdf$/i.test(p) ? 'application/pdf' : 'application/octet-stream'
    const rawRange = req.headers?.range
    const range = parseByteRange(rawRange, size)
    const base = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${encodeURIComponent(p.split(/[\\/]/).pop() ?? 'file.pdf')}"`,
    }
    if (range) {
      const { start, end } = range
      res.writeHead(206, {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      })
      createReadStream(p, { start, end }).pipe(res as unknown as NodeJS.WritableStream)
      return
    }
    res.writeHead(200, { ...base, 'Content-Length': String(size) })
    createReadStream(p).pipe(res as unknown as NodeJS.WritableStream)
  } catch (err: any) {
    send(res, 500, { error: String(err?.message ?? err) })
  }
}

function parseByteRange(raw: unknown, size: number): { start: number; end: number } | null {  if (typeof raw !== 'string' || !raw.startsWith('bytes=')) return null
  const m = /bytes=(\d*)-(\d*)/.exec(raw)
  if (!m) return null
  const [, s, e] = m
  if (s === '' && e === '') return null
  const start = s === '' ? Math.max(0, size - Number(e)) : Number(s)
  const end = e === '' ? size - 1 : Number(e)
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

async function healthOf(client: ZoteroClient) {
  return client.health()
}

async function verifyOf(client: ZoteroClient) {
  const health = await client.health()
  const out: Record<string, unknown> = { health, search: null, collections: null }
  if (health.ok) {
    const s = await client.scoped().search({ limit: 3 })
    out.search = {
      ok: s.source !== 'none', total: s.total, source: s.source, error: s.error,
      sample: s.items.slice(0, 3).map((i) => ({ key: i.key, title: i.title, itemType: i.itemType, year: i.year })),
    }
    const c = await client.scoped().collections()
    out.collections = { total: c.total, source: c.source, error: c.error, roots: c.tree.filter((x) => x.depth === 0).slice(0, 20).map((x) => ({ key: x.key, name: x.name, itemCount: x.itemCount })) }
  }
  return out
}

async function treeOf(client: ZoteroClient, query: URLSearchParams) {
  const q = query.get('q')?.trim()
  const collection = query.get('collection')?.trim()
  const search = await client.scoped().search({
    limit: 40,
    query: q || undefined,
    qmode: q ? 'everything' : undefined,
    // q 与 collection 可并存（Local API 支持组合过滤）。
    collectionKey: collection || undefined,
  })
  const c = await client.scoped().collections()
  // 列表隐藏纯附件行（它们没有独立的文献价值）。
  const items = search.items.filter((i) => i.itemType !== 'attachment')
  return {
    source: search.source,
    recent: items.map((i) => ({ key: i.key, title: i.title, itemType: i.itemType, year: i.year, creators: i.creators.map((x) => x.fullName).slice(0, 3) })),
    total: search.total,
    collections: c.tree.map((x) => ({ key: x.key, name: x.name, parentKey: x.parentKey, depth: x.depth, itemCount: x.itemCount })),
    collectionsTotal: c.total,
    error: search.error || c.error,
  }
}

async function readOf(client: ZoteroClient, query: URLSearchParams) {
  const cfg = currentConfig()
  const itemKey = query.get('itemKey')!
  try {
    const parsed = await ensureParsed(client, cfg, (query.get('mode') as 'auto' | 'mineru' | 'text') ?? 'auto', itemKey, query.get('attachmentKey') ?? undefined)
    appendArtifact(cfg, { type: 'read', title: parsed.title || itemKey, payload: `${parsed.source} · ${parsed.textChars} 字符` })
    return {
      status: 'ok', itemKey, title: parsed.title, attachmentKey: parsed.attachmentKey,
      source: parsed.source, textChars: parsed.textChars, cacheDir: parsed.cacheDir,
      sectionTitles: parsed.md.split('\n').filter((l) => /^#{1,3}\s+/.test(l)).map((l) => l.replace(/^#{1,3}\s+/, '')).slice(0, 30),
      preview: parsed.md.slice(0, 800),
    }
  } catch (err: any) {
    return { status: 'error', itemKey, error: String(err?.message ?? err), hint: err?.hint ?? '' }
  }
}

/** Build the conversation-context text for one paper. */
async function buildPaperContext(deps: PanelApiDeps, body: Record<string, unknown>): Promise<{ ok: boolean; chars: number; text: string; error?: string }> {
  const client = deps.client
  const cfg = currentConfig()
  const itemKey = String(body.itemKey ?? '')
  if (!itemKey) return { ok: false, chars: 0, text: '', error: '缺少 itemKey' }
  const got = await client.scoped().getItem(itemKey)
  if (!got.found || !got.item) return { ok: false, chars: 0, text: '', error: `条目不存在: ${itemKey}` }
  const it = got.item
  const lines: string[] = []
  lines.push('【Zotero 文献上下文 · dsh-zotero 面板注入】')
  lines.push(`- 标题: ${it.title || '(无标题)'}`)
  const authors = it.creators.map((c) => c.fullName).filter(Boolean).join(', ')
  if (authors) lines.push(`- 作者: ${authors}`)
  if (it.year) lines.push(`- 年份: ${it.year}`)
  if (it.publicationTitle) lines.push(`- 期刊/来源: ${it.publicationTitle}`)
  if (it.doi) lines.push(`- DOI: ${it.doi}`)
  if (it.url) lines.push(`- URL: ${it.url}`)
  lines.push(`- 标签: ${it.tags.join(', ') || '(无)'}`)
  lines.push(`- Zotero key: ${it.key}（可调用 zotero_get_item / zotero_read_fulltext / zotero_retrieve 读取全文——zotero_retrieve 按问题检索最相关章节证据；zotero_read_fulltext 按 offset 精读各章；zotero_read_pdf 仅预览）`)
  if (it.abstractNote) lines.push(`- 摘要: ${it.abstractNote.slice(0, 1200)}`)
  const mode = String(body.mode ?? 'meta')
  if (mode === 'qa') {
    try {
      const parsed = await ensureParsed(client, cfg, 'auto', itemKey, String(body.attachmentKey ?? '') || undefined)
      const budget = Math.max(cfg.fullTextTokenBudget * 2, 8000)
      lines.push('【全文节选（缓存文本，供精读问答；可用 zotero_summarize 做定向总结）】')
      lines.push(parsed.md.slice(0, budget))
    } catch (err: any) {
      lines.push(`【全文解析失败：${String(err?.message ?? err)}】`)
    }
  } else if (mode === 'rag') {
    // ── 检索召回模式：用用户问题在缓存全文中检索 top 证据片段注入（复刻上游证据打包） ──
    const query = String(body.query ?? '').trim()
    try {
      const parsed = await ensureParsed(client, cfg, 'auto', itemKey, String(body.attachmentKey ?? '') || undefined)
      if (query) {
        const res = await retrieveEvidence(parsed, query, {
          topK: Number(body.retrieveTopK ?? 4),
          runVariantGen: deps.agentDefaultModel
            ? async (q) => {
                const model = resolveModel(deps.agentDefaultModel)
                const system = 'You are a retrieval query planner for academic papers. Expand the user question into up to 6 alternative query phrasings for evidence search: synonyms, abbreviations vs full forms (e.g. "PD" ↔ "peridynamics"), notation and English variants of technical terms. Keep each variant a single search query under 120 chars. Output one variant per line, no numbering, no preamble, no quotes.'
                const out = await streamText(deps.llm, model, {
                  system,
                  user: `Paper: ${String(q.paperTitle ?? '(unknown)')}\nQuestion: ${q.query}`,
                  temperature: 0.2,
                  maxTokens: 400,
                })
                return out
                  .split('\n')
                  .map((l) => l.trim())
                  .filter((l) => l && !/^\d+[.)]/.test(l) && !/^(v\d|variant)/i.test(l))
                  .map((l) => l.replace(/^[-•*]\s*/, '').replace(/^['"]|['"]$/g, ''))
                  .filter((l) => l.length >= 2)
              }
            : undefined,
        })
        lines.push(formatEvidencePack(res, { budgetPerHit: 1400, maxHits: Number(body.retrieveTopK ?? 4) }))
      } else {
        // 无具体问题 → 回退头部节选。
        lines.push('【全文节选（缓存文本；追问具体问题时将自动按检索召回注入）】')
        lines.push(parsed.md.slice(0, Math.max(cfg.fullTextTokenBudget * 2, 8000)))
      }
    } catch (err: any) {
      lines.push(`【全文解析失败：${String(err?.message ?? err)}】`)
    }
  }
  const text = lines.join('\n')
  return { ok: true, chars: text.length, text }
}

/**
 * 「送入 DSH」：把 Zotero PDF 里选中的一段文字推进该论文的会话。
 *
 * 和 /inject-context 的区别是粒度：那个推整篇论文的元数据或全文，这个只推一段选段，
 * 而且会为该论文**懒开**一个会话 —— 在 Zotero 里读到哪里、选中就送，不必先打开面板。
 *
 * ask=true 时追加一轮追问让模型直接回应这段；默认只进上下文，等用户自己接着问
 * （对应 VSCode 聊天里 "Add to Chat" 的语义）。
 */
async function quoteIntoSession(deps: PanelApiDeps, body: Record<string, unknown>) {
  const itemKey = String(body.itemKey ?? '').trim()
  const text = String(body.text ?? '').trim()
  if (!itemKey) return { ok: false, error: '缺少 itemKey' }
  if (!text) return { ok: false, error: '选中的文字为空' }

  const page = String(body.page ?? '').trim()
  const ask = body.ask === true

  let store = readChatStore()
  const mine = store.conversations
    .filter((c) => c.kind === 'paper' && c.itemKey === itemKey)
    .sort((a, b) => (b.seq || 1) - (a.seq || 1))
  let conv: ChatConv | undefined = mine[0]
  let opened = false

  // 懒开：从没打开过这篇论文的会话时补一条记录，否则 DSH 面板的 History 里
  // 根本找不到它 —— 选段进去了用户也无从查看。
  if (!conv) {
    const seq = maxPaperSeq(store, itemKey) + 1
    conv = {
      kind: 'paper',
      itemKey,
      title: String(body.title ?? '').trim() || itemKey,
      sessionId: seq === 1 ? `zotero-paper-${itemKey}` : `zotero-paper-${itemKey}-${seq}`,
      seq,
      injectedAt: 0,
      at: Date.now(),
    }
    writeChatStore({ conversations: [...store.conversations, conv] })
    store = readChatStore()
    opened = true
  }

  const sessionId = conv.sessionId
  let agent: AgentLike
  try {
    agent = await ensureLiveAgent(deps, sessionId, undefined)
  } catch (err: unknown) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }

  const quoted = text.split(/\r?\n/).map((line) => `> ${line}`).join('\n')
  const head = page ? `【Zotero 选段 · 第 ${page} 页】` : '【Zotero 选段】'
  const block = [
    head,
    quoted,
    '',
    '（这是用户此刻在 Zotero 里选中并送进来的原文，可能希望你解读、翻译，或与上面的讨论联系起来。）',
  ].join('\n')

  // 会话还没注入过论文元数据时一起带上，让模型知道这段话属于哪篇。
  const fresh = !conv?.injectedAt
  let context = ''
  if (fresh) {
    const built = await buildPaperContext(deps, { itemKey, mode: 'meta' })
    if (built.ok) context = built.text + '\n\n'
  }

  // 先记账再注入：面板的引用卡靠这份记录，注入成不成功都不该让用户看不到
  // 自己刚送了什么 —— 卡片本身就是主路径，注入只是加分项。
  lastQuoteBySession.set(sessionId, {
    page,
    text,
    ask,
    at: Date.now(),
    title: String(body.title ?? '').trim(),
    itemKey,
    locator: body.locator && typeof body.locator === 'object' ? (body.locator as Record<string, unknown>) : null,
  })

  let injectError: string | undefined
  try {
    injectText(agent, context + block)
  } catch (err: unknown) {
    injectError = String((err as Error)?.message ?? err)
    // 会话里可能压着一条陈旧的 pending 消息（跨重启残留），清掉再试一次。
    try {
      const stale = agentsOf(deps)?.get(sessionId)
      if (stale?.cancel) stale.cancel({ kind: 'user' }, { keepInbox: false })
    } catch { /* best-effort */ }
    try {
      injectText(agent, context + block)
      injectError = undefined
    } catch (err2: unknown) {
      injectError = String((err2 as Error)?.message ?? err2)
    }
  }

  if (conv) {
    writeChatStore({
      conversations: [
        ...store.conversations.filter((c) => !(c.kind === 'paper' && c.itemKey === itemKey && c.seq === conv.seq)),
        { ...conv, at: Date.now(), ...(fresh ? { injectedAt: Date.now() } : {}) },
      ],
    })
  }

  let followup = false
  if (ask) {
    try { followupText(agent, QUOTE_ASK_PROMPT); followup = true } catch { followup = false }
  }

  console.log(`[dsh-zotero] quote itemKey=${itemKey} page=${page || '-'} chars=${text.length} ask=${ask} session=${sessionId} opened=${opened}${injectError ? ' injectFailed=' + injectError : ''}`)
  return {
    ok: true,
    sessionId,
    chars: text.length,
    page: page || undefined,
    followup,
    opened,
    locator: (body.locator as unknown) ?? null,
    ...(injectError ? { warning: '选段已登记，但注入会话失败：' + injectError } : {}),
  }
}

async function injectContext(deps: PanelApiDeps, body: Record<string, unknown>) {
  const built = await buildPaperContext(deps, body)
  if (!built.ok) return { ok: false, error: built.error ?? '构建上下文失败' }
  const sessionId = String(body.sessionId ?? '')
  const agents = deps.agents as { get?(id: unknown): { inject?(msg: unknown): unknown } | undefined } | undefined
  const agent = agents?.get?.(sessionId)
  if (!agent?.inject) {
    return { ok: false, error: '无法定位会话 agent（sessionId 无效或会话未激活）', chars: built.chars }
  }
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: built.text }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    }))
    return { ok: true, chars: built.chars, sessionId }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), chars: built.chars }
  }
}

/** 「开读」：注入 QA 上下文 + followup 唤起一次模型阅读轮次。 */
async function startRead(deps: PanelApiDeps, body: Record<string, unknown>) {
  const built = await buildPaperContext(deps, body)
  if (!built.ok) return { ok: false, error: built.error ?? '构建上下文失败' }
  const sessionId = String(body.sessionId ?? '')
  const agents = deps.agents as
    | { get?(id: unknown): { inject?(msg: unknown): unknown; followup?(msg: unknown): unknown } | undefined }
    | undefined
  const agent = agents?.get?.(sessionId)
  if (!agent?.inject) {
    return { ok: false, error: '无法定位会话 agent（sessionId 无效或会话未激活）', chars: built.chars }
  }
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: built.text }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    }))
    if (typeof agent.followup === 'function') {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: READ_PROMPT }],
          source: { kind: 'user' },
        }),
      )
      return { ok: true, chars: built.chars, sessionId, followup: true }
    }
    return { ok: true, chars: built.chars, sessionId, followup: false, note: '已注入上下文；请手动在对话中输入阅读指令' }
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err), chars: built.chars }
  }
}

function maskConfig(cfg: ZoteroConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = SECRET_FIELDS.has(k) && String(v) ? '•••（已设置）' : v
  }
  out.cacheDir = resolveCacheDir(cfg)
  return out
}

/* ── artifacts store ───────────────────────────────────────────────── */

interface Artifact { type: string; title: string; payload: string; at: string }

function artifactsPath(cfg: ZoteroConfig): string {
  return join(resolveCacheDir(cfg), 'artifacts.json')
}

function readArtifacts(cfg: ZoteroConfig): Artifact[] {
  try {
    const p = artifactsPath(cfg)
    if (!existsSync(p)) return []
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Artifact[]
    return Array.isArray(raw) ? raw.slice(-50) : []
  } catch {
    return []
  }
}

function appendArtifact(cfg: ZoteroConfig, a: { type: string; title: string; payload: string }): Artifact[] {
  const list = readArtifacts(cfg)
  list.push({ ...a, at: new Date().toISOString() })
  writeArtifacts(cfg, list)
  return list
}

function writeArtifacts(cfg: ZoteroConfig, list: Artifact[]): void {
  try {
    const p = artifactsPath(cfg)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(list.slice(-50), null, 2), 'utf8')
  } catch { /* artifacts are best-effort */ }
}

export { PLUGIN_ID as PANEL_PLUGIN_ID }