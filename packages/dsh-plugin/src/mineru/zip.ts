/**
 * dsh-zotero — minimal ZIP reader for MinerU result zips (zero deps).
 *
 * Reads only what MinerU outputs need: local file headers + central
 * directory (supporting entry method 0 = store and 8 = deflate) and exposes
 * each member as bytes + the canonical markdown (`full.md` preferred).
 * Uses node:zlib, so no third-party runtime dependency (the DSH loader
 * rejects the fflate exports layout; see docs/M2 notes).
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

export interface MinerUZipEntry {
  relPath: string
  bytes: Uint8Array
}

export type MinerUUnpackResult =
  | {
      ok: true
      md: string
      files: MinerUZipEntry[]
    }
  | { ok: false; message: string }

function u16(v: DataView, o: number): number {
  return v.getUint16(o, true)
}
function u32(v: DataView, o: number): number {
  return v.getUint32(o, true)
}

export function unpackMineruZip(zipBytes: Uint8Array): MinerUUnpackResult {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength)
  // 1) Locate EOCD (last 64 KiB, `PK\x05\x06` signature).
  let eocd = -1
  const scanFrom = Math.max(0, zipBytes.length - 65557)
  for (let i = zipBytes.length - 22; i >= scanFrom; i -= 1) {
    if (u32(view, i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return { ok: false, message: '不是有效的 zip（未找到 EOCD）' }
  const entryCount = u16(view, eocd + 10)
  const cdOffset = u32(view, eocd + 16)
  if (cdOffset < 0 || cdOffset >= zipBytes.length) return { ok: false, message: 'zip 中央目录偏移非法' }

  // 2) Walk central directory entries.
  type Cen = { name: string; method: number; localOffset: number; compSize: number }
  const entries: Cen[] = []
  let p = cdOffset
  for (let i = 0; i < entryCount; i += 1) {
    if (p + 46 > zipBytes.length) return { ok: false, message: 'zip 中央目录截断' }
    if (u32(view, p) !== CEN_SIG) return { ok: false, message: `zip 中央目录条目 ${i} 签名异常` }
    const method = u16(view, p + 10)
    const compSize = u32(view, p + 20)
    const nameLen = u16(view, p + 28)
    const extraLen = u16(view, p + 30)
    const commentLen = u16(view, p + 32)
    const localOffset = u32(view, p + 42)
    const name = latin1(zipBytes, p + 46, nameLen)
    entries.push({ name, method, localOffset, compSize })
    p += 46 + nameLen + extraLen + commentLen
  }

  // 3) Read each member from its local header.
  const files: MinerUZipEntry[] = []
  let mdCandidate: string | null = null
  for (const e of entries) {
    const lp = e.localOffset
    if (lp + 30 > zipBytes.length) continue
    if (u32(view, lp) !== LOC_SIG) continue
    const nameLen = u16(view, lp + 26)
    const extraLen = u16(view, lp + 28)
    const dataStart = lp + 30 + nameLen + extraLen
    const dataEnd = dataStart + e.compSize
    if (dataEnd > zipBytes.length) continue
    const comp = zipBytes.slice(dataStart, dataEnd)
    let bytes: Uint8Array
    try {
      bytes = e.method === 0 ? comp : e.method === 8 ? new Uint8Array(inflateRawSync(comp)) : comp
    } catch {
      continue
    }
    const relPath = e.name.replace(/\\/g, '/')
    if (/\.md$/i.test(relPath)) {
      if (relPath.endsWith('full.md') || mdCandidate === null) {
        mdCandidate = new TextDecoder('utf-8').decode(bytes)
      }
    } else if (bytes.length > 0) {
      files.push({ relPath, bytes })
    }
  }

  if (mdCandidate === null) {
    return { ok: false, message: 'zip 内没有 markdown 全文（可能为空结果或非 MinerU 产物）' }
  }
  return { ok: true, md: mdCandidate, files }
}

function latin1(bytes: Uint8Array, start: number, len: number): string {
  let out = ''
  for (let i = start; i < start + len; i += 1) out += String.fromCharCode(bytes[i])
  return out
}
