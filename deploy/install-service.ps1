# Aster 库存系统 - 局域网生产部署（幂等，可重复执行）
# 内容：注册开机自启计划任务（SYSTEM 账户，失败自动重启）+ 防火墙入站规则（仅专用网络 + 局域网网段）
# 不安装任何新组件，仅使用 Windows 自带的计划任务与防火墙。
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$root      = Split-Path -Parent $PSScriptRoot
$wrapper   = Join-Path $PSScriptRoot "aster-server.ps1"
$taskName  = "AsterInventoryServer"
$ruleName  = "Aster 库存系统 (TCP 4173 仅局域网)"
$lanSubnet = $env:ASTER_LAN_SUBNET
if ([string]::IsNullOrWhiteSpace($lanSubnet)) {
  throw "请设置 ASTER_LAN_SUBNET 为目标 Windows 主机的局域网 CIDR 网段"
}
$stateRoot = if ([string]::IsNullOrWhiteSpace($env:ASTER_STATE_ROOT)) { $root } else { [IO.Path]::GetFullPath($env:ASTER_STATE_ROOT) }
$database = Join-Path (Join-Path $stateRoot "data") "aster-inventory.sqlite"
if (-not (Test-Path -LiteralPath $database -PathType Leaf)) {
  throw "缺少统一库存数据库 $database；先备份并执行受控迁移，安装脚本不会自动创建空数据库"
}

# ---------- 1. 计划任务：开机自启 + 异常退出自动重启 ----------
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Aster 库存系统生产服务（node server.mjs，端口 4173，开机自启，失败每分钟重启最多 5 次）" | Out-Null
Write-Host "[OK] 计划任务已注册: $taskName"

# ---------- 2. 防火墙：仅放行 4173，限定专用网络 + 局域网网段 ----------
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName $ruleName
}
New-NetFirewallRule -DisplayName $ruleName `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173 `
  -Profile Private -RemoteAddress $lanSubnet `
  -Description "Aster 库存系统 Web/API；仅专用网络配置文件且来源为 $lanSubnet 时放行，不公网暴露" | Out-Null
Write-Host "[OK] 防火墙规则已创建: $ruleName (TCP 4173, Private, $lanSubnet)"

# ---------- 3. 启动服务 ----------
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  Write-Host "[OK] 服务已监听 4173 (LocalAddress=$($listener[0].LocalAddress))"
} else {
  Write-Host "[WARN] 未检测到 4173 监听，请查看 logs\ 目录日志"
}
