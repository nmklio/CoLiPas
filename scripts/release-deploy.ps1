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
  $headTree = (git rev-parse "HEAD^{tree}").Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read local HEAD tree."
  }

  $remoteRef = & $gh api "repos/$GitHubRepo/git/ref/heads/$Branch" | ConvertFrom-Json
  $remoteSha = $remoteRef.object.sha
  $remoteCommit = & $gh api "repos/$GitHubRepo/git/commits/$remoteSha" | ConvertFrom-Json
  $remoteTree = $remoteCommit.tree.sha
  if ($remoteTree -eq $headTree) {
    Write-Host "GitHub already has the current tree at $remoteSha."
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
      $candidateTree = (git rev-parse "$candidate^{tree}").Trim()
      if ($LASTEXITCODE -eq 0 -and $candidateTree -eq $remoteTree) {
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
  $updateBody = @{
    sha = $newCommit.sha
    force = $false
  } | ConvertTo-Json -Depth 5 -Compress
  $updatedRef = $updateBody | & $gh api "repos/$GitHubRepo/git/refs/heads/$Branch" -X PATCH --input - | ConvertFrom-Json
  if ($updatedRef.object.sha -ne $newCommit.sha) {
    throw "GitHub API ref update did not return expected commit."
  }

  Write-Warning "GitHub API produced commit $($newCommit.sha) for local HEAD $head. The tree matches, so aligning the local branch to the published ref."
  git fetch origin $Branch
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Unable to fetch published GitHub API commit; continuing because GitHub ref already points to a matching tree."
    $global:LASTEXITCODE = 0
    return
  }

  $publishedTree = (git rev-parse "origin/$Branch^{tree}").Trim()
  if ($LASTEXITCODE -ne 0 -or $publishedTree -ne $headTree) {
    throw "Published GitHub tree $publishedTree does not match local HEAD tree $headTree."
  }

  git update-ref "refs/heads/$Branch" "origin/$Branch"
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to align local $Branch to origin/$Branch."
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

Run-Step "Sensitive data guard" {
  node scripts/secret-scan.mjs
}

Run-Step "Push GitHub" {
  Push-GitHub
}

Run-Step "Update server" {
  ssh -i $SshKey -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$RemoteUser@$RemoteHost" $RemoteCommand
}

Run-Step "Production public page browser validation" {
  $env:PUBLIC_PAGES_BASE_URL = "https://c.miao7777.com"
  $env:PUBLIC_PAGES_MODE = "public"
  try {
    node scripts/public-pages-check.mjs
  } finally {
    Remove-Item Env:\PUBLIC_PAGES_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:\PUBLIC_PAGES_MODE -ErrorAction SilentlyContinue
  }
}

Write-Host "CoLiPas release deploy completed."
