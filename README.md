<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&height=220&color=0:0F172A,45:0F766E,100:2563EB&text=CoLiPas%20Cloud%20Server%20Panel&fontColor=FFFFFF&fontSize=48&fontAlignY=38&desc=Private%20cloud%20server%20management%20with%20SSH,%20AI,%20automation,%20and%20audit&descAlignY=60&animation=fadeIn" alt="CoLiPas Cloud Server Management Panel header" />

<p align="center">
  <a href="https://github.com/nmklio/CoLiPas/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/nmklio/CoLiPas/ci.yml?branch=master&label=ci&style=for-the-badge"></a>
  <a href="https://hub.docker.com/r/heiyue797/colipas"><img alt="Docker Hub" src="https://img.shields.io/badge/Docker%20Hub-heiyue797%2Fcolipas-2496ED?logo=docker&logoColor=white&style=for-the-badge"></a>
  <a href="https://github.com/nmklio/CoLiPas/pkgs/container/colipas"><img alt="GHCR" src="https://img.shields.io/badge/GHCR-nmklio%2Fcolipas-181717?logo=github&logoColor=white&style=for-the-badge"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white&style=for-the-badge">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=06131a&style=for-the-badge">
</p>

<h3>Self-hosted cloud server management in one deployable Node.js service.</h3>

<p>
  <b>CoLiPas Cloud Server Management Panel</b> combines server inventory, live SSH, AI-assisted operations,
  workflow automation, custom API testing, and release security evidence in a private control panel.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  &nbsp;|&nbsp;
  <a href="#production-deploy">Production deploy</a>
  &nbsp;|&nbsp;
  <a href="#docker-one-command-deploy">Docker deploy</a>
  &nbsp;|&nbsp;
  <a href="#security-model">Security</a>
  &nbsp;|&nbsp;
  <a href="#verification">Verification</a>
</p>

<img src=".github/assets/colipas-dashboard-preview.svg" alt="CoLiPas Cloud Server Management Panel sanitized dashboard preview" width="980" />

<sub>The preview uses fictional providers and RFC 5737 documentation IP ranges only. It does not contain user servers, real IP addresses, SSH credentials, runtime databases, or private deployment data.</sub>

</div>

## Languages

[English](README.md) | [中文文档](README_CN.md) | [日本語ドキュメント](README_JP.md)

## What CoLiPas Cloud Server Management Panel Is

CoLiPas Cloud Server Management Panel is a self-hosted operations console for teams that manage cloud servers, private nodes, and manually onboarded Linux machines. It is not a marketing landing page or a demo-only dashboard: it is built around the everyday loop of adding servers, verifying access, checking health, running guarded SSH tasks, asking AI for operational context, and keeping audit evidence.

The runtime is intentionally simple. One Node.js process serves the Express API and the production React frontend on `PORT=8080`. SQLite stores account settings, server inventory, audit trails, AI provider settings, encrypted SSH metadata, and release evidence. No external database is required for a single-node deployment.

## Operator Flow

1. Create a private `.env` from `.env.example` and replace every default secret.
2. Sign in to the protected console.
3. Add servers one at a time, or safely bulk import up to 500 credential-free CSV / JSON inventory assets per request.
4. Schedule a maintenance window before reboots, shutdowns, or high-impact SSH changes; Operations preflight shows whether each target is covered without bypassing operator confirmation.
5. Use the contextual launch guide: keep the full release checklist on Overview, then use the compact workspace summary in Servers, AI, Operations, API, and Security until you need to expand the evidence.
6. Triage the global Operations inbox, which groups release blockers, SSH coverage gaps, and open events and routes each item to the correct module.
7. Use the overview map, server table, live browser terminal, operations center, AI assistant, custom API lab, and security audit as one linked workflow.
8. Run `npm test` or the release script before shipping changes so build, API, browser, performance, concurrency, reset-password, and secret-scan checks run together.

## Core Modules

