<#
  list_decisions.ps1 —— 列出决策日志的索引，不读全文。

  存在的意义：决策日志会越来越长，整篇读进来是浪费。先看索引，
  需要哪条再定点打开那一段。

  输出：编号 | 日期 | 状态 | 标题 的表格。
#>
param(
  [Parameter(Mandatory=$true)][string]$Root,
  [string]$FileName = "",
  [string]$Filter = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$candidates = if ([string]::IsNullOrWhiteSpace($FileName)) {
  @("decisions.md", "decision_log.md", "DECISIONS.md")
} else { @($FileName) }

$target = $null
foreach ($c in $candidates) {
  foreach ($base in @($Root, (Join-Path $Root "docs"))) {
    $p = Join-Path $base $c
    if (Test-Path -LiteralPath $p) { $target = $p; break }
  }
  if ($target) { break }
}

if (-not $target) {
  Write-Output "(未找到决策日志)"
  exit 0
}

$lines = Get-Content -LiteralPath $target -Encoding UTF8
$rows = @()
foreach ($line in $lines) {
  $m = [regex]::Match($line, "^##\s*(D-(\d+))\s*[（(]?([0-9]{4}-[0-9]{2}-[0-9]{2})?[）)]?\s*(.*)$")
  if ($m.Success) {
    $id    = $m.Groups[1].Value
    $date  = $m.Groups[3].Value
    $title = $m.Groups[4].Value.Trim()
    $rows += [pscustomobject]@{ ID = $id; Date = $date; Title = $title }
  }
}

if ($Filter) { $rows = $rows | Where-Object { $_.Title -match $Filter -or $_.ID -match $Filter } }

if ($rows.Count -eq 0) {
  Write-Output "(没有解析到决策条目)"
} else {
  Write-Output ("文件: " + $target)
  Write-Output ("共 " + $rows.Count + " 条")
  Write-Output ""
  $rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Output
}
