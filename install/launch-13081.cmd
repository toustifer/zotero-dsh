@echo off
REM Launch the DSH workbench on port 13081 (the Zotero-mapped instance).
REM Avoid port 3081 conflict with GameViewer/UU Remote.
set "DSH_HOME=C:\Users\15775\.dsh-zotero"
cd /d "C:\Users\15775\.dsh-zotero"
echo [launch-13081] DSH_HOME=%DSH_HOME% >> "C:\Users\15775\.dsh-zotero\web-3081.log"
"C:\nvm4w\nodejs\node.exe" "C:\Users\15775\.dsh-zotero\heal-sessions.cjs" >> "C:\Users\15775\.dsh-zotero\web-3081.log" 2>&1
"C:\Users\15775\.npm-global\dsh.cmd" --profile zotero --port 13081 --no-open >> "C:\Users\15775\.dsh-zotero\web-3081.log" 2>&1
