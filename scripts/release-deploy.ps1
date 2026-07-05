param(
  [string]$RemoteHost = "colipas-prod",
  [string]$RemoteUser = "colipas-deploy",
  [string]$RemoteCommand = "sudo /usr/local/sbin/colipas-update",
  [string]$Branch = "master",
  [string]$SshKey = "$env:USERPROFILE\.ssh\colipas_deploy_rsa",
  [string]$GitHubRepo = "nmklio/CoLiPas",
  [string]$TargetsFile = "release-targets.local.json",
  [string]$TargetsJson = "",
  [string]$ProductionBaseUrl = "https://colipas.example.com",
  [switch]$PlanOnly,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

$RepoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $RepoRoot) {
  throw "Unable to locate the git repository root."
}
Set-Location $RepoRoot
$script:PublishedCommitSha = ""
$script:TargetUpdateResults = @()
$script:SuccessfulDeployTargets = @()

function Run-Step {
  param(
    [string]$Title,
    [scriptblock]$Command
  )

  Write-Host "==> $Title"
  $global:LASTEXITCODE = 0
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

function Require-Command {
  param([string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command -and $Name -eq "gh") {
    $fallbackGh = "C:\Program Files\GitHub CLI\gh.exe"
    if (Test-Path $fallbackGh) {
      return $fallbackGh
    }
  }
  if (-not $command) {
    throw "Required command not found: $Name"
  }

  return $command.Source
}

function Invoke-ProductionBrowserValidation {
  param(
    [object]$Target,
    [int]$MaxAttempts = 3,
    [int]$RetryDelaySeconds = 8
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $env:PUBLIC_PAGES_BASE_URL = $Target.publicBaseUrl
    $env:PUBLIC_PAGES_MODE = $Target.publicMode
    try {
      node scripts/public-pages-check.mjs
      $validationExitCode = $LASTEXITCODE
      if ($validationExitCode -eq 0) {
        return
      }

      throw "public-pages-check exited with code $validationExitCode"
    } catch {
      if ($attempt -ge $MaxAttempts) {
        throw "Production browser validation failed for target $($Target.name) after $MaxAttempts attempts: $_"
      }

      Write-Warning "Production browser validation attempt $attempt/$MaxAttempts failed for target $($Target.name): $_"
      Start-Sleep -Seconds $RetryDelaySeconds
    } finally {
      Remove-Item Env:\PUBLIC_PAGES_BASE_URL -ErrorAction SilentlyContinue
      Remove-Item Env:\PUBLIC_PAGES_MODE -ErrorAction SilentlyContinue
      $global:LASTEXITCODE = 0
    }
  }
}

function Resolve-LocalPath {
  param([string]$Value)

  if (-not $Value) {
    return ""
  }

  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  if ($expanded -eq "~" -or $expanded.StartsWith("~/") -or $expanded.StartsWith("~\")) {
    return Join-Path $env:USERPROFILE $expanded.Substring(2)
  }

  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return $expanded
  }

  return Join-Path $RepoRoot $expanded
}

function Get-PropertyValue {
  param(
    [object]$Object,
    [string]$Name,
    [string]$Default = ""
  )

  if ($null -eq $Object) {
    return $Default
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Default
  }

  $value = [string]$property.Value
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $Default
  }

  return $value
}

function Get-PropertyBool {
  param(
    [object]$Object,
    [string]$Name,
    [bool]$Default = $false
  )

  if ($null -eq $Object) {
    return $Default
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Default
  }

  return [System.Convert]::ToBoolean($property.Value)
}

function ConvertTo-DeployTargets {
  param([object]$Config)

  $rawTargets = @()
  if ($null -ne $Config -and $null -ne $Config.PSObject.Properties["targets"]) {
    $rawTargets = @($Config.targets)
  } elseif ($null -ne $Config) {
    $rawTargets = @($Config)
  }

  $targets = @()
  foreach ($item in $rawTargets) {
    if (Get-PropertyBool $item "enabled" $true) {
      $hostName = Get-PropertyValue $item "host" $RemoteHost
      $userName = Get-PropertyValue $item "user" $RemoteUser
      $command = Get-PropertyValue $item "command" $RemoteCommand
      $targetName = Get-PropertyValue $item "name" $hostName

      if ([string]::IsNullOrWhiteSpace($hostName)) {
        throw "Release target '$targetName' is missing host."
      }
      if ([string]::IsNullOrWhiteSpace($userName)) {
        throw "Release target '$targetName' is missing user."
      }
      if ([string]::IsNullOrWhiteSpace($command)) {
        throw "Release target '$targetName' is missing command."
      }

      $targets += [pscustomobject]@{
        name = $targetName
        host = $hostName
        user = $userName
        command = $command
        sshKey = Get-PropertyValue $item "sshKey" $SshKey
        publicBaseUrl = Get-PropertyValue $item "publicBaseUrl" $ProductionBaseUrl
        publicMode = Get-PropertyValue $item "publicMode" "public"
        deploymentMode = Get-PropertyValue $item "deploymentMode" "systemd"
        skipPublicValidation = Get-PropertyBool $item "skipPublicValidation" $false
      }
    }
  }

  return @($targets)
}

function Get-DeployTargets {
  if (-not [string]::IsNullOrWhiteSpace($TargetsJson)) {
    return ConvertTo-DeployTargets ($TargetsJson | ConvertFrom-Json)
  }

  $resolvedTargetsFile = Resolve-LocalPath $TargetsFile
  if (Test-Path $resolvedTargetsFile) {
    return ConvertTo-DeployTargets (Get-Content -LiteralPath $resolvedTargetsFile -Raw | ConvertFrom-Json)
  }

  return ConvertTo-DeployTargets ([pscustomobject]@{
    name = $RemoteHost
    host = $RemoteHost
    user = $RemoteUser
    command = $RemoteCommand
    sshKey = $SshKey
    publicBaseUrl = $ProductionBaseUrl
    publicMode = "public"
    deploymentMode = "systemd"
  })
}

function Write-DeployPlan {
  param([object[]]$Targets)

  $Targets | ForEach-Object {
    [pscustomobject]@{
      name = $_.name
      host = $_.host
      user = $_.user
      command = $_.command
      sshKey = $_.sshKey
      publicBaseUrl = $_.publicBaseUrl
      publicMode = $_.publicMode
      deploymentMode = $_.deploymentMode
      skipPublicValidation = $_.skipPublicValidation
    }
  } | ConvertTo-Json -Depth 5
}

function Invoke-TargetUpdate {
  param([object]$Target)

  $sshArgs = @()
  $resolvedSshKey = Resolve-LocalPath $Target.sshKey
  if ($resolvedSshKey) {
    $sshArgs += @("-i", $resolvedSshKey, "-o", "IdentitiesOnly=yes")
  }
  $head = $script:PublishedCommitSha
  if ([string]::IsNullOrWhiteSpace($head)) {
    $head = (git rev-parse "HEAD").Trim()
  }
  if ($LASTEXITCODE -ne 0 -or -not $head) {
    throw "Unable to read local HEAD for deployment evidence."
  }
  $safeTargetName = ConvertTo-ShellSingleQuoted $Target.name
  $safeMode = ConvertTo-ShellSingleQuoted $Target.deploymentMode
  $safePublicUrl = ConvertTo-ShellSingleQuoted $Target.publicBaseUrl
  $safeCommit = ConvertTo-ShellSingleQuoted $head
  $safeArtifact = ConvertTo-ShellSingleQuoted "$($Target.name)-$Branch"
  $releaseEnv = "RELEASE_TARGET_NAME=$safeTargetName RELEASE_CHANNEL='production' RELEASE_DEPLOYMENT_MODE=$safeMode RELEASE_PUBLIC_URL=$safePublicUrl RELEASE_GIT_COMMIT=$safeCommit RELEASE_ARTIFACT_ID=$safeArtifact"
  $targetCommand = [string]$Target.command
  if ($targetCommand -match '^\s*sudo\s+(.+)$') {
    $evidenceCommand = "sudo env $releaseEnv $($Matches[1])"
  } else {
    $evidenceCommand = "$releaseEnv $targetCommand"
  }
  $sshArgs += @("-o", "StrictHostKeyChecking=accept-new", "$($Target.user)@$($Target.host)", $evidenceCommand)

  Write-Host "Updating target $($Target.name) via $($Target.host)."
  & ssh @sshArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Target $($Target.name) update failed with exit code $LASTEXITCODE."
  }
}

