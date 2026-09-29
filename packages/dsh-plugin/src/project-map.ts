/**
 * project-map.ts — 论文 ↔ 工作区 映射层（M4 v2：分区模型）。
 *
 * v1 只有「项目」一层，表达不了要的两件事：
 *   1. 论文要能同时属于多个 idea（重叠）
 *   2. 「调研别人的论文」与「做自己的论文」是两种不同的活动，要分区分空间
 *
 * v2 的分层：
 *
 *   Zone   固定两个：survey（调研区）/ research（研究区）。不可增删。
 *   Group  区下面的工作空间组。zone 决定语义：
 *            survey   →  Idea 组（一个 idea 一摊事）
 *            research →  项目组，其中恰有一个 kind='dev' 的专用开发空间
 *          每个 Group 有自己的 cwd —— DSH 的工作区必须是真实目录，所以 cwd 落在这一层。
 *   Member 论文 ↔ Group 的归属。**多对多**：重叠就发生在这里。
 *   Edge   论文 ↔ 论文的有向关系。全局，不挂在任何组下。
 *   Conv   会话归属到 Group（不是 Zone，也不是论文）。
 *
 * 三条不变量：
 *   1. Zone 是分类，不是目录；能落 cwd 的最小单位是 Group。
 *   2. 重叠只在 Member 上表达。一篇论文可以同时是三个 idea 的成员。
 *   3. 会话归属唯一，且 cwd 由**打开时的上下文**（哪个 Group）决定，不由论文决定 ——
 *      同一篇论文从 idea A 和 idea B 打开，是两个会话、两个 cwd。
 *      这正是一次复现要在两套实验目录下各跑一遍时想要的行为。
 *
 * 落盘：<cacheDir>/project-map.json（v1 自动迁移为 research 区的 project 组）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveCacheDir } from './mineru/cache.ts'
import { currentConfig } from './runtime.ts'

/** 分区。固定两个，不可扩展。 */
export type ZoneId = 'survey' | 'research'

/** 组在所在区里的语义。 */
export type GroupKind = 'idea' | 'project' | 'dev'

/** 论文在某组里的角色。 */
export type PaperRole = 'primary' | 'reference' | 'background'

/**
 * 论文在某组里的活动状态。两个区取值不同：
 *   survey   → to-read / reading / reproduced / rejected
 *   research → drafting / under-review / published
 * 用宽松 string 存，避免为一个 UI 文案改 schema。
 */
export type PaperStatus = string

/** 论文间的有向关系。 */
export type EdgeKind = 'cite' | 'compare' | 'extends' | 'contradicts'

export interface Zone {
  id: ZoneId
  name: string
  /** 该区的定位说明，面板头部展示。 */
  blurb: string
}

/** 两个固定分区。 */
export const ZONES: readonly Zone[] = [
  { id: 'survey', name: '调研区', blurb: '读别人的论文：按 idea 归拢，标复现状态' },
  { id: 'research', name: '研究区', blurb: '做自己的论文：按课题归拢，含专用开发空间' },
] as const

export interface Group {
  /** slug 主键，全局唯一（跨区也不重名）。 */
  id: string
  zone: ZoneId
  name: string
  kind: GroupKind
  /** 该组对应的工作目录 —— DSH 工作区的落点。空串表示尚未指定。 */
  cwd: string
  /**
   * 远程执行目标。
   *
   * DSH 的工作区必须是**本地真实目录**，所以远程实验采用「同名锚点」：
   * cwd 指向本地锚点目录，remote.path 指向远端真实目录，两者**末段名一致**
   * （jepa-lewm ↔ jepa-lewm），一眼能对上。本地锚点放脚本/笔记/配置，
   * 真正的算力活经 ssh 打过去跑。
   */
  remote?: {
    /** ssh 别名或 user@host，例如 lab-gpu。 */
    host: string
    /** 远端绝对路径，例如 /data/exp/jepa-lewm。 */
    path: string
  }
  /** dsh workspaceController 的 id（若已与 GUI 工作区列表绑定）。 */
  workspaceId?: string
  /** 置顶（开发空间与当前主攻组建议置顶）。 */
  pinned?: boolean
  note?: string
  createdAt: number
  at: number
}

