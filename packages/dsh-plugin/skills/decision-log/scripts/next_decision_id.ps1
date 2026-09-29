<#
  next_decision_id.ps1 —— 为决策日志分配下一个编号，并给出目标文件路径。

  只做确定性的事：找文件、扫编号、算下一个。内容一律由调用方写入，
  这样长文本不经过命令行，绕开 Windows 参数编码问题。

  输出（UTF-8 JSON）：
    { "ok": true, "file": "<绝对路径>", "next_id": "D-004", "existing": 3, "created": false }
#>
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$FileName = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not (Test-Path -LiteralPath $Root)) {
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
}
$Root = (Resolve-Path -LiteralPath $Root).Path

# 候选文件名，按优先级。既有文件优先复用，避免同一目录出现两份决策日志。
if ([string]::IsNullOrWhiteSpace($FileName)) {
  $candidates = @("decisions.md", "decision_log.md", "DECISIONS.md")
  $found = $null
  foreach ($c in $candidates) {
    $p = Join-Path $Root $c
    if (Test-Path -LiteralPath $p) { $found = $p; break }
  }
  # 也看一层 docs/
  if (-not $found) {
    foreach ($c in $candidates) {
      $p = Join-Path $Root ("docs/" + $c)
      if (Test-Path -LiteralPath $p) { $found = $p; break }
    }
  }
  if ($found) { $target = $found } else { $target = Join-Path $Root "decisions.md" }
} else {
  $target = Join-Path $Root $FileName
}

$created = $false
if (-not (Test-Path -LiteralPath $target)) { $created = $true }

$max = 0
$count = 0
if (-not $created) {
  $text = Get-Content -LiteralPath $target -Raw -Encoding UTF8
  # 匹配 D-001 / D-12 / D-0123 三种写法
  $ms = [regex]::Matches($text, "(?m)^##\s*D-(\d+)")
  foreach ($m in $ms) {
    $count++
    $n = [int]$m.Groups[1].Value
    if ($n -gt $max) { $max = $n }
  }
}

$next = $max + 1
$nextId = "D-{0:D3}" -f $next

$result = [ordered]@{
  ok        = $true
  file      = $target
  next_id   = $nextId
  existing  = $count
  created   = $created
}
$result | ConvertTo-Json -Compress
