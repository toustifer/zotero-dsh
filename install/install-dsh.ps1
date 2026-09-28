<#
  Installs the dsh-zotero DSH plugin into one DSH profile.

  It does three things:
    1. unpacks the prebuilt plugin into  <DshHome>\plugins\dsh-zotero
    2. links it into  <profile>\node_modules\@dsh-external\dsh-zotero
    3. appends the loader anchor to  <profile>\cordis.patch.yml  (only once)

  Nothing is compiled here -- the plugin ships prebuilt, so you do not need
  pnpm, TypeScript, or a DSH source checkout.

  Usage:
    pwsh -File install-dsh.ps1
    pwsh -File install-dsh.ps1 -Profile zotero
    pwsh -File install-dsh.ps1 -PluginDir <path-to-built-package>

  Re-run it after every "dsh plugin install": pnpm rebuilds the profile's
  node_modules and wipes the link.
#>
param(
  [string]$Profile   = 'web',
  [string]$DshHome   = $(Join-Path $HOME '.dsh'),
  [string]$PluginDir = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$nl   = [Environment]::NewLine

function Say($m) { Write-Host "[dsh-zotero] $m" }
function Die($m) { Write-Error "[dsh-zotero] $m"; exit 1 }

# ---- 1. resolve a source package -------------------------------------------
$staging = ''
if ($PluginDir -ne '') {
  if (-not (Test-Path (Join-Path $PluginDir 'lib\index.js'))) { Die "no lib/index.js under $PluginDir" }
  $staging = $PluginDir
  Say "using prebuilt package at $staging"
} else {
  # Newest wins: several releases can sit side by side, and a bare -First 1 would
  # pick whichever the filesystem happens to list first.
  $tgz = Get-ChildItem -Path $here -Filter 'dsh-zotero-*.tgz' -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.BaseName -replace '^dsh-zotero-', '') } -Descending | Select-Object -First 1
  if (-not $tgz) { Die "no dsh-zotero-*.tgz next to this script; pass -PluginDir instead" }
  $staging = Join-Path $env:TEMP ('dsh-zotero-unpack-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  tar -xzf $tgz.FullName -C $staging
  if ($LASTEXITCODE -ne 0) { Die "failed to unpack $($tgz.Name)" }
  Say "unpacked $($tgz.Name)"
}

# ---- 2. place it under DshHome\plugins -------------------------------------
$target = Join-Path $DshHome 'plugins\dsh-zotero'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $staging '*') $target -Recurse -Force
if (-not (Test-Path (Join-Path $target 'lib\index.js'))) { Die "install went wrong: $target has no lib/index.js" }
Say "plugin files -> $target"

# ---- 3. link into the profile ----------------------------------------------
$profileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path $profileDir)) {
  Die "profile '$Profile' not found at $profileDir -- start DSH once for that profile, or pass -Profile <name>"
}
$scope = Join-Path $profileDir 'node_modules\@dsh-external'
New-Item -ItemType Directory -Force -Path $scope | Out-Null
$link = Join-Path $scope 'dsh-zotero'
if (Test-Path $link) { (Get-Item $link -Force).Delete() }
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
if (-not (Test-Path (Join-Path $link 'lib\index.js'))) { Die "link created but lib/index.js unreachable" }
Say "linked $link"

# ---- 4. add the loader anchor ----------------------------------------------
$patch  = Join-Path $profileDir 'cordis.patch.yml'
$anchor = '@dsh-external/dsh-zotero'
if (-not (Test-Path $patch)) {
  # No file yet: the appended block below becomes the whole list (no "[]" seed,
  # which would leave the file with two top-level arrays).
  Set-Content -Path $patch -Encoding UTF8 -Value ('# Your patch layer for this dsh profile.' + $nl)
}
$existing = Get-Content $patch -Raw
if ($existing -match [regex]::Escape($anchor)) {
  Say "cordis.patch.yml already references the package -- left untouched"
} else {
  $block = $nl +
    '# dsh-zotero -- Zotero library access (Local API tools, PDF reading, side panel).' + $nl +
    '- insert:' + $nl +
    '    - id: dsh-zotero' + $nl +
    "      name: '@dsh-external/dsh-zotero'" + $nl
  Add-Content -Path $patch -Value $block -Encoding UTF8
  Say "anchor appended to $patch"
}

# ---- 5. install the research agent preset -----------------------------------
# 预设放在 DSH 的用户根下，是给人改的东西 —— 已经存在就不覆盖。
# 缺了它，工具照常可用，但模型不会按文献工作的纪律去用它们。
$presetSrc = Join-Path $staging 'presets\research'
if (Test-Path (Join-Path $presetSrc 'agent.cordis.yml')) {
  $presetDst = Join-Path $DshHome '.agent-presets\research'
  if (Test-Path $presetDst) {
    Say "preset already at $presetDst -- left untouched (yours wins)"
  } else {
    New-Item -ItemType Directory -Force -Path $presetDst | Out-Null
    Copy-Item (Join-Path $presetSrc '*') $presetDst -Recurse -Force
    Say "research preset -> $presetDst"
  }
} else {
  Say "no presets\research in the package -- skipping the agent preset"
}

# ---- 6. install the session-log healer --------------------------------------
# DSH validates every session log's first Zstd frame when it scans the session
# store at boot, and fails closed: one half-written header frame -- what an
# interrupted write leaves -- takes down the whole plugin tree, and the Web GUI
# then reports "Failed to load plugins". This sweep quarantines such a log
# before DSH ever sees it. Run it from whatever starts this instance.
$healerSrc = Join-Path $here 'heal-sessions.cjs'
if (Test-Path $healerSrc) {
  $healerDst = Join-Path $DshHome 'heal-sessions.cjs'
  Copy-Item $healerSrc $healerDst -Force
  Say "session healer -> $healerDst"
  Say "  call it before starting DSH, e.g.: node ""$healerDst"""
} else {
  Say "no heal-sessions.cjs next to this script -- skipping the session healer"
}

Say ''
Say "done. restart the DSH instance for profile '$Profile', for example:"
Say "    dsh $Profile"
