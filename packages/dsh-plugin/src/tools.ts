/**
 * dsh-zotero — model-facing tools (M1: connection layer).
 *
 * zotero_health          Local/Web API 健康检测与数据源探测
 * zotero_library_search  库检索（元数据 + 可选全文 qmode=everything + tag/collection/itemType 过滤）
 * zotero_get_item        单条目详情（含附件/笔记/批注子项）
 * zotero_collections     收藏夹树（层级展开）
 *
 * 命名说明：环境内 zotero-wave-rag 已注册 zotero_search（语义检索），为避免
 * 同 scope 工具重名（注册即抛错），本插件的 Local API 检索命名为
 * zotero_library_search，并在描述中区分语义检索。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { remoteInstructionText, writeRemoteInstructions } from './panel-api.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ZoteroClient } from './zotero/client.ts'
import type { Config } from './config.ts'
import { annotateItem } from './backend/annotations.ts'

const renderJson = (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: JSON.stringify(value, null, 2) },
]

/** 按 output schema 递归裁剪返回值（dsh-tools 校验器 strict：未声明字段会被拒）。 */
export function stripBySchema(value: unknown, node: any): any {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((v) => stripBySchema(v, node?.items ?? {}))
  }
  if (typeof value === 'object') {
    let props: Record<string, unknown> = {}
    if (Array.isArray(node?.oneOf)) {
      for (const o of node.oneOf) Object.assign(props, o?.properties ?? {})
    } else {
      props = node?.properties ?? {}
    }
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(props)) {
      if (Object.hasOwn(value, k)) out[k] = stripBySchema((value as Record<string, unknown>)[k], props[k])
    }
    return out
  }
  return value
}

const itemSummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    version: { type: 'integer', required: true },
    itemType: { type: 'string', required: true },
    title: { type: 'string', required: true },
    creators: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          creatorType: { type: 'string', required: true },
          firstName: { type: 'string', required: true },
          lastName: { type: 'string', required: true },
          name: { type: 'string' },
          fullName: { type: 'string', required: true },
        },
      },
    },
    date: { type: 'string', required: true },
    year: { type: 'integer' },
    abstractNote: { type: 'string', required: true },
    doi: { type: 'string', required: true },
    url: { type: 'string', required: true },
    publicationTitle: { type: 'string', required: true },
    journalAbbreviation: { type: 'string', required: true },
    extra: { type: 'string', required: true },
    tags: { type: 'array', items: { type: 'string' }, required: true },
    collections: { type: 'array', items: { type: 'string' }, required: true },
    numChildren: { type: 'integer', required: true },
    numNotes: { type: 'integer', required: true },
    dateAdded: { type: 'string', required: true },
    dateModified: { type: 'string', required: true },
    library: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', required: true },
        id: { type: 'integer', required: true },
        name: { type: 'string' },
      },
    },
    source: { type: 'string', required: true },
  },
} as const