| Area | Included capability |
| --- | --- |
| Inventory and map | Cloud account overview, custom provider names, server lifecycle status, region and OS detection, resource refresh, and map grouping. |
| Server access | Manual onboarding, inventory-only mode, simulated SSH, password/private-key SSH verification, diagnostics, and guarded power actions. |
| Safe bulk inventory import | CSV / JSON file selection or paste preview, local spreadsheet-safe validation report export, 2 MB and 500-row limits, duplicate name/IP skipping, transactional SQLite writes, and strict rejection of passwords, private keys, tokens, API keys, or SSH credential fields. |
| Live SSH terminal | xterm-style browser terminal, WebSocket streaming with compatible fallback, persistent Operate / Focus / Diagnose workspace presets, copy/clear tools, `Ctrl+C`, large-output guards, visible disconnect recovery, manual reconnect without command replay, and backend shell cleanup when the panel closes. |
| Fleet views | Save common inventory filters as up to eight browser-only views, then restore a focused operational scope without sending filter or asset data anywhere. |
| Contextual launch guide | Full six-step release checklist on Overview; a compact, persistent workspace summary elsewhere or in Performance mode, with a one-click path back to complete evidence and the next remediation. |
| Global operations inbox | Aggregates release blockers, SSH and asset coverage gaps, and open events into priority groups with direct module routing. Review state stores only safe stable IDs and timestamps in the current browser. |
| Adaptive operator controls | Keeps the signed-in name and synchronization state visible while moving refresh, language, account settings, and sign-out into one accessible overflow panel on desktop and mobile; compact breakpoints preserve the operations inbox, launch check, and command palette without a multi-row toolbar. |
| Adaptive refresh scheduler | Refreshes Overview every 15 seconds in standard mode or 30 seconds in Performance mode, pauses polling while the tab is hidden or the browser is offline, resumes from data freshness on return, and applies failure backoff up to 120 seconds. |
| Contextual command palette | Groups the current highest-priority remediation, recent safe actions, and all available actions. Recent history stores only up to five browser-local action IDs and can be cleared at any time. |
| AI operations | OpenAI-compatible base URL support, model discovery, streaming chat, multi-turn context, cached answers, force refresh, and server-side key storage. New chats provide three safe starter paths for risk review, SSH health-check planning, and daily prioritization; they only fill the composer and never send or execute automatically. |
| Workflow automation | Asset sync, health checks, SSH commands, reboot/shutdown flows, persisted maintenance windows with quick-duration scheduling, target preflight, and high-impact command confirmation. |
| Custom API lab | Allowlisted backend proxy for provider API testing without exposing browser-side secrets or private network targets. |
| Security audit | Auth events, blocked calls, SSH actions, remediation flows, relation cards, diagnostics export, release readiness evidence, and revocable public-safe evidence snapshots for external review. |
| Operator account | Login, restart-safe SQLite session storage using token hashes instead of raw Cookies, 15-second foreground sync, configurable active-session capacity with oldest-session retirement, individual or bulk revocation of other signed-in devices, privacy-minimized device labels without raw IP or User-Agent values, profile/avatar update with decoded-image validation and automatic brand fallback, password change, and Chinese / English / Japanese UI language switching. |

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
| `SESSION_MAX_ACTIVE` | Maximum active administrator sessions, from 2 to 64. Defaults to 12; the oldest session is retired when the limit is reached. |
| `COLIPAS_DATA_DIR` | Runtime data directory. Defaults to `.data`. |
| `COLIPAS_DB_PATH` | Optional SQLite database path. Defaults to `COLIPAS_DATA_DIR/colipas.sqlite`. |
| `CREDENTIAL_ENCRYPTION_KEY` | Long random key used to encrypt stored SSH credentials. |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | Optional default OpenAI-compatible provider settings. Keys can also be saved through the protected UI. |
| `CUSTOM_API_ALLOWED_HOSTS` | Comma-separated host allowlist for the custom API proxy. |
| `CUSTOM_API_TIMEOUT_MS` | Timeout for custom API proxy requests. |
| `RELEASE_VERIFY_TOKEN` | Optional bearer token for `/api/release/verify`. |
| `RELEASE_TARGET_NAME` / `RELEASE_CHANNEL` / `RELEASE_DEPLOYMENT_MODE` / `RELEASE_PUBLIC_URL` | Safe release labels used in readiness evidence. |
| `RELEASE_GIT_COMMIT` / `RELEASE_ARTIFACT_ID` / `RELEASE_DEPLOYED_AT` | Optional deployment metadata shown in readiness evidence. |

## Production Deploy

Use one of the one-command Linux deploy modes below. Docker Compose is recommended for most users; native Linux + systemd is available when you want the service managed directly by the host. Deployment users only run the installer or Compose workflow; they do not need to push code, build Docker images, or publish images.

### Docker One-Command Deploy

Run this on a Linux server. On supported distributions, the installer installs Docker and the Docker Compose plugin if they are missing, asks for install directory, public URL, admin username, and initial password, then starts CoLiPas Cloud Server Management Panel and checks service health.

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_DEPLOY_MODE=docker \
  bash
```

Recommended answers:

| Prompt | Recommended value |
| --- | --- |
| Install directory | `/opt/colipas` |
| Git branch | `master` |
| Public URL or domain | Your HTTPS domain, for example `https://colipas.example.com` |
| Admin username | `admin` or your operator account name |
| Deployment mode | `Docker Compose` |
| Initial admin password | Paste a strong password, or leave blank to auto-generate one |

