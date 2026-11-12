# video-agent

视频生成任务的 Web 界面，运行在 Next.js 上。

## 本地运行

```powershell
npm ci
Copy-Item .env.example .env.local
npm run dev
```

在 `.env.local` 中填写 `VIDEO_API_KEY` 与 `VIDEO_API_SECRET`。该文件不会被 Git 提交，也不会打包进 Docker 镜像。

## 更新腾讯云服务

服务部署在 `ubuntu@124.221.33.239` 的 3002 端口。部署脚本会构建 Linux/amd64 镜像（本机没有 Docker 时自动在服务器构建），上传运行配置、等待健康检查，并在失败时回滚到上一镜像。任务历史存储在服务器的 Docker 卷 `video-agent-data` 中。

### 日常更新

克隆仓库后，确保已拥有一把被服务器授权的私钥，然后直接执行：

```powershell
.\deploy.ps1
```

也可双击 `deploy.cmd`。脚本优先使用 `~/.ssh/video-agent-deploy`，并兼容已有的 `~/.ssh/ppt-agent-deploy` 私钥。可用 `-IdentityFile` 指定其他已授权私钥。

### 新同事首次配置

私钥和服务器密码不得放入仓库。首次需要由拥有服务器登录权限的人执行一次：

```powershell
.\setup-deployment.ps1
```

该命令在本机生成专用密钥，并仅将公钥加入服务器；之后日常更新只需运行 `deploy.ps1`。
