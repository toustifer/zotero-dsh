#!/usr/bin/env node
/**
 * 打包预构建的 DSH 侧插件供 Release 使用。
 *
 * 除了 lib/ 与装配文件，还带上 pdfjs-dist 的 worker —— 宿主只用它一个文件
 * （lib/panel-api.js 里 require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')），
 * 而整个包 33 MB、单个 worker 只有 1.2 MB。带上的好处是装的时候不必联网。
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = resolve(dirname(fileURLToPath(import.meta.url)))
const PKG = resolve(HERE, '..')
const OUT = process.argv[2] || join(PKG, '..', '..', 'install', 'dsh-zotero-0.1.1.tgz')
const STAGE = join(process.env.TEMP || '/tmp', 'dshz-pack-' + Date.now())

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })

for (const f of ['package.json', 'cordis.patch.yml', 'dsh.plugin.json']) {
  cpSync(join(PKG, f), join(STAGE, f))
}
cpSync(join(PKG, 'lib'), join(STAGE, 'lib'), { recursive: true })

// 只挑宿主真正 require.resolve 的那一个文件
const workerSrc = join(PKG, 'node_modules', 'pdfjs-dist')
const workerDst = join(STAGE, 'node_modules', 'pdfjs-dist')
if (existsSync(workerSrc)) {
  mkdirSync(join(workerDst, 'build'), { recursive: true })
  cpSync(join(workerSrc, 'package.json'), join(workerDst, 'package.json'))
  cpSync(join(workerSrc, 'build', 'pdf.worker.min.mjs'), join(workerDst, 'build', 'pdf.worker.min.mjs'))
  console.log('[pack] bundled pdf.worker.min.mjs (' + Math.round(statSync(join(workerDst, 'build', 'pdf.worker.min.mjs')).size / 1024) + ' KB)')
} else {
  console.warn('[pack] pdfjs-dist not found in node_modules — the tarball will rely on npm install at setup time')
}

rmSync(OUT, { force: true })
const r = spawnSync('tar', ['-czf', OUT, 'package.json', 'cordis.patch.yml', 'dsh.plugin.json', 'lib', 'node_modules'], {
  cwd: STAGE,
  stdio: 'inherit',
})
rmSync(STAGE, { recursive: true, force: true })
if (r.status !== 0) { console.error('[pack] tar failed'); process.exit(1) }
console.log('[pack] ' + OUT + '  ' + Math.round(statSync(OUT).size / 1024) + ' KB')