/** 论文 ↔ 组的归属。多对多 —— 重叠发生在这里。 */
export interface Member {
  groupId: string
  /** Zotero itemKey —— 跨组/跨会话的稳定主键。 */
  itemKey: string
  /** 冗余存标题，面板列表免回查 Zotero。 */
  title: string
  role: PaperRole
  status: PaperStatus
  at: number
}

export interface PaperEdge {
  /** 引用方 itemKey。 */
  from: string
  /** 被引方 itemKey。 */
  to: string
  kind: EdgeKind
  note?: string
  /** 自动落边时记录的来源会话。 */
  sessionId?: string
  at: number
}

export interface ConvBinding {
  sessionId: string
  groupId: string
  /** 主论文 itemKey；库级会话（zotero-library）为空。 */
  itemKey?: string
  at: number
}

/**
 * 论文级的复现工作区目标。
 *
 * 为什么不挂在 Group 上：一篇论文可能还没归到任何组（用户就是想先把复现目录
 * 定下来），而"这篇论文的代码放哪"本身是论文的属性，不是某个组视图的属性。
 * 所以单独一层，key 就是 Zotero itemKey。
 */
export interface WorkspaceTargetRecord {
  itemKey: string
  /** 显式本地目录。与 remote 互斥，remote 优先。 */
  dir?: string
  remote?: { host: string; path: string }
  at: number
}

export interface ProjectMap {
  version: 2
  groups: Group[]
  members: Member[]
  edges: PaperEdge[]
  convs: ConvBinding[]
  /** 论文 → 工作区目标的显式覆盖。空表示全部走默认落点规则。 */
  targets: WorkspaceTargetRecord[]
}

const EMPTY: ProjectMap = { version: 2, groups: [], members: [], edges: [], convs: [], targets: [] }

function mapPath(): string {
  return join(resolveCacheDir(currentConfig()), 'project-map.json')
}

/** 把任意名称折成 slug 主键：小写、非字母数字折成 '-'、保留中文、限长。 */
export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (s || 'group').slice(0, 64)
}

/** 区 id 校验：只认固定两个。 */
export function isZone(v: unknown): v is ZoneId {
  return v === 'survey' || v === 'research'
}

function normGroup(raw: unknown): Group | undefined {
  const r = raw as Record<string, unknown>
  if (!r || typeof r.id !== 'string' || typeof r.name !== 'string') return undefined
  if (!isZone(r.zone)) return undefined
  const kind: GroupKind = r.kind === 'dev' || r.kind === 'project' ? r.kind : 'idea'
  return {
    id: r.id,
    zone: r.zone,
    name: r.name,
    kind,
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
    ...(r.remote && typeof (r.remote as Record<string, unknown>).host === 'string'
      && typeof (r.remote as Record<string, unknown>).path === 'string'
      ? { remote: { host: String((r.remote as Record<string, unknown>).host), path: String((r.remote as Record<string, unknown>).path) } }
      : {}),
    ...(typeof r.workspaceId === 'string' ? { workspaceId: r.workspaceId } : {}),
    ...(r.pinned === true ? { pinned: true } : {}),
    ...(typeof r.note === 'string' ? { note: r.note } : {}),
    createdAt: Number(r.createdAt) || Date.now(),
    at: Number(r.at) || Date.now(),
  }
}

