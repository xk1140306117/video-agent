[CmdletBinding()]
param(
  [string]$Server = "ubuntu@124.221.33.239",
  [int]$Port = 3002,
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\video-agent-deploy",
  [string]$BaseImage = "docker.m.daocloud.io/library/node:22-alpine"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployDir = Join-Path $ProjectRoot ".deploy"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Image = "video-agent:$Timestamp"
$Archive = Join-Path $DeployDir "video-agent-$Timestamp.tar"
$RemoteDir = "~/video-agent-deploy"
$RemoteArchive = "$RemoteDir/video-agent-$Timestamp.tar"

if (-not (Test-Path -LiteralPath $IdentityFile) -and $IdentityFile -eq "$env:USERPROFILE\.ssh\video-agent-deploy") {
  $LegacyIdentityFile = "$env:USERPROFILE\.ssh\ppt-agent-deploy"
  if (Test-Path -LiteralPath $LegacyIdentityFile) {
    Write-Host "使用现有的共享部署密钥 $LegacyIdentityFile"
    $IdentityFile = $LegacyIdentityFile
  }
}

if (-not (Test-Path -LiteralPath $IdentityFile)) {
  throw "未找到部署密钥 $IdentityFile。请先运行 .\setup-deployment.ps1。"
}

$DockerBin = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"
if (-not (Get-Command docker -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $DockerBin)) {
  $env:Path = "$DockerBin;$env:Path"
}
$LocalDocker = [bool](Get-Command docker -ErrorAction SilentlyContinue)
if ($LocalDocker) {
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { $LocalDocker = $false }
}

New-Item -ItemType Directory -Path $DeployDir -Force | Out-Null
$SourceArchive = Join-Path $DeployDir "video-agent-src-$Timestamp.tar"

if ($LocalDocker) {
  Write-Host "[1/5] 构建 Linux 镜像 $Image"
  docker build --platform linux/amd64 --build-arg "NODE_IMAGE=$BaseImage" --tag $Image $ProjectRoot
  if ($LASTEXITCODE -ne 0) { throw "Docker 镜像构建失败" }

  Write-Host "[2/5] 导出镜像"
  docker save --output $Archive $Image
  if ($LASTEXITCODE -ne 0) { throw "Docker 镜像导出失败" }
} else {
  Write-Host "[1/5] 本机没有 Docker，打包源码到服务器构建 $Image"
  if (Test-Path -LiteralPath $SourceArchive) { Remove-Item -LiteralPath $SourceArchive -Force }
  & tar.exe -cf $SourceArchive --exclude=node_modules --exclude=.next --exclude=.next-dev --exclude=.video-agent --exclude=.deploy --exclude=.git --exclude=.env --exclude=.env.* -C $ProjectRoot .
  if ($LASTEXITCODE -ne 0) { throw "打包源码失败" }
}

$SshArgs = @("-i", $IdentityFile, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes")

Write-Host "[3/5] 准备远端目录"
& ssh @SshArgs $Server "mkdir -p $RemoteDir"
if ($LASTEXITCODE -ne 0) { throw "无法通过部署密钥连接服务器" }

& scp @SshArgs (Join-Path $ProjectRoot "deploy\remote-deploy.sh") "${Server}:$RemoteDir/remote-deploy.sh"
if ($LASTEXITCODE -ne 0) { throw "远端部署脚本上传失败" }

$ProductionEnv = Join-Path $ProjectRoot ".env.production"
if (-not (Test-Path -LiteralPath $ProductionEnv)) {
  $ProductionEnv = Join-Path $ProjectRoot ".env.local"
}
if (-not (Test-Path -LiteralPath $ProductionEnv)) {
  throw "未找到 .env.production 或 .env.local，无法提供视频服务凭据。"
}
& scp @SshArgs $ProductionEnv "${Server}:$RemoteDir/.env"
if ($LASTEXITCODE -ne 0) { throw "生产环境配置上传失败" }
& ssh @SshArgs $Server "chmod 600 $RemoteDir/.env"
if ($LASTEXITCODE -ne 0) { throw "生产环境配置权限设置失败" }

if ($LocalDocker) {
  Write-Host "[4/5] 上传镜像"
  & scp @SshArgs $Archive "${Server}:$RemoteArchive"
  if ($LASTEXITCODE -ne 0) { throw "镜像上传失败" }
  Write-Host "[5/5] 替换远端容器并执行健康检查"
  & ssh @SshArgs $Server "chmod 700 $RemoteDir/remote-deploy.sh && VIDEO_AGENT_PORT=$Port $RemoteDir/remote-deploy.sh $RemoteArchive $Image"
  if ($LASTEXITCODE -ne 0) { throw "远端部署失败；服务器已尝试自动回滚" }
  Remove-Item -LiteralPath $Archive -Force
} else {
  $RemoteSource = "$RemoteDir/video-agent-src-$Timestamp.tar"
  Write-Host "[4/5] 上传源码，由服务器 Docker 构建"
  & scp @SshArgs $SourceArchive "${Server}:$RemoteSource"
  if ($LASTEXITCODE -ne 0) { throw "源码上传失败" }
  Write-Host "[5/5] 在服务器构建镜像并替换容器"
  $RemoteBuild = @"
set -eu
rm -rf $RemoteDir/src
mkdir -p $RemoteDir/src
tar -xf $RemoteSource -C $RemoteDir/src
docker build --build-arg NODE_IMAGE=$BaseImage --tag $Image $RemoteDir/src
chmod 700 $RemoteDir/remote-deploy.sh
VIDEO_AGENT_PORT=$Port $RemoteDir/remote-deploy.sh --built $Image
rm -rf $RemoteDir/src $RemoteSource
"@
  & ssh @SshArgs $Server $RemoteBuild
  if ($LASTEXITCODE -ne 0) { throw "远端部署失败；服务器已尝试自动回滚" }
  Remove-Item -LiteralPath $SourceArchive -Force
}

Write-Host "部署完成：http://124.221.33.239:$Port/"
