/**
 * dsh-zotero — PDF acquisition for parsing.
 *
 * Primary : Zotero Local API file GET  /api/users/0/items/{attachmentKey}/file
 *           (read requests need no key on the local API).
 * Fallback: configured static storage dir — glob <storageDir>/<key>/* for the
 *           file directly on disk (used when the local API is disabled).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import type { ZoteroClient } from './client.ts'

export interface PdfFetchResult {
  bytes: Uint8Array
  source: 'api' | 'storage'
  fileName: string
}

export async function fetchAttachmentPdf(
  client: ZoteroClient,
  attachmentKey: string,
  cfg: Config,
  signal?: AbortSignal,
): Promise<PdfFetchResult> {
  // 1) Local/Web API file endpoint (local reads need no auth).
  const viaApi = await client.fetchFile(attachmentKey, signal)
  if (viaApi) {
    return { bytes: viaApi.bytes, source: 'api', fileName: viaApi.fileName }
  }

  // 2) On-disk storage fallback (static config).
  if (cfg.storageDir.trim()) {
    const dir = join(cfg.storageDir, attachmentKey)
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (/\.pdf$/i.test(f)) {
          const bytes = new Uint8Array(readFileSync(join(dir, f)))
          return { bytes, source: 'storage', fileName: f }
        }
      }
      // Some attachments store files inside nested folders; one-level glob.
      for (const sub of readdirSync(dir)) {
        const subDir = join(dir, sub)
        if (existsSync(subDir) && readdirSync(subDir).some((f) => /\.pdf$/i.test(f))) {
          const f = readdirSync(subDir).find((x) => /\.pdf$/i.test(x))!
          return { bytes: new Uint8Array(readFileSync(join(subDir, f))), source: 'storage', fileName: f }
        }
      }
    }
  }
  throw new Error(
    `无法获取附件 ${attachmentKey} 的 PDF：Local API 不可用且未命中 storageDir。请开启 Zotero Local API（httpServer.localAPI.enabled）或配置 storageDir（Zotero 数据目录/storage 的父目录）。`,
  )
}
