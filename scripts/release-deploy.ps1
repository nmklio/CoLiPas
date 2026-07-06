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
$script:TargetHealthResults = @()
$script:DefaultTargetUpdateAttempts = 2
$script:DefaultTargetUpdateRetryDelaySeconds = 15
$script:DefaultHealthCommitValidationAttempts = 6
$script:DefaultHealthCommitValidationRetryDelaySeconds = 5

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

function Join-UrlPath {
  param(
    [string]$BaseUrl,
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    return ""
  }

  return "$($BaseUrl.TrimEnd('/'))/$($Path.TrimStart('/'))"
}

function Get-HealthGitCommit {
  param([object]$Health)

  if ($null -eq $Health -or $null -eq $Health.PSObject.Properties["release"]) {
    return ""
  }

  $release = $Health.release
  if ($null -eq $release -or $null -eq $release.PSObject.Properties["gitCommit"]) {
    return ""
  }

  return [string]$release.gitCommit
}

function Test-HealthCommitMatches {
  param(
    [object]$Health,
    [string]$ExpectedCommit
  )

  $actualCommit = Get-HealthGitCommit $Health
  if ([string]::IsNullOrWhiteSpace($actualCommit) -or [string]::IsNullOrWhiteSpace($ExpectedCommit)) {
    return $false
  }
  if ($actualCommit -notmatch '^[0-9a-fA-F]{7,40}$' -or $ExpectedCommit -notmatch '^[0-9a-fA-F]{7,40}$') {
    return $false
  }

  return $ExpectedCommit.StartsWith($actualCommit, [StringComparison]::OrdinalIgnoreCase) -or $actualCommit.StartsWith($ExpectedCommit, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-TargetHealthCommitValidation {
  param(
    [object]$Target,
    [string]$ExpectedCommit,
    [int]$MaxAttempts = $script:DefaultHealthCommitValidationAttempts,
    [int]$RetryDelaySeconds = $script:DefaultHealthCommitValidationRetryDelaySeconds
  )

  if ([string]::IsNullOrWhiteSpace($Target.publicBaseUrl)) {
    Write-Host "Skipping health commit validation for target $($Target.name): no publicBaseUrl."
    return
  }

  $healthUrl = Join-UrlPath $Target.publicBaseUrl "/api/health"
  $lastError = ""
  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 20 -Headers @{
        "Cache-Control" = "no-cache"
        "Pragma" = "no-cache"
      }
      if ($health.status -ne "ok") {
        throw "Health endpoint status was '$($health.status)' instead of 'ok'."
      }

      $actualCommit = Get-HealthGitCommit $health
      if (-not (Test-HealthCommitMatches -Health $health -ExpectedCommit $ExpectedCommit)) {
        throw "Health endpoint commit '$actualCommit' does not match published commit '$($ExpectedCommit.Substring(0, [Math]::Min(12, $ExpectedCommit.Length)))'."
      }

      $script:TargetHealthResults += [pscustomobject]@{
        name = $Target.name
        ok = $true
        publicBaseUrl = $Target.publicBaseUrl
        gitCommit = $actualCommit
        attempts = $attempt
        error = ""
      }
      Write-Host "Target $($Target.name) health commit verified: $actualCommit."
      return
    } catch {
      $lastError = [string]$_
      $global:LASTEXITCODE = 0
      if ($attempt -lt $MaxAttempts) {
        Write-Warning "Health commit validation attempt $attempt/$MaxAttempts failed for target $($Target.name): $lastError"
        if ($RetryDelaySeconds -gt 0) {
          Start-Sleep -Seconds $RetryDelaySeconds
        }
        continue
      }
    }
  }

  $script:TargetHealthResults += [pscustomobject]@{
    name = $Target.name
    ok = $false
    publicBaseUrl = $Target.publicBaseUrl
    gitCommit = ""
    attempts = $MaxAttempts
    error = $lastError
  }
  throw "Health commit validation failed for target $($Target.name) after $MaxAttempts attempts: $lastError"
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

function Get-PropertyInt {
  param(
    [object]$Object,
    [string[]]$Names,
    [int]$Default = 0
  )

  foreach ($name in $Names) {
    $rawValue = Get-PropertyValue $Object $name ""
    if ([string]::IsNullOrWhiteSpace($rawValue)) {
      continue
    }

    $parsedValue = 0
    if (-not [int]::TryParse($rawValue, [ref]$parsedValue)) {
      throw "Release target field '$name' must be an integer."
    }
    if ($parsedValue -lt 1 -or $parsedValue -gt 65535) {
      throw "Release target field '$name' must be between 1 and 65535."
    }
    return $parsedValue
  }

  return $Default
}

function Get-PropertyIntRange {
  param(
    [object]$Object,
    [string[]]$Names,
    [int]$Default,
    [int]$Min,
    [int]$Max
  )

  foreach ($name in $Names) {
    if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$name]) {
      continue
    }

    $rawValue = [string]$Object.$name
    if ([string]::IsNullOrWhiteSpace($rawValue)) {
      continue
    }

    $parsedValue = 0
    if (-not [int]::TryParse($rawValue, [ref]$parsedValue)) {
      throw "Release target field '$name' must be an integer."
    }
    if ($parsedValue -lt $Min -or $parsedValue -gt $Max) {
      throw "Release target field '$name' must be between $Min and $Max."
    }
    return $parsedValue
  }

  return $Default
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
        sshPort = Get-PropertyInt $item @("sshPort", "port") 0
        publicBaseUrl = Get-PropertyValue $item "publicBaseUrl" $ProductionBaseUrl
        publicMode = Get-PropertyValue $item "publicMode" "public"
        deploymentMode = Get-PropertyValue $item "deploymentMode" "systemd"
        skipPublicValidation = Get-PropertyBool $item "skipPublicValidation" $false
        updateAttempts = Get-PropertyIntRange $item @("updateAttempts", "retryAttempts") $script:DefaultTargetUpdateAttempts 1 5
        retryDelaySeconds = Get-PropertyIntRange $item @("retryDelaySeconds", "updateRetryDelaySeconds") $script:DefaultTargetUpdateRetryDelaySeconds 0 300
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
    sshPort = 0
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
      sshKeyConfigured = -not [string]::IsNullOrWhiteSpace($_.sshKey)
      publicBaseUrl = $_.publicBaseUrl
      publicMode = $_.publicMode
      deploymentMode = $_.deploymentMode
      skipPublicValidation = $_.skipPublicValidation
      updateAttempts = $_.updateAttempts
      retryDelaySeconds = $_.retryDelaySeconds
    }
  } | ConvertTo-Json -Depth 5
}

