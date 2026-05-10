<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&height=220&color=0:0F172A,45:0F766E,100:2563EB&text=CoLiPas&fontColor=FFFFFF&fontSize=64&fontAlignY=38&desc=Multi-cloud%20server%20operations%20panel%20with%20AI,%20SSH,%20automation,%20and%20audit&descAlignY=60&animation=fadeIn" alt="CoLiPas header" />

<p align="center">
  <a href="https://github.com/nmklio/CoLiPas/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/nmklio/CoLiPas/ci.yml?branch=master&label=ci&style=for-the-badge"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white&style=for-the-badge">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=06131a&style=for-the-badge">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white&style=for-the-badge">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-node:sqlite-003B57?logo=sqlite&logoColor=white&style=for-the-badge">
</p>

<h3>Production-grade multi-cloud operations in one deployable Node service.</h3>

<p>
  <b>CoLiPas</b> brings server inventory, global monitoring, SSH access, AI operations, workflow automation,
  custom API testing, and security audit into one private control panel.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  &nbsp;|&nbsp;
  <a href="#production-deploy">Production deploy</a>
  &nbsp;|&nbsp;
  <a href="#security-model">Security model</a>
  &nbsp;|&nbsp;
  <a href="#project-layout">Project layout</a>
</p>

<img src=".github/assets/colipas-dashboard-preview.svg" alt="CoLiPas sanitized multi-region dashboard preview" width="980" />

<sub>The preview image uses fictional providers and RFC 5737 documentation IP ranges only. It does not contain user servers, real IP addresses, SSH credentials, or runtime data.</sub>

</div>

## Why It Feels Different

| Release-ready area | CoLiPas approach |
| --- | --- |
| Clean public distribution | Repository assets use sanitized demo data only; runtime `.data`, `.env`, screenshots, and local databases are ignored. |
| Real operations workflow | Server onboarding, map filtering, SSH shell, AI chat, orchestration, custom API testing, and audit remediation are linked. |
| Safer defaults | Protected APIs require login, sensitive AI/API/SSH data is redacted, and test fixtures use documentation IP ranges. |

## What CoLiPas Does

CoLiPas is designed for teams that manage a mix of public cloud, private cloud, overseas nodes, and manually onboarded Linux servers. The frontend is a React operations console; the backend is an Express API that serves the app, protects operator sessions, stores state in SQLite, and performs guarded integrations.

| Area | What is included |
| --- | --- |
| Multi-cloud inventory | Cloud account overview, custom provider names, server lifecycle status, region and OS detection, resource refresh, and dashboard map grouping. |
| Server access | Manual onboarding, inventory-only mode, simulated SSH mode, real password/private-key SSH verification, live shell streaming, diagnostics, and guarded power actions. |
| AI operations | OpenAI-compatible base URL support, model discovery, streaming chat, multi-turn context, cache reuse, force refresh, and connectivity testing. |
| Workflow automation | Targeted operation tasks for asset sync, health checks, patching, backup verification, and SSH-connected server workflows. |
| Custom API lab | Allowlisted backend proxy for testing provider APIs without exposing browser-side secrets or private network targets. |
| Security audit | Auth events, blocked API calls, SSH actions, remediation flows, risk relation cards, and audit trail persistence. |
| Operator experience | Login page, editable profile/avatar, password change, Chinese/English/Japanese language switch, and responsive authenticated dashboard. |

## Highlights

- One production service on `PORT=8080` for both `/api/*` and the built frontend.
- SQLite persistence through Node's built-in `node:sqlite`; no external database server is required for a single-node deployment.
- SSH secrets are encrypted at rest with `CREDENTIAL_ENCRYPTION_KEY`.
- AI keys stay server-side or in one-time request payloads; they are not committed and are guarded by smoke checks.
- The custom API proxy blocks private IP ranges, unsafe headers, redirects to sensitive networks, and secret leakage in audit targets.
- `npm test` builds the app, starts a temporary production server, runs API and source-level smoke checks, then cleans up test data.

## Quick Start

<table>
  <tr>
    <td width="28%"><b>1. Clone</b><br><sub>Get the public sanitized source.</sub></td>
    <td><code>git clone https://github.com/nmklio/CoLiPas.git && cd CoLiPas</code></td>
  </tr>
  <tr>
    <td><b>2. Configure</b><br><sub>Keep secrets in your private env file.</sub></td>
    <td><code>npm install && cp .env.example .env</code></td>
  </tr>
  <tr>
    <td><b>3. Verify</b><br><sub>Build and run the production smoke suite.</sub></td>
    <td><code>npm test</code></td>
  </tr>
  <tr>
    <td><b>4. Run</b><br><sub>One production service, one port.</sub></td>
    <td><code>npm start</code></td>
  </tr>
</table>

Open `http://127.0.0.1:8080/` after the production server starts.

For local development, the available scripts are:

```bash
npm run dev          # Vite frontend dev server
npm run dev:server   # Express API watcher
npm run build        # client + server build
npm run smoke        # smoke checks against an existing server
npm test             # production build + temporary smoke environment
npm start            # production server
```

## Runtime Configuration

Create `.env` from `.env.example` and replace every default before exposing the panel.

