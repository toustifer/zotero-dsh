/**
 * dsh-zotero — MinerU parse cache on disk (workspace/DSH_HOME layout).
 *
 * <cacheDir>/mineru/<attachmentKey>/
 *   full.md            canonical markdown
 *   manifest.json      { parsedAtUtc, backend, source, mdChars, images[] }
 *   images/<relPath>   extracted figure assets
 *
 * The layout mirrors upstream llm-for-zotero's cache so existing MinerU
 * outputs could be reused in principle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../config.ts'

export interface MineruManifest {
  parsedAtUtc: string
  backend: string
  source: string
  mdChars: number
  images: string[]
  /** 条目标题（overview 列表展示；旧缓存可能缺失）。 */
  title?: string
}

/**
 * itemKey -> the attachment keys already parsed for it.
 *
 * The cache is keyed by ATTACHMENT key, and the only way to learn an item's
 * attachment keys is to ask Zotero. That makes an otherwise pure-disk cache
 * unreachable whenever Zotero is down — closed for a DB write, restarting,
 * crashed — even though full.md is sitting right there. This index is the map
 * that survives without Zotero: recorded on every successful lookup, consulted
 * only when the Local API cannot be reached.
 */
const INDEX_FILE = 'item-attachments.json'

function indexPath(cfg: Config): string {
  return join(resolveCacheDir(cfg), 'mineru', INDEX_FILE)
}

export function readAttachmentIndex(cfg: Config): Record<string, string[]> {
  try {
    const p = indexPath(cfg)
    if (!existsSync(p)) return {}
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string[]>
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** Remember (never forget) the attachment keys seen for one item. */
export function rememberAttachments(cfg: Config, itemKey: string, attachmentKeys: string[]): void {
  const keys = attachmentKeys.filter((k) => typeof k === 'string' && k.length > 0)
  if (!itemKey || keys.length === 0) return
  try {
    const idx = readAttachmentIndex(cfg)
    const merged = Array.from(new Set([...(idx[itemKey] ?? []), ...keys]))
    if (merged.length === (idx[itemKey] ?? []).length) return
    idx[itemKey] = merged
    mkdirSync(join(resolveCacheDir(cfg), 'mineru'), { recursive: true })
    writeFileSync(indexPath(cfg), JSON.stringify(idx, null, 2), 'utf8')
  } catch {
    /* The index is a convenience, never a failure. */
  }
}

/**
 * Attachment keys worth trying when Zotero cannot be asked, restricted to those
 * that actually have a cached full.md. Preferred key (an explicit
 * attachmentKey argument) is tried first.
 */
export function offlineAttachmentKeys(cfg: Config, itemKey: string, preferred?: string): string[] {
  const fromIndex = readAttachmentIndex(cfg)[itemKey] ?? []
  const ordered = preferred ? [preferred, ...fromIndex] : fromIndex
  const seen = new Set<string>()
  return ordered.filter((k) => {
    if (!k || seen.has(k)) return false
    seen.add(k)
    return existsSync(join(attachmentCacheDir(cfg, k), 'full.md'))
  })
}

export function resolveCacheDir(cfg: Config): string {
  if (cfg.cacheDir.trim()) return cfg.cacheDir
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'data', 'dsh-zotero', 'cache')
}

export function attachmentCacheDir(cfg: Config, attachmentKey: string): string {
  return join(resolveCacheDir(cfg), 'mineru', String(attachmentKey))
}

export function readCachedMd(cfg: Config, attachmentKey: string): string | null {
  const p = join(attachmentCacheDir(cfg, attachmentKey), 'full.md')
  try {
    if (!existsSync(p)) return null
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function readManifest(cfg: Config, attachmentKey: string): MineruManifest | null {
  const p = join(attachmentCacheDir(cfg, attachmentKey), 'manifest.json')
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as MineruManifest
  } catch {
    return null
  }
}

export function writeCache(
  cfg: Config,
  attachmentKey: string,
  md: string,
  images: Array<{ relPath: string; bytes: Uint8Array }>,
  backend: string,
  source: string,
  title?: string,
): { dir: string; manifest: MineruManifest } {
  const dir = attachmentCacheDir(cfg, attachmentKey)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'full.md'), md, 'utf8')
  const imageNames: string[] = []
  for (const img of images) {
    // Flatten to images/<basename> with collision suffixes.
    const base = img.relPath.split('/').pop() || 'img.bin'
    let name = base
    let i = 1
    while (imageNames.includes(name) && i < 1000) {
      const dot = base.lastIndexOf('.')
      name = `${dot > 0 ? base.slice(0, dot) : base}-${i}${dot > 0 ? base.slice(dot) : ''}`
      i += 1
    }
    imageNames.push(name)
    writeFileSync(join(dir, 'images', name), img.bytes)
  }
  const manifest: MineruManifest = {
    parsedAtUtc: new Date().toISOString(),
    backend,
    source,
    mdChars: md.length,
    images: imageNames,
    ...(title ? { title } : {}),
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { dir, manifest }
}
