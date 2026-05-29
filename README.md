<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&height=220&color=0:0F172A,45:0F766E,100:2563EB&text=CoLiPas&fontColor=FFFFFF&fontSize=64&fontAlignY=38&desc=Private%20cloud%20operations%20with%20SSH,%20AI,%20automation,%20and%20audit&descAlignY=60&animation=fadeIn" alt="CoLiPas header" />

<p align="center">
  <a href="https://github.com/nmklio/CoLiPas/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/nmklio/CoLiPas/ci.yml?branch=master&label=ci&style=for-the-badge"></a>
  <a href="https://hub.docker.com/r/heiyue797/colipas"><img alt="Docker Hub" src="https://img.shields.io/badge/Docker%20Hub-heiyue797%2Fcolipas-2496ED?logo=docker&logoColor=white&style=for-the-badge"></a>
  <a href="https://github.com/nmklio/CoLiPas/pkgs/container/colipas"><img alt="GHCR" src="https://img.shields.io/badge/GHCR-nmklio%2Fcolipas-181717?logo=github&logoColor=white&style=for-the-badge"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white&style=for-the-badge">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=06131a&style=for-the-badge">
</p>

<h3>Self-hosted multi-cloud operations in one deployable Node.js service.</h3>

<p>
  <b>CoLiPas</b> combines server inventory, live SSH, AI-assisted operations,
  workflow automation, custom API testing, and release security evidence in a private control panel.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  &nbsp;|&nbsp;
  <a href="#production-deploy">Production deploy</a>
  &nbsp;|&nbsp;
  <a href="#published-docker-image">Docker image</a>
  &nbsp;|&nbsp;
  <a href="#security-model">Security</a>
  &nbsp;|&nbsp;
  <a href="#verification">Verification</a>
</p>

<img src=".github/assets/colipas-dashboard-preview.svg" alt="CoLiPas sanitized multi-region dashboard preview" width="980" />

<sub>The preview uses fictional providers and RFC 5737 documentation IP ranges only. It does not contain user servers, real IP addresses, SSH credentials, runtime databases, or private deployment data.</sub>

</div>

## Languages

[English](README.md) | [中文文档](README_CN.md) | [日本語ドキュメント](README_JP.md)

## What CoLiPas Is

CoLiPas is a self-hosted operations console for teams that manage cloud servers, private nodes, and manually onboarded Linux machines. It is not a marketing landing page or a demo-only dashboard: it is built around the everyday loop of adding servers, verifying access, checking health, running guarded SSH tasks, asking AI for operational context, and keeping audit evidence.

The runtime is intentionally simple. One Node.js process serves the Express API and the production React frontend on `PORT=8080`. SQLite stores account settings, server inventory, audit trails, AI provider settings, encrypted SSH metadata, and release evidence. No external database is required for a single-node deployment.

## Operator Flow

1. Create a private `.env` from `.env.example` and replace every default secret.
2. Sign in to the protected console.
3. Add servers as inventory-only assets, simulated SSH assets, or real SSH-connected machines.
4. Use the overview map, server table, live browser terminal, operations center, AI assistant, custom API lab, and security audit as one linked workflow.
5. Run `npm test` or the release script before shipping changes so build, API, browser, performance, concurrency, reset-password, and secret-scan checks run together.

## Core Modules

| Area | Included capability |
| --- | --- |
| Inventory and map | Cloud account overview, custom provider names, server lifecycle status, region and OS detection, resource refresh, and map grouping. |
| Server access | Manual onboarding, inventory-only mode, simulated SSH, password/private-key SSH verification, diagnostics, and guarded power actions. |
| Live SSH terminal | xterm-style browser terminal, WebSocket streaming, copy/clear tools, `Ctrl+C`, large-output guards, and backend shell cleanup when the panel closes. |
| AI operations | OpenAI-compatible base URL support, model discovery, streaming chat, multi-turn context, cached answers, force refresh, and server-side key storage. |
| Workflow automation | Asset sync, health checks, SSH commands, reboot/shutdown flows, target preflight, and high-impact command confirmation. |
| Custom API lab | Allowlisted backend proxy for provider API testing without exposing browser-side secrets or private network targets. |
| Security audit | Auth events, blocked calls, SSH actions, remediation flows, relation cards, diagnostics export, and release readiness evidence. |
| Operator account | Login, session protection, profile/avatar update, password change, and Chinese / English / Japanese UI language switching. |

