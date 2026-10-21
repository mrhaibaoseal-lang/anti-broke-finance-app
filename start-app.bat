@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
echo ====================================================================
echo 🛡️ 啟動「餘額守門員 GuardPay」...
echo 🌐 請在瀏覽器開啟：http://localhost:3088
echo ====================================================================
start "" "http://localhost:3088"
"C:\Program Files\nodejs\node.exe" src/server.js
pause
