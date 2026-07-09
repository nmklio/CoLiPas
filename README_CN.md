<div align="center">

# CoLiPas云服务器管理面板

### 可私有化部署的云服务器运维控制台

</div>

## 语言

[中文文档](README_CN.md) | [English Docs](README.md) | [日本語ドキュメント](README_JP.md)

## 项目介绍

CoLiPas云服务器管理面板是一个面向实际上线环境的服务器运维后台。它把服务器资产、全球监控小地图、SSH 终端、AI 运维助手、运维编排、自定义 API 测试、安全审计和发布验证集中到一个受登录保护的控制台里。

项目采用 React + TypeScript + Express + SQLite 架构，一个 Node.js 生产服务同时提供 `/api/*` 接口和构建后的前端页面。运行数据默认保存在 `.data` 目录中，SSH 凭据会使用 `CREDENTIAL_ENCRYPTION_KEY` 加密保存。

这个仓库只应包含源码、脱敏示例和部署脚本。不要提交真实服务器 IP、密码、API Key、SSH 私钥、`.env`、`.data`、运行数据库、日志或用户数据。

## 核心能力

| 模块 | 能力 |
| --- | --- |
| 多云资产 | 云账号概览、自定义云厂商、服务器生命周期、区域/系统识别、资源刷新和地图聚合。 |
| 服务器接入 | 手动添加服务器、资产模式、模拟 SSH、密码/密钥 SSH 验证、诊断和开关机/重启操作。 |
| 浏览器 SSH | xterm 风格交互终端、实时输出、窗口关闭清理后端会话、`Ctrl+C` 中断、复制和清屏工具。 |
| 资产视图 | 将常用的关键词、厂商、状态、地域和健康筛选保存为最多 8 个浏览器本地视图，一键恢复排障工作范围，筛选和资产信息不会上传。 |
| 上下文上线检查 | 总览显示完整六项上线检查；服务器、AI、运维、API、安全等工作区及性能模式默认显示可持久化的摘要，需要时一键展开完整证据并跳转最高优先级修复。 |
| AI 运维 | OpenAI 兼容接口、模型获取、流式对话、多轮上下文、缓存复用、强制刷新和连接测试。 |
| 运维编排 | 资产巡检、健康检查、SSH 命令、重启/关机等任务，并在执行前做目标预检。 |
| 自定义 API | 后端安全代理测试云厂商 API，阻止私网地址、危险请求头、跳转和审计泄漏。 |
| 安全审计 | 登录、API、SSH、任务、修复动作和发布证据都会写入审计链路。 |

## 快速开始

```bash
git clone https://github.com/nmklio/CoLiPas.git
cd CoLiPas
npm install
cp .env.example .env
npm test
npm start
```

启动后访问：

```text
http://127.0.0.1:8080/
```

常用脚本：

```bash
npm run build        # 构建前端和后端
npm run smoke        # 针对已有服务运行冒烟检查
npm run perf         # 浏览器性能检查
npm test             # 完整生产灰度测试
npm start            # 启动生产服务
```

## 运行配置

从 `.env.example` 创建 `.env`，上线前至少修改以下配置：

| 变量 | 用途 |
| --- | --- |
| `PORT` | 生产服务端口，默认示例使用 `8080`。 |
| `CORS_ORIGIN` | 允许访问 API 的浏览器来源。 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 初始管理员账号和密码，上线前必须修改默认密码。 |
| `SESSION_SECRET` | 用于会话 Cookie 的长随机密钥。 |
| `COLIPAS_DATA_DIR` | 运行数据目录，默认 `.data`。 |
| `COLIPAS_DB_PATH` | SQLite 数据库路径，默认位于数据目录中。 |
| `CREDENTIAL_ENCRYPTION_KEY` | 加密 SSH 凭据的长随机密钥。 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 可选的 OpenAI 兼容模型配置。 |
| `CUSTOM_API_ALLOWED_HOSTS` | 自定义 API 测试允许访问的主机列表。 |
| `RELEASE_VERIFY_TOKEN` | 可选的发布验证接口 Bearer Token。 |

## 生产部署