/** 旧版迁移：v1 的 project 一律当作 research 区的 project 组。 */
function migrateV1(raw: Record<string, unknown>): ProjectMap {
  const out: ProjectMap = { version: 2, groups: [], members: [], edges: [], convs: [], targets: [] }
  const idMap = new Map<string, string>()
  const projects = Array.isArray(raw.projects) ? (raw.projects as Record<string, unknown>[]) : []
  for (const p of projects) {
    const g = normGroup({ ...p, zone: 'research', kind: 'project' })
    if (!g) continue
    out.groups.push(g)
    idMap.set(String(p.id), g.id)
  }
  const papers = Array.isArray(raw.papers) ? (raw.papers as Record<string, unknown>[]) : []
  for (const p of papers) {
    const gid = idMap.get(String(p.projectId))
    if (!gid || typeof p.itemKey !== 'string') continue
    out.members.push({
      groupId: gid,
      itemKey: p.itemKey,
      title: typeof p.title === 'string' ? p.title : p.itemKey,
      role: p.role === 'primary' || p.role === 'background' ? p.role : 'reference',
      status: '',
      at: Number(p.at) || Date.now(),
    })
  }
  if (Array.isArray(raw.edges)) out.edges = raw.edges as PaperEdge[]
  const convs = Array.isArray(raw.convs) ? (raw.convs as Record<string, unknown>[]) : []
  for (const c of convs) {
    const gid = idMap.get(String(c.projectId))
    if (!gid || typeof c.sessionId !== 'string') continue
    out.convs.push({
      sessionId: c.sessionId,
      groupId: gid,
      ...(typeof c.itemKey === 'string' ? { itemKey: c.itemKey } : {}),
      at: Number(c.at) || Date.now(),
    })
  }
  return out
}

export function readProjectMap(): ProjectMap {
  try {
    const p = mapPath()
    if (!existsSync(p)) return { ...EMPTY }
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    // v1 → v2：老文件的 version 是 1（或缺失），且带 projects/papers 字段。
    if (raw?.version !== 2 && (Array.isArray(raw?.projects) || Array.isArray(raw?.papers))) {
      const migrated = migrateV1(raw)
      writeProjectMap(migrated)
      return migrated
    }
    return {
      version: 2,
      groups: Array.isArray(raw?.groups)
        ? (raw.groups as unknown[]).map(normGroup).filter((g): g is Group => Boolean(g))
        : [],
      members: Array.isArray(raw?.members) ? (raw.members as Member[]) : [],
      edges: Array.isArray(raw?.edges) ? (raw.edges as PaperEdge[]) : [],
      convs: Array.isArray(raw?.convs) ? (raw.convs as ConvBinding[]) : [],
      targets: Array.isArray(raw?.targets)
        ? (raw.targets as Record<string, unknown>[])
            .filter((t) => typeof t?.itemKey === 'string')
            .map((t) => ({
              itemKey: String(t.itemKey),
              ...(typeof t.dir === 'string' && t.dir ? { dir: t.dir } : {}),
              ...(t.remote && typeof (t.remote as Record<string, unknown>).host === 'string'
                && typeof (t.remote as Record<string, unknown>).path === 'string'
                ? { remote: { host: String((t.remote as Record<string, unknown>).host), path: String((t.remote as Record<string, unknown>).path) } }
                : {}),
              at: Number(t.at) || Date.now(),
            }))
        : [],
    }
  } catch {
    return { ...EMPTY }
  }
}

export function writeProjectMap(m: ProjectMap): void {
  const p = mapPath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(m, null, 2), 'utf8')
}

/** 取唯一组 id：同名冲突时追加 -2 / -3 …（跨区也唯一，避免面板按 id 找错区）。 */
function uniqueGroupId(m: ProjectMap, name: string, ignore?: string): string {
  const base = slugify(name)
  let id = base
  let n = 1
  while (m.groups.some((g) => g.id === id && g.id !== ignore)) {
    n += 1
    id = base + '-' + n
  }
  return id
}

/** 读一篇论文的显式工作区目标；没设过返回 undefined。 */
export function getWorkspaceTarget(itemKey: string): WorkspaceTargetRecord | undefined {
  const m = readProjectMap()
  return m.targets.find((t) => t.itemKey === itemKey)
}

