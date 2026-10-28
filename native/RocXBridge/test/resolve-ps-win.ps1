# resolve-ps-win.ps1 — 验证 RocXBridgeWin.cpp 的 Photoshop 查找逻辑
#
# 与 C++ 侧保持同样的查找顺序:
#   1) HKLM/HKCU 注册表 SOFTWARE\Adobe\Photoshop\<ver>\ApplicationPath
#   2) Adobe CC 默认安装路径扫描 (CC 2018 ~ 2026+)
#   3) .psd UserChoice 关联
#   4) 校验结果确实是 Photoshop.exe
#
# 用法: powershell -NoProfile -File test/resolve-ps-win.ps1

$ErrorActionPreference = "Stop"

$knownVersions = @(12.0, 13.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0, 21.0, 22.0, 23.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0, 200.0)
$hardcoded = @(
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

function Test-PhotoshopExe([string]$p) {
    if (-not $p) { return $false }
    return ([System.IO.Path]::GetFileName($p) -ieq "Photoshop.exe")
}

$found = $null
$via = ""

# 1) 注册表
foreach ($v in $knownVersions) {
    $appPath = $null
    try { $appPath = (Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Adobe\Photoshop\$v" -Name "ApplicationPath" -ErrorAction SilentlyContinue).ApplicationPath } catch {}
    if (-not $appPath) {
        try { $appPath = (Get-ItemProperty -LiteralPath "HKCU:\SOFTWARE\Adobe\Photoshop\$v" -Name "ApplicationPath" -ErrorAction SilentlyContinue).ApplicationPath } catch {}
    }
    if ($appPath) {
        $exe = Join-Path $appPath "Photoshop.exe"
        if (Test-Path -LiteralPath $exe) { $found = $exe; $via = "registry v=$v"; break }
    }
}
if ($found) { "1) registry      -> HIT : $found" } else { "1) registry      -> MISS" }

# 2) 硬编码
if (-not $found) {
    foreach ($c in $hardcoded) {
        if (Test-Path -LiteralPath $c) { $found = $c; $via = "hardcoded"; break }
    }
}
if ($via -eq "hardcoded") { "2) hardcoded     -> HIT : $found" } else { "2) hardcoded     -> $(if ($via -eq '') { 'MISS' } else { 'skipped' })" }

# 3) .psd UserChoice
if (-not $found) {
    $ucKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.psd\UserChoice"
    if (Test-Path $ucKey) {
        $progId = (Get-ItemProperty $ucKey).ProgId
        "3) .psd UserChoice -> ProgId=$progId"
        foreach ($k in @("HKCU:\SOFTWARE\Classes\$progId\shell\open\command", "HKLM:\SOFTWARE\Classes\$progId\shell\open\command")) {
            if (Test-Path $k) {
                $cmd = (Get-ItemProperty $k)."(default)"
                if ($cmd -match '^"([^"]+)"') {
                    $exe = $Matches[1]
                    if (Test-PhotoshopExe $exe) { $found = $exe; $via = "userchoice(.psd)"; break }
                    else { "   -> 拒绝: $exe 不是 Photoshop.exe" }
                }
            }
        }
    } else { "3) .psd UserChoice -> MISS (无 .psd 关联)" }
}

# 2b) Adobe 目录枚举(绿色版兜底) — 插在硬编码之后、UserChoice 之前
if (-not $found) {
    foreach ($adobeRoot in @("C:\Program Files\Adobe", "C:\Program Files (x86)\Adobe")) {
        if (-not (Test-Path -LiteralPath $adobeRoot)) { continue }
        $best = $null; $bestScore = -1
        foreach ($d1 in (Get-ChildItem -LiteralPath $adobeRoot -Directory -ErrorAction SilentlyContinue)) {
            $cands = @((Join-Path $d1.FullName "Photoshop.exe"))
            foreach ($d2 in (Get-ChildItem -LiteralPath $d1.FullName -Directory -ErrorAction SilentlyContinue)) {
                $cands += (Join-Path $d2.FullName "Photoshop.exe")
            }
            $score = 0
            if ($d1.Name -match '(\d{4})') { $score = [int]$Matches[1] }
            foreach ($c in $cands) {
                if (Test-Path -LiteralPath $c) {
                    if ($score -gt $bestScore) { $bestScore = $score; $best = $c }
                }
            }
        }
        if ($best) { $found = $best; $via = "adobe-dir-scan"; break }
    }
    if ($via -eq "adobe-dir-scan") { "2b) adobe dir scan -> HIT : $found" } else { "2b) adobe dir scan -> MISS" }
}

# 4) 校验
if ($found) {
    if (Test-PhotoshopExe $found) {
        ""
        "RESULT: OK"
        "  Photoshop : $found"
        "  来源     : $via"
        exit 0
    } else {
        "RESULT: FAIL (解析结果不是 Photoshop.exe: $found)"
        exit 1
    }
} else {
    ""
    "RESULT: FAIL (三级查找全部落空,C++ 会返回 ok:false 并降级到 launcher 脚本)"
    exit 1
}