function Invoke-TargetUpdates {
  param([object[]]$Targets)

  $results = @()
  foreach ($target in $Targets) {
    try {
      Invoke-TargetUpdate $target
      $results += [pscustomobject]@{
        name = $target.name
        target = $target
        ok = $true
        error = ""
      }
    } catch {
      $message = [string]$_
      Write-Warning "Target $($target.name) update failed; continuing with remaining targets: $message"
      $global:LASTEXITCODE = 0
      $results += [pscustomobject]@{
        name = $target.name
        target = $target
        ok = $false
        error = $message
      }
    }
  }

  $script:TargetUpdateResults = @($results)
  $script:SuccessfulDeployTargets = @($results | Where-Object { $_.ok } | ForEach-Object { $_.target })

  if ($script:SuccessfulDeployTargets.Count -eq 0) {
    $failedNames = ($results | ForEach-Object { $_.name }) -join ", "
    throw "No server targets updated successfully. Failed targets: $failedNames"
  }
}

function Assert-NoTargetUpdateFailures {
  $failed = @($script:TargetUpdateResults | Where-Object { -not $_.ok })
  if ($failed.Count -eq 0) {
    return
  }

  $failedNames = ($failed | ForEach-Object { $_.name }) -join ", "
  throw "Release deploy finished with failed server targets: $failedNames"
}