/**
 * 写/清一篇论文的工作区目标。
 * 传空 dir 且空 remote 视为**清除**，之后该论文回到默认落点规则。
 */
export function setWorkspaceTarget(input: {
  itemKey: string
  dir?: string
  remote?: { host: string; path: string } | null
}): WorkspaceTargetRecord | undefined {
  const m = readProjectMap()
  const key = String(input.itemKey || '').trim()
  if (!key) return undefined
  const dir = String(input.dir ?? '').trim()
  const remote = input.remote && input.remote.host && input.remote.path
    ? { host: String(input.remote.host), path: String(input.remote.path) }
    : undefined

  m.targets = m.targets.filter((t) => t.itemKey !== key)
  if (!dir && !remote) { writeProjectMap(m); return undefined }   // 显式清除

  const rec: WorkspaceTargetRecord = {
    itemKey: key,
    ...(dir ? { dir } : {}),
    ...(remote ? { remote } : {}),
    at: Date.now(),
  }
  m.targets.push(rec)
  writeProjectMap(m)
  return rec
}

/** 新建或更新一个组。传 id 即更新；只覆盖显式给出的字段。 */
export function upsertGroup(input: {
  id?: string
  zone: ZoneId
  name: string
  kind?: GroupKind
  cwd?: string
  remote?: { host: string; path: string } | null
  workspaceId?: string
  pinned?: boolean
  note?: string
}): Group {
  const m = readProjectMap()
  const now = Date.now()
  const name = input.name.trim() || '未命名'
  const existing = input.id ? m.groups.find((g) => g.id === input.id) : undefined
  if (existing) {
    existing.name = name
    existing.zone = input.zone
    if (input.kind !== undefined) existing.kind = input.kind
    if (input.cwd !== undefined) existing.cwd = input.cwd
    // remote 传 null 表示显式清除（退回纯本地），不传则不动。
    if (input.remote !== undefined) {
      if (input.remote === null) delete existing.remote
      else existing.remote = { host: String(input.remote.host), path: String(input.remote.path) }
    }
    if (input.workspaceId !== undefined) existing.workspaceId = input.workspaceId
    if (input.pinned !== undefined) existing.pinned = input.pinned
    if (input.note !== undefined) existing.note = input.note
    existing.at = now
    writeProjectMap(m)
    return existing
  }
  // kind 默认值随区：调研区默认 idea，研究区默认 project。
  const kind: GroupKind = input.kind ?? (input.zone === 'survey' ? 'idea' : 'project')
  const g: Group = {
    id: input.id && !m.groups.some((x) => x.id === input.id) ? input.id : uniqueGroupId(m, name),
    zone: input.zone,
    name,
    kind,
    cwd: input.cwd ?? '',
    ...(input.remote ? { remote: { host: String(input.remote.host), path: String(input.remote.path) } } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.pinned ? { pinned: true } : {}),
    ...(input.note ? { note: input.note } : {}),
    createdAt: now,
    at: now,
  }
  m.groups.push(g)
  writeProjectMap(m)
  return g
}

/** 删组：连带清该组的成员归属与会话归属；全局边保持不动。 */
export function deleteGroup(groupId: string): { ok: boolean; wasDev?: boolean } {
  const m = readProjectMap()
  const g = m.groups.find((x) => x.id === groupId)
  if (!g) return { ok: false }
  m.groups = m.groups.filter((x) => x.id !== groupId)
  m.members = m.members.filter((x) => x.groupId !== groupId)
  m.convs = m.convs.filter((x) => x.groupId !== groupId)
  writeProjectMap(m)
  return { ok: true, ...(g.kind === 'dev' ? { wasDev: true } : {}) }
}

/**
 * 把论文挂进组。多对多：同一 itemKey 可挂在任意多个组下，各自带 role/status。
 * 重复挂载同一组则更新 role/status/title。
 */
