# Aster 库存系统 - 生产运行包装器（由计划任务 AsterInventoryServer 调用）
# 看门狗模式：node 异常退出后 10 秒内自动拉起；连续快速崩溃 5 次才放弃（交由计划任务 RestartOnFailure 兜底）。
# 持续运行超过 120 秒视为健康，崩溃计数清零。
$root = Split-Path -Parent $PSScriptRoot
$releasesRoot = Join-Path $root "releases"
$node = "C:\Program Files\nodejs\node.exe"

function Resolve-RunRoot {
  $pointerPath = Join-Path $releasesRoot "current.json"
  if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $root }

  try {
    $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding utf8 | ConvertFrom-Json
    $candidateRaw = [string]$pointer.path
    if ([string]::IsNullOrWhiteSpace($candidateRaw)) { throw "current.json 缺少 path" }
    $candidate = [IO.Path]::GetFullPath($candidateRaw)
    $resolvedReleases = (Resolve-Path -LiteralPath $releasesRoot).Path.TrimEnd("\")
    if (-not $candidate.StartsWith($resolvedReleases + "\", [StringComparison]::OrdinalIgnoreCase)) {
      throw "current.json 指向 releases 目录之外：$candidate"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $candidate "server.mjs") -PathType Leaf)) {
      throw "current.json 指向的版本缺少 server.mjs：$candidate"
    }
    return $candidate.TrimEnd("\")
  } catch {
    throw "无法解析原子发布指针 current.json：$($_.Exception.Message)"
  }
}

$runRoot = Resolve-RunRoot
Set-Location $runRoot

$env:HOST = "0.0.0.0"   # 局域网可访问；由防火墙规则限制为专用网络 + 部署时配置的局域网网段
$env:PORT = "4173"
$env:PROD = "1"         # 静态资源仅服务 web/dist，不回退仓库根目录（防权限矩阵等文件被直接下载）
# 版本化发布应在任务环境中显式配置版本目录之外的共享状态根；旧式平铺部署回退到原程序根，
# 不把数据库复制到 release 目录。
if ([string]::IsNullOrWhiteSpace($env:ASTER_STATE_ROOT)) { $env:ASTER_STATE_ROOT = $root }
$stateRoot = [IO.Path]::GetFullPath($env:ASTER_STATE_ROOT)
$runtimeConfig = Join-Path $stateRoot ".local-private\runtime-config.local.json"
if (-not (Test-Path -LiteralPath $runtimeConfig -PathType Leaf)) {
  throw "缺少本地私有运行配置 $runtimeConfig；拒绝使用示例仓库名称启动"
}
$env:ASTER_RUNTIME_CONFIG = $runtimeConfig
$env:ASTER_WAREHOUSE_ACCOUNTS = Join-Path $stateRoot ".local-private\warehouse-accounts.local.json"
Remove-Item Env:ASTER_OVERSEAS_WAREHOUSES -ErrorAction SilentlyContinue
$database = Join-Path (Join-Path $stateRoot "data") "aster-inventory.sqlite"
if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
  throw "缺少统一库存数据库 $database；必须先备份并执行 scripts/migrate-to-sqlite.mjs，禁止启动空库"
}

# 后端源码变更后必须先完成前端构建；构建指纹不匹配时拒绝启动，避免新前端打到旧 API。
$metaPath = Join-Path $runRoot "web\dist\build-meta.json"
$serverPath = Join-Path $runRoot "server.mjs"
if (-not (Test-Path -LiteralPath $metaPath -PathType Leaf)) { throw "缺少 web/dist/build-meta.json；请先执行受控构建" }
$meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
$backendHash = (Get-FileHash -LiteralPath $serverPath -Algorithm SHA256).Hash.ToUpperInvariant()
if ([string]::IsNullOrWhiteSpace([string]$meta.backendSourceSha256) -or $backendHash -ne ([string]$meta.backendSourceSha256).ToUpperInvariant()) {
  throw "构建指纹与 server.mjs 不一致；拒绝启动，先重新构建并原子发布 web/dist"
}
if ($meta.databaseSourceSha256) {
  $databaseHash = (Get-FileHash -LiteralPath (Join-Path $runRoot "inventory-db.mjs") -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($databaseHash -ne ([string]$meta.databaseSourceSha256).ToUpperInvariant()) { throw "业务规则模块与构建指纹不一致" }
}
if ($meta.lingxingHostSourceSha256) {
  $hostHash = (Get-FileHash -LiteralPath (Join-Path $runRoot "lingxing-host.mjs") -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($hostHash -ne ([string]$meta.lingxingHostSourceSha256).ToUpperInvariant()) { throw "领星执行模块与构建指纹不一致" }
}

$pointerPath = Join-Path $releasesRoot "current.json"
if (Test-Path -LiteralPath $pointerPath -PathType Leaf) {
  $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding utf8 | ConvertFrom-Json
  $expectedReleaseHash = ([string]$pointer.releaseFilesSha256).ToUpperInvariant()
  if (-not [string]::IsNullOrWhiteSpace($expectedReleaseHash)) {
    $fingerprintScript = Join-Path $runRoot "scripts\release-fingerprint.mjs"
    if (-not (Test-Path -LiteralPath $fingerprintScript -PathType Leaf)) { throw "发布目录缺少 scripts/release-fingerprint.mjs；拒绝启动" }
    $fingerprintRaw = & $node $fingerprintScript $runRoot
    if ($LASTEXITCODE -ne 0) { throw "发布目录文件指纹计算失败；拒绝启动" }
    try { $actualReleaseHash = ([string](($fingerprintRaw -join "") | ConvertFrom-Json).sha256).ToUpperInvariant() } catch { throw "发布目录文件指纹输出无效；拒绝启动" }
    if ($actualReleaseHash -ne $expectedReleaseHash) { throw "发布目录文件指纹不一致；拒绝启动" }
  }
}

$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("server-" + (Get-Date -Format "yyyyMMdd") + ".log")
try {
  $probe = [IO.File]::Open($log, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::Append, [IO.FileShare]::None)
  $probe.Close()
} catch {
  # 旧看门狗异常退出时可能仍短暂持有按日日志；新部署不能因此被阻塞。
  $log = Join-Path $logDir ("server-" + (Get-Date -Format "yyyyMMdd") + "-" + $PID + ".log")
}

function Write-Log($msg) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [wrapper] $msg" | Out-File -Append -Encoding utf8 $log
}

$maxFailures = 5
$failures = 0
$server = Join-Path $runRoot "server.mjs"

Write-Log "watchdog start HOST=$env:HOST PORT=$env:PORT STATE_ROOT=$stateRoot"

while ($true) {
  $startedAt = Get-Date
  Write-Log "starting node (failures=$failures)"
  # node:sqlite 在当前 Node 版本会把 ExperimentalWarning 写到 stderr；
  # 直接使用 *>> 会被 Windows PowerShell 的 Stop 策略当成 NativeCommandError，
  # 使服务刚监听就退出。合并 stdout/stderr 到日志，仍保留 LASTEXITCODE。
  & $node $server >> $log 2>&1
  $code = $LASTEXITCODE
  $ranSeconds = [int]((Get-Date) - $startedAt).TotalSeconds
  Write-Log "node exited, code=$code, ran=${ranSeconds}s"

  if ($ranSeconds -gt 120) { $failures = 0 } else { $failures++ }
  if ($failures -ge $maxFailures) {
    Write-Log "consecutive fast crashes reached $maxFailures, giving up (exit $code)"
    exit $code
  }
  Write-Log "restarting in 10s"
  Start-Sleep -Seconds 10
}
