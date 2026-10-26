# Run in an elevated Windows PowerShell after extracting to C:\LabPlanner.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
if ($appRoot -ne 'C:\LabPlanner') { throw 'Extract the reviewed package to C:\LabPlanner before installing. Do not run this in the development project.' }
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run Windows PowerShell as administrator.' }
$nodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$npmPath = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath $npmPath)) { throw 'Install machine-wide Node.js 24 LTS from nodejs.org first.' }
$version = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.') { throw 'This package requires Node.js 24 LTS.' }
if (Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 4317 is already occupied. Nothing has been changed.' }
foreach ($name in @('LabPlanner-Web', 'LabPlanner-DailyBackup')) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw "Task $name already exists. Use the update procedure; no task will be overwritten." }
}
$backupRoot = 'C:\LabPlannerBackups'
$configPath = Join-Path $appRoot 'data\server-config.json'
if ((Test-Path -LiteralPath $configPath) -or (Test-Path -LiteralPath $backupRoot)) { throw 'Server configuration or backup folder already exists. Inspect the previous installation before continuing.' }
if (Get-ChildItem -LiteralPath $appRoot -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Reparse points are not allowed in the installation folder.' }
Set-Location -LiteralPath $appRoot
& $npmPath ci --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. No scheduled tasks were registered.' }
New-Item -ItemType Directory -Path (Join-Path $appRoot 'data\logs') -Force | Out-Null
New-Item -ItemType Directory -Path $backupRoot | Out-Null
function Set-RestrictedDirectoryAcl([string]$path, [string]$serviceRights) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rights = if ($sid -eq 'S-1-5-19') { $serviceRights } else { 'FullControl' }
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
}
# The task can modify data/backups but cannot modify application code.
Set-RestrictedDirectoryAcl $appRoot 'ReadAndExecute'
Set-RestrictedDirectoryAcl (Join-Path $appRoot 'data') 'Modify'
Set-RestrictedDirectoryAcl $backupRoot 'Modify'
@{ nodePath = $nodePath; backupDirectory = $backupRoot } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
$powershellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runner = Join-Path $PSScriptRoot 'Run-Task.ps1'
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited
$webAction = New-ScheduledTaskAction -Execute $powershellPath -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$runner`" -Mode Web" -WorkingDirectory $appRoot
$backupAction = New-ScheduledTaskAction -Execute $powershellPath -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File `"$runner`" -Mode Backup" -WorkingDirectory $appRoot
$webSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$backupSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'LabPlanner-Web' -Action $webAction -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $webSettings -Description 'LabPlanner loopback backend; HTTPS proxy required.' | Out-Null
Register-ScheduledTask -TaskName 'LabPlanner-DailyBackup' -Action $backupAction -Trigger (New-ScheduledTaskTrigger -Daily -At '03:00') -Principal $principal -Settings $backupSettings -Description 'Verified SQLite backup; server local time 03:00.' | Out-Null
Start-ScheduledTask -TaskName 'LabPlanner-Web'
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Seconds 1
    try { $null = Invoke-RestMethod 'http://127.0.0.1:4317/api/status' -TimeoutSec 2; $ready = $true; break } catch {}
}
if (-not $ready) { throw 'Tasks were registered but startup failed. Check data\logs and Task Scheduler; do not re-run the installer.' }
Write-Host 'Backend ready on 127.0.0.1:4317 only. No IIS, firewall, OS time-zone, or power settings were changed.'
Write-Host 'Next: Initialize-Admin.ps1 (unless importing users), verify a backup, then configure internal HTTPS.'
Write-Host "Daily backup: $backupRoot at 03:00 server local time. Check disk space and copy backups to protected separate storage."
