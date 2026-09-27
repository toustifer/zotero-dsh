# Build zotero-dsh.xpi from addon/ (contents only, no top-level folder).
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here "addon"
$out  = Join-Path $here "zotero-dsh.xpi"
if (-not (Test-Path $src)) { throw "addon/ not found at $src" }
if (Test-Path $out) { Remove-Item $out -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $out)
$len = (Get-Item $out).Length
Write-Output "built: $out ($([math]::Round($len/1KB,1)) KB)"
