# DSH Zotero Workbench watchdog.
# Keep the 13081 DSH instance alive: if the port stops listening, relaunch it.
$ErrorActionPreference = 'Continue'
$DshHome = 'C:\Users\15775\.dsh-zotero'
$Port    = 13081
$Log     = Join-Path $DshHome 'watchdog-13081.log'
$Launch  = Join-Path $DshHome 'launch-3081.cmd'

function Write-Log([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  try { Add-Content -Path $Log -Value $line -Encoding UTF8 } catch {}
}

function Test-Port([int]$p) {
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { return $true }
  } catch {}
  return $false
}

Write-Log ('watchdog start pid=' + $PID)
$fails = 0
while ($true) {
  if (Test-Port $Port) {
    $fails = 0
    Start-Sleep -Seconds 20
  } else {
    Write-Log ('port ' + $Port + ' down -> launching workbench (attempt ' + ($fails + 1) + ')')
    try {
      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $Launch -WindowStyle Hidden -WorkingDirectory $DshHome
      Write-Log 'launch dispatched'
    } catch {
      Write-Log ('launch failed: ' + $_.Exception.Message)
    }
    $fails++
    Start-Sleep -Seconds 25
  }
}
