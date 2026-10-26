import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const ps = command => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-Command', command], {
  encoding: 'utf8', timeout: 60000, windowsHide: true,
  // A PowerShell 7 parent otherwise passes incompatible module paths to Windows PowerShell 5.1.
  env: { ...process.env, PSModulePath: [join(process.env.WINDIR || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules'), join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell/Modules')].join(';') }
});

test('Windows deployment scripts parse without executing administrative installation', { skip: process.platform !== 'win32' }, async () => {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  for (const [path, entry] of Object.entries(lock.packages)) if (path) {
    assert.equal(entry.link, undefined, 'Deployment lock must not depend on development node_modules links');
    assert.ok(!path.includes('.pnpm'));
    assert.ok(entry.resolved.startsWith('https://registry.npmjs.org/'));
    assert.ok(entry.integrity.startsWith('sha512-'));
  }
  const result = ps(`$ErrorActionPreference='Stop'; $files=Get-ChildItem -LiteralPath ${quote(join(root, 'deploy/windows'))} -Filter '*.ps1'; foreach($file in $files){ $tokens=$null; $errors=$null; $null=[Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors); if($errors.Count){ throw ($errors | Out-String) } }; Write-Output $files.Count`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), '4');
  const aclCheck = ps(`$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile(${quote(join(root, 'deploy/windows/Install-Server.ps1'))},[ref]$tokens,[ref]$errors);
    $f=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Set-RestrictedDirectoryAcl'},$true);
    function Set-Acl { param($LiteralPath,$AclObject) $script:captured=$AclObject };
    . ([scriptblock]::Create($f.Extent.Text)); Set-RestrictedDirectoryAcl 'C:\\LabPlanner' 'ReadAndExecute';
    $rules=$script:captured.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]);
    if($rules.Count -ne 3 -or -not $script:captured.AreAccessRulesProtected){throw 'Unexpected ACL'};
    $service=@($rules | Where-Object {$_.IdentityReference.Value -eq 'S-1-5-19'})[0];
    if($service.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write){throw 'Service can write application code'};
    Write-Output 'acl-ok'`);
  assert.equal(aclCheck.status, 0, aclCheck.stdout + aclCheck.stderr);
  assert.equal(aclCheck.stdout.trim(), 'acl-ok');
  const install = await readFile(join(root, 'deploy/windows/Install-Server.ps1'), 'utf8');
  const runner = await readFile(join(root, 'deploy/windows/Run-Task.ps1'), 'utf8');
  assert.match(install, /appRoot -ne 'C:\\LabPlanner'/);
  assert.match(install, /S-1-5-19.*LogonType ServiceAccount -RunLevel Limited/);
  assert.match(runner, /HOST = '127\.0\.0\.1'/);
  assert.match(runner, /COOKIE_SECURE = '1'/);
  assert.doesNotMatch(install, /New-NetFirewallRule|Enable-WindowsOptionalFeature|Register-ScheduledTask[^\r\n]*-Force/);
  for (const file of ['Install-Server.ps1', 'Run-Task.ps1', 'Initialize-Admin.ps1', 'Build-Package.ps1']) {
    const bytes = await readFile(join(root, 'deploy/windows', file));
    assert.ok(bytes.every(b => b < 128), `${file}: ASCII source for Windows PowerShell 5.1 compatibility`);
  }
});

test('deployment ZIP contains exactly the current allowlisted sources, verifies every hash and excludes private/runtime files', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lab-package-test-'));
  const zip = join(folder, 'server-install.zip');
  try {
    const build = ps(`& ${quote(join(root, 'deploy/windows/Build-Package.ps1'))} -Destination ${quote(zip)}`);
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const verify = ps(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead(${quote(zip)}); try {
      $reader=New-Object IO.StreamReader($zip.GetEntry('PACKAGE-SHA256.json').Open()); try { $manifest=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() };
      if($zip.Entries.Count -ne $manifest.Count+1){ throw 'Unexpected ZIP entries' };
      foreach($item in $manifest){
        if($item.path -match '(^|/)(data|node_modules|test-results|backups|\\.git)/|\\.(sqlite|pfx|pem|key|zip|log)$'){ throw 'Private file included' };
        $entry=$zip.GetEntry($item.path); if(-not $entry){throw 'Missing entry'}; $stream=$entry.Open(); $sha=[Security.Cryptography.SHA256]::Create();
        try { $hash=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','') } finally { $stream.Dispose(); $sha.Dispose() };
        if($hash -ne $item.sha256){throw 'Archive hash mismatch'};
        if((Get-FileHash -LiteralPath (Join-Path ${quote(root)} $item.path) -Algorithm SHA256).Hash -ne $hash){throw 'Source hash mismatch'}
      }; Write-Output $manifest.Count
    } finally { $zip.Dispose() }`);
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
    assert.ok(Number(verify.stdout.trim()) > 25);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
