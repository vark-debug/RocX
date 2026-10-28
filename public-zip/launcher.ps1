# launcher.ps1 — RocX 抓帧→PS 启动器 (Windows)
#
# 由 UXP `shell.openPath` 启动 launcher.cmd,launcher.cmd 再调本脚本。
# UXP 不支持传参,args JSON 由 UXP 端写到 pluginDataFolder;
# pluginDataFolder 真实路径形如:
#   %APPDATA%\Adobe\UXP\PluginsStorage\PPRO\<ver>\<Developer|External>\<pluginId>\PluginData\
#
# 注意:这里不硬编码 pluginId,也不用 glob 固定层级 —— 正式 CCX 包的 manifest id
# 是 com.rocx.uxp_premierepro(uniqueIds 会加宿主后缀),开发模式才是 com.rocx.uxp;
# 且 CCX 双击安装走 External 段而非 Developer。硬编码任一项都会导致找不到 args 文件。
# 改为像 macOS 的 launcher.command 那样递归搜 UXP 根目录,只按文件名匹配。
#
# 启动顺序:
#   1) 注册表扫描 (HKLM/HKCU SOFTWARE\Adobe\Photoshop\{12.0..200.0})
#   2) 硬编码扫描 Adobe Creative Cloud 默认安装路径 (Adobe CC 2018 ~ 2026+)
#   3) 扫描 C:\Program Files\Adobe\ 下所有子目录 (绿色版/Portable 兜底)
#   4) .psd UserChoice COM fallback

# 诊断日志(写入独立文件,不与 cmd 日志抢锁)
$logFile = Join-Path $env:TEMP "rocx-launcher.log"
$logLine = "[" + (Get-Date -Format "HH:mm:ss.ff") + "] "
"=== launcher.ps1 START $(Get-Date -Format 'o') ===" | Out-File -LiteralPath $logFile -Encoding utf8

# 1) 定位 args JSON
$appdata = $env:APPDATA
$uxpRoot = Join-Path $appdata "Adobe\UXP"
$argsFile = $null
if (Test-Path -LiteralPath $uxpRoot) {
    # 递归搜 UXP 根目录,取最近修改的一个(PR 可能同时留有多版本目录)
    $candidates = Get-ChildItem -LiteralPath $uxpRoot -Recurse -File -Filter "rocx-launcher-args.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if ($candidates) { $argsFile = $candidates[0].FullName }
}
if (-not $argsFile) {
    # 兜底:老布局 %APPDATA%\Adobe\UXP\<pluginId>\ (非 PluginsStorage)
    $legacy = Get-ChildItem -LiteralPath $uxpRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "rocx-launcher-args.json" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($legacy) { $argsFile = $legacy }
}

if (-not $argsFile) {
    "$logLine no args file found under $uxpRoot" | Out-File -LiteralPath $logFile -Append -Encoding utf8
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

# 剥离 "\\?\" 扩展长度前缀 —— UXP 的 nativePath 常带这个前缀,
# 直接传给 Photoshop 会被当成普通 Win32 路径而打不开。
if ($imagePath.StartsWith("\\?\")) {
    $imagePath = $imagePath.Substring(4)
    "$logLine stripped \\?\ prefix -> $imagePath" | Out-File -LiteralPath $logFile -Append -Encoding utf8
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

# 3c) 扫描 Adobe 安装目录下的所有子目录 ——
#     绿色版(Portable / 非 CC 安装)不写注册表,目录名也不标准
#     ("PS2024"、"PS 2024 绿色版"等),固定候选列表覆盖不到,靠枚举兜底。
if (-not $psExe) {
    foreach ($adobeRoot in @("C:\Program Files\Adobe", "C:\Program Files (x86)\Adobe")) {
        if (-not (Test-Path -LiteralPath $adobeRoot)) { continue }
        $foundDirs = Get-ChildItem -LiteralPath $adobeRoot -Directory -ErrorAction SilentlyContinue
        foreach ($d1 in $foundDirs) {
            $c1 = Join-Path $d1.FullName "Photoshop.exe"
            if (Test-Path -LiteralPath $c1) {
                $psExe = $c1
                "$logLine found via Adobe dir scan: $psExe" | Out-File -LiteralPath $logFile -Append -Encoding utf8
                break
            }
            # 二级子目录
            foreach ($d2 in (Get-ChildItem -LiteralPath $d1.FullName -Directory -ErrorAction SilentlyContinue)) {
                $c2 = Join-Path $d2.FullName "Photoshop.exe"
                if (Test-Path -LiteralPath $c2) {
                    $psExe = $c2
                    "$logLine found via Adobe dir scan (2 levels): $psExe" | Out-File -LiteralPath $logFile -Append -Encoding utf8
                    break
                }
            }
            if ($psExe) { break }
        }
        if ($psExe) { break }
    }
}

# 3d) .psd UserChoice COM fallback
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