| Variable | Purpose |
| --- | --- |
| `PORT` | Production HTTP port. Use `8080` for the bundled deployment examples. |
| `CORS_ORIGIN` | Allowed browser origin when the API is accessed cross-origin. |
| `CUSTOM_API_ALLOWED_HOSTS` | Comma-separated host allowlist for the custom API proxy. |
| `AI_API_KEY` | Optional default OpenAI-compatible API key. Leave empty to use request-level provider settings or simulated output. |
| `AI_BASE_URL` | OpenAI-compatible API base URL, for example `https://api.openai.com/v1`. |
| `AI_MODEL` | Default model used when no provider override is supplied. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Initial administrator credentials. Change the password in production. |
| `SESSION_SECRET` | Long random secret used for session cookies. |
| `COLIPAS_DATA_DIR` | Runtime data directory. Defaults to `.data`. |
| `COLIPAS_DB_PATH` | Optional SQLite database path. Defaults to `COLIPAS_DATA_DIR/colipas.sqlite`. |
| `CREDENTIAL_ENCRYPTION_KEY` | Long random key used to encrypt stored SSH credentials. |

## Production Deploy

CoLiPas runs as a single Linux service. A typical deployment:

```bash
sudo useradd --system --home /opt/colipas --shell /usr/sbin/nologin colipas
sudo mkdir -p /opt/colipas
sudo chown -R colipas:colipas /opt/colipas
git clone https://github.com/nmklio/CoLiPas.git /opt/colipas
cd /opt/colipas
cp .env.example .env
npm ci
npm test
sudo cp deploy/colipas.service /etc/systemd/system/colipas.service
sudo systemctl daemon-reload
sudo systemctl enable --now colipas
```

Use `deploy/nginx.conf` as a reverse-proxy starting point. It is tuned for long-running AI and SSH streams with buffering disabled.

For repeat releases, install `deploy/server-update.sh` on the server as `/usr/local/sbin/colipas-update`, then run the local guarded release flow:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release-deploy.ps1
```

The release script runs `npm test` first, requires a clean working tree, pushes GitHub, then triggers the server update command over SSH. Configure the SSH target as a private local host alias such as `colipas-prod`; keep `.env`, `.data`, SSH private keys, server IPs, and deployment credentials outside public web roots and outside Git.

To make local commits publish automatically after the same guarded checks, install the optional local hook:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-release-hook.ps1
```

The hook is stored only under your local `.git/hooks/post-commit`. It is not committed to the repository and it still blocks deployment when tests fail, the tree is dirty, GitHub push fails, or the server update command fails.

## Server Onboarding

Add servers from the Servers page with provider, region, public/private IP, OS, tags, and optional custom cloud provider names.

CoLiPas supports three onboarding modes:

| Mode | Behavior |
| --- | --- |
| Inventory only | Saves the server asset without SSH verification. The lifecycle state stays unconnected until credentials are verified. |
| Verify SSH | Opens a backend SSH connection using password or private-key authentication before marking the server connected. |
| Simulated SSH | Creates a demo connection for local release checks and UI demos. |

Connected SSH credentials are stored separately from server assets and encrypted before persistence. Server deletion is available through `DELETE /api/servers/:serverId`.

## AI Provider Flow

The AI console supports OpenAI-compatible providers:

1. Set a base URL and API key.
2. Load available models from `/models`.
3. Test connectivity with a streaming request.
4. Start a streaming multi-turn conversation.
5. Reuse cached answers or force refresh when current infrastructure state changes.

The backend redacts upstream error bodies and rejects sensitive query parameters in AI base URLs.

## Security Model

CoLiPas is an operations tool, so the default security posture is defensive:

- All operational APIs except health and auth require an authenticated session.
- Session cookies are HTTP-only and password changes revoke other sessions.
- The custom API proxy rejects localhost, private IPv4 ranges, link-local ranges, multicast ranges, unsafe headers, and redirect-following.
- SSH command audit summaries are redacted and bounded.
- Credentials are encrypted with `CREDENTIAL_ENCRYPTION_KEY` before storage.
- Audit entries and remediation actions are persisted and linked back into the security panel.

Before internet exposure, replace all default secrets, restrict `CORS_ORIGIN`, put the service behind HTTPS, and limit SSH access to the minimum required hosts.

## Project Layout

```text
src/
  app/                  React shell, login, and authenticated console entry
  modules/
    ai/                 Streaming AI operations console
    cloud/              Cloud account cards and sync state
    custom-api/         API request builder
    operations/         Workflow orchestration center
    security/           Audit and remediation panel
    servers/            Inventory, map, SSH terminal, server actions
  server/
    app.ts              Express API and static frontend hosting
    services/           AI, auth, audit, database, SSH, inventory, proxy
  shared/               Shared validation and prompt helpers
deploy/                 systemd and nginx examples
scripts/                Smoke and production verification scripts
.github/assets/         Repository preview assets for GitHub only
public/                 Static files copied into production builds
```

## Verification

Run the full production smoke before shipping changes:

```bash
npm test
```

The smoke suite covers authentication, profile/password changes, protected APIs, SQLite persistence, AI streaming and cache behavior, model loading, custom API SSRF guards, SSH terminal contracts, server lifecycle logic, operations target validation, security remediation, dashboard map interaction guards, and production build output.

## Notes

This repository is public for inspection and deployment. Runtime secrets, user data, SSH credentials, `.env`, `.data`, and generated local databases must stay private.