function Get-SshFailureHint {
  param(
    [int]$ExitCode,
    [string[]]$OutputLines
  )

  $combined = (($OutputLines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "`n")
  if ($combined -match '(?i)connection refused') {
    return "SSH transport failed: connection refused. The target host was reachable, but the SSH port is closed or sshd/firewall is rejecting it."
  }
  if ($combined -match '(?i)(connection timed out|operation timed out|timed out|no route to host|network is unreachable)') {
    return "SSH transport failed: network timeout or route problem. Check DNS, security group/firewall rules, and whether the configured SSH port is reachable."
  }
  if ($combined -match '(?i)(permission denied|authentication failed|too many authentication failures|publickey|password)') {
    return "SSH authentication failed. Check the deploy user, key, authorized_keys, and whether the target allows this authentication method."
  }
  if ($combined -match '(?i)(could not resolve hostname|name or service not known|temporary failure in name resolution|nodename nor servname provided)') {
    return "SSH host resolution failed. Check the release target host alias or DNS record."
  }
  if ($combined -match '(?i)(host key verification failed|remote host identification has changed|offending .*key)') {
    return "SSH host-key verification failed. Check known_hosts for a changed or stale host key before retrying."
  }
  if ($combined -match '(?i)(command not found|no such file or directory|not found)') {
    return "Remote update command failed before deployment. Check that the configured update script exists and is executable on the target."
  }
  if ($ExitCode -eq 255) {
    return "SSH transport failed with exit code 255. Check connectivity, host alias, SSH daemon, firewall, and deploy credentials."
  }

  return "Remote update command failed with exit code $ExitCode. Check the target update script logs on the server."
}

function Invoke-SshWithDiagnostics {
  param(
    [string]$TargetName,
    [string]$TargetHost,
    [string[]]$SshArgs
  )

  $capturedLines = [Collections.Generic.List[string]]::new()
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & ssh @SshArgs 2>&1 | ForEach-Object {
      $line = [string]$_
      $capturedLines.Add($line)
      Write-Host $line
    }
    $sshExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($sshExitCode -ne 0) {
    $hint = Get-SshFailureHint -ExitCode $sshExitCode -OutputLines $capturedLines.ToArray()
    throw "Target $TargetName update failed with exit code $sshExitCode. $hint Target host: $TargetHost."
  }
}

function Invoke-TargetUpdate {
  param([object]$Target)

  $sshArgs = @()
  $resolvedSshKey = Resolve-LocalPath $Target.sshKey
  if ($resolvedSshKey) {
    $sshArgs += @("-i", $resolvedSshKey, "-o", "IdentitiesOnly=yes")
  }
  if ($Target.sshPort -and [int]$Target.sshPort -gt 0) {
    $sshArgs += @("-p", ([string][int]$Target.sshPort))
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
  Invoke-SshWithDiagnostics -TargetName $Target.name -TargetHost $Target.host -SshArgs $sshArgs
}

function Invoke-TargetUpdateWithRetry {
  param([object]$Target)

  $maxAttempts = [int]$Target.updateAttempts
  if ($maxAttempts -lt 1) {
    $maxAttempts = $script:DefaultTargetUpdateAttempts
  }
  $retryDelaySeconds = [int]$Target.retryDelaySeconds
  if ($retryDelaySeconds -lt 0) {
    $retryDelaySeconds = $script:DefaultTargetUpdateRetryDelaySeconds
  }

  $lastError = ""
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      if ($maxAttempts -gt 1) {
        Write-Host "Target $($Target.name) update attempt $attempt/$maxAttempts."
      }
      Invoke-TargetUpdate $Target
      return [pscustomobject]@{
        name = $Target.name
        target = $Target
        ok = $true
        error = ""
        attempts = $attempt
      }
    } catch {
      $lastError = [string]$_
      $global:LASTEXITCODE = 0
      if ($attempt -lt $maxAttempts) {
        Write-Warning "Target $($Target.name) update attempt $attempt/$maxAttempts failed; retrying: $lastError"
        if ($retryDelaySeconds -gt 0) {
          Start-Sleep -Seconds $retryDelaySeconds
        }
        continue
      }
    }
  }

  return [pscustomobject]@{
    name = $Target.name
    target = $Target
    ok = $false
    error = $lastError
    attempts = $maxAttempts
  }
}