生产部署支持 Docker Compose 和原生 Linux + systemd 两种一键模式。大多数用户选 Docker；需要主机 systemd 直接托管服务时选原生 Linux。部署用户只需要运行下面的一键脚本；脚本会拉取项目并启动服务，不要求你推送代码、构建 Docker 镜像或发布镜像。

### Docker 一键部署（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_DEPLOY_MODE=docker \
  bash
```

推荐选择：

| 提示项 | 推荐值 |
| --- | --- |
| Install directory | `/opt/colipas` |
| Git branch | `master` |
| Public URL or domain | 你的 HTTPS 域名，例如 `https://colipas.example.com` |
| Admin username | `admin` 或你的管理员账号名 |
| Deployment mode | `Docker Compose` |
| Initial admin password | 输入强密码，或留空自动生成 |

脚本只会把密钥写到服务器本地。如果 `/opt/colipas/.env` 已存在，它会保留当前管理员密码、数据库路径、SSH 加密密钥、AI 配置和其他运行配置。手动输入或通过环境变量传入的初始密码不会在部署结束时再次打印；只有脚本自动生成的密码会显示一次。

无人值守部署可以用环境变量传入同样的答案：

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='replace-with-strong-password' \
  COLIPAS_DEPLOY_MODE=docker \
  COLIPAS_ASSUME_YES=1 \
  bash
```

常用参数包括：`COLIPAS_APP_DIR`、`COLIPAS_BRANCH`、`COLIPAS_ADMIN_USERNAME`、`COLIPAS_DEPLOY_MODE=docker|native`、`COLIPAS_NON_INTERACTIVE=1`、`COLIPAS_ASSUME_YES=1`。

Docker 部署会保留 Compose 数据卷，因此 SQLite 数据、审计记录、加密 SSH 元数据、AI 配置和账号设置会在容器重建后保留。

### 原生 Linux + systemd 一键部署

当你希望 CoLiPas云服务器管理面板作为主机 systemd 服务运行，而不是运行在 Docker 里时，使用这个模式。脚本会在 apt 系统上安装 Node.js 24、创建 `colipas` 服务用户、构建应用、安装 `deploy/colipas.service`、启动服务并检查健康状态。

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_DEPLOY_MODE=native \
  bash
```

无人值守原生 Linux 部署：

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='replace-with-strong-password' \
  COLIPAS_DEPLOY_MODE=native \
  COLIPAS_ASSUME_YES=1 \
  bash
```

原生模式的运行数据通常保存在 `/opt/colipas/.data`，重复部署时会保留已有 `.env` 密钥。如果不是 apt 系统，请先安装 Node.js 24，或改用 Docker 模式。

## 忘记管理员密码

CoLiPas云服务器管理面板不保存明文密码，只保存 `scrypt` 哈希。忘记密码时需要重置。

Docker 一键部署 / Docker Compose：

```bash
cd /opt/colipas
docker compose exec -e COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' colipas npm run reset:admin
docker compose restart colipas
```

原生 Linux + systemd：

```bash
cd /opt/colipas
sudo -u colipas env COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' npm run reset:admin
sudo systemctl restart colipas
```

重置脚本只更新管理员账号，不会删除服务器、SSH 凭据、审计记录、AI 缓存、自定义 API 设置或其他运行数据。

## 安全模型

- 除健康检查和登录接口外，所有运维 API 都需要登录会话。
- 会话 Cookie 使用 HTTP-only，修改密码会撤销其他会话。
- SSH 命令摘要会脱敏并限制长度。
- SSH 凭据用 `CREDENTIAL_ENCRYPTION_KEY` 加密保存。
- 自定义 API 代理会阻止私网地址、链路本地地址、危险请求头和敏感跳转。
- 发布验证、诊断导出和审计报告会避免泄漏密钥、私钥和真实运行数据。

## 验证

提交或上线前建议运行：

```bash
npm test
npm audit --omit=dev --audit-level=high
node scripts/secret-scan.mjs
```

完整测试会构建项目、启动临时生产服务、运行 API 冒烟、浏览器验证、性能检查、并发检查和管理员密码重置检查。
