#!/usr/bin/env node
/*
 * Pre-flight session-log healer for the 3081 workbench.
 *
 * Why this exists: DSH validates every session log's FIRST Zstd frame when it
 * scans the session store at boot (dsh-session-persistence-jsonl reads the
 * header via readFirstZstdLine -> assertZstdHeaderFrame) and fails closed. A log
 * whose first frame is not exactly one header line -- what an interrupted write
 * leaves behind -- takes down the whole plugin tree, and the Web GUI reports
 * "Failed to load plugins". It only looked intermittent because the next boot,
 * one that no longer tripped over the bad file, came up fine.
 *
 * So: before every launch, move aside any log that provably fails that exact
 * check. Quarantined directories are never deleted -- losing a session costs
 * more than a failed boot -- so the test errs toward leaving a suspicious file
 * alone (anything it cannot decode outright is reported as undecidable, not
 * corrupt).
 *
 * ASCII only on purpose: launcher .cmd files read this path via the OEM code page.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

/*
 * Locate the home from this file's own directory by default -- this copy lives at
 * the root of the DSH home it guards. DSH_HOME is deliberately NOT consulted: the
 * script is also run by hand from shells that carry the *other* harness home, and
 * sweeping the wrong store would quarantine the wrong sessions. An explicit
 * argument wins so the installer can keep one canonical copy elsewhere.
 */
const HOME = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname)
const SESSIONS = path.join(HOME, 'sessions')
const QUARANTINE = path.join(HOME, 'sessions-quarantine')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/* A header record is a few hundred compressed bytes; 16 KiB is generous and
 * keeps the whole sweep cheap enough to sit on the launch path. */
const PROBE_BYTES = 16 * 1024
const LOG_FILE = /^session\.v\d+\.jsonl\.zstd$/

/**
 * Inspect only what DSH's boot path inspects: the independently decodable first
 * frame. Returns {ok:false} ONLY when the file provably breaks that contract.
 */
function probe(file) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch (e) { return { ok: true, reason: 'unreadable:' + e.code } }
  try {
    const buf = Buffer.alloc(PROBE_BYTES)
    const read = fs.readSync(fd, buf, 0, PROBE_BYTES, 0)
    const bytes = buf.subarray(0, read)
    if (bytes.length === 0) return { ok: false, reason: 'empty log' }
    if (bytes.indexOf(ZSTD_MAGIC) !== 0) return { ok: false, reason: 'no zstd frame at offset 0' }
    /*
     * The header frame is tiny, so a magic occurrence just past offset 0 is the
     * second frame boundary. A wrong split can only make the decode below fail,
     * and that is reported as undecidable rather than corrupt.
     */
    const next = bytes.indexOf(ZSTD_MAGIC, 4)
    const end = next > 0 ? next : bytes.length
    let plain
    try { plain = zlib.zstdDecompressSync(bytes.subarray(0, end)) }
    catch (e) { return { ok: true, reason: 'undecidable:' + String(e.message).slice(0, 48) } }
    const text = plain.toString('utf8')
    if (text.length === 0) return { ok: true, reason: 'undecidable:empty frame' }
    if (text.indexOf('\n') !== text.length - 1) {
      return { ok: false, reason: 'first frame holds ' + text.split('\n').length + ' lines' }
    }
    return { ok: true }
  } finally { fs.closeSync(fd) }
}

function walk(dir, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (LOG_FILE.test(e.name)) out.push(p)
  }
  return out
}

function main() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const logs = walk(SESSIONS, [])
  const moved = []
  for (const file of logs) {
    const verdict = probe(file)
    if (verdict.ok) continue
    const dir = path.dirname(file)
    const dest = path.join(QUARANTINE, path.basename(dir) + '-corrupt-' + stamp)
    try {
      fs.mkdirSync(QUARANTINE, { recursive: true })
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true })
      fs.renameSync(dir, dest)
      moved.push(path.basename(dir) + '  <- ' + verdict.reason)
    } catch (e) {
      console.log('[heal-sessions] could not quarantine ' + dir + ': ' + e.message)
    }
  }
  const at = new Date().toISOString()
  console.log('[heal-sessions] ' + at + ' checked=' + logs.length + ' quarantined=' + moved.length)
  for (const m of moved) console.log('[heal-sessions]   ' + m)
}

main()