export function bindMember(input: {
  groupId: string
  itemKey: string
  title?: string
  role?: PaperRole
  status?: string
}): Member {
  const m = readProjectMap()
  const now = Date.now()
  const found = m.members.find((x) => x.groupId === input.groupId && x.itemKey === input.itemKey)
  if (found) {
    if (input.title) found.title = input.title
    if (input.role) found.role = input.role
    if (input.status !== undefined) found.status = input.status
    found.at = now
    writeProjectMap(m)
    return found
  }
  const mem: Member = {
    groupId: input.groupId,
    itemKey: input.itemKey,
    title: input.title ?? input.itemKey,
    role: input.role ?? 'reference',
    status: input.status ?? '',
    at: now,
  }
  m.members.push(mem)
  writeProjectMap(m)
  return mem
}

/** 从组里摘论文（连带解该组下该论文的会话归属；论文本身与其他组不受影响）。 */
export function unbindMember(groupId: string, itemKey: string): { ok: boolean } {
  const m = readProjectMap()
  const before = m.members.length
  m.members = m.members.filter((x) => !(x.groupId === groupId && x.itemKey === itemKey))
  m.convs = m.convs.filter((c) => !(c.groupId === groupId && c.itemKey === itemKey))
  if (m.members.length === before) return { ok: false }
  writeProjectMap(m)
  return { ok: true }
}

/** 改组内论文的状态（复现进度 / 撰写阶段）。 */
export function setMemberStatus(
  groupId: string,
  itemKey: string,
  status: string,
): { ok: boolean; member?: Member } {
  const m = readProjectMap()
  const found = m.members.find((x) => x.groupId === groupId && x.itemKey === itemKey)
  if (!found) return { ok: false }
  found.status = status
  found.at = Date.now()
  writeProjectMap(m)
  return { ok: true, member: found }
}

/**
 * 记录一条论文间有向边。同一 (from,to,kind) 幂等：只刷新时间与备注。
 * 反向边不自动创建 —— 引用是有方向的，反向由调用方显式决定。
 */
