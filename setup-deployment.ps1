[CmdletBinding()]
param(
  [string]$Server = "ubuntu@124.221.33.239",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\video-agent-deploy"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $IdentityFile)) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $IdentityFile) -Force | Out-Null
  & ssh-keygen -t ed25519 -f $IdentityFile -N '' -C "video-agent-deploy"
  if ($LASTEXITCODE -ne 0) { throw "SSH 密钥生成失败" }
}

$PublicKey = (Get-Content -Raw "$IdentityFile.pub").Trim()
Write-Host "请根据提示输入服务器账户密码，仅用于将公钥写入服务器。"
& ssh -tt -i $IdentityFile -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new $Server "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$PublicKey' ~/.ssh/authorized_keys || printf '%s\n' '$PublicKey' >> ~/.ssh/authorized_keys"
if ($LASTEXITCODE -ne 0) { throw "服务器公钥配置失败" }

Write-Host "公钥登录已配置。之后直接运行 .\deploy.ps1 或双击 deploy.cmd 即可更新服务。"
