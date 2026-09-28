[CmdletBinding()]
param(
  [string]$SourceRoot = "",
  [string]$ReleaseRoot = "",
  [string]$Version = ""
)

# 仅准备不可变生产版本和 current.json 指针；不触碰共享状态，也不自动重启服务。
# 发布内容使用显式 allowlist，禁止把开发依赖、截图、配置或任何 SQLite 状态带入版本目录。
$ErrorActionPreference = "Stop"
$sourcePath = if ([string]::IsNullOrWhiteSpace($SourceRoot)) { Split-Path -Parent $PSScriptRoot } else { $SourceRoot }
$source = (Resolve-Path -LiteralPath $sourcePath).Path.TrimEnd("\")
$releases = if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) { Join-Path $source "releases" } else { [IO.Path]::GetFullPath($ReleaseRoot) }
$versionName = if ([string]::IsNullOrWhiteSpace($Version)) { Get-Date -Format "yyyyMMdd-HHmmss" } else { $Version }
if ($versionName -notmatch '^[A-Za-z0-9._-]+$') { throw "Version 只能包含字母、数字、点、下划线和连字符" }
$stage = Join-Path $releases (".staging-" + $versionName + "-" + $PID)
$target = Join-Path $releases $versionName
foreach ($candidate in @($stage, $target)) {
  if (-not ([IO.Path]::GetFullPath($candidate)).StartsWith([IO.Path]::GetFullPath($releases).TrimEnd("\") + "\", [StringComparison]::OrdinalIgnoreCase)) { throw "发布目标必须位于指定 releases 目录内" }
}
if (Test-Path -LiteralPath $target) { throw "发布目录已存在：$target" }
if (Test-Path -LiteralPath $stage) { throw "发布暂存目录已存在：$stage" }
New-Item -ItemType Directory -Path $releases -Force | Out-Null
New-Item -ItemType Directory -Path $stage | Out-Null

$requiredFiles = @(
  "server.mjs",
  "inventory-db.mjs",
  "lingxing-host.mjs",
  "warehouse-address.mjs",
  "upgrade-template.mjs",
  "migrations\requirements-5-9.mjs",
  "package.json",
  "scripts\release-fingerprint.mjs"
)
$operationalFiles = @(
  "README.md",
  "正式前端Wimoor改版与部署验收-20260920.md",
  "领星真实同步排查记录-20260920.md",
  "本轮精简对照与验收-20260911.md",
  "逐项有效需求对照-20260911.md",
  "领星同步字段与混合任务验收-20260911.md",
  "领星标签页清理修复-20260914.md",
  "领星执行页启动修复-20260914.md",
  "多人页面更新修复与验收-20260914.md",
  "全业务多人数据自动更新验收-20260914.md",
  "批次调拨记录验收-20260914.md",
  "海外仓与直发FBA改造验收-20260915.md",
  "审批中心紧凑布局验收-20260915.md",
  "审批中心行式比较验收-20260915.md",
  "审批中心数量渠道与资料验收-20260916.md",
  "审批中心资料入表与操作下移验收-20260916.md",
  "审批中心精简列与商务表单验收-20260916.md",
  "审批中心18列顺序验收-20260916.md",
  "审批中心逐步结果展示验收-20260916.md",
  "审批中心状态标志与提交按钮验收-20260916.md",
  "deploy\aster-server.ps1",
  "deploy\install-service.ps1",
  "deploy\publish-release.ps1",
  "deploy\register-task.ps1",
  "deploy\uninstall-service.ps1",
  "deploy\inventory-processes.ps1",
  "scripts\migrate-inventory-v3.mjs",
  "scripts\migrate-to-sqlite.mjs",
  "scripts\sqlite-quick-check.mjs",
  "scripts\lingxing-page-collector.js",
  "scripts\lingxing-removal-page-collector.js",
  "scripts\LINGXING-SCRIPTS.md",
  "scripts\build-edge-extension.mjs",
  "edge-extension\manifest.json",
  "edge-extension\background.js",
  "edge-extension\tab-operations.js",
  "edge-extension\worker.js",
  "edge-extension\report-runner.js",
  "edge-extension\worker.html",
  "领星部署端同步说明.md",
  "edge-extension\lingxing-page-collector.js",
  "edge-extension\lingxing-removal-page-collector.js",
  "edge-extension\README.md"
)

function Copy-AllowlistedFile([string]$relativePath, [bool]$required) {
  $sourcePath = Join-Path $source $relativePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    if ($required) { throw "生产发布缺少必需文件：$relativePath" }
    return
  }
  $destination = Join-Path $stage $relativePath
  $destinationParent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  Copy-Item -LiteralPath $sourcePath -Destination $destination -Force
}

function Assert-NoForbiddenReleaseContent([string]$candidateRoot) {
  $resolvedCandidate = (Resolve-Path -LiteralPath $candidateRoot).Path.TrimEnd("\")
  $forbiddenSegments = @("-", ".git", "config", "state", "data", "backups", "logs", "releases", "node_modules", "_shots")
  $violations = @()
  Get-ChildItem -LiteralPath $resolvedCandidate -Force -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($resolvedCandidate.Length).TrimStart("\")
    $segments = @($relative -split '[\\/]')
    $hasForbiddenSegment = @($segments | Where-Object { $forbiddenSegments -contains $_.ToLowerInvariant() }).Count -gt 0
    $isForbiddenFile = -not $_.PSIsContainer -and (
      $_.Name.Equals("config.json", [StringComparison]::OrdinalIgnoreCase) -or
      $_.Name -match '(?i)(\.sqlite(?:-(?:wal|shm))?|\.wal|\.shm)$'
    )
    $isReparsePoint = ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($hasForbiddenSegment -or $isForbiddenFile -or $isReparsePoint) { $violations += $relative }
  }
  if ($violations.Count -gt 0) {
    $sample = ($violations | Select-Object -First 20) -join ", "
    throw "发布内容包含禁止项，拒绝切换 current.json：$sample"
  }
}

function Get-ReleaseFingerprint([string]$candidateRoot) {
  $fingerprintScript = Join-Path $candidateRoot "scripts\release-fingerprint.mjs"
  if (-not (Test-Path -LiteralPath $fingerprintScript -PathType Leaf)) { throw "发布目录缺少 scripts/release-fingerprint.mjs" }
  $raw = & node $fingerprintScript $candidateRoot
  if ($LASTEXITCODE -ne 0) { throw "发布目录文件指纹计算失败：$candidateRoot" }
  try { return (($raw -join "") | ConvertFrom-Json).sha256.ToUpperInvariant() } catch { throw "发布目录文件指纹输出无效：$candidateRoot" }
}

$pointerTemp = Join-Path $releases ("current.json.tmp-" + $PID)
$targetCreated = $false
$pointerActivated = $false

try {
  $metaPath = Join-Path $source "web\dist\build-meta.json"
  if (-not (Test-Path -LiteralPath $metaPath -PathType Leaf)) { throw "缺少 web/dist/build-meta.json；请先执行 npm run build" }
  $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
  $backendHash = (Get-FileHash -LiteralPath (Join-Path $source "server.mjs") -Algorithm SHA256).Hash.ToUpperInvariant()
  $metadataBackendHash = ([string]$meta.backendSourceSha256).ToUpperInvariant()
  if ([string]::IsNullOrWhiteSpace($metadataBackendHash) -or $backendHash -ne $metadataBackendHash) { throw "前后端构建指纹不一致，拒绝发布" }
  $databaseHash = (Get-FileHash -LiteralPath (Join-Path $source "inventory-db.mjs") -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($databaseHash -ne ([string]$meta.databaseSourceSha256).ToUpperInvariant()) { throw "业务规则模块与前端构建不一致，拒绝发布" }
  $hostHash = (Get-FileHash -LiteralPath (Join-Path $source "lingxing-host.mjs") -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($hostHash -ne ([string]$meta.lingxingHostSourceSha256).ToUpperInvariant()) { throw "领星执行模块与前端构建不一致，拒绝发布" }

  foreach ($relativePath in $requiredFiles) { Copy-AllowlistedFile $relativePath $true }
  foreach ($relativePath in $operationalFiles) { Copy-AllowlistedFile $relativePath $false }

  $distSource = Join-Path $source "web\dist"
  if (-not (Test-Path -LiteralPath $distSource -PathType Container)) { throw "缺少 web/dist；请先执行 npm run build" }
  $distDestination = Join-Path $stage "web\dist"
  New-Item -ItemType Directory -Path $distDestination -Force | Out-Null
  Get-ChildItem -LiteralPath $distSource -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $distDestination $_.Name) -Recurse -Force
  }

  # 必须在版本目录落地和 current.json 切换前递归扫描；任何状态文件都会使暂存目录整体回滚。
  Assert-NoForbiddenReleaseContent $stage
  Move-Item -LiteralPath $stage -Destination $target
  $targetCreated = $true
  Assert-NoForbiddenReleaseContent $target
  $publishedBackendHash = (Get-FileHash -LiteralPath (Join-Path $target "server.mjs") -Algorithm SHA256).Hash.ToUpperInvariant()
  $publishedMetaPath = Join-Path $target "web\dist\build-meta.json"
  $publishedMeta = Get-Content -LiteralPath $publishedMetaPath -Raw | ConvertFrom-Json
  if ($publishedBackendHash -ne $backendHash -or ([string]$publishedMeta.backendSourceSha256).ToUpperInvariant() -ne $backendHash) {
    throw "版本目录构建指纹校验失败，拒绝切换 current.json"
  }
  $releaseFilesSha256 = Get-ReleaseFingerprint $target
  [ordered]@{ version = $versionName; path = $target; publishedAt = (Get-Date).ToString("o"); backendSourceSha256 = $backendHash; frontendMetaSha256 = (Get-FileHash -LiteralPath (Join-Path $target "web\dist\build-meta.json") -Algorithm SHA256).Hash.ToUpperInvariant(); releaseFilesSha256 = $releaseFilesSha256 } | ConvertTo-Json | Out-File -LiteralPath $pointerTemp -Encoding utf8
  Move-Item -LiteralPath $pointerTemp -Destination (Join-Path $releases "current.json") -Force
  $pointerActivated = $true
  Write-Output "发布已准备：$target；请先执行健康检查，再由计划任务受控重启。"
} catch {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  if (Test-Path -LiteralPath $pointerTemp) { Remove-Item -LiteralPath $pointerTemp -Force }
  if ($targetCreated -and -not $pointerActivated -and (Test-Path -LiteralPath $target)) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  throw
}
