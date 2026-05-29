<div align="center">

# CoLiPas

### 可私有化部署的多云服务器运维控制台

</div>

## 语言

[中文文档](README_CN.md) | [English Docs](README.md) | [日本語ドキュメント](README_JP.md)

## 项目介绍

CoLiPas 是一个面向实际上线环境的云服务器运维面板。它把服务器资产、全球监控小地图、SSH 终端、AI 运维助手、运维编排、自定义 API 测试、安全审计和发布验证集中到一个受登录保护的控制台里。

项目采用 React + TypeScript + Express + SQLite 架构，一个 Node.js 生产服务同时提供 `/api/*` 接口和构建后的前端页面。运行数据默认保存在 `.data` 目录中，SSH 凭据会使用 `CREDENTIAL_ENCRYPTION_KEY` 加密保存。

这个仓库只应包含源码、脱敏示例和部署脚本。不要提交真实服务器 IP、密码、API Key、SSH 私钥、`.env`、`.data`、运行数据库、日志或用户数据。

## 核心能力

| 模块 | 能力 |
| --- | --- |
| 多云资产 | 云账号概览、自定义云厂商、服务器生命周期、区域/系统识别、资源刷新和地图聚合。 |
| 服务器接入 | 手动添加服务器、库存模式、模拟 SSH、密码/密钥 SSH 验证、诊断和开关机/重启操作。 |
| 浏览器 SSH | xterm 风格交互终端、实时输出、窗口关闭清理后端会话、`Ctrl+C` 中断、复制和清屏工具。 |
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

### 一键 Linux 部署

适合新的 Linux 主机。默认使用 Docker Compose，密钥只写入服务器本地 `.env`。

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo bash
```

常见参数：

```bash
sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='ChangeThisStrongPassword123' \
  COLIPAS_DEPLOY_MODE=docker \
  bash scripts/one-click-deploy.sh
```

如果要使用原生 systemd 部署，把 `COLIPAS_DEPLOY_MODE` 设置为 `native`。

### Docker Compose

```bash
git clone https://github.com/nmklio/CoLiPas.git
cd CoLiPas
cp .env.example .env
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
```

`docker-compose.yml` 会把运行数据挂载到 `/app/.data`，因此 SQLite 数据、审计记录、加密 SSH 元数据和账号设置会在容器重建后保留。

### 原生 Linux + systemd

适合需要 journald、系统服务和主机级集成的部署方式。

```bash
sudo useradd --system --home /opt/colipas --shell /usr/sbin/nologin colipas
sudo mkdir -p /opt/colipas
sudo chown -R colipas:colipas /opt/colipas
sudo -u colipas git clone https://github.com/nmklio/CoLiPas.git /opt/colipas
cd /opt/colipas
sudo -u colipas cp .env.example .env
sudo -u colipas npm ci
sudo -u colipas npm test
sudo cp deploy/colipas.service /etc/systemd/system/colipas.service
sudo systemctl daemon-reload
sudo systemctl enable --now colipas
curl -fsS http://127.0.0.1:8080/api/health
```

## 忘记管理员密码

CoLiPas 不保存明文密码，只保存 `scrypt` 哈希。忘记密码时需要重置。

原生 Linux：

```bash
cd /opt/colipas
sudo -u colipas env COLIPAS_RESET_PASSWORD='NewStrongPassword123' npm run reset:admin
sudo systemctl restart colipas
```

Docker Compose：

```bash
docker compose exec -e COLIPAS_RESET_PASSWORD='NewStrongPassword123' colipas npm run reset:admin
docker compose restart colipas
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
