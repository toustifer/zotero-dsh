@echo off
REM Reverse tunnel: Shenzhen server's 127.0.0.1:13100 -> this box's 13081.
REM (13081, not 3081: the Zotero workbench moved off 3081 after UU-Remote kept
REM  squatting that port at boot. Keep this in step with launch-3081.cmd.)
REM
REM Pure ASCII (see launch-3081.cmd for why).
REM
REM Why this instead of Tailscale: measured from this machine,
REM   Tailscale via DERP(hkg)  : ~600 ms, and the Mac's own port 23119 took 5 s
REM   Cloudflare -> Shenzhen   : ~700-1700 ms (CF routes overseas then back)
REM   this direct path         : ~30 ms, 5.4 MB/s
REM Shenzhen is the same city as this box (ICMP 6-7 ms), so the relay is local.
REM
REM Bound to 127.0.0.1 on the remote side on purpose: nginx all 13100 from
REM the same host, so no GatewayPorts and no extra security-group rule needed.
:loop
"C:\Windows\System32\OpenSSH\ssh.exe" -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -R 127.0.0.1:13100:127.0.0.1:13081 cjjserver
timeout /t 15 /nobreak > nul
goto loop