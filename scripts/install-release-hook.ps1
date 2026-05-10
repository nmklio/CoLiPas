param(
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$root = (git rev-parse --show-toplevel).Trim()
$gitDir = (git rev-parse --git-dir).Trim()
if (-not [System.IO.Path]::IsPathRooted($gitDir)) {
  $gitDir = Join-Path $root $gitDir
}

$hookPath = Join-Path $gitDir "hooks\post-commit"

if ($Remove) {
  if (Test-Path $hookPath) {
    Remove-Item -LiteralPath $hookPath -Force
    Write-Host "Removed post-commit release hook."
  } else {
    Write-Host "No post-commit release hook is installed."
  }
  exit 0
}

$releaseScript = Join-Path $root "scripts\release-deploy.ps1"
$hook = @"
#!/bin/sh
echo "==> CoLiPas post-commit release hook"
powershell -NoProfile -ExecutionPolicy Bypass -File "$releaseScript"
"@

Set-Content -LiteralPath $hookPath -Value $hook -Encoding ascii
Write-Host "Installed post-commit release hook at $hookPath"
Write-Host "Future commits will run the guarded release flow: npm test -> GitHub push -> server update."
