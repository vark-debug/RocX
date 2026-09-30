# launcher.ps1 — RocX 抓帧→PS 启动器 (Windows)
#
# 由 UXP `shell.openPath` 启动 launcher.cmd,launcher.cmd 再调本脚本。
# UXP 不支持传参,args JSON 由 UXP 端写到 pluginDataFolder;
# pluginDataFolder 真实路径形如:
#   %APPDATA%\Adobe\UXP\PluginsStorage\PPRO\<ver>\Developer\<pluginId>\PluginData\
# 路径包含 PR 版本号,本脚本用 glob 搜索所有可能的版本目录。
#
# 启动顺序:
#   1) 注册表扫描 (HKLM/HKCU SOFTWARE\Adobe\Photoshop\{12.0..200.0})
#   2) 硬编码扫描 Adobe Creative Cloud 默认安装路径 (Adobe CC 2018 ~ 2026+)
#   3) .psd UserChoice COM fallback

# 诊断日志(写入独立文件,不与 cmd 日志抢锁)
$pluginId = "com.rocx.uxp"
$logFile = Join-Path $env:TEMP "rocx-launcher.log"
$logLine = "[" + (Get-Date -Format "HH:mm:ss.ff") + "] "
"=== launcher.ps1 START $(Get-Date -Format 'o') ===" | Out-File -LiteralPath $logFile -Encoding utf8

# 1) 定位 args JSON
$appdata = $env:APPDATA
$pattern1 = "$appdata\Adobe\UXP\PluginsStorage\PPRO\*\Developer\$pluginId\PluginData\rocx-launcher-args.json"
$pattern2 = "$appdata\Adobe\UXP\$pluginId\rocx-launcher-args.json"

$argsFile = $null
$found = Get-ChildItem -Path $pattern1 -ErrorAction SilentlyContinue | Select-Object -First 1
if ($found) {
    $argsFile = $found.FullName
} else {
    $found2 = Get-ChildItem -Path $pattern2 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found2) { $argsFile = $found2.FullName }
}

if (-not $argsFile) {
    "$logLine no args file found" | Out-File -LiteralPath $logFile -Append -Encoding utf8
    exit 0
}
"$logLine argsFile=$argsFile" | Out-File -LiteralPath $logFile -Append -Encoding utf8

# 2) 读 args JSON
$imagePath = ""
try {
    $raw = Get-Content -LiteralPath $argsFile -Raw -Encoding UTF8
    $argsObj = $raw | ConvertFrom-Json
    $imagePath = [string]$argsObj.path
    "$logLine imagePath=$imagePath" | Out-File -LiteralPath $logFile -Append -Encoding utf8
} catch {
    "$logLine failed to read args JSON" | Out-File -LiteralPath $logFile -Append -Encoding utf8
    Remove-Item -LiteralPath $argsFile -Force -ErrorAction SilentlyContinue
    exit 0
}

if (-not $imagePath -or -not (Test-Path -LiteralPath $imagePath)) {
    "$logLine image path invalid or not found" | Out-File -LiteralPath $logFile -Append -Encoding utf8
    Remove-Item -LiteralPath $argsFile -Force -ErrorAction SilentlyContinue
    exit 0
}

# 消费后立即删除,防重复启动
Remove-Item -LiteralPath $argsFile -Force -ErrorAction SilentlyContinue

# 3) 找 Photoshop
$psExe = $null

# 3a) 注册表扫描
$knownVersions = @(12.0, 13.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0, 200.0)
foreach ($v in $knownVersions) {
    $key = "SOFTWARE\Adobe\Photoshop\$v"
    $appPath = $null
    try { $appPath = (Get-ItemProperty -LiteralPath "HKLM:\$key" -Name "ApplicationPath" -ErrorAction SilentlyContinue).ApplicationPath } catch {}
    if (-not $appPath) {
        try { $appPath = (Get-ItemProperty -LiteralPath "HKCU:\$key" -Name "ApplicationPath" -ErrorAction SilentlyContinue).ApplicationPath } catch {}
    }
    if ($appPath) {
        $candidate = Join-Path $appPath "Photoshop.exe"
        if (Test-Path -LiteralPath $candidate) {
            $psExe = $candidate
            "$logLine found via registry v=$v: $psExe" | Out-File -LiteralPath $logFile -Append -Encoding utf8
            break
        }
    }
}

# 3b) 硬编码扫描 Adobe Creative Cloud 默认路径
if (-not $psExe) {
    $candidates = @(
        "C:\Program Files\Adobe\Adobe Photoshop 2026\Photoshop.exe",
        "C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe",
        "C:\Program Files\Adobe\Adobe Photoshop 2024\Photoshop.exe",
        "C:\Program Files\Adobe\Adobe Photoshop 2023\Photoshop.exe",
        "C:\Program Files\Adobe\Adobe Photoshop 2022\Photoshop.exe",
        "C:\Program Files\Adobe\Adobe Photoshop 2021\Photoshop.exe",
        "C:\Program Files\Adobe\Adobe Photoshop 2020\Photoshop.exe",
        "C:\Program Files\Adobe\Adobe Photoshop CC 2019\Photoshop.exe",
        "C:\Program Files\Adobe\Adobe Photoshop CC 2018\Photoshop.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) {
            $psExe = $c
            "$logLine found via hardcoded: $psExe" | Out-File -LiteralPath $logFile -Append -Encoding utf8
            break
        }
    }
}

# 3c) .psd UserChoice COM fallback
if (-not $psExe) {
    try {
        $userChoice = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.psd\UserChoice" -ErrorAction SilentlyContinue
        if ($userChoice -and $userChoice.ProgId) {
            $progKey = "HKCU:\Software\Classes\$($userChoice.ProgId)\shell\open\command"
            $cmd = (Get-ItemProperty -LiteralPath $progKey -ErrorAction SilentlyContinue).'(default)'
            if (-not $cmd) {
                $progKey = "HKLM:\Software\Classes\$($userChoice.ProgId)\shell\open\command"
                $cmd = (Get-ItemProperty -LiteralPath $progKey -ErrorAction SilentlyContinue).'(default)'
            }
            if ($cmd -and $cmd -match '^"([^"]+)"') {
                $candidate = $Matches[1]
                if (Test-Path -LiteralPath $candidate) {
                    $psExe = $candidate
                    "$logLine found via UserChoice: $psExe" | Out-File -LiteralPath $logFile -Append -Encoding utf8
                }
            }
        }
    } catch {}
}

# 4) 启动 PS / 静默退出
if ($psExe) {
    "$logLine launching: $psExe $imagePath" | Out-File -LiteralPath $logFile -Append -Encoding utf8
    Start-Process -FilePath $psExe -ArgumentList "`"$imagePath`""
} else {
    "$logLine Photoshop not found anywhere, exit silently" | Out-File -LiteralPath $logFile -Append -Encoding utf8
}

"=== launcher.ps1 END ===" | Out-File -LiteralPath $logFile -Append -Encoding utf8
exit 0
