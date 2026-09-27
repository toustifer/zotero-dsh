#!/usr/bin/env node
/**
 * dsh-zotero host build — junction-link build/runtime deps, then tsc.
 *
 * Modes (auto-probed):
 *   1. Source checkout: DSH_CHECKOUT env or <HOME>/dsh-harness|dsh|.dsh/dsh-harness
 *   2. Installed dsh: npm-global @deepseek-ai/dsh + donor plugin or local/profiles modules
 *      under ~/.dsh/profiles, ~/.dsh/plugins, ~/.dsh/.external-plugins.
 *
 * All linking is deterministic: each target is recreated as a junction
 * (Windows) or symlink. Run via `node scripts/build.mjs` (host half); the
 * client half is `tsdown` (package.json build:client).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(ROOT, 'node_modules')

function log(msg) {
  console.log(`[dsh-zotero build] ${msg}`)
}

function fail(msg) {
  console.error(`[dsh-zotero build] ${msg}`)
  process.exit(1)
}

function firstExisting(...paths) {
  for (const p of paths) {
    if (p && existsSync(p)) return p
  }
  return undefined
}

/** Link `node_modules/<rel>` -> <source> (junction on win32, dir symlink elsewhere). */
function linkPkg(rel, source) {
  if (!source) fail(`dependency target missing for ${rel}`)
  const abs = resolve(source)
  if (!existsSync(abs)) fail(`dependency target missing: ${abs}`)
  const link = join(NM, rel)
  if (abs.toLowerCase() === link.toLowerCase()) return
  // 幂等重建：rmSync 对 junction/symlink 只摘链、不跟进目标目录，
  // 而 rmdir/unlink 在 Windows 上对目录型重解析点会静默失败（随后 symlinkSync EEXIST）。
  try {
    rmSync(link, { recursive: true, force: true })
  } catch {}
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(abs, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function probeCheckout() {
  const env = process.env.DSH_CHECKOUT
  if (env && existsSync(join(env, 'packages'))) return env
  const home = homedir()
  for (const cand of ['dsh-harness', 'dsh', '.dsh/dsh-harness']) {
    const p = join(home, cand)
    if (existsSync(join(p, 'packages'))) return p
  }
  return null
}

function probeNpmGlobal() {
  try {
    const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const r = spawnSync(cmd, ['root', '-g'], {
      shell: true,
      encoding: 'utf8',
    })
    if (r.status === 0 && r.stdout.trim() && existsSync(r.stdout.trim())) {
      return r.stdout.trim()
    }
  } catch {}

  const home = homedir()
  const candidates = [
    join(home, '.npm-global', 'node_modules'),
    process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm', 'node_modules') : '',
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ]
  return firstExisting(...candidates) || ''
}

function donorNodeModules() {
  const home = homedir()
  const pluginRoots = [
    join(home, '.dsh', 'plugins'),
    join(home, '.dsh', '.external-plugins'),
  ]
  for (const pr of pluginRoots) {
    if (!existsSync(pr)) continue
    try {
      for (const entry of readdirSync(pr)) {
        const nm = join(pr, entry, 'node_modules')
        if (existsSync(join(nm, 'typescript')) && existsSync(join(nm, 'tsdown'))) {
          return nm
        }
      }
    } catch {}
  }
  return null
}

function candidateSlots(dshNm) {
  const home = homedir()
  const out = []
  if (dshNm) {
    out.push(join(dshNm, '@deepseek-ai', 'dsh-client-ui-slots'))
  }
  out.push(join(home, '.dsh', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-client-ui-slots'))

  const pluginRoots = [
    join(home, '.dsh', 'plugins'),
    join(home, '.dsh', '.external-plugins'),
  ]
  for (const pr of pluginRoots) {
    if (!existsSync(pr)) continue
    try {
      for (const entry of readdirSync(pr)) {
        out.push(join(pr, entry, 'node_modules', '@deepseek-ai', 'dsh-client-ui-slots'))
      }
    } catch {}
  }
  return out.filter(p => existsSync(p))
}

function findPnpmPackage(pkgName) {
  const pnpmDir = join(NM, '.pnpm')
  if (!existsSync(pnpmDir)) return null
  try {
    for (const d of readdirSync(pnpmDir)) {
      if (d.startsWith(`${pkgName}@`)) {
        const candidate = join(pnpmDir, d, 'node_modules', pkgName)
        if (existsSync(candidate)) return candidate
      }
    }
  } catch {}
  return null
}

function findTsc(donor, checkout) {
  return firstExisting(
    join(NM, 'typescript', 'bin', 'tsc'),
    join(NM, 'typescript', 'lib', 'tsc.js'),
    join(NM, 'typescript', 'tsc'),
    checkout ? join(checkout, 'node_modules', 'typescript', 'bin', 'tsc') : undefined,
    checkout ? join(checkout, 'node_modules', 'typescript', 'tsc') : undefined,
    donor ? join(donor, 'typescript', 'bin', 'tsc') : undefined,
    donor ? join(donor, 'typescript', 'tsc') : undefined,
    findPnpmPackage('typescript') ? join(findPnpmPackage('typescript'), 'bin', 'tsc') : undefined,
  )
}

function runTsc(tscJs) {
  if (!tscJs) fail('tsc not found (typescript package)')
  log(`tsc: ${tscJs}`)
  const r = spawnSync(process.execPath, [tscJs, '-p', join(ROOT, 'tsconfig.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (r.status !== 0) fail(`tsc exited ${r.status}`)
  log('host compile OK → lib/')
}

function main() {
  const checkout = probeCheckout()
  if (checkout) {
    log(`mode: source checkout (${checkout})`)
    mkdirSync(NM, { recursive: true })
    linkPkg('cordis', join(checkout, 'vendor', 'cordis'))
    linkPkg('cosmokit', join(checkout, 'vendor', 'cosmokit'))
    linkPkg('schemastery', join(checkout, 'vendor', 'schemastery'))
    linkPkg('@deepseek-ai/schemastery', join(checkout, 'vendor', 'schemastery'))
    linkPkg('@deepseek-ai/dsh-tools', join(checkout, 'packages', 'core', 'tools'))
    linkPkg('@deepseek-ai/dsh-llm', join(checkout, 'packages', 'llm', 'llm'))
    linkPkg('@deepseek-ai/dsh-system-prompt', join(checkout, 'packages', 'core', 'system-prompt'))
    linkPkg('@types/node', join(checkout, 'node_modules', '@types', 'node'))
    const slots = firstExisting(
      join(checkout, 'packages', 'client', 'ui-slots'),
      ...candidateSlots(),
    )
    if (slots) {
      linkPkg('@deepseek-ai/dsh-client-ui-slots', slots)
    }
    if (!existsSync(join(NM, 'typescript'))) {
      linkPkg('typescript', join(checkout, 'node_modules', 'typescript'))
    }
    const donor = donorNodeModules()
    if (donor && !existsSync(join(NM, 'tsdown'))) {
      linkPkg('tsdown', join(donor, 'tsdown'))
    }
    const tsc = findTsc(donor, checkout)
    runTsc(tsc)
    return
  }

  log('mode: installed dsh (no source checkout)')
  const npmGlobal = probeNpmGlobal()
  if (!npmGlobal) fail('npm root -g / global node_modules detection failed')
  const dshNm = join(npmGlobal, '@deepseek-ai', 'dsh', 'node_modules')
  if (!existsSync(join(dshNm, '@deepseek-ai'))) fail(`installed dsh not found: ${dshNm}`)

  const donor = donorNodeModules()
  const profilesNm = join(homedir(), '.dsh', 'profiles', 'node_modules')

  const cordisSrc = firstExisting(
    donor ? join(donor, 'cordis') : undefined,
    join(dshNm, '@deepseek-ai', 'cordis'),
    join(profilesNm, '@deepseek-ai', 'cordis'),
    join(dshNm, 'cordis'),
  )
  const cosmokitSrc = firstExisting(
    donor ? join(donor, 'cosmokit') : undefined,
    join(dshNm, '@deepseek-ai', 'cosmokit'),
    join(profilesNm, '@deepseek-ai', 'cosmokit'),
    join(dshNm, 'cosmokit'),
  )

  if (!cordisSrc) fail('cordis dependency source not found')
  if (!cosmokitSrc) fail('cosmokit dependency source not found')

  log(`linking deps (donor: ${donor || 'none (using installed dsh / local)'})`)
  linkPkg('cordis', cordisSrc)
  linkPkg('cosmokit', cosmokitSrc)
  linkPkg('@deepseek-ai/cordis', cordisSrc)
  linkPkg('@deepseek-ai/cosmokit', cosmokitSrc)

  if (!existsSync(join(NM, 'typescript'))) {
    const tsSrc = firstExisting(
      findPnpmPackage('typescript'),
      donor ? join(donor, 'typescript') : undefined,
      join(dshNm, 'typescript'),
    )
    if (tsSrc) linkPkg('typescript', tsSrc)
  }
  if (!existsSync(join(NM, 'tsdown'))) {
    const tsdSrc = firstExisting(
      findPnpmPackage('tsdown'),
      donor ? join(donor, 'tsdown') : undefined,
      join(dshNm, 'tsdown'),
    )
    if (tsdSrc) linkPkg('tsdown', tsdSrc)
  }

  linkPkg('schemastery', join(dshNm, '@deepseek-ai', 'schemastery'))
  linkPkg('@deepseek-ai/schemastery', join(dshNm, '@deepseek-ai', 'schemastery'))
  linkPkg('@deepseek-ai/dsh-tools', join(dshNm, '@deepseek-ai', 'dsh-tools'))
  linkPkg('@deepseek-ai/dsh-llm', join(dshNm, '@deepseek-ai', 'dsh-llm'))
  linkPkg('@deepseek-ai/dsh-system-prompt', join(dshNm, '@deepseek-ai', 'dsh-system-prompt'))

  if (!existsSync(join(NM, '@types', 'node'))) {
    const typesNode = firstExisting(
      join(dshNm, '@types', 'node'),
      donor ? join(donor, '@types', 'node') : undefined,
    )
    if (typesNode) linkPkg('@types/node', typesNode)
  }

  const slots = firstExisting(...candidateSlots(dshNm))
  if (slots) {
    linkPkg('@deepseek-ai/dsh-client-ui-slots', slots)
  }

  const tsc = findTsc(donor, null)
  runTsc(tsc)
}

main()
