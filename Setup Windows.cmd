@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing
where npm >nul 2>nul
if errorlevel 1 goto missing
call npm run setup
set "setup_result=%errorlevel%"
pause
exit /b %setup_result%
:missing
echo Install Node.js 24 LTS using the Windows installer at https://nodejs.org/en/download.
echo Then restart your agent app and reopen this setup file.
pause
exit /b 1
