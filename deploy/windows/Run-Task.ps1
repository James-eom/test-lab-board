[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Web', 'Backup')][string]$Mode)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
if ($appRoot -ne 'C:\LabPlanner') { throw 'This runner is restricted to C:\LabPlanner.' }
$config = Get-Content -LiteralPath (Join-Path $appRoot 'data\server-config.json') -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $config.nodePath)) { throw 'Configured Node.js executable is missing.' }
Set-Location -LiteralPath $appRoot
$env:HOST = '127.0.0.1'
$env:PORT = '4317'
$env:COOKIE_SECURE = '1'
$env:DB_PATH = Join-Path $appRoot 'data\lab.sqlite'
$env:BACKUP_DIR = $config.backupDirectory
$scriptFile = if ($Mode -eq 'Web') { 'server.mjs' } else { 'scripts\backup.mjs' }
$logFile = Join-Path $appRoot ('data\logs\' + $Mode + '-' + (Get-Date -Format 'yyyyMMdd') + '.log')
# Windows PowerShell can turn native stderr warnings into ErrorRecords; exit status is authoritative.
$ErrorActionPreference = 'Continue'
& $config.nodePath (Join-Path $appRoot $scriptFile) *>> $logFile
exit $LASTEXITCODE
