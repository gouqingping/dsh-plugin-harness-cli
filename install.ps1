# dsh-plugin-harness-cli 一键安装脚本（Windows / macOS / Linux 通用）
#
# Windows : powershell -ExecutionPolicy Bypass -File install.ps1
# macOS/Linux : pwsh ./install.ps1     （或直接用同目录的 install.sh，无需 PowerShell）
#
# 做什么：找到 DSH harness → 拷插件 → 建链接 → 注册 cordis.patch.yml（带备份、幂等）。
# 重复执行安全：插件目录整体替换，注册只用标记块维护，不会产生重复条目。
param(
  [string]$HarnessRoot = "",
  [string]$DshHome = "",
  [switch]$SkipCordis,
  [switch]$KeepBackupOfPlugin
)

$ErrorActionPreference = "Stop"

$PluginName = "dsh-plugin-harness-cli"
$PluginId = "harness-cli"
$Scope = "@deepseek-ai"
$MarkerStart = "# >>> $PluginName >>>"
$MarkerEnd = "# <<< $PluginName <<<"

$src = $PSScriptRoot
$pluginSrc = Join-Path $src "plugin"

# 0. 平台判断（PowerShell 5.1 没有 $IsWindows/$IsMacOS）
$onWindows = [System.Environment]::OSVersion.Platform -eq 'Win32NT'
$onMac = $false
$onLinux = $false
if ($PSVersionTable.PSVersion.Major -ge 6) {
  $onMac = $IsMacOS
  $onLinux = $IsLinux
}
$platform = if ($onWindows) { "Windows" } elseif ($onMac) { "macOS" } elseif ($onLinux) { "Linux" } else { "未知系统" }
Write-Host "平台: $platform / PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor Cyan

if (-not (Test-Path (Join-Path $pluginSrc "package.json"))) {
  Write-Host "❌ 本目录下没有 plugin/package.json，请在解压后的包根目录执行本脚本" -ForegroundColor Red
  exit 1
}

if (-not $DshHome) {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
}

# 1. 检测 harness 路径
function Get-HarnessCandidates {
  $list = @()
  if ($env:DSH_HARNESS_ROOT) { $list += $env:DSH_HARNESS_ROOT }
  if ($onWindows) {
    $base = Join-Path $env:LOCALAPPDATA "Seadun\Agent-App\versions"
  } elseif ($onMac) {
    $base = Join-Path $HOME "Library/Application Support/Seadun/Agent-App/versions"
  } else {
    $xdg = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
    $base = Join-Path $xdg "Seadun/Agent-App/versions"
  }
  if (Test-Path $base) {
    $list += Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "runtime/harness" }
  }
  return $list
}

if (-not $HarnessRoot) {
  foreach ($candidate in (Get-HarnessCandidates)) {
    if (Test-Path (Join-Path $candidate "node_modules")) { $HarnessRoot = $candidate; break }
  }
}
if (-not $HarnessRoot -or -not (Test-Path (Join-Path $HarnessRoot "node_modules"))) {
  Write-Host "❌ 未找到 DSH harness。请指定: -HarnessRoot <path>（或设 DSH_HARNESS_ROOT）" -ForegroundColor Red
  Write-Host "   已尝试的候选目录：" -ForegroundColor Yellow
  foreach ($c in (Get-HarnessCandidates)) { Write-Host "   - $c" }
  exit 1
}
Write-Host "使用 harness: $HarnessRoot"

# 1.5 插件是否已被 DSH 内置（bundle 层已注册同 id/name）
$builtin = $false
$scopeDir = Join-Path $HarnessRoot (Join-Path "node_modules" $Scope)
if (Test-Path $scopeDir) {
  $idPattern = "(?m)^\s*-\s*id:\s*" + [regex]::Escape($PluginId) + "\s*$"
  $namePattern = [regex]::Escape("$Scope/$PluginName")
  foreach ($pkgDir in (Get-ChildItem $scopeDir -Directory -ErrorAction SilentlyContinue)) {
    $bp = Join-Path $pkgDir.FullName "cordis.patch.yml"
    if (-not (Test-Path $bp)) { continue }
    $bc = Get-Content $bp -Raw
    if ($bc -match $idPattern -or $bc -match $namePattern) { $builtin = $true; break }
  }
}

# 2. 复制插件本体到 harness node_modules
$harnessPlugin = Join-Path $HarnessRoot (Join-Path "node_modules" (Join-Path $Scope $PluginName))
if ($KeepBackupOfPlugin -and (Test-Path $harnessPlugin)) {
  $old = "$harnessPlugin.bak-" + (Get-Date -Format "yyyyMMddHHmmss")
  Move-Item $harnessPlugin $old
  Write-Host "ℹ 旧插件已备份: $old" -ForegroundColor DarkGray
} elseif (Test-Path $harnessPlugin) {
  Remove-Item $harnessPlugin -Recurse -Force
}
New-Item -ItemType Directory -Path $harnessPlugin -Force | Out-Null
Get-ChildItem $pluginSrc -Force | Copy-Item -Destination $harnessPlugin -Recurse -Force
Write-Host "✅ 插件已复制到 harness: $harnessPlugin"

