import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { Config } from '../config.js'
import { resolveCacheDir } from '../mineru/cache.js'
import { fetchAttachmentPdf } from './pdf.js'
import type { ZoteroClient } from './client.js'

/**
 * dsh-zotero — render PDF pages to PNG so a vision-capable model can read what
 * text extraction cannot: tables set as bitmaps, figures, and boxed formulas.
 *
 * Why this exists: pdftotext/MinerU-pipeline can only return what is in the text
 * layer. In this literature the tables are usually images, so zotero_read_fulltext
 * hands back a caption with no numbers. Rendering the page sidesteps the whole
 * question — the numbers are in the pixels.
 *
 * Rendering goes through poppler's pdftoppm (same family as the pdftotext the
 * plugin already shells out to). It is not bundled: when it is missing the tool
 * says so instead of guessing.
 */

export interface RenderedPage {
  page: number
  file: string
  width: number
  height: number
  bytes: number
}

export function renderDir(cfg: Config, attachmentKey: string): string {
  return join(resolveCacheDir(cfg), 'render', attachmentKey)
}

function pngSize(buf: Buffer): { width: number; height: number } {
  // PNG header: 8-byte signature + IHDR chunk
  // IHDR: 4-byte length + "IHDR" + width(4) + height(4) + ...
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('Invalid PNG header')
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  }
}

export async function renderPdfPage(
  pdfPath: string,
  page: number,
  dpi: number,
  outDir: string,
): Promise<RenderedPage> {
  await mkdir(outDir, { recursive: true })
  
  const prefix = join(outDir, `p${page}-${dpi}`)
  const outFile = `${prefix}.png`
  
  // If already rendered, return cached
  if (existsSync(outFile)) {
    const buf = await readFile(outFile)
    const { width, height } = pngSize(buf)
    return { page, file: outFile, width, height, bytes: buf.length }
  }
  
  // Render with pdftoppm
  const args = [
    '-png',
    '-r', String(dpi),
    '-f', String(page),
    '-l', String(page),
    '-singlefile',
    pdfPath,
    prefix,
  ]
  
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('pdftoppm', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    
    let stderr = ''
    proc.stderr?.on('data', chunk => { stderr += chunk })
    
    proc.on('error', err => {
      reject(new Error(`pdftoppm 不可用: ${err.message}（需要安装 poppler-utils 或 MiKTeX）`))
    })
    
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`pdftoppm 渲染失败 (exit ${code}): ${stderr.trim() || '无输出'}`))
      } else {
        resolve()
      }
    })
  })
  
  // Read result
  const buf = await readFile(outFile)
  const { width, height } = pngSize(buf)
  return { page, file: outFile, width, height, bytes: buf.length }
}

export async function renderAttachmentPage(
  client: ZoteroClient,
  cfg: Config,
  itemKey: string,
  attachmentKey: string | undefined,
  page: number,
  dpi: number,
  signal?: AbortSignal,
): Promise<RenderedPage & { attachmentKey: string }> {
  // Fetch PDF (API-first, storage-fallback via fetchAttachmentPdf)
  const { bytes, fileName, source } = await fetchAttachmentPdf(
    client,
    attachmentKey ?? itemKey,
    cfg,
    signal,
  )
  
  // Write to temp file
  const tempDir = join(resolveCacheDir(cfg), 'temp')
  await mkdir(tempDir, { recursive: true })
  const tempPdf = join(tempDir, `${attachmentKey ?? itemKey}-${Date.now()}.pdf`)
  await writeFile(tempPdf, bytes)
  
  try {
    // Render
    const outDir = renderDir(cfg, attachmentKey ?? itemKey)
    const rendered = await renderPdfPage(tempPdf, page, dpi, outDir)
    return { ...rendered, attachmentKey: attachmentKey ?? itemKey }
  } finally {
    // Clean up temp PDF (fire-and-forget)
    await import('node:fs/promises').then(fs => 
      fs.unlink(tempPdf).catch(() => {})
    )
  }
}
