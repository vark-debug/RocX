# kling-cli-locate-win.ps1 — 模拟 klingCli.ts 的 Windows 分支,验证 CLI 定位
#
# 复刻新逻辑:
#   1) where node (要 .exe)          -> node 绝对路径
#   2) npm root -g                   -> npm 全局根
#   3) <npmRoot>\@klingai\<pkg>\dist\cli.js --version -> 验证能跑
#
# 对照旧逻辑(已知是坏的):
#   where kling -> 取第一行 -> 拿到无扩展名的 kling(sh shim),CreateProcessW 跑不了
#
# 用法: powershell -NoProfile -File test/kling-cli-locate-win.ps1

$ErrorActionPreference = "Continue"

function Pick-PathLine {
    param([string]$Out, [string]$MustEndWith)
    foreach ($raw in ($Out -split "`r?`n")) {
        $line = $raw.Trim()
        if (-not ($line.StartsWith("/") -or $line -match '^[A-Za-z]:[\\/]')) { continue }
        if ($MustEndWith -and -not $line.ToLower().EndsWith($MustEndWith.ToLower())) { continue }
        return $line
    }
    return ""
}

"=== 旧逻辑 (where kling 取第一行) ==="
$oldOut = & cmd.exe /d /s /c "where kling" 2>&1 | Out-String
$oldFirst = ($oldOut -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })[0]
"  第一行        : $oldFirst"
"  以 .cmd 结尾 : $($oldFirst.ToLower().EndsWith('.cmd'))"
"  是 sh 脚本   : $((Get-Content $oldFirst -TotalCount 1 -ErrorAction SilentlyContinue) -like '#!*')  → CreateProcessW 会失败"
""
"  修复后 pickPathLine(mustEndWith=kling.cmd):"
"    -> $(Pick-PathLine -Out $oldOut -MustEndWith 'kling.cmd')"

""
"=== 新逻辑 step 1: where node ==="
$nodeOut = & cmd.exe /d /s /c "where node" 2>&1 | Out-String
$nodePath = Pick-PathLine -Out $nodeOut -MustEndWith ".exe"
if (-not $nodePath) {
    "  FAIL: 没找到 node.exe"
    exit 1
}
"  node : $nodePath"
"  version: $(& $nodePath --version 2>&1)"

""
"=== 新逻辑 step 2: npm root -g ==="
$npmOut = & cmd.exe /d /s /c "npm root -g" 2>&1 | Out-String
$npmRoot = Pick-PathLine -Out $npmOut
if (-not $npmRoot) {
    $appdata = $env:APPDATA
    $npmRoot = "$appdata\npm\node_modules"
    "  (where 失败,兜底) : $npmRoot"
} else {
    "  npmRoot : $npmRoot"
}

""
"=== 新逻辑 step 3: 探测 CLI JS 入口 ==="
$found = $null
foreach ($pkg in @("cli-cn", "cli-global")) {
    $js = Join-Path (Join-Path (Join-Path (Join-Path $npmRoot "@klingai") $pkg) "dist") "cli.js"
    if (-not (Test-Path -LiteralPath $js)) {
        "  [$pkg] 不存在: $js"
        continue
    }
    $ver = & $nodePath $js --version 2>&1 | Out-String
    if ($ver -match 'kling-cli') {
        "  [$pkg] OK: $js"
        "         --version => $($ver.Trim())"
        $found = $js
        break
    } else {
        "  [$pkg] 输出不含 kling-cli: $($ver.Trim())"
    }
}

""
if ($found) {
    "RESULT: OK"
    "  最终执行入口: $nodePath $found"
    exit 0
} else {
    "RESULT: FAIL (未能定位可灵 CLI JS 入口)"
    exit 1
}