function ConvertTo-ShellSingleQuoted {
  param([string]$Value)

  if ($null -eq $Value) {
    return "''"
  }

  return "'" + $Value.Replace("'", "'\''") + "'"
}

function Invoke-GhApiJson {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Method,
    [Parameter(Mandatory = $true)]
    [object]$Body
  )

  $gh = Require-Command "gh"
  $jsonPath = Join-Path ([IO.Path]::GetTempPath()) ("colipas-gh-api-" + [Guid]::NewGuid().ToString("N") + ".json")
  try {
    $json = $Body | ConvertTo-Json -Depth 20 -Compress
    [IO.File]::WriteAllText($jsonPath, $json, [Text.UTF8Encoding]::new($false))
    $response = & $gh api $Path -X $Method --input $jsonPath
    if ($LASTEXITCODE -ne 0) {
      throw "gh api $Method $Path failed."
    }

    if (-not $response) {
      throw "gh api $Method $Path returned an empty response."
    }

    return $response | ConvertFrom-Json
  } finally {
    Remove-Item -LiteralPath $jsonPath -Force -ErrorAction SilentlyContinue
  }
}

function Get-GitCommitTreeSha {
  param([string]$Revision)

  $tree = (git show -s --format=%T $Revision).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($tree) -or $tree -notmatch '^[0-9a-f]{40}$') {
    throw "Unable to read git tree for revision $Revision."
  }

  return $tree
}

function Get-GitBlobContentBase64 {
  param([string]$BlobSha)

  if ([string]::IsNullOrWhiteSpace($BlobSha) -or $BlobSha -notmatch '^[0-9a-f]{40}$') {
    throw "Invalid git blob sha: $BlobSha"
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo.FileName = "git"
  $process.StartInfo.Arguments = "cat-file blob $BlobSha"
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.CreateNoWindow = $true

  $memory = [IO.MemoryStream]::new()
  try {
    if (-not $process.Start()) {
      throw "Unable to start git cat-file for blob $BlobSha."
    }

    $process.StandardOutput.BaseStream.CopyTo($memory)
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "git cat-file blob $BlobSha failed: $stderr"
    }

    return [Convert]::ToBase64String($memory.ToArray())
  } finally {
    $memory.Dispose()
    $process.Dispose()
  }
}

