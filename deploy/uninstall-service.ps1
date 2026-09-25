# Aster 库存系统 - 部署回滚：停止服务、移除计划任务与防火墙规则
# 配置恢复和数据库恢复分别办理；SQLite须停服备份并校验，不可用旧库覆盖新增业务。
#Requires -RunAsAdministrator
$ErrorActionPreference = "Continue"

$taskName = "AsterInventoryServer"
$ruleName = "Aster 库存系统 (TCP 4173 仅局域网)"
. (Join-Path $PSScriptRoot 'inventory-processes.ps1')

# 1. 停止并移除计划任务
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$installRoot = Get-AsterTaskInstallRoot -Task $task -FallbackRoot (Split-Path -Parent $PSScriptRoot)
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "[OK] 计划任务已移除: $taskName"
} else {
  Write-Host "[--] 计划任务不存在，跳过"
}

# 2. 仅结束该安装目录的服务程序及任务包装器。
Get-AsterInventoryProcesses -InstallRoot $installRoot |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] 已结束库存系统进程 PID=$($_.ProcessId)"
  }

# 3. 移除防火墙规则
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName $ruleName
  Write-Host "[OK] 防火墙规则已移除: $ruleName"
} else {
  Write-Host "[--] 防火墙规则不存在，跳过"
}

Write-Host "完成。数据文件未改动；配置及数据库恢复请按 README 的停服、备份、校验步骤办理。"
