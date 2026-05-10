param(
  [string]$RemoteHost = "colipas-prod",
  [string]$RemoteUser = "colipas-deploy",
  [string]$RemoteCommand = "/usr/local/sbin/colipas-update",
  [string]$Branch = "master",
  [string]$SshKey = "$env:USERPROFILE\.ssh\colipas_deploy_ed25519"
)

$ErrorActionPreference = "Stop"

function Run-Step {
  param(
    [string]$Title,
    [scriptblock]$Command
  )

  Write-Host "==> $Title"
  & $Command
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
  git push origin $Branch
}

Run-Step "Update server" {
  ssh -i $SshKey -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "$RemoteUser@$RemoteHost" $RemoteCommand
}

Write-Host "CoLiPas release deploy completed."