# 3. 建链接（profiles 模块扫描需要）
$profilePlugin = Join-Path $DshHome (Join-Path "profiles" (Join-Path "node_modules" (Join-Path $Scope $PluginName)))
New-Item -ItemType Directory -Path (Split-Path $profilePlugin -Parent) -Force | Out-Null
if (Test-Path $profilePlugin) { Remove-Item $profilePlugin -Recurse -Force }

if ($onWindows) {
  New-Item -ItemType Junction -Path $profilePlugin -Target $harnessPlugin | Out-Null
  Write-Host "✅ Junction 已创建"
} else {
  try {
    New-Item -ItemType SymbolicLink -Path $profilePlugin -Target $harnessPlugin | Out-Null
    Write-Host "✅ 符号链接已创建"
  } catch {
    Copy-Item $harnessPlugin $profilePlugin -Recurse -Force
    Write-Host "⚠ 创建符号链接失败（权限？），已改为复制副本" -ForegroundColor Yellow
  }
}

# 4. 给 CLI 入口加可执行位（仅类 Unix）
if (-not $onWindows) {
  $binFile = Join-Path $harnessPlugin "bin/dsh-plugin-harness-cli.js"
  if (Test-Path $binFile) {
    try { & chmod +x $binFile } catch { Write-Host "⚠ 未能 chmod +x（用 node 调用即可）" -ForegroundColor DarkGray }
  }
}

# 5. 注册 cordis.patch.yml（标记块 + 备份；内置插件不再注册）
$patchPath = Join-Path $DshHome "profiles/web/cordis.patch.yml"
$entryBlock = @"
$MarkerStart
- insert:
    - id: $PluginId
      name: '$Scope/$PluginName'
$MarkerEnd
"@

function Remove-MarkedBlock([string]$text) {
  $pattern = "(?ms)^" + [regex]::Escape($MarkerStart) + "\r?\n.*?^" + [regex]::Escape($MarkerEnd) + "\r?\n?"
  return [regex]::Replace($text, $pattern, "")
}

function New-BackupPath([string]$path) {
  $stamp = Get-Date -Format "yyyyMMddHHmmssfff"
  $candidate = "$path.bak-$stamp"
  $n = 1
  while (Test-Path $candidate) { $candidate = "$path.bak-$stamp-$n"; $n++ }
  return $candidate
}

if ($builtin) {
  Write-Host "ℹ 插件 $PluginName 已随 DSH 内置，跳过 cordis 注册，仅更新文件" -ForegroundColor Yellow
} elseif ($SkipCordis) {
  if (Test-Path $patchPath) {
    $current = Get-Content $patchPath -Raw
    if ($current.Contains($MarkerStart)) {
      $backup = New-BackupPath $patchPath
      Copy-Item $patchPath $backup
      $stripped = (Remove-MarkedBlock $current).TrimEnd()
      [System.IO.File]::WriteAllText($patchPath, "$stripped`n", (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "✅ 已从 cordis.patch.yml 移除本插件注册（备份: $backup）"
    }
  }
  Write-Host "ℹ 按 -SkipCordis 要求跳过 cordis 注册" -ForegroundColor Yellow
} elseif (-not (Test-Path $patchPath)) {
  New-Item -ItemType Directory -Path (Split-Path $patchPath -Parent) -Force | Out-Null
  [System.IO.File]::WriteAllText($patchPath, "$entryBlock`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "✅ 已新建 cordis.patch.yml 并注册（首个插件）"
} else {
  $content = Get-Content $patchPath -Raw
  $clean = (Remove-MarkedBlock $content).TrimEnd()
  $idPattern = "(?m)^\s*-\s*id:\s*" + [regex]::Escape($PluginId) + "\s*$"
  $namePattern = [regex]::Escape("$Scope/$PluginName")
  if ($content.Contains($MarkerStart) -and -not ($clean -match $idPattern) -and -not ($clean -match $namePattern)) {
    Write-Host "✅ 插件已在 cordis.patch.yml 注册且无变化（跳过备份与写入）" -ForegroundColor Yellow
  } elseif ($clean -match $idPattern -or $clean -match $namePattern) {
    Write-Host "✅ 插件已在 cordis.patch.yml 注册（id/name 已存在），未重复写入" -ForegroundColor Yellow
  } else {
    $backup = New-BackupPath $patchPath
    Copy-Item $patchPath $backup
    $next = if ($clean.Trim() -eq "") { "$entryBlock`n" } else { "$clean`n`n$entryBlock`n" }
    [System.IO.File]::WriteAllText($patchPath, $next, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "✅ cordis.patch.yml 已注册（备份: $backup）"
  }
}

Write-Host ""
Write-Host "🎉 插件 $PluginName 安装完成！" -ForegroundColor Green
Write-Host "   完全退出 Seadun 应用后重新打开。"
Write-Host "   在目标项目里试跑："
Write-Host "   node `"$harnessPlugin/bin/dsh-plugin-harness-cli.js`" check"