function Invoke-TargetUpdates {
  param([object[]]$Targets)

  $results = @()
  foreach ($target in $Targets) {
    $result = Invoke-TargetUpdateWithRetry $target
    if (-not $result.ok) {
      Write-Warning "Target $($target.name) update failed after $($result.attempts) attempt(s); continuing with remaining targets: $($result.error)"
    }
    $results += $result
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

function ConvertTo-GitCommitIdentity {
  param([object]$Identity)

  if ($null -eq $Identity) {
    throw "Git commit identity is missing."
  }

  $name = [string]$Identity.name
  $email = [string]$Identity.email
  $dateText = [string]$Identity.date
  if ([string]::IsNullOrWhiteSpace($name) -or $name.Contains("`n") -or $name.Contains("<") -or $name.Contains(">")) {
    throw "Invalid git commit identity name."
  }
  if ([string]::IsNullOrWhiteSpace($email) -or $email.Contains("`n") -or $email.Contains("<") -or $email.Contains(">")) {
    throw "Invalid git commit identity email."
  }

  $date = [DateTimeOffset]::Parse($dateText, [Globalization.CultureInfo]::InvariantCulture)
  $totalOffsetMinutes = [int][Math]::Abs($date.Offset.TotalMinutes)
  $sign = if ($date.Offset.TotalMinutes -lt 0) { "-" } else { "+" }
  $offsetHours = [Math]::Floor($totalOffsetMinutes / 60)
  $offsetMinutes = $totalOffsetMinutes % 60
  $offsetText = "{0}{1:00}{2:00}" -f $sign, $offsetHours, $offsetMinutes

  return "$name <$email> $($date.ToUnixTimeSeconds()) $offsetText"
}

function New-GitCommitObjectPayload {
  param(
    [string]$TreeSha,
    [string[]]$ParentShas,
    [object]$Author,
    [object]$Committer,
    [string]$Message
  )

  if ([string]::IsNullOrWhiteSpace($TreeSha) -or $TreeSha -notmatch '^[0-9a-f]{40}$') {
    throw "Invalid git tree sha: $TreeSha"
  }

  $lines = @("tree $TreeSha")
  foreach ($parent in $ParentShas) {
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -notmatch '^[0-9a-f]{40}$') {
      throw "Invalid git parent sha: $parent"
    }
    $lines += "parent $parent"
  }
  $lines += "author $(ConvertTo-GitCommitIdentity $Author)"
  $lines += "committer $(ConvertTo-GitCommitIdentity $Committer)"

  return (($lines -join "`n") + "`n`n" + $Message)
}

function Import-GitHubApiCommitObject {
  param(
    [string]$CommitSha,
    [string]$TreeSha,
    [string[]]$ParentShas,
    [object]$Author,
    [object]$Committer,
    [string]$Message
  )

  $payload = New-GitCommitObjectPayload -TreeSha $TreeSha -ParentShas $ParentShas -Author $Author -Committer $Committer -Message $Message
  $commitPath = Join-Path ([IO.Path]::GetTempPath()) ("colipas-gh-commit-" + [Guid]::NewGuid().ToString("N") + ".txt")
  try {
    [IO.File]::WriteAllText($commitPath, $payload, [Text.UTF8Encoding]::new($false))
    $writtenSha = (git hash-object -t commit -w $commitPath).Trim()
    if ($LASTEXITCODE -ne 0 -or $writtenSha -ne $CommitSha) {
      throw "Imported GitHub API commit object $writtenSha did not match expected $CommitSha."
    }

    return $writtenSha
  } finally {
    Remove-Item -LiteralPath $commitPath -Force -ErrorAction SilentlyContinue
  }
}

function Get-GitObjectSha1 {
  param(
    [string]$Type,
    [byte[]]$Payload
  )

  $header = [Text.UTF8Encoding]::new($false).GetBytes("$Type $($Payload.Length)`0")
  $combined = [byte[]]::new($header.Length + $Payload.Length)
  [Array]::Copy($header, 0, $combined, 0, $header.Length)
  [Array]::Copy($Payload, 0, $combined, $header.Length, $Payload.Length)
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try {
    $hash = $sha1.ComputeHash($combined)
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $sha1.Dispose()
  }
}

function Test-GitHubApiCommitObjectImport {
  $tree = Get-GitCommitTreeSha "HEAD"
  $parent = (git rev-parse "HEAD").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($parent)) {
    throw "Unable to read HEAD for GitHub API commit object import self-test."
  }

  $author = [pscustomobject]@{
    name = "CoLiPas Builder"
    email = "colipas@example.local"
    date = "2026-07-05T23:45:46+08:00"
  }
  $committer = [pscustomobject]@{
    name = "CoLiPas Builder"
    email = "colipas@example.local"
    date = "2026-07-05T23:45:46+08:00"
  }
  $message = "release-selftest-no-trailing-newline"
  $payload = New-GitCommitObjectPayload -TreeSha $tree -ParentShas @($parent) -Author $author -Committer $committer -Message $message
  $payloadBytes = [Text.UTF8Encoding]::new($false).GetBytes($payload)
  $expectedSha = Get-GitObjectSha1 -Type "commit" -Payload $payloadBytes
  $writtenSha = Import-GitHubApiCommitObject -CommitSha $expectedSha -TreeSha $tree -ParentShas @($parent) -Author $author -Committer $committer -Message $message

  git cat-file -e "$writtenSha^{commit}"
  if ($LASTEXITCODE -ne 0) {
    throw "Imported GitHub API commit object is not readable by git."
  }

  Write-Host "ok release deploy imports GitHub API commit objects when fetch is unavailable"
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
  $flakyMarkerPath = Join-Path $tempRoot "flaky-marker.txt"
  $previousPath = $env:PATH
  $previousCapture = $env:COLIPAS_SSH_SELFTEST_CAPTURE
  $previousFlakyMarker = $env:COLIPAS_SSH_SELFTEST_FLAKY_MARKER
  $previousResults = $script:TargetUpdateResults
  $previousSuccessfulTargets = $script:SuccessfulDeployTargets

  try {
    @'
@echo off
echo %*>>"%COLIPAS_SSH_SELFTEST_CAPTURE%"
echo %* | findstr /C:"flaky-host" >nul
if not errorlevel 1 (
  if not exist "%COLIPAS_SSH_SELFTEST_FLAKY_MARKER%" (
    echo first>"%COLIPAS_SSH_SELFTEST_FLAKY_MARKER%"
    echo fatal: unable to access repository: Failed to connect to github.com port 443 1>&2
    exit /b 128
  )
)
echo %* | findstr /C:"fail-host" >nul
if not errorlevel 1 (
  echo ssh: connect to host fail-host port 22: Connection refused 1>&2
  exit /b 255
)
exit /b 0
'@ | Set-Content -LiteralPath $mockSshPath -Encoding ASCII
    @'
#!/usr/bin/env sh
printf '%s\n' "$*" >> "$COLIPAS_SSH_SELFTEST_CAPTURE"
case "$*" in
  *flaky-host*) if [ ! -f "$COLIPAS_SSH_SELFTEST_FLAKY_MARKER" ]; then printf first > "$COLIPAS_SSH_SELFTEST_FLAKY_MARKER"; printf '%s\n' 'fatal: unable to access repository: Failed to connect to github.com port 443' >&2; exit 128; fi ;;
  *fail-host*) printf '%s\n' 'ssh: connect to host fail-host port 22: Connection refused' >&2; exit 255 ;;
  *) exit 0 ;;