export function registerZoteroTools(ctx: { tools: { register(tool: unknown): void } }, client: ZoteroClient, config: Config): void {

  /* ── 工作区远程目标：两段式，强制人工确认 ──────────────────────────── */

  /*
   * 为什么不给 UI 按钮：填远程目标是一句话的事（"我这摊活跑在 lab-gpu 的
   * /data/exp/x 上"），对话比表单快；但写文件是有副作用的，所以拆成
   * preview / apply 两段，用一次性 planId 把两段绑起来 —— apply 拿不到
   * 有效 planId 就拒绝执行，模型没有办法一步跳过确认。
   *
   * 待确认的计划只存在内存里，5 分钟过期，且用掉即作废。
   */
  const pendingRemotePlans = new Map<
    string,
    { workspacePath: string; remote: { host: string; path: string } | null; at: number }
  >()
  const PLAN_TTL_MS = 5 * 60 * 1000

  const prunePlans = (): void => {
    const now = Date.now()
    for (const [k, v] of pendingRemotePlans) {
      if (now - v.at > PLAN_TTL_MS) pendingRemotePlans.delete(k)
    }
  }

  ctx.tools.register(
    defineTool({
      name: 'zotero_workspace_remote_preview',
      description:
        'PREVIEW ONLY — writes nothing. Show what "set a remote execution target for this workspace" would write into the workspace, and mint a one-shot planId. ' +
        'The remote target is a property of an EXISTING workspace: it records where that workspace\'s experiments actually run (which ssh host, which remote path). ' +
        'It does NOT create a workspace, a directory, or any sidebar entry — the only side effect of applying it is one AGENTS.local.md inside the given directory, which DSH then feeds into every session rooted there. ' +
        'WORKFLOW (mandatory): 1) call this tool; 2) show the user the returned content verbatim and ask them to confirm, using ask_user_question; ' +
        '3) only after they agree, call zotero_workspace_remote_apply with the planId. Never apply without the user having seen the content. ' +
        'Pass clear=true to preview REMOVING an existing target.',
      parameters: {
        workspacePath: {
          type: 'string',
          required: true,
          description:
            'Absolute local path of an existing workspace directory (e.g. D:\\...\\_ideas\\3d lewm). Must already exist — this tool never creates it.',
        },
        host: {
          type: 'string',
          description: 'ssh alias of the machine that runs the experiments, e.g. lab-gpu. Required unless clear=true.',
        },
        remotePath: {
          type: 'string',
          description: 'Absolute path on that machine, e.g. /data/exp/jepa-lewm. Required unless clear=true.',
        },
        clear: {
          type: 'boolean',
          description: 'Preview removing the remote target from this workspace instead of setting one.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            planId: { type: 'string', required: true },
            file: { type: 'string', required: true },
            action: { type: 'string', required: true },
            content: { type: 'string', required: true },
            error: { type: 'string', required: true },
            nextStep: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (args: {
        workspacePath: string
        host?: string
        remotePath?: string
        clear?: boolean
      }) => {
        prunePlans()
        const wsPath = String(args.workspacePath ?? '').trim()
        if (!wsPath) {
          return { ok: false, planId: '', file: '', action: '', content: '', error: '缺少 workspacePath', nextStep: '' }
        }
        if (!existsSync(wsPath)) {
          return {
            ok: false, planId: '', file: '', action: '', content: '',
            error: `工作区目录不存在：${wsPath}。这个工具只给已有工作区配远端，不会创建目录。`,
            nextStep: '',
          }
        }
        const clearing = args.clear === true
        if (!clearing && (!args.host || !args.remotePath)) {
          return {
            ok: false, planId: '', file: '', action: '', content: '',
            error: '需要同时给出 host 与 remotePath，或传 clear=true 表示清除',
            nextStep: '',
          }
        }
        const remote = clearing
          ? null
          : { host: String(args.host).trim(), path: String(args.remotePath).trim() }
        const file = join(wsPath, 'AGENTS.local.md')
        const content = remote ? remoteInstructionText(remote, wsPath) : '(将删除该文件)'
        const planId = randomUUID()
        pendingRemotePlans.set(planId, { workspacePath: wsPath, remote, at: Date.now() })
        return {
          ok: true,
          planId,
          file,
          action: clearing ? 'clear' : 'set',
          content,
          error: '',
          nextStep:
            '把上面的 content 原样展示给用户，用 ask_user_question 取得明确同意后，再调用 zotero_workspace_remote_apply。',
        }
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: '预览工作区远程目标', kind: 'other', rawInput: null }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'zotero_workspace_remote_apply',
      description:
        'Apply a previously previewed workspace remote-target change. Requires a planId from zotero_workspace_remote_preview. ' +
        'Call this ONLY after the user has seen the previewed content and explicitly agreed to it. ' +
        'The plan is single-use and expires after 5 minutes; an invalid or stale planId is rejected.',
      parameters: {
        planId: {
          type: 'string',
          required: true,
          description: 'planId returned by zotero_workspace_remote_preview.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            file: { type: 'string', required: true },
            action: { type: 'string', required: true },
            error: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (args: { planId: string }) => {
        prunePlans()
        const id = String(args.planId ?? '').trim()
        const plan = pendingRemotePlans.get(id)
        if (!plan) {
          return {
            ok: false, file: '', action: '',
            error: '计划不存在或已过期（有效期 5 分钟，且只能用一次）。请重新调用 zotero_workspace_remote_preview。',
          }
        }
        pendingRemotePlans.delete(id)   // 用掉即作废
        try {
          const file = writeRemoteInstructions(plan.workspacePath, plan.remote)
          return { ok: true, file, action: plan.remote ? 'set' : 'clear', error: '' }
        } catch (err: unknown) {
          return { ok: false, file: '', action: '', error: String((err as Error)?.message ?? err) }
        }
      },
      isConcurrencySafe: () => false,
      presentCall: () => ({ card: 'generic', title: '应用工作区远程目标', kind: 'other', rawInput: null }),
    }),
  )

    /* ── zotero_health ─────────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_health',
      description:
        'Report whether the Zotero source is reachable and which one: local API (Zotero Desktop HTTP server) or web API (configured fallback). Use it before Zotero tools fail repeatedly, or when the user asks why Zotero data is unavailable.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            source: { type: 'string', required: true },
            localBase: { type: 'string', required: true },
            webUserId: { type: 'string', required: true },
            latencyMs: { type: 'integer', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async () => client.health(),
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: 'Zotero 连接检测', kind: 'other', rawInput: null }),
    }),
  )

  /* ── zotero_library_search ─────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_library_search',
      description:
        'Search the Zotero library by metadata (title/creator/year/tags/abstract) or fulltext with qmode=everything, plus tag/collection/itemType filters. Returns normalized item summaries (no PDF bodies). SQLite/Semantic library search is zotero_search (zotero-wave-rag); this tool hits the live Zotero API and reflects the desktop state.',
      parameters: {
        query: {
          type: 'string',
          description:
            'Free-text query. With qmode=everything it also searches the full text of PDFs bound to your items.',
        },
        qmode: {
          type: 'string',
          enum: ['titleCreatorYear', 'everything', 'title', 'creators', 'year', 'tags', 'abstractNote'],
          description:
            'Search mode. everything = fulltext+metadata (slower); default titleCreatorYear.',
        },
        tag: { type: 'string', description: 'Restrict to items carrying this exact tag.' },
        collectionKey: { type: 'string', description: 'Restrict to a collection (its API key, e.g. from zotero_collections).' },
        itemType: { type: 'string', description: 'Zotero item type, e.g. journalArticle, book, conferencePaper.' },
        sort: {
          type: 'string',
          enum: ['dateAdded', 'dateModified', 'title', 'date', 'creator'],
          description: 'Sort field (default dateAdded); Zotero spells it `creator`, not `creators`.',
        },
        direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default desc).' },
        limit: { type: 'integer', description: 'Page size, 1-100 (default from config).' },
        start: { type: 'integer', description: 'Offset for pagination.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            items: { type: 'array', items: itemSummarySchema, required: true },
            qmode: { type: 'string', required: true },
            library: { type: 'string', required: true },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (args, exec) => {
        const a = args as Record<string, unknown>
        return client.scoped(exec.signal).search({
          query: typeof a.query === 'string' ? a.query : undefined,
          qmode: typeof a.qmode === 'string' ? a.qmode : undefined,
          tag: typeof a.tag === 'string' ? a.tag : undefined,
          collectionKey: typeof a.collectionKey === 'string' ? a.collectionKey : undefined,
          itemType: typeof a.itemType === 'string' ? a.itemType : undefined,
          sort: typeof a.sort === 'string' ? a.sort : undefined,
          direction: a.direction === 'asc' ? 'asc' : a.direction === 'desc' ? 'desc' : undefined,
          limit: typeof a.limit === 'number' ? a.limit : undefined,
          start: typeof a.start === 'number' ? a.start : undefined,
        })
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `库检索: ${String((args as { query?: unknown }).query ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_get_item ───────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_get_item',
      description:
        'Fetch one Zotero item with all its children: attachments (with file download paths), notes, and annotations. Use it after zotero_library_search / zotero_collections to read full metadata, tags, collections or to locate the PDF for further processing.',
      parameters: {
        key: {
          type: 'string',
          required: true,
          description: 'Zotero item key (the `key` field returned by zotero_library_search / zotero_collections).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            source: { type: 'string', required: true },
            item: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    ...itemSummarySchema.properties,
                    attachments: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          key: { type: 'string', required: true },
                          title: { type: 'string', required: true },
                          contentType: { type: 'string', required: true },
                          linkMode: { type: 'string', required: true },
                          filename: { type: 'string' },
                          downloadPath: { type: 'string', required: true },
                          isPdf: { type: 'boolean', required: true },
                        },
                      },
                    },
                    notes: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          key: { type: 'string', required: true },
                          note: { type: 'string', required: true },
                          title: { type: 'string', required: true },
                        },
                      },
                    },
                    annotations: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          key: { type: 'string', required: true },
                          annotationText: { type: 'string', required: true },
                          annotationComment: { type: 'string', required: true },
                          color: { type: 'string', required: true },
                          pageLabel: { type: 'string' },
                        },
                      },
                    },
                  },
                },
                { type: 'null' },
              ],
            },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (args, exec) => {
        return client.scoped(exec.signal).getItem(String((args as { key: string }).key ?? ''))
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: 'generic',
        title: `条目: ${String((args as { key?: unknown }).key ?? '')}`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  /* ── zotero_collections ────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_collections',
      description:
        'List the Zotero collection tree (nested folders, with item counts and depth). Use it for library browsing, or to resolve a collection name to its key before zotero_library_search(collectionKey=...).',
      parameters: {
        flat: {
          type: 'boolean',
          description:
            'Return the flat list (all collections with parentKey) instead of the nested tree (default false).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            tree: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  parentKey: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                  itemCount: { type: 'integer' },
                  depth: { type: 'integer', required: true },
                },
              },
            },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (_args: any, exec: any) => {
        return client.scoped(exec.signal).collections()
      },
      isConcurrencySafe: () => true,
      presentCall: () => ({ card: 'generic', title: 'Zotero 收藏夹', kind: 'other', rawInput: null }),
    }),
  )

  /* ── zotero_annotate ───────────────────────────────────────────────── */

  ctx.tools.register(
    defineTool({
      name: 'zotero_annotate',
      description:
        'Add an annotation (highlight, note, or comment) to a Zotero library item via Local API, and synchronize/append a structured Markdown note card into the local DSH workspace.',
      parameters: {
        itemKey: {
          type: 'string',
          description: 'Zotero item key (e.g. 8-char key like 4X8K9LP2).',
        },
        type: {
          type: 'string',
          enum: ['highlight', 'note', 'comment'],
          description: 'Annotation type: highlight (高亮划线), note (独立笔记), or comment (批注心得).',
        },
        text: {
          type: 'string',
          description: 'Selected/quoted text from the literature (for highlight or quote).',
        },
        comment: {
          type: 'string',
          description: 'User or agent annotation thoughts, reflection, critique, or notes.',
        },
        color: {
          type: 'string',
          description: 'Color hex code for the highlight/annotation (e.g. #ffd400 for yellow, #ff6666 for red, #2ea8e5 for blue).',
        },
        pageLabel: {
          type: 'string',
          description: 'Page label or number (e.g. "5" or "p. 12").',
        },
        attachmentKey: {
          type: 'string',
          description: 'Optional attachment key of the PDF. Defaults to resolving the item primary PDF attachment.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to attach to the annotation/note in Zotero and Markdown card.',
        },
        markdownPath: {
          type: 'string',
          description: 'Relative file path in workspace to write/append the Markdown card. Defaults to zotero-notes/<itemKey>.md.',
        },
        exportMarkdown: {
          type: 'boolean',
          description: 'Whether to write/append to local workspace Markdown file. Defaults to true.',
        },
        syncToZotero: {
          type: 'boolean',
          description: 'Whether to push to Zotero Local API. Defaults to true.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            itemKey: { type: 'string', required: true },
            type: { type: 'string', required: true },
            zoteroCreated: { type: 'boolean', required: true },
            zoteroItemKey: { type: 'string', required: true },
            markdownSaved: { type: 'boolean', required: true },
            markdownPath: { type: 'string', required: true },
            citation: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                title: { type: 'string', required: true },
                doi: { type: 'string', required: true },
              },
              required: true,
            },
            error: { type: 'string', required: true },
            hint: { type: 'string', required: true },
          },
        },
        render: renderJson,
      },
      execute: async (args: any, exec: any) => {
        const a = args as Record<string, unknown>
        const itemKey = String(a.itemKey || '')
        const type = (['highlight', 'note', 'comment'].includes(String(a.type))
          ? String(a.type)
          : 'note') as 'highlight' | 'note' | 'comment'
        const text = typeof a.text === 'string' ? a.text : undefined
        const comment = typeof a.comment === 'string' ? a.comment : undefined
        const color = typeof a.color === 'string' ? a.color : undefined
        const pageLabel = typeof a.pageLabel === 'string' ? a.pageLabel : undefined
        const attachmentKey = typeof a.attachmentKey === 'string' ? a.attachmentKey : undefined
        const tags = Array.isArray(a.tags) ? a.tags.map(String) : undefined
        const markdownPath = typeof a.markdownPath === 'string' ? a.markdownPath : undefined
        const exportMarkdown = typeof a.exportMarkdown === 'boolean' ? a.exportMarkdown : true
        const syncToZotero = typeof a.syncToZotero === 'boolean' ? a.syncToZotero : true

        const scopedClient = client.scoped(exec?.signal)
        return annotateItem(scopedClient, {
          itemKey,
          type,
          text,
          comment,
          color,
          pageLabel,
          attachmentKey,
          tags,
          markdownPath,
          exportMarkdown,
          syncToZotero,
        })
      },
      isConcurrencySafe: () => false,
      presentCall: (args: any) => ({
        card: 'generic',
        title: `Zotero 批注: ${String(args?.itemKey ?? '')} (${String(args?.type ?? 'note')})`,
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  void config
}
