/**
 * dsh-ventus-plugins 兼容补丁（dsh 0.1.2-alpha.1）
 *
 * 背景：upstream 8edd220（2026-08-28）的 client.js 要求 client 服务
 * "conversationEvents"，而当前 web（dsh-harness v0.1.2-alpha.1）没有该服务
 * → client boot 3 entries pending（ventus/ego/cae 连锁）→ 面板全挂。
 * 本脚本把 client.js 的 3 处引用改为可选（inject 移除 + 调用判空），
 * 使 ventus 新版在当前 dsh 上可加载；上游适配后可删除本补丁。
 * 重放：node scripts/patch-ventus-client.mjs [ventusLibDir]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const libDir = process.argv[2] || 'C:/Users/Fisfzy/.dsh/.external-plugins/dsh-ventus-plugins/lib'
const clientPath = join(libDir, 'client.js')
let src = readFileSync(clientPath, 'utf8')
const original = src

// 1) inject 移除（两种写法：带前导逗号 / 带尾随逗号）
src = src.replaceAll('"conversationEvents",', '')
src = src.replaceAll(',"conversationEvents"', '')
// 2) 调用点判空（image-gallery 的 register）
src = src.replace(
  /ctx\.conversationEvents\.register\(/g,
  '(ctx.conversationEvents?.register ?? ((d) => (() => {})))(',
)

if (src === original) {
  console.log('no change needed (already patched or clean)')
  process.exit(0)
}
mkdirSync(dirname(join(libDir, '..', 'notes')), { recursive: true })
writeFileSync(join(dirname(libDir), 'lib-client.patch.log'), new Date().toISOString() + ' patched\n', { flag: 'a' })
writeFileSync(clientPath, src, 'utf8')
const remaining = (src.match(/conversationEvents/g) || []).length
console.log('patched; remaining conversationEvents refs:', remaining)