## Quick Start

Use this path for local evaluation or development.

```bash
git clone https://github.com/nmklio/CoLiPas.git
cd CoLiPas
npm ci
cp .env.example .env
npm test
npm start
```

Open `http://127.0.0.1:8080/` after the production server starts.

Common scripts:

```bash
npm run dev          # Vite frontend dev server for local development
npm run dev:server   # Express API watcher
npm run build        # client + server build
npm run smoke        # source and API smoke checks against an existing server
npm run perf         # browser timing check against an existing server
npm test             # production build + temporary verification environment
npm start            # production server from build/server/index.js
```

## Runtime Configuration

Create `.env` from `.env.example`. Before exposing the service, replace at least the administrator password, session secret, credential encryption key, CORS origin, and custom API allowlist.

| Variable | Purpose |
| --- | --- |
| `PORT` | Production HTTP port. The bundled examples use `8080`. |
| `CORS_ORIGIN` | Allowed browser origin when the API is accessed cross-origin. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Initial administrator credentials. Change them for production. |
| `SESSION_SECRET` | Long random secret for HTTP-only session cookies. |
| `SESSION_TTL_HOURS` | Session lifetime in hours. |
| `COLIPAS_DATA_DIR` | Runtime data directory. Defaults to `.data`. |
| `COLIPAS_DB_PATH` | Optional SQLite database path. Defaults to `COLIPAS_DATA_DIR/colipas.sqlite`. |
| `CREDENTIAL_ENCRYPTION_KEY` | Long random key used to encrypt stored SSH credentials. |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | Optional default OpenAI-compatible provider settings. Keys can also be saved through the protected UI. |
| `CUSTOM_API_ALLOWED_HOSTS` | Comma-separated host allowlist for the custom API proxy. |
| `CUSTOM_API_TIMEOUT_MS` | Timeout for custom API proxy requests. |
| `RELEASE_VERIFY_TOKEN` | Optional bearer token for `/api/release/verify`. |
| `RELEASE_TARGET_NAME` / `RELEASE_CHANNEL` / `RELEASE_DEPLOYMENT_MODE` / `RELEASE_PUBLIC_URL` | Safe release labels used in readiness evidence. |
| `RELEASE_GIT_COMMIT` / `RELEASE_ARTIFACT_ID` / `RELEASE_DEPLOYED_AT` | Optional build metadata populated by release automation. |

## Production Deploy

Choose one deployment path. The interactive installer is the recommended path for new servers; published images are the fastest path when you already manage Docker yourself.

### Interactive Linux Installer

The interactive Linux installer asks for install directory, public URL, admin username, deployment mode, and initial password. It then clones or updates the repository, writes a private `.env` if needed, starts the service, and runs a health check.

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo bash
```

Recommended answers:

| Prompt | Recommended value |
| --- | --- |
| Install directory | `/opt/colipas` |
| Git branch | `master` |
| Public URL or domain | Your HTTPS domain, for example `https://colipas.example.com` |
| Admin username | `admin` or your operator account name |
| Deployment mode | `Docker Compose` for most users; `Native systemd` only when you need host-level service control |
| Initial admin password | Paste a strong password, or leave blank to auto-generate one |

Existing deployments are preserved. If `/opt/colipas/.env` already exists, the installer keeps the current admin password, database path, SSH encryption key, AI provider settings, and other runtime configuration.

