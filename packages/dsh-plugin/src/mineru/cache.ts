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