export function linkPapers(input: {
  from: string
  to: string
  kind?: EdgeKind
  note?: string
  sessionId?: string
}): PaperEdge {
  const m = readProjectMap()
  const now = Date.now()
  const kind: EdgeKind = input.kind ?? 'cite'
  const found = m.edges.find((e) => e.from === input.from && e.to === input.to && e.kind === kind)
  if (found) {
    if (input.note !== undefined) found.note = input.note
    if (input.sessionId !== undefined) found.sessionId = input.sessionId
    found.at = now
    writeProjectMap(m)
    return found
  }
  const edge: PaperEdge = {
    from: input.from,
    to: input.to,
    kind,
    ...(input.note ? { note: input.note } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    at: now,
  }
  m.edges.push(edge)
  writeProjectMap(m)
  return edge
}

export function unlinkPapers(from: string, to: string, kind?: EdgeKind): { ok: boolean; removed: number } {
  const m = readProjectMap()
  const before = m.edges.length
  m.edges = m.edges.filter(
    (e) => !(e.from === from && e.to === to && (kind === undefined || e.kind === kind)),
  )
  const removed = before - m.edges.length
  if (removed > 0) writeProjectMap(m)
  return { ok: removed > 0, removed }
}

/** 该论文所在的全部组（多对多反查）。 */
export function groupsOfPaper(itemKey: string): Group[] {
  const m = readProjectMap()
  const ids = new Set(m.members.filter((x) => x.itemKey === itemKey).map((x) => x.groupId))
  return m.groups.filter((g) => ids.has(g.id))
}

/** 同一篇论文在哪些组里、各是什么角色与状态 —— 重叠视图的数据源。 */
export function membershipsOfPaper(itemKey: string): Member[] {
  return readProjectMap().members.filter((x) => x.itemKey === itemKey)
}

/** 某论文的引用邻域：out = 它引用了谁，in = 谁引用了它。 */
export function neighborsOfPaper(itemKey: string, kind?: EdgeKind): { out: PaperEdge[]; in: PaperEdge[] } {
  const m = readProjectMap()
  const ok = (e: PaperEdge): boolean => kind === undefined || e.kind === kind
  return {
    out: m.edges.filter((e) => e.from === itemKey && ok(e)),
    in: m.edges.filter((e) => e.to === itemKey && ok(e)),
  }
}

/** 会话归属：默认把该组的主论文钉为该会话 itemKey。 */
export function bindConversation(input: {
  sessionId: string
  groupId: string
  itemKey?: string
}): ConvBinding {
  const m = readProjectMap()
  const now = Date.now()
  const found = m.convs.find((c) => c.sessionId === input.sessionId)
  if (found) {
    found.groupId = input.groupId
    if (input.itemKey !== undefined) found.itemKey = input.itemKey
    found.at = now
    writeProjectMap(m)
    return found
  }
  const b: ConvBinding = {
    sessionId: input.sessionId,
    groupId: input.groupId,
    ...(input.itemKey ? { itemKey: input.itemKey } : {}),
    at: now,
  }
  m.convs.push(b)
  writeProjectMap(m)
  return b
}

/** 会话 → 组。没绑过时返回 undefined，调用方回落到旧行为（继承父会话 cwd）。 */
export function groupForSession(sessionId: string): Group | undefined {
  const m = readProjectMap()
  const c = m.convs.find((x) => x.sessionId === sessionId)
  if (!c) return undefined
  return m.groups.find((g) => g.id === c.groupId)
}

/** 会话应使用的工作目录：优先该会话所属组的 cwd。 */
export function cwdForSession(sessionId: string): string | undefined {
  const g = groupForSession(sessionId)
  return g?.cwd ? g.cwd : undefined
}

/**
 * 打开上下文 → 组。按优先级解析：显式 groupId → 该会话已绑的组 → 该论文在指定区的组。
 * zone 省略时跨区取第一个命中（保持 v1 行为）。
 */
export function resolveGroup(input: {
  sessionId?: string
  itemKey?: string
  groupId?: string
  zone?: ZoneId
}): Group | undefined {
  const m = readProjectMap()
  if (input.groupId) {
    const g = m.groups.find((x) => x.id === input.groupId)
    if (g) return g
  }
  if (input.sessionId) {
    const c = m.convs.find((x) => x.sessionId === input.sessionId)
    if (c) {
      const g = m.groups.find((x) => x.id === c.groupId)
      if (g) return g
    }
  }
  if (input.itemKey) {
    const ids = m.members.filter((x) => x.itemKey === input.itemKey).map((x) => x.groupId)
    const cands = m.groups.filter(
      (g) => ids.includes(g.id) && (input.zone === undefined || g.zone === input.zone),
    )
    // 有 cwd 的优先，让会话直接落到能干活的地方。
    const withCwd = cands.filter((g) => g.cwd)
    const pool = withCwd.length > 0 ? withCwd : cands
    return pool[0]
  }
  return undefined
}

/** 取某个区的全部组（含成员与组内会话），供面板分区渲染。置顶优先。 */
export function zoneSnapshot(zone: ZoneId): {
  zone: Zone
  groups: Array<Group & { members: Member[]; sessions: ConvBinding[] }>
} {
  const m = readProjectMap()
  const z = ZONES.find((x) => x.id === zone) ?? ZONES[0]
  return {
    zone: z,
    groups: m.groups
      .filter((g) => g.zone === zone)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.at - a.at)
      .map((g) => ({
        ...g,
        members: m.members.filter((x) => x.groupId === g.id),
        sessions: m.convs.filter((c) => c.groupId === g.id),
      })),
  }
}

/** 面板一次性拉全量：两个区 + 全局边。 */
export function projectSnapshot(): {
  zones: Array<{ zone: Zone; groups: Array<Group & { members: Member[]; sessions: ConvBinding[] }> }>
  edges: PaperEdge[]
} {
  return {
    zones: ZONES.map((z) => zoneSnapshot(z.id)),
    edges: readProjectMap().edges,
  }
}
