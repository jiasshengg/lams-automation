@echo off
cd /d "%~dp0"
where powershell.exe >nul 2>nul
if errorlevel 1 goto missing_powershell
powershell.exe -NoLogo -NoProfile -File "%~dp0scripts\setup\bootstrap-windows.ps1"
set "setup_result=%errorlevel%"
pause
exit /b %setup_result%
:missing_powershell
echo Setup stopped: Windows PowerShell is unavailable.
echo Ask your IT team to enable PowerShell or install Node.js 24 LTS, then run npm run setup.
pause
exit /b 1
