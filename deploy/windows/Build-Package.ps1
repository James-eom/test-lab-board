[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$archivePath = [IO.Path]::GetFullPath($Destination)
if ([IO.Path]::GetExtension($archivePath) -ne '.zip' -or (Test-Path -LiteralPath $archivePath)) { throw 'Choose a NEW .zip destination; existing files will not be overwritten.' }
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ('lab-package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stageRoot | Out-Null
try {
    $entries = @('public', 'src', 'scripts', 'tests', 'docs', 'deploy', 'server.mjs', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'playwright.config.mjs', 'Start-Lab.ps1', 'README.md', 'HANDOFF.md', '.gitignore')
    $manifest = @()
    foreach ($entry in $entries) {
        $item = Get-Item -LiteralPath (Join-Path $sourceRoot $entry) -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source reparse points are not permitted.' }
        $files = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Force) } else { @($item) }
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($sourceRoot.Length + 1)
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint -or $relative -match '(?i)(^|[\\/])(data|node_modules|\.git|backups|test-results|\.env)([\\/]|$)|\.(sqlite|sqlite-wal|sqlite-shm|db|zip|pfx|pem|key|log)$') { throw "Private/runtime file is not permitted: $relative" }
            $target = Join-Path $stageRoot $relative
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $target
            $sourceHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $sourceHash) { throw "Source changed during packaging: $relative" }
            $manifest += [PSCustomObject]@{ path = $relative.Replace([char]92, [char]47); sha256 = $sourceHash }
        }
    }
    $manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $stageRoot 'PACKAGE-SHA256.json') -Encoding UTF8
    New-Item -ItemType Directory -Path (Split-Path -Parent $archivePath) -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Force) {
            $entryName = $file.FullName.Substring($stageRoot.Length + 1).Replace([char]92, [char]47)
            $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose() }
    Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
    Write-Host "Packaged $($manifest.Count) source files. Database, API credentials, Git history, dependencies and test output excluded."
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stageRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedStage) -match '^lab-package-[0-9a-f]{32}$') {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    } else { throw 'Temporary cleanup path validation failed.' }
}
