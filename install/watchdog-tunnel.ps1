# Shenzhen reverse-tunnel watchdog.
#
# The tunnel (server 127.0.0.1:13100 -> this box's 13081) is a plain ssh -R under
# a cmd loop. If the loop process itself dies the tunnel stays down until someone
# notices -- which is exactly what happened once already. This keeps it up.
#
# ASCII only, like the other .ps1/.cmd/.vbs files in this folder.
$ErrorActionPreference = 'Continue'
$Loop = 'C:\Users\15775\.dsh-zotero\tunnel-shenzhen.cmd'
$Log  = 'C:\Users\15775\.dsh-zotero\watchdog-tunnel.log'

function Write-Log([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  try { Add-Content -Path $Log -Value $line -Encoding UTF8 } catch {}
}

function Tunnel-Ssh-Alive {
  try {
    $p = Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match '13100:127\.0\.0\.1:13081' }
    return [bool]$p
  } catch { return $false }
}

function Loop-Alive {
  try {
    $p = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'tunnel-shenzhen' }
    return [bool]$p
  } catch { return $false }
}

function Start-Tunnel {
  try {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $Loop -WindowStyle Hidden
    Write-Log 'tunnel loop dispatched'
  } catch { Write-Log ('dispatch failed: ' + $_.Exception.Message) }
}

Write-Log ('watchdog start pid=' + $PID)
$round = 0
while ($true) {
  $round++
  if (-not (Loop-Alive)) {
    Write-Log 'loop process gone -> restarting'
    Start-Tunnel
    Start-Sleep -Seconds 20
    continue
  }
  if (-not (Tunnel-Ssh-Alive)) {
    # The cmd loop should respawn ssh on its own within ~15s; wait one cycle
    # before interfering, otherwise we race the loop and end up with two.
    Write-Log 'ssh forward missing -> waiting one cycle'
    Start-Sleep -Seconds 20
    if (-not (Tunnel-Ssh-Alive)) {
      Write-Log 'ssh forward still missing -> recycle loop'
      try {
        Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -match 'tunnel-shenzhen' } |
          ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      } catch {}
      Start-Tunnel
    }
    continue
  }
  # Every ~2 min, verify from the far side that the port is actually bound.
  if ($round % 4 -eq 0) {
    try {
      $r = & ssh -o ConnectTimeout=10 -o BatchMode=yes story 'ss -ltn | grep -c 13100' 2>$null
      if ("$r".Trim() -eq '0') {
        Write-Log 'remote 13100 not bound although ssh alive -> recycle'
        try {
          Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match '13100:127\.0\.0\.1:13081' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        } catch {}
      }
    } catch { Write-Log ('remote check failed: ' + $_.Exception.Message) }
  }
  Start-Sleep -Seconds 30
}
