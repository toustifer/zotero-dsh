' Start the Shenzhen reverse tunnel, detached and respawning.
' Pure ASCII: wscript reads .vbs with the OEM code page.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\15775\.dsh-zotero"
sh.Run "cmd.exe /c tunnel-shenzhen.cmd", 0, False
