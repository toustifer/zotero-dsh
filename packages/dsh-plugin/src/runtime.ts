/**
 * dsh-zotero — runtime config store（settings.json overlay + hot apply）。
 *
 * schema（Config）是唯一契约：类型/默认值/校验。本模块提供可写的运行时
 * 覆盖层 <DSH_HOME>/data/dsh-zotero/settings.json；apply() 时与 schema 默认值
 * 合并，面板「设置」表单保存 → writeOverlay → setActiveConfig 热生效
 * （client/MinerU 下一次调用即用新配置，无需重启/重载）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './config.ts'

/** 与 config.ts schema 默认值保持一致的默认集。 */
export const DEFAULT_CONFIG: Config = {
  localApiHost: '127.0.0.1',
  localApiPort: 23119,
  localApiKey: '',
  webUserId: '',
  webApiKey: '',
  requestTimeoutMs: 15000,
  searchLimit: 25,
  storageDir: '',
  mineruMode: 'local',
  mineruLocalApiBase: 'http://127.0.0.1:8000',
  mineruLocalBackend: 'pipeline',
  mineruCloudApiKey: '',
  mineruCloudModel: 'vlm',
  mineruForceOcr: false,
  mineruMaxAutoPages: 100,
  fullTextTokenBudget: 20000,
  chatWithPdfPrompt: '',
  summaryPrompt: '',
  translatePrompt: '',
  translateTargetLang: 'zh',
  pdf2zhBaseUrl: 'https://api.deepseek.com/v1',
  pdf2zhApiKey: '',
  pdf2zhModel: 'deepseek-chat',
  pdf2zhThreads: 4,
  ragEnabled: false,
  cacheDir: '',
}

function settingsPath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'data', 'dsh-zotero', 'settings.json')
}

/** 按字段类型表做轻量清洗（覆盖层只接受已知键、正确原型）。 */
function sanitizeOverlay(raw: unknown): Partial<Config> {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: Partial<Config> = {}
  const str = (k: keyof Config) => {
    if (typeof r[k] === 'string') (out as Record<string, unknown>)[k] = r[k]
  }
  const num = (k: keyof Config, min: number, max: number) => {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) {
      (out as Record<string, unknown>)[k] = v
    }
  }
  const bool = (k: keyof Config) => {
    if (typeof r[k] === 'boolean') (out as Record<string, unknown>)[k] = r[k]
  }
  const oneOf = (k: keyof Config, allowed: string[]) => {
    if (typeof r[k] === 'string' && allowed.includes(r[k] as string)) (out as Record<string, unknown>)[k] = r[k]
  }
  str('localApiHost'); num('localApiPort', 1, 65535); str('localApiKey')
  str('webUserId'); str('webApiKey'); num('requestTimeoutMs', 1000, 120000)
  num('searchLimit', 1, 100); str('storageDir')
  oneOf('mineruMode', ['local', 'cloud']); str('mineruLocalApiBase')
  oneOf('mineruLocalBackend', ['pipeline', 'vlm', 'hybrid']); str('mineruCloudApiKey')
  oneOf('mineruCloudModel', ['pipeline', 'vlm']); bool('mineruForceOcr')
  num('mineruMaxAutoPages', 1, 10000); num('fullTextTokenBudget', 1000, 500000)
  str('chatWithPdfPrompt'); str('summaryPrompt'); str('translatePrompt')
  bool('ragEnabled'); str('cacheDir')
  str('translateTargetLang')
  str('pdf2zhBaseUrl'); str('pdf2zhApiKey'); str('pdf2zhModel'); num('pdf2zhThreads', 1, 16)
  return out
}

export function loadOverlay(): Partial<Config> {
  try {
    const p = settingsPath()
    if (!existsSync(p)) return {}
    return sanitizeOverlay(JSON.parse(readFileSync(p, 'utf8')))
  } catch {
    return {}
  }
}

export function writeOverlay(partial: Partial<Config>): Partial<Config> {
  const merged = { ...loadOverlay(), ...sanitizeOverlay(partial) }
  try {
    mkdirSync(join(settingsPath(), '..'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8')
  } catch {
    /* best-effort */
  }
  return merged
}

export function composeConfig(): Config {
  return { ...baseConfig, ...loadOverlay() }
}

/* ── active runtime config（热生效） ─────────────────────────────── */

/** cordis 组合层传入的配置（覆盖层的基底）。 */
let baseConfig: Config = composeOverlayBase()

function composeOverlayBase(): Config {
  return { ...DEFAULT_CONFIG }
}

export function setBaseConfig(cfg: Config): void {
  baseConfig = cfg
}

let active: Config = composeConfig()

export function setActiveConfig(cfg: Config): void {
  active = cfg
}

export function currentConfig(): Config {
  return active
}