function Test-GitHubApiJsonFallback {
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("colipas-release-selftest-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $mockGhPath = Join-Path $tempRoot "gh.cmd"
  $mockGhUnixPath = Join-Path $tempRoot "gh"
  $mockResponderPath = Join-Path $tempRoot "mock-gh-response.ps1"
  $capturePath = Join-Path $tempRoot "capture.json"
  $previousPath = $env:PATH
  $previousCapture = $env:COLIPAS_GH_SELFTEST_CAPTURE
  $previousResponder = $env:COLIPAS_GH_SELFTEST_RESPONDER

  try {
    @'
@echo off
setlocal EnableExtensions
if "%~1" NEQ "api" exit /b 21
set "input="
:loop
if "%~1"=="" goto done
if "%~1"=="--input" (
  set "input=%~2"
  shift
)
shift
goto loop
:done
if "%input%"=="" exit /b 22
powershell -NoProfile -ExecutionPolicy Bypass -File "%COLIPAS_GH_SELFTEST_RESPONDER%" "%input%"
'@ | Set-Content -LiteralPath $mockGhPath -Encoding ASCII
    @'
#!/usr/bin/env sh
if [ "$1" != "api" ]; then
  exit 21
fi

input=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--input" ]; then
    shift
    input="${1:-}"
  fi
  shift || true
done

if [ -z "$input" ]; then
  exit 22
fi

pwsh -NoProfile -ExecutionPolicy Bypass -File "$COLIPAS_GH_SELFTEST_RESPONDER" "$input"
'@ | Set-Content -LiteralPath $mockGhUnixPath -Encoding ASCII
    if (Get-Command chmod -ErrorAction SilentlyContinue) {
      & chmod +x $mockGhUnixPath
    }
    @'
param([string]$InputJsonPath)

$bytes = [IO.File]::ReadAllBytes($InputJsonPath)
if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
  exit 23
}

$json = [IO.File]::ReadAllText($InputJsonPath, [Text.UTF8Encoding]::new($false))
$body = $json | ConvertFrom-Json
[IO.File]::WriteAllText($env:COLIPAS_GH_SELFTEST_CAPTURE, $json, [Text.UTF8Encoding]::new($false))
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[pscustomobject]@{
  ok = $true
  sha = 'mock-sha'
  echo = $body.message
} | ConvertTo-Json -Compress
'@ | Set-Content -LiteralPath $mockResponderPath -Encoding UTF8

    $env:COLIPAS_GH_SELFTEST_CAPTURE = $capturePath
    $env:COLIPAS_GH_SELFTEST_RESPONDER = $mockResponderPath
    $env:PATH = "$tempRoot$([IO.Path]::PathSeparator)$previousPath"
    $result = Invoke-GhApiJson -Path "repos/example/repo/git/mock" -Method "POST" -Body @{
      message = "fallback-file-input"
      nested = @{
        value = 42
      }
    }

    if ($result.ok -ne $true -or $result.sha -ne "mock-sha" -or $result.echo -ne "fallback-file-input") {
      throw "GitHub API JSON fallback self-test returned unexpected response."
    }
    if (-not (Test-Path -LiteralPath $capturePath)) {
      throw "GitHub API JSON fallback self-test did not capture request body."
    }

    $capturedBytes = [IO.File]::ReadAllBytes($capturePath)
    if ($capturedBytes.Length -ge 3 -and $capturedBytes[0] -eq 239 -and $capturedBytes[1] -eq 187 -and $capturedBytes[2] -eq 191) {
      throw "GitHub API JSON fallback wrote a BOM-prefixed request body."
    }

    $captured = Get-Content -LiteralPath $capturePath -Raw | ConvertFrom-Json
    if ($captured.message -ne "fallback-file-input" -or $captured.nested.value -ne 42) {
      throw "GitHub API JSON fallback self-test captured an invalid request body."
    }

    $leftovers = Get-ChildItem -Path ([IO.Path]::GetTempPath()) -Filter "colipas-gh-api-*.json" -ErrorAction SilentlyContinue
    if ($leftovers | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-5) }) {
      throw "GitHub API JSON fallback left temporary request files behind."
    }

    Write-Host "ok release deploy GitHub API JSON fallback uses BOM-free temp-file input"
  } finally {
    $env:PATH = $previousPath
    if ($null -eq $previousCapture) {
      Remove-Item Env:\COLIPAS_GH_SELFTEST_CAPTURE -ErrorAction SilentlyContinue
    } else {
      $env:COLIPAS_GH_SELFTEST_CAPTURE = $previousCapture
    }
    if ($null -eq $previousResponder) {
      Remove-Item Env:\COLIPAS_GH_SELFTEST_RESPONDER -ErrorAction SilentlyContinue
    } else {
      $env:COLIPAS_GH_SELFTEST_RESPONDER = $previousResponder
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Test-TargetUpdateFailureIsolation {
  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("colipas-release-target-selftest-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  $mockSshPath = Join-Path $tempRoot "ssh.cmd"
  $mockSshUnixPath = Join-Path $tempRoot "ssh"
  $capturePath = Join-Path $tempRoot "ssh-calls.txt"
  $previousPath = $env:PATH
  $previousCapture = $env:COLIPAS_SSH_SELFTEST_CAPTURE
  $previousResults = $script:TargetUpdateResults
  $previousSuccessfulTargets = $script:SuccessfulDeployTargets

  try {
    @'
@echo off
echo %*>>"%COLIPAS_SSH_SELFTEST_CAPTURE%"
echo %* | findstr /C:"fail-host" >nul
if not errorlevel 1 exit /b 31
exit /b 0
'@ | Set-Content -LiteralPath $mockSshPath -Encoding ASCII
    @'
#!/usr/bin/env sh
printf '%s\n' "$*" >> "$COLIPAS_SSH_SELFTEST_CAPTURE"
case "$*" in
  *fail-host*) exit 31 ;;
  *) exit 0 ;;
esac
'@ | Set-Content -LiteralPath $mockSshUnixPath -Encoding ASCII
    if (Get-Command chmod -ErrorAction SilentlyContinue) {
      & chmod +x $mockSshUnixPath
    }

    $env:COLIPAS_SSH_SELFTEST_CAPTURE = $capturePath
    $env:PATH = "$tempRoot$([IO.Path]::PathSeparator)$previousPath"

    $targets = @(
      [pscustomobject]@{
        name = "fail-target"
        host = "fail-host"
        user = "mock-user"
        command = "mock-command"
        sshKey = ""
        publicBaseUrl = "https://fail.example.test"
        publicMode = "public"
        deploymentMode = "systemd"
        skipPublicValidation = $false
      },
      [pscustomobject]@{
        name = "ok-target"
        host = "ok-host"
        user = "mock-user"
        command = "mock-command"
        sshKey = ""
        publicBaseUrl = "https://ok.example.test"
        publicMode = "public"
        deploymentMode = "docker"
        skipPublicValidation = $false
      }
    )

    Invoke-TargetUpdates $targets
    if ($script:SuccessfulDeployTargets.Count -ne 1 -or $script:SuccessfulDeployTargets[0].name -ne "ok-target") {
      throw "Target update failure isolation did not preserve the successful target."
    }

    $captured = Get-Content -LiteralPath $capturePath -Raw
    if (-not $captured.Contains("fail-host") -or -not $captured.Contains("ok-host")) {
      throw "Target update failure isolation did not attempt every target."
    }

    $failureGuardRaised = $false
    try {
      Assert-NoTargetUpdateFailures
    } catch {
      $failureGuardRaised = $true
      if (-not ([string]$_).Contains("fail-target")) {
        throw "Target update failure guard did not include the failed target name."
      }
      $global:LASTEXITCODE = 0
    }
    if (-not $failureGuardRaised) {
      throw "Target update failure guard did not fail after a partial release."
    }

    Write-Host "ok release deploy continues updating healthy targets and reports partial failures"
  } finally {
    $env:PATH = $previousPath
    $script:TargetUpdateResults = $previousResults
    $script:SuccessfulDeployTargets = $previousSuccessfulTargets
    if ($null -eq $previousCapture) {
      Remove-Item Env:\COLIPAS_SSH_SELFTEST_CAPTURE -ErrorAction SilentlyContinue
    } else {
      $env:COLIPAS_SSH_SELFTEST_CAPTURE = $previousCapture
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}


function Push-GitHub {
  git push origin $Branch
  if ($LASTEXITCODE -eq 0) {
    $script:PublishedCommitSha = (git rev-parse "HEAD").Trim()
    return
  }

  Write-Warning "git push failed; falling back to GitHub API."
  $gh = Require-Command "gh"

  $head = (git rev-parse "HEAD").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read local HEAD."
  }
  $headTree = Get-GitCommitTreeSha "HEAD"

  $remoteRef = & $gh api "repos/$GitHubRepo/git/ref/heads/$Branch" | ConvertFrom-Json
  $remoteSha = $remoteRef.object.sha
  $remoteCommit = & $gh api "repos/$GitHubRepo/git/commits/$remoteSha" | ConvertFrom-Json
  $remoteTree = $remoteCommit.tree.sha
  if ($remoteTree -eq $headTree) {
    Write-Host "GitHub already has the current tree at $remoteSha."
    $script:PublishedCommitSha = $remoteSha
    $global:LASTEXITCODE = 0
    return
  }

  $baseCommit = $null
  $remoteCommitAvailable = $false
  try {
    $null = git cat-file -e "$remoteSha^{commit}" 2>$null
    $remoteCommitAvailable = $LASTEXITCODE -eq 0
  } catch {
    $remoteCommitAvailable = $false
    $global:LASTEXITCODE = 0
  }

  if ($remoteCommitAvailable) {
    git merge-base --is-ancestor $remoteSha $head
    if ($LASTEXITCODE -eq 0) {
      $baseCommit = $remoteSha
    } else {
      $global:LASTEXITCODE = 0
    }
  }

  if (-not $baseCommit) {
    Write-Warning "Remote $Branch commit $remoteSha is not available locally or is not a direct ancestor; matching by tree."
    $ancestors = git rev-list --first-parent $head
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to inspect local HEAD history."
    }

    foreach ($candidate in $ancestors) {
      $candidateTree = Get-GitCommitTreeSha $candidate
      if ($candidateTree -eq $remoteTree) {
        $baseCommit = $candidate
        break
      }
    }
  }

  if (-not $baseCommit) {
    throw "Remote $Branch tree $remoteTree does not match local HEAD history; refusing API fallback."
  }

  $treeEntries = @()
  $files = git diff --name-only $baseCommit $head
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to list changed files."
  }

  foreach ($file in $files) {
    $treeLine = git ls-tree $head -- $file
    if ($LASTEXITCODE -ne 0 -or -not $treeLine) {
      $treeEntries += @{
        path = $file
        mode = "100644"
        type = "blob"
        sha = $null
      }
      continue
    }

    $parts = $treeLine -split "\s+", 4
    $mode = $parts[0]
    $type = $parts[1]
    $blobSha = $parts[2]
    if ($type -ne "blob") {
      throw "GitHub API fallback only supports file blobs, got $type for $file"
    }

    $content = Get-GitBlobContentBase64 $blobSha
    $blob = Invoke-GhApiJson -Path "repos/$GitHubRepo/git/blobs" -Method "POST" -Body @{
      content = $content
      encoding = "base64"
    }

    $treeEntries += @{
      path = $file
      mode = $mode
      type = $type
      sha = $blob.sha
    }
  }

  $newTree = Invoke-GhApiJson -Path "repos/$GitHubRepo/git/trees" -Method "POST" -Body @{
    base_tree = $remoteTree
    tree = $treeEntries
  }
  if ($newTree.sha -ne $headTree) {
    throw "GitHub API tree $($newTree.sha) does not match local HEAD tree $headTree."
  }

  $message = ((git log -1 --pretty=%B) -join "`n").TrimEnd("`r", "`n")
  $author = @{
    name = (git show -s --format=%an HEAD).Trim()
    email = (git show -s --format=%ae HEAD).Trim()
    date = (git show -s --format=%aI HEAD).Trim()
  }
  $committer = @{
    name = (git show -s --format=%cn HEAD).Trim()
    email = (git show -s --format=%ce HEAD).Trim()
    date = (git show -s --format=%cI HEAD).Trim()
  }
  $newCommit = Invoke-GhApiJson -Path "repos/$GitHubRepo/git/commits" -Method "POST" -Body @{
    message = $message
    tree = $newTree.sha
    parents = @($remoteSha)
    author = $author
    committer = $committer
  }
  $updatedRef = Invoke-GhApiJson -Path "repos/$GitHubRepo/git/refs/heads/$Branch" -Method "PATCH" -Body @{
    sha = $newCommit.sha
    force = $false
  }
  if ($updatedRef.object.sha -ne $newCommit.sha) {
    throw "GitHub API ref update did not return expected commit."
  }

  $script:PublishedCommitSha = $newCommit.sha
  if ($newCommit.sha -eq $head) {
    git update-ref "refs/remotes/origin/$Branch" $head
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to align origin/$Branch to the GitHub API published HEAD."
    }

    Write-Host "GitHub API pushed local HEAD $head."
    return
  }

  Write-Warning "GitHub API produced commit $($newCommit.sha) for local HEAD $head. The tree matches, so aligning the local branch to the published ref."
  git fetch origin $Branch
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Unable to fetch published GitHub API commit; continuing because GitHub ref already points to a matching tree."
    $global:LASTEXITCODE = 0
    return
  }

  $publishedTree = Get-GitCommitTreeSha "origin/$Branch"
  if ($publishedTree -ne $headTree) {
    throw "Published GitHub tree $publishedTree does not match local HEAD tree $headTree."
  }

  git update-ref "refs/heads/$Branch" "origin/$Branch"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to align local $Branch to origin/$Branch."
  }

  Write-Host "GitHub API pushed $($newCommit.sha)."
}

