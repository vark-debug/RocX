@echo off
REM launcher.cmd — RocX 抓帧→PS 启动器 (Windows 入口)
REM
REM 由 UXP `shell.openPath` 启动(.cmd 是 UXP 白名单里最稳的 Windows 入口)。
REM 调起同目录下的 launcher.ps1 执行实际工作(查注册表/启动 PS)。

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%launcher.ps1"

if not exist "%PS_SCRIPT%" (
    exit /b 0
)

powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PS_SCRIPT%"
exit /b 0
