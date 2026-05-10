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

function Push-GitHub {
  git push origin $Branch
  if ($LASTEXITCODE -eq 0) {
    return
  }

  Write-Warning "git push failed; falling back to GitHub API."
  $gh = Require-Command "gh"

  $head = (git rev-parse "HEAD").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read local HEAD."
  }
  $parent = (git rev-parse "HEAD^").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read local HEAD parent."
  }
  $headTree = (git rev-parse "HEAD^{tree}").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read local HEAD tree."
  }

  $remoteRef = & $gh api "repos/$GitHubRepo/git/ref/heads/$Branch" | ConvertFrom-Json
  $remoteSha = $remoteRef.object.sha
  if ($remoteSha -ne $parent) {
    throw "Remote $Branch moved to $remoteSha; expected local parent $parent."
  }

  $remoteTree = (& $gh api "repos/$GitHubRepo/git/commits/$remoteSha" | ConvertFrom-Json).tree.sha
  if ($remoteTree -eq $headTree) {
    Write-Host "GitHub already has the current tree at $remoteSha."
    return
  }

  $treeEntries = @()
  $files = git diff --name-only $parent $head
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

    $parts = $treeLine -split "\s+"
    $mode = $parts[0]
    $type = $parts[1]
    if ($type -ne "blob") {
      throw "GitHub API fallback only supports file blobs, got $type for $file"
    }

    $localPath = Join-Path $PWD.Path ($file -replace "/", [IO.Path]::DirectorySeparatorChar)
    $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($localPath))
    $blobBody = @{
      content = $content
      encoding = "base64"
    } | ConvertTo-Json -Depth 5 -Compress
    $blob = $blobBody | & $gh api "repos/$GitHubRepo/git/blobs" -X POST --input - | ConvertFrom-Json

    $treeEntries += @{
      path = $file
      mode = $mode
      type = $type
      sha = $blob.sha
    }
  }

  $newTreeBody = @{
    base_tree = $remoteTree
    tree = $treeEntries
  } | ConvertTo-Json -Depth 10 -Compress
  $newTree = $newTreeBody | & $gh api "repos/$GitHubRepo/git/trees" -X POST --input - | ConvertFrom-Json
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
  $newCommitBody = @{
    message = $message
    tree = $newTree.sha
    parents = @($remoteSha)
    author = $author
    committer = $committer
  } | ConvertTo-Json -Depth 10 -Compress
  $newCommit = $newCommitBody | & $gh api "repos/$GitHubRepo/git/commits" -X POST --input - | ConvertFrom-Json
  if ($newCommit.sha -ne $head) {
    throw "GitHub API commit $($newCommit.sha) does not match local HEAD $head."
  }

  $updateBody = @{
    sha = $newCommit.sha
    force = $false
  } | ConvertTo-Json -Depth 5 -Compress
  $updatedRef = $updateBody | & $gh api "repos/$GitHubRepo/git/refs/heads/$Branch" -X PATCH --input - | ConvertFrom-Json
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
