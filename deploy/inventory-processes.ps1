# Shared by controlled stop/uninstall and isolated ownership verification.
function Get-AsterInventoryProcesses {
  param([Parameter(Mandatory=$true)][string]$InstallRoot, [object[]]$Processes)
  $resolvedRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $servers = @((Join-Path $resolvedRoot 'server.mjs'))
  $wrappers = @((Join-Path $resolvedRoot 'deploy\aster-server.ps1'))
  $releases = Join-Path $resolvedRoot 'releases'
  if (Test-Path -LiteralPath $releases -PathType Container) {
    foreach ($release in Get-ChildItem -LiteralPath $releases -Directory) {
      if ($release.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      $servers += Join-Path $release.FullName 'server.mjs'
      $wrappers += Join-Path $release.FullName 'deploy\aster-server.ps1'
    }
  }
  if ($null -eq $Processes) { $Processes = @(Get-CimInstance Win32_Process -ErrorAction Stop) }
  foreach ($process in $Processes) {
    $paths = if ($process.Name -ieq 'node.exe') { $servers }
      elseif ($process.Name -in @('powershell.exe','pwsh.exe')) { $wrappers } else { @() }
    if (!$paths.Count -or !$process.ExecutablePath) { continue }
    # Compare complete command arguments to exact installed program paths. A filename substring is insufficient.
    $arguments = @([regex]::Matches([string]$process.CommandLine, '"([^"]*)"|(\S+)') | ForEach-Object {
      if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
    if ($process.Name -ieq 'node.exe') {
      # The installed task launches node with the absolute server program as its first argument.
      # A different program merely mentioning this path (including node -e) is not owned.
      if ($arguments.Count -gt 1 -and $paths -icontains $arguments[1]) { $process }
    } else {
      $fileIndex = -1
      for ($index = 1; $index -lt $arguments.Count; $index++) {
        if ($arguments[$index] -ieq '-File') { $fileIndex = $index; break }
      }
      if ($fileIndex -ge 0 -and $arguments.Count -gt ($fileIndex + 1) -and $paths -icontains $arguments[$fileIndex + 1]) { $process }
    }
  }
}

function Get-AsterTaskInstallRoot {
  param([object]$Task, [string]$FallbackRoot)
  foreach ($action in @($Task.Actions)) {
    $match = [regex]::Match([string]$action.Arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+\\deploy\\aster-server\.ps1)"|([^\s]+\\deploy\\aster-server\.ps1))(?:\s|$)')
    if ($match.Success) {
      $scriptPath = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
      if ([IO.Path]::IsPathRooted($scriptPath)) { return Split-Path -Parent (Split-Path -Parent ([IO.Path]::GetFullPath($scriptPath))) }
    }
  }
  return [IO.Path]::GetFullPath($FallbackRoot)
}
