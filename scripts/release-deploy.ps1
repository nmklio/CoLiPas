param(
  [string]$RemoteHost = "colipas-prod",
  [string]$RemoteUser = "colipas-deploy",
  [string]$RemoteCommand = "sudo /usr/local/sbin/colipas-update",
  [string]$Branch = "master",
  [string]$SshKey = "$env:USERPROFILE\.ssh\colipas_deploy_rsa",
  [string]$GitHubRepo = "nmklio/CoLiPas"
)

$ErrorActionPreference = "Stop"

function Run-Step {
  param(
    [string]$Title,
    [scriptblock]$Command
  )

  Write-Host "==> $Title"
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

function Require-Command {
  param([string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Required command not found: $Name"
  }
}

function Push-GitHub {
  git push origin $Branch
  if ($LASTEXITCODE -eq 0) {
    return
  }

  Write-Warning "git push failed; falling back to GitHub API."
  Require-Command "gh"

  $headTree = (git rev-parse "HEAD^{tree}").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read local HEAD tree."
  }

  $remoteRef = gh api "repos/$GitHubRepo/git/ref/heads/$Branch" | ConvertFrom-Json
  $remoteSha = $remoteRef.object.sha
  $remoteTree = (gh api "repos/$GitHubRepo/git/commits/$remoteSha" | ConvertFrom-Json).tree.sha
  if ($remoteTree -eq $headTree) {
    Write-Host "GitHub already has the current tree at $remoteSha."
    return
  }

  $treeEntries = @()
  $files = git ls-files
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to list tracked files."
  }

  foreach ($file in $files) {
    $blobSha = (git rev-parse "HEAD:$file").Trim()
    if ($LASTEXITCODE -ne 0) {
      throw "Unable to read tracked file blob: $file"
    }
    $mode = "100644"
    if ((git ls-files -s -- $file) -match "^(?<mode>\d{6})\s") {
      $mode = $Matches.mode
    }
    $treeEntries += @{
      path = $file
      mode = $mode
      type = "blob"
      sha = $blobSha
    }
  }

  $newTreeBody = @{
    base_tree = $remoteTree
    tree = $treeEntries
  } | ConvertTo-Json -Depth 10
  $newTree = $newTreeBody | gh api "repos/$GitHubRepo/git/trees" -X POST --input - | ConvertFrom-Json

  $message = (git log -1 --pretty=%s).Trim()
  $newCommitBody = @{
    message = $message
    tree = $newTree.sha
    parents = @($remoteSha)
  } | ConvertTo-Json -Depth 10
  $newCommit = $newCommitBody | gh api "repos/$GitHubRepo/git/commits" -X POST --input - | ConvertFrom-Json

  $updateBody = @{
    sha = $newCommit.sha
    force = $false
  } | ConvertTo-Json -Depth 5
  $updatedRef = $updateBody | gh api "repos/$GitHubRepo/git/refs/heads/$Branch" -X PATCH --input - | ConvertFrom-Json
  if ($updatedRef.object.sha -ne $newCommit.sha) {
    throw "GitHub API ref update did not return expected commit."
  }

  Write-Host "GitHub API pushed $($newCommit.sha)."
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

Run-Step "Push GitHub" {
  Push-GitHub
}

Run-Step "Update server" {
  ssh -i $SshKey -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$RemoteUser@$RemoteHost" $RemoteCommand
}

Write-Host "CoLiPas release deploy completed."
