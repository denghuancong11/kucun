# 重新注册 AsterInventoryServer 计划任务（显式 XML，确保 RestartOnFailure 生效）
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$wrapper = Join-Path $PSScriptRoot "aster-server.ps1"
$taskName = "AsterInventoryServer"

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Aster 库存系统生产服务（node server.mjs，端口 4173，开机自启，异常退出后每 1 分钟重启、最多 5 次）</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT10S</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$wrapper"</Arguments>
    </Exec>
  </Actions>
</Task>
"@

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Xml $xml | Out-Null

$check = Export-ScheduledTask -TaskName $taskName
if ($check -match "<Interval>PT1M</Interval>" -and $check -match "<Count>5</Count>") {
  Write-Host "[OK] 任务已重新注册，RestartOnFailure = 每 1 分钟 / 最多 5 次"
} else {
  throw "RestartOnFailure 配置校验失败"
}
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
Write-Host "[OK] 任务已启动: $((Get-ScheduledTask -TaskName $taskName).State)"