For unattended installs:

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='ChangeThisStrongPassword123' \
  COLIPAS_DEPLOY_MODE=docker \
  COLIPAS_ASSUME_YES=1 \
  bash
```

Useful options: `COLIPAS_APP_DIR`, `COLIPAS_BRANCH`, `COLIPAS_ADMIN_USERNAME`, `COLIPAS_DEPLOY_MODE=docker|native`, `COLIPAS_NON_INTERACTIVE=1`, `COLIPAS_ASSUME_YES=1`, and `COLIPAS_DRY_RUN=1`.

### Published Docker Image

Every `master` push publishes public images to Docker Hub and GitHub Container Registry.

Docker Hub:

```bash
docker pull heiyue797/colipas:latest
```

GitHub Container Registry:

```bash
docker pull ghcr.io/nmklio/colipas:latest
```

Run with Docker Hub:

```bash
cp .env.example .env
# Edit .env before starting the container.
docker volume create colipas-data
docker run -d --name colipas --restart unless-stopped \
  --env-file .env \
  -p 8080:8080 \
  -v colipas-data:/app/.data \
  heiyue797/colipas:latest
curl -fsS http://127.0.0.1:8080/api/health
```

Run with GHCR by replacing the image with `ghcr.io/nmklio/colipas:latest`.

Available tags include `latest`, `master`, release tags such as `v1.0.0`, and short commit tags such as `sha-ab12cd3`.

### Manual Docker Compose

Use Manual Docker Compose when you want to control every command yourself.

```bash
git clone https://github.com/nmklio/CoLiPas.git
cd CoLiPas
cp .env.example .env
# Edit .env before the first start.
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/api/health
```

The included `docker-compose.yml` mounts a named volume at `/app/.data`, so SQLite data, audit records, encrypted SSH metadata, AI provider settings, and account settings survive container rebuilds.

To update a Docker Compose deployment:

```bash
git pull --ff-only
export RELEASE_GIT_COMMIT="$(git rev-parse HEAD)"
export RELEASE_ARTIFACT_ID="docker-$(date -u +%Y%m%d%H%M%S)"
docker compose up -d --build
docker compose logs --tail=80 colipas
```

### Native Linux + systemd

Use native Linux when you want direct host integration, journald logs, and a locked-down service user. Install Node.js 24 LTS or newer, Git, and Nginx first.

```bash
sudo useradd --system --home /opt/colipas --shell /usr/sbin/nologin colipas
sudo mkdir -p /opt/colipas
sudo chown -R colipas:colipas /opt/colipas
sudo -u colipas git clone https://github.com/nmklio/CoLiPas.git /opt/colipas
cd /opt/colipas
sudo -u colipas cp .env.example .env
# Edit /opt/colipas/.env before enabling the service.
sudo -u colipas npm ci
sudo -u colipas npm test
sudo cp deploy/colipas.service /etc/systemd/system/colipas.service
sudo systemctl daemon-reload
sudo systemctl enable --now colipas
systemctl status colipas --no-pager
curl -fsS http://127.0.0.1:8080/api/health
```

The systemd unit only grants write access to the runtime data directory. Keep `.env`, `.data`, SSH private keys, server IPs, and deployment credentials outside public web roots and outside Git.

### Reverse Proxy

Use `deploy/nginx.conf` as a starting point. It disables buffering for AI and SSH streams and sets a `2m` upload limit for profile images.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/colipas.conf
sudo ln -sfn /etc/nginx/sites-available/colipas.conf /etc/nginx/sites-enabled/colipas.conf
sudo nginx -t
sudo systemctl reload nginx
```

Replace `server_name` and TLS certificate paths before using it on a new domain.

## Release Automation

For repeat releases, install `deploy/server-update.sh` on each target server, then run the guarded local release flow:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-deploy.ps1
```

The release script runs `npm test`, checks tracked files for secrets, requires a clean tree, pushes GitHub, updates configured targets over SSH, and runs production browser validation. Keep multi-server release settings in an untracked `release-targets.local.json`; do not commit real IP addresses, passwords, private keys, API keys, runtime DBs, logs, screenshots, or user data.

Preview the resolved release plan without running tests, pushing, or touching servers:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-deploy.ps1 -PlanOnly
```

