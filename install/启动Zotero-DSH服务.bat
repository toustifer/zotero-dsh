@echo off
chcp 65001 >nul
echo 正在检查并启动 Zotero-DSH 专用后端服务 (13081)...
wscript.exe "C:\Users\15775\.dsh-zotero\start-3081.vbs"
timeout /t 3 /nobreak >nul
netstat -ano | findstr 13081 >nul
if %errorlevel% equ 0 (
    echo [OK] Zotero-DSH 后端服务已成功就绪 (端口 13081)!
) else (
    echo [提示] 服务正在后台拉起中，请在 Zotero 右侧面板点击 [重载] 即可。
)
timeout /t 2 >nul
exit