$DeployTargets = @(Get-DeployTargets)
if ($DeployTargets.Count -eq 0) {
  throw "No release deploy targets are enabled."
}

if ($SelfTest) {
  Test-GitHubApiJsonFallback
  Test-TargetUpdateFailureIsolation
  exit 0
}

if ($PlanOnly) {
  Write-DeployPlan $DeployTargets
  exit 0
}

Run-Step "Local grey test" {
  npm test
}

Run-Step "Git status guard" {
  $status = git status --porcelain
  if ($status) {
    throw "Working tree has uncommitted changes. Commit them before release deploy."
  }
}

Run-Step "Sensitive data guard" {
  node scripts/secret-scan.mjs
}

Run-Step "Push GitHub" {
  Push-GitHub
}

Run-Step "Update server targets" {
  Invoke-TargetUpdates $DeployTargets
}

Run-Step "Production target browser validation" {
  foreach ($target in $script:SuccessfulDeployTargets) {
    if ($target.skipPublicValidation) {
      Write-Host "Skipping browser validation for target $($target.name)."
      continue
    }
    if ([string]::IsNullOrWhiteSpace($target.publicBaseUrl)) {
      Write-Host "Skipping browser validation for target $($target.name): no publicBaseUrl."
      continue
    }

    Write-Host "Validating $($target.name) at $($target.publicBaseUrl) in $($target.publicMode) mode."
    Invoke-ProductionBrowserValidation -Target $target
  }
}

Run-Step "Server target failure guard" {
  Assert-NoTargetUpdateFailures
}

Write-Host "CoLiPas cloud server management panel release deploy completed."
