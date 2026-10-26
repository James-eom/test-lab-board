# Run locally on the server BEFORE exposing the HTTPS site to other computers.
$ErrorActionPreference = 'Stop'
$status = Invoke-RestMethod 'http://127.0.0.1:4317/api/status'
if (-not $status.setupRequired) { Write-Host 'An administrator already exists. Existing accounts have not been changed.'; return }
$login = Read-Host 'Administrator login (3-40 ASCII characters)'
$displayName = Read-Host 'Administrator display name'
$secret = Read-Host 'Administrator password (10-200 characters)' -AsSecureString
$pointer = [IntPtr]::Zero
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $payload = @{ login = $login; name = $displayName; password = $password } | ConvertTo-Json -Compress
    $null = Invoke-RestMethod 'http://127.0.0.1:4317/api/setup' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload))
    Write-Host 'Administrator created. Enable the reviewed HTTPS proxy, then sign in over HTTPS.'
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $password = $null; $payload = $null; $secret.Dispose()
}