Existing deployments are preserved. If `/opt/colipas/.env` already exists, the installer keeps the current admin password, database path, SSH encryption key, AI provider settings, and other runtime configuration. When you provide the initial password yourself, the installer writes it to the private `.env` file but does not print it again in the terminal output; only auto-generated passwords are shown once.

For unattended installs:

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='replace-with-strong-password' \
  COLIPAS_DEPLOY_MODE=docker \
  COLIPAS_ASSUME_YES=1 \
  bash
```

Useful options: `COLIPAS_APP_DIR`, `COLIPAS_BRANCH`, `COLIPAS_ADMIN_USERNAME`, `COLIPAS_DEPLOY_MODE=docker|native`, `COLIPAS_NON_INTERACTIVE=1`, `COLIPAS_ASSUME_YES=1`, and `COLIPAS_DRY_RUN=1`.

The Docker deployment keeps runtime data in the Compose volume and preserves SQLite data, audit records, encrypted SSH metadata, AI provider settings, and account settings across container rebuilds.

### Native Linux + systemd One-Command Deploy

Use this mode when you want CoLiPas Cloud Server Management Panel to run as a host systemd service instead of Docker. On apt-based systems, the installer installs Node.js 24 if it is missing, creates the `colipas` service user, builds the app, installs `deploy/colipas.service`, starts the service, and checks local health.

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_DEPLOY_MODE=native \
  bash
```

For unattended native Linux deploys:

```bash
curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env \
  COLIPAS_PUBLIC_URL='https://colipas.example.com' \
  COLIPAS_ADMIN_PASSWORD='replace-with-strong-password' \
  COLIPAS_DEPLOY_MODE=native \
  COLIPAS_ASSUME_YES=1 \
  bash
```

Native mode stores runtime data under the install directory, usually `/opt/colipas/.data`, and keeps existing `.env` secrets when redeployed. If the server is not apt-based, install Node.js 24 first or use Docker mode.

### Reverse Proxy

Use `deploy/nginx.conf` as a starting point. It disables buffering for AI and SSH streams and sets a `2m` upload limit for profile images.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/colipas.conf
sudo ln -sfn /etc/nginx/sites-available/colipas.conf /etc/nginx/sites-enabled/colipas.conf
sudo nginx -t
sudo systemctl reload nginx
```

Replace `server_name` and TLS certificate paths before using it on a new domain.

## Forgot the Admin Password

CoLiPas Cloud Server Management Panel stores administrator passwords as `scrypt` hashes. Forgotten passwords must be reset, not recovered.

Docker one-command / Docker Compose deployment:

```bash
cd /opt/colipas
docker compose exec -e COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' colipas npm run reset:admin
```

Native Linux + systemd deployment:

```bash
cd /opt/colipas
sudo -u colipas env COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' npm run reset:admin
```

Optional flags are available for non-default accounts or database paths:

```bash
node scripts/reset-admin-password.mjs --username admin --db /opt/colipas/.data/colipas.sqlite --password 'replace-with-new-strong-password'
```

The reset script updates the administrator password and immediately revokes that account's persisted login sessions. It does not delete servers, SSH credentials, audit entries, AI cache, custom API settings, or other runtime data.

## Security Model

- All operational APIs except health and auth require an authenticated session.
- Session cookies are HTTP-only. Only SHA-256 token hashes and sanitized device/time metadata are stored in SQLite, so valid sessions survive service restarts without persisting raw Cookie, IP, or User-Agent values. Account settings refresh every 15 seconds, enforce the configured capacity, and support individual or bulk revocation.
- Stored SSH credentials are encrypted with `CREDENTIAL_ENCRYPTION_KEY`.
- AI provider keys are stored server-side or accepted as one-time request payloads; smoke checks guard against leakage.
- The custom API proxy blocks localhost, private IPv4 ranges, link-local ranges, multicast ranges, unsafe headers, and redirect-following.
- SSH command audit summaries are redacted and bounded.
- Release verification, diagnostics export, and audit reports are sanitized before display.
- Operators can create short-lived, revocable release-evidence links. Every link contains a fixed aggregate snapshot only; raw server addresses, deployment targets, commit IDs, commands, credentials, audit details, and user data are excluded. Creation, viewing, and revocation are audited.
- The public login screen shows only service availability, access protection, and the latest check time; database, deployment target, and release identifiers remain in the authenticated audit workspace.

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
PERF_BASE_URL=http://127.0.0.1:18080 PERF_ADMIN_PASSWORD='<admin-password>' npm run perf
```

The performance check measures login, section switching, map interaction, browser console errors, and Chromium long-task duration. It is a measurement guard, not a replacement for `npm test`.

## Repository Safety Notes

This public repository is for source code, sanitized examples, deployment scripts, and documentation. Runtime secrets, real server IPs, passwords, API keys, SSH private keys, `.env`, `.data`, SQLite runtime databases, generated logs, screenshots, and user data must stay private.