esac
'@ | Set-Content -LiteralPath $mockSshUnixPath -Encoding ASCII
    if (Get-Command chmod -ErrorAction SilentlyContinue) {
      & chmod +x $mockSshUnixPath
    }

    $env:COLIPAS_SSH_SELFTEST_CAPTURE = $capturePath
    $env:COLIPAS_SSH_SELFTEST_FLAKY_MARKER = $flakyMarkerPath
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
        updateAttempts = 2
        retryDelaySeconds = 0
      },
      [pscustomobject]@{
        name = "flaky-target"
        host = "flaky-host"
        user = "mock-user"
        command = "mock-command"
        sshKey = ""
        publicBaseUrl = "https://flaky.example.test"
        publicMode = "public"
        deploymentMode = "systemd"
        skipPublicValidation = $false
        updateAttempts = 2
        retryDelaySeconds = 0
      },
      [pscustomobject]@{
        name = "ok-target"
        host = "ok-host"
        user = "mock-user"
        command = "mock-command"
        sshKey = ""
        sshPort = 22674
        publicBaseUrl = "https://ok.example.test"
        publicMode = "public"
        deploymentMode = "docker"
        skipPublicValidation = $false
        updateAttempts = 1
        retryDelaySeconds = 0
      }
    )

    Invoke-TargetUpdates $targets
    $successfulNames = @($script:SuccessfulDeployTargets | ForEach-Object { $_.name })
    if ($script:SuccessfulDeployTargets.Count -ne 2 -or -not $successfulNames.Contains("flaky-target") -or -not $successfulNames.Contains("ok-target")) {
      throw "Target update failure isolation did not preserve the successful target."
    }

    $captured = Get-Content -LiteralPath $capturePath -Raw
    if (-not $captured.Contains("fail-host") -or -not $captured.Contains("flaky-host") -or -not $captured.Contains("ok-host")) {
      throw "Target update failure isolation did not attempt every target."
    }
    if (([regex]::Matches($captured, "fail-host")).Count -ne 2 -or ([regex]::Matches($captured, "flaky-host")).Count -ne 2) {
      throw "Target update retry attempts were not recorded for failed and flaky targets."
    }
    if (-not $captured.Contains("-p 22674")) {
      throw "Target update did not pass the configured SSH port."
    }

    $failedResults = @($script:TargetUpdateResults | Where-Object { -not $_.ok })
    if ($failedResults.Count -ne 1) {
      throw "Target update failure isolation did not record exactly one failed target."
    }
    if ([int]$failedResults[0].attempts -ne 2) {
      throw "Target update failure isolation did not retain failed attempt evidence."
    }
    if (
      -not ([string]$failedResults[0].error).Contains("SSH transport failed: connection refused") -or
      -not ([string]$failedResults[0].error).Contains("Target host: fail-host")
    ) {
      throw "Target update diagnostics did not explain the SSH connection-refused failure."
    }
    $flakyResult = @($script:TargetUpdateResults | Where-Object { $_.name -eq "flaky-target" })[0]
    if (-not $flakyResult.ok -or [int]$flakyResult.attempts -ne 2) {
      throw "Target update retry did not recover a transiently failing target."
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

    Write-Host "ok release deploy retries transient target updates, preserves healthy targets, and reports partial failures"
  } finally {
    $env:PATH = $previousPath
    $script:TargetUpdateResults = $previousResults
    $script:SuccessfulDeployTargets = $previousSuccessfulTargets
    if ($null -eq $previousCapture) {
      Remove-Item Env:\COLIPAS_SSH_SELFTEST_CAPTURE -ErrorAction SilentlyContinue
    } else {
      $env:COLIPAS_SSH_SELFTEST_CAPTURE = $previousCapture
    }
    if ($null -eq $previousFlakyMarker) {
      Remove-Item Env:\COLIPAS_SSH_SELFTEST_FLAKY_MARKER -ErrorAction SilentlyContinue
    } else {
      $env:COLIPAS_SSH_SELFTEST_FLAKY_MARKER = $previousFlakyMarker
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Test-TargetHealthCommitValidation {
  $expectedCommit = "abcdef1234567890abcdef1234567890abcdef12"
  $matchingHealth = [pscustomobject]@{
    status = "ok"
    release = [pscustomobject]@{
      gitCommit = "abcdef123456"
    }
  }
  $fullHealth = [pscustomobject]@{
    status = "ok"
    release = [pscustomobject]@{
      gitCommit = $expectedCommit
    }
  }
  $staleHealth = [pscustomobject]@{
    status = "ok"
    release = [pscustomobject]@{
      gitCommit = "111111111111"
    }
  }
  $missingHealth = [pscustomobject]@{
    status = "ok"
  }

  if ((Join-UrlPath "https://example.test/" "/api/health") -ne "https://example.test/api/health") {
    throw "Health validation URL join did not normalize duplicate slashes."
  }
  if (-not (Test-HealthCommitMatches -Health $matchingHealth -ExpectedCommit $expectedCommit)) {
    throw "Health commit validation did not accept a target commit prefix."
  }
  if (-not (Test-HealthCommitMatches -Health $fullHealth -ExpectedCommit $expectedCommit)) {
    throw "Health commit validation did not accept an exact target commit."
  }
  if (Test-HealthCommitMatches -Health $staleHealth -ExpectedCommit $expectedCommit) {
    throw "Health commit validation did not reject a stale target commit."
  }
  if (Test-HealthCommitMatches -Health $missingHealth -ExpectedCommit $expectedCommit) {
    throw "Health commit validation did not reject missing release evidence."
  }

  Write-Host "ok release deploy validates production health commits and detects target drift"
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
    Write-Warning "Unable to fetch published GitHub API commit; importing the API-created commit object locally."
    $global:LASTEXITCODE = 0
    $null = Import-GitHubApiCommitObject -CommitSha $newCommit.sha -TreeSha $newTree.sha -ParentShas @($remoteSha) -Author $author -Committer $committer -Message $message
    git update-ref "refs/remotes/origin/$Branch" $newCommit.sha
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to align origin/$Branch to imported GitHub API commit."
    }
  } else {
    $publishedTree = Get-GitCommitTreeSha "origin/$Branch"
    if ($publishedTree -ne $headTree) {
      throw "Published GitHub tree $publishedTree does not match local HEAD tree $headTree."
    }
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
  Test-GitHubApiCommitObjectImport
  Test-TargetUpdateFailureIsolation
  Test-TargetHealthCommitValidation
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

Run-Step "Production target health commit validation" {
  $expectedCommit = $script:PublishedCommitSha
  if ([string]::IsNullOrWhiteSpace($expectedCommit)) {
    $expectedCommit = (git rev-parse "HEAD").Trim()
  }
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($expectedCommit)) {
    throw "Unable to read expected deployment commit for production health validation."
  }

  foreach ($target in $script:SuccessfulDeployTargets) {
    Invoke-TargetHealthCommitValidation -Target $target -ExpectedCommit $expectedCommit
  }
}

Run-Step "Server target failure guard" {
  Assert-NoTargetUpdateFailures
}

Write-Host "CoLiPas cloud server management panel release deploy completed."