To publish after local commits automatically, install the optional local hook:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-release-hook.ps1
```

The hook lives only under `.git/hooks/post-commit` and is not committed to the repository.

## Forgot the Admin Password

CoLiPas stores administrator passwords as `scrypt` hashes. Forgotten passwords must be reset, not recovered.

Native Linux:

```bash
cd /opt/colipas
sudo -u colipas env COLIPAS_RESET_PASSWORD='NewStrongPassword123' npm run reset:admin
sudo systemctl restart colipas
```

Docker Compose:

```bash
docker compose exec -e COLIPAS_RESET_PASSWORD='NewStrongPassword123' colipas npm run reset:admin
docker compose restart colipas
```

Optional flags are available for non-default accounts or database paths:

```bash
node scripts/reset-admin-password.mjs --username admin --db /opt/colipas/.data/colipas.sqlite --password 'NewStrongPassword123'
```

The reset script only updates the `admin-account` row. It does not delete servers, SSH credentials, audit entries, AI cache, custom API settings, or other runtime data.

## Security Model

- All operational APIs except health and auth require an authenticated session.
- Session cookies are HTTP-only, and password changes revoke other sessions.
- Stored SSH credentials are encrypted with `CREDENTIAL_ENCRYPTION_KEY`.
- AI provider keys are stored server-side or accepted as one-time request payloads; smoke checks guard against leakage.
- The custom API proxy blocks localhost, private IPv4 ranges, link-local ranges, multicast ranges, unsafe headers, and redirect-following.
- SSH command audit summaries are redacted and bounded.
- Release verification, diagnostics export, and audit reports are sanitized before display.

Before internet exposure, replace all default secrets, restrict `CORS_ORIGIN`, put the service behind HTTPS, and limit SSH access to the minimum required hosts.

## Project Layout

```text
src/
  app/                  React shell, login, docs, and authenticated console entry
  modules/
    ai/                 Streaming AI operations console
    cloud/              Cloud account cards and sync state
    custom-api/         API request builder and allowlisted proxy UI
    operations/         Workflow orchestration center
    security/           Audit, readiness, diagnostics, and remediation
    servers/            Inventory, map linkage, SSH terminal, server actions
  server/
    app.ts              Express API and static frontend hosting
    sshShellSocket.ts   WebSocket bridge for live SSH shells
    services/           AI, auth, audit, database, SSH, inventory, proxy
  shared/               Shared validation and command-risk helpers
deploy/                 systemd, nginx, and server update examples
scripts/                Smoke, browser, performance, release, and reset tooling
.github/assets/         Repository preview assets for GitHub only
public/                 Static files copied into production builds
```

## Verification

Run the full production smoke before shipping changes:

```bash
npm test
npm audit --omit=dev --audit-level=high
node scripts/secret-scan.mjs
```

`npm test` builds the app, starts a temporary production server on port `18080`, runs API and browser checks, validates SSH terminal behavior, exercises AI/cache/custom API/security flows, checks performance and concurrency, validates reset-password behavior, then cleans up temporary test data.

For UI smoothness checks against a running production server:

```bash
PERF_BASE_URL=http://127.0.0.1:18080 PERF_ADMIN_PASSWORD=admin123456 npm run perf
```

The performance check measures login, section switching, map interaction, browser console errors, and Chromium long-task duration. It is a measurement guard, not a replacement for `npm test`.

## Repository Safety Notes

This public repository is for source code, sanitized examples, deployment scripts, and documentation. Runtime secrets, real server IPs, passwords, API keys, SSH private keys, `.env`, `.data`, SQLite runtime databases, generated logs, screenshots, and user data must stay private.
