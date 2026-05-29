#!/usr/bin/env bash
set -euo pipefail

INCOMING_COLIPAS_SERVER_NAME="${COLIPAS_SERVER_NAME:-}"
INCOMING_RELEASE_PUBLIC_URL="${RELEASE_PUBLIC_URL:-}"
INCOMING_RELEASE_TARGET_NAME="${RELEASE_TARGET_NAME:-}"
INCOMING_RELEASE_CHANNEL="${RELEASE_CHANNEL:-}"
INCOMING_RELEASE_DEPLOYMENT_MODE="${RELEASE_DEPLOYMENT_MODE:-}"
INCOMING_RELEASE_GIT_COMMIT="${RELEASE_GIT_COMMIT:-}"
INCOMING_RELEASE_ARTIFACT_ID="${RELEASE_ARTIFACT_ID:-}"
INCOMING_RELEASE_DEPLOYED_AT="${RELEASE_DEPLOYED_AT:-}"

COLIPAS_RELEASE_CONFIG_FILE="${COLIPAS_RELEASE_CONFIG:-/etc/default/colipas-release}"
if [ -f "$COLIPAS_RELEASE_CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  . "$COLIPAS_RELEASE_CONFIG_FILE"
fi

[ -n "$INCOMING_COLIPAS_SERVER_NAME" ] && COLIPAS_SERVER_NAME="$INCOMING_COLIPAS_SERVER_NAME"
[ -n "$INCOMING_RELEASE_PUBLIC_URL" ] && RELEASE_PUBLIC_URL="$INCOMING_RELEASE_PUBLIC_URL"
[ -n "$INCOMING_RELEASE_TARGET_NAME" ] && RELEASE_TARGET_NAME="$INCOMING_RELEASE_TARGET_NAME"
[ -n "$INCOMING_RELEASE_CHANNEL" ] && RELEASE_CHANNEL="$INCOMING_RELEASE_CHANNEL"
[ -n "$INCOMING_RELEASE_DEPLOYMENT_MODE" ] && RELEASE_DEPLOYMENT_MODE="$INCOMING_RELEASE_DEPLOYMENT_MODE"
[ -n "$INCOMING_RELEASE_GIT_COMMIT" ] && RELEASE_GIT_COMMIT="$INCOMING_RELEASE_GIT_COMMIT"
[ -n "$INCOMING_RELEASE_ARTIFACT_ID" ] && RELEASE_ARTIFACT_ID="$INCOMING_RELEASE_ARTIFACT_ID"
[ -n "$INCOMING_RELEASE_DEPLOYED_AT" ] && RELEASE_DEPLOYED_AT="$INCOMING_RELEASE_DEPLOYED_AT"
if [ -n "$INCOMING_RELEASE_PUBLIC_URL" ] && [ -z "$INCOMING_COLIPAS_SERVER_NAME" ]; then
  unset COLIPAS_SERVER_NAME
fi

APP_DIR="${COLIPAS_APP_DIR:-/opt/colipas}"
SERVICE_NAME="${COLIPAS_SERVICE_NAME:-colipas}"
BRANCH="${COLIPAS_BRANCH:-master}"
APP_USER="${COLIPAS_APP_USER:-colipas}"
SERVER_NAME="${COLIPAS_SERVER_NAME:-colipas.example.com}"
LANDING_ROOT="${COLIPAS_LANDING_ROOT:-/var/www/colipas-landing}"
SSL_CERTIFICATE="${COLIPAS_SSL_CERTIFICATE:-/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem}"
SSL_CERTIFICATE_KEY="${COLIPAS_SSL_CERTIFICATE_KEY:-/etc/letsencrypt/live/$SERVER_NAME/privkey.pem}"
RELEASE_VERIFY_TOKEN_VALUE=""
PUBLIC_URL="${RELEASE_PUBLIC_URL:-https://$SERVER_NAME}"

if [ -z "${COLIPAS_SERVER_NAME:-}" ] && [ -n "${RELEASE_PUBLIC_URL:-}" ]; then
  derived_server_name="$(printf '%s' "$RELEASE_PUBLIC_URL" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#/.*$##; s#:[0-9]+$##')"
  if [ -n "$derived_server_name" ]; then
    SERVER_NAME="$derived_server_name"
    SSL_CERTIFICATE="${COLIPAS_SSL_CERTIFICATE:-/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem}"
    SSL_CERTIFICATE_KEY="${COLIPAS_SSL_CERTIFICATE_KEY:-/etc/letsencrypt/live/$SERVER_NAME/privkey.pem}"
  fi
fi
PUBLIC_URL="${RELEASE_PUBLIC_URL:-https://$SERVER_NAME}"

if [ -z "${COLIPAS_RESET_ADMIN_PASSWORD:-}" ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  extracted_reset_password="$(printf '%s' "$SSH_ORIGINAL_COMMAND" | sed -n "s/.*COLIPAS_RESET_ADMIN_PASSWORD='\([^']*\)'.*/\1/p")"
  if [ -z "$extracted_reset_password" ]; then
    extracted_reset_password="$(printf '%s' "$SSH_ORIGINAL_COMMAND" | sed -n 's/.*COLIPAS_RESET_ADMIN_PASSWORD=\([^[:space:]]*\).*/\1/p')"
  fi
  if [ -n "$extracted_reset_password" ]; then
    COLIPAS_RESET_ADMIN_PASSWORD="$extracted_reset_password"
  fi
fi

run_as_app() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$APP_USER" -- "$@"
  else
    "$@"
  fi
}

ensure_current_build() {
  if [ ! -d node_modules ]; then
    run_as_app npm ci
  fi
  run_as_app npm run build
}

reset_admin_password_if_requested() {
  if [ -z "${COLIPAS_RESET_ADMIN_PASSWORD:-}" ]; then
    return 0
  fi
  run_as_app env COLIPAS_RESET_PASSWORD="$COLIPAS_RESET_ADMIN_PASSWORD" npm run reset:admin
}

install_deploy_sudo_env_keep() {
  if [ "$(id -u)" -ne 0 ] || ! command -v visudo >/dev/null 2>&1 || ! id colipas-deploy >/dev/null 2>&1; then
    return 0
  fi
  local sudoers_file="/etc/sudoers.d/colipas-deploy-env-keep"
  local sudoers_tmp
  sudoers_tmp="$(mktemp)"
  cat >"$sudoers_tmp" <<'SUDOERS'
Defaults:colipas-deploy env_keep += "SSH_ORIGINAL_COMMAND COLIPAS_RESET_ADMIN_PASSWORD"
SUDOERS
  if visudo -cf "$sudoers_tmp" >/dev/null; then
    install -m 0440 "$sudoers_tmp" "$sudoers_file"
  else
    echo "WARN: failed to validate $sudoers_file; one-time admin password reset over forced SSH may be unavailable" >&2
  fi
  rm -f "$sudoers_tmp"
}

install_deploy_forced_command_env_preserve() {
  if [ "$(id -u)" -ne 0 ] || ! id colipas-deploy >/dev/null 2>&1; then
    return 0
  fi
  local deploy_home
  deploy_home="$(getent passwd colipas-deploy | cut -d: -f6)"
  local authorized_keys="$deploy_home/.ssh/authorized_keys"
  if [ -z "$deploy_home" ] || [ ! -f "$authorized_keys" ]; then
    return 0
  fi
  local authorized_keys_tmp
  authorized_keys_tmp="$(mktemp)"
  sed 's#sudo /usr/local/sbin/colipas-update#sudo --preserve-env=SSH_ORIGINAL_COMMAND,COLIPAS_RESET_ADMIN_PASSWORD /usr/local/sbin/colipas-update#g' "$authorized_keys" > "$authorized_keys_tmp"
  if ! cmp -s "$authorized_keys" "$authorized_keys_tmp"; then
    install -m 0600 -o colipas-deploy -g "$(id -gn colipas-deploy)" "$authorized_keys_tmp" "$authorized_keys"
  fi
  rm -f "$authorized_keys_tmp"
}

patch_landing_page_ui() {
  if ! command -v node >/dev/null 2>&1; then
    echo "WARN: node is unavailable; skipping landing page UI patch" >&2
    return 0
  fi

  local candidates=(
    "$LANDING_ROOT/index.html"
    "/var/www/colipas/index.html"
    "/var/www/html/index.html"
    "$APP_DIR/output/colipas-landing-index.html"
  )

  local patched=0
  local landing_file
  for landing_file in "${candidates[@]}"; do
    if [ ! -f "$landing_file" ] || ! grep -q "CoLiPas" "$landing_file"; then
      continue
    fi

    LANDING_FILE="$landing_file" node <<'NODE'
const fs = require('node:fs');

const file = process.env.LANDING_FILE;
let html = fs.readFileSync(file, 'utf8');
let changed = false;

function replaceOnce(pattern, replacement) {
  const next = html.replace(pattern, replacement);
  if (next !== html) {
    html = next;
    changed = true;
  }
}

function replaceAll(pattern, replacement) {
  const next = html.replace(pattern, replacement);
  if (next !== html) {
    html = next;
    changed = true;
  }
}

replaceAll(/\/\* colipas landing balanced ui(?: v[0-9]+)? \*\/[\s\S]*?(?=<\/style>)/g, '');
replaceAll(/<a class="button github-button" href="https:\/\/github\.com\/nmklio\/CoLiPas"[^>]*>GitHub<\/a>/g, '');

if (!html.includes('href="/docs.html"')) {
  replaceOnce(/(<a href="#deploy">[\s\S]*?<\/a>)/, '$1\n      <a href="/docs.html">文档</a>');
}

if (!html.includes('https://github.com/nmklio/CoLiPas')) {
  replaceOnce(/<a class="nav-action" href="\/admin\/">([\s\S]*?)<\/a>/, (_match, label) => (
    `<div class="nav-actions"><a class="nav-github" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">GitHub</a><a class="nav-action" href="/admin/">${label}</a></div>`
  ));
}

replaceOnce(/(<section class="hero wrap">[\s\S]*?)<h1>[\s\S]*?<\/h1>/, (_match, prefix) => (
  `${prefix}<h1><span class="hero-title-main">CoLiPas云服务器管理面板</span><span class="hero-title-accent">接入、监控、修复一体化</span></h1>`
));

replaceAll(/<div><strong>CoLiPas<\/strong><span>多云服务器管理与 AI 运维后台<\/span><\/div>/g, (
  '<div><strong>CoLiPas云服务器管理面板</strong><span>云服务器管理与 AI 运维后台</span></div>'
));
replaceAll(/<span>多云服务器管理与 AI 运维后台<\/span>/g, '<span>云服务器管理与 AI 运维后台</span>');

replaceOnce(/(<section id="product" class="section wrap">[\s\S]*?<h2>)[\s\S]*?(<\/h2>)/, (_match, prefix, suffix) => (
  `${prefix}先接入，再验证，再修复，最后审计${suffix}`
));

replaceOnce(/(<section id="product" class="section wrap">[\s\S]*?<p class="section-copy">)[\s\S]*?(<\/p>\s*<\/div>\s*<div class="position-grid">)/, (_match, prefix, suffix) => (
  `${prefix}
        从资产登记、地域识别、SSH 验证到 AI 分析和编排执行，关键动作都会留下审计记录，方便上线前巡检和问题复盘。
      ${suffix}`
));

replaceOnce(/(<section id="features" class="section wrap">[\s\S]*?<h2>)[\s\S]*?(<\/h2>)/, (_match, prefix, suffix) => (
  `${prefix}围绕服务器接入、诊断、修复构建完整后台${suffix}`
));

replaceOnce(/(<section id="features" class="section wrap">[\s\S]*?<p class="section-copy">)[\s\S]*?(<\/p>\s*<\/div>\s*<div class="feature-grid">)/, (_match, prefix, suffix) => (
  `${prefix}保留资产、终端、AI、编排和审计入口，介绍页只展示能力边界，真实操作统一进入受保护后台。${suffix}`
));

if (!html.includes('.nav-actions {')) {
  replaceOnce('.nav-action {', `.nav-actions {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.nav-action,
.nav-github {`);
  replaceOnce(/box-shadow: 0 16px 34px rgba\(37, 99, 235, \.22\);\n}\n\.hero \{/, `box-shadow: 0 16px 34px rgba(37, 99, 235, .22);
}
.nav-github {
  color: #122033;
  background: #fff;
  border: 1px solid #dce7f4;
  box-shadow: none;
}
.hero {`);
}

if (!html.includes('.github-button {')) {
  replaceOnce('.button:hover {', `.github-button {
  color: #fff;
  background: var(--blue);
  border-color: var(--blue);
  box-shadow: 0 16px 34px rgba(37, 99, 235, .18);
}
.button:hover {`);
}

if (!html.includes('@media (max-width: 640px) {\n  .nav-actions')) {
  replaceOnce('@media (max-width: 640px) {', `@media (max-width: 640px) {
  .nav-actions {
    justify-self: stretch;
    display: grid;
    grid-template-columns: 1fr 1fr;
  }`);
}

replaceOnce('</style>', `/* colipas landing balanced ui v3 */
@media (min-width: 981px) {
  .nav { height: 72px; }
  .nav-inner,
  .wrap {
    width: min(1200px, calc(100% - 64px));
  }
  .nav-inner {
    grid-template-columns: minmax(180px, 1fr) auto minmax(220px, 1fr);
    gap: 30px;
  }
  .nav-actions {
    justify-self: end;
    gap: 10px;
  }
  .nav-github,
  .nav-action {
    min-height: 42px;
    padding: 0 18px;
    border-radius: 10px;
  }
  .hero {
    min-height: clamp(560px, calc(100vh - 250px), 640px);
    padding: clamp(34px, 5vh, 56px) 0 32px;
    grid-template-columns: minmax(0, 1fr) minmax(420px, 488px);
    gap: clamp(40px, 5vw, 58px);
    align-items: center;
    transform: none;
  }
  .hero > div:first-child { min-width: 0; }
  h1 {
    max-width: 680px;
    margin: 24px 0 18px;
    font-size: clamp(48px, 4.2vw, 62px);
    line-height: 1.04;
    text-wrap: balance;
  }
  h1 .hero-title-main,
  h1 .hero-title-accent {
    display: block;
  }
  h1 .hero-title-main {
    color: var(--ink);
  }
  h1 .hero-title-accent {
    color: var(--blue);
  }
  .lead {
    max-width: 620px;
    font-size: 16px;
    line-height: 1.75;
  }
  .hero-buttons {
    margin-top: 30px;
  }
  .product-preview {
    width: min(100%, 488px);
    max-width: 488px;
    justify-self: end;
    transform: translateY(2px);
  }
  .preview-top {
    height: 46px;
  }
  .mini-console {
    min-height: 286px;
    grid-template-columns: .92fr 1.08fr;
  }
  .mini-sidebar,
  .mini-panel {
    padding: 24px;
  }
  .stats {
    max-width: 620px;
    margin-top: 24px;
    padding-top: 20px;
  }
  .section {
    padding: 66px 0;
  }
  #product.section {
    padding-top: 38px;
    padding-bottom: 58px;
  }
  #product .split {
    grid-template-columns: minmax(0, .9fr) minmax(360px, .74fr);
    gap: 36px;
    align-items: center;
    padding-top: 8px;
  }
  #product h2 {
    max-width: 620px;
    font-size: clamp(32px, 2.65vw, 38px);
    line-height: 1.14;
    word-break: keep-all;
    overflow-wrap: normal;
  }
  #product .section-copy {
    max-width: 480px;
    justify-self: end;
    padding: 0 0 0 22px;
    border-left: 4px solid var(--blue);
    background: transparent;
    box-shadow: none;
  }
  .position-grid {
    margin-top: 24px;
    gap: 16px;
  }
  .position-card {
    min-height: 104px;
    padding: 20px;
  }
  #features.section {
    padding-top: 58px;
  }
  #features .feature-head {
    display: block;
    max-width: 920px;
    margin-bottom: 30px;
  }
  #features .feature-head h2 {
    max-width: 900px;
  }
  #features .feature-head .section-copy {
    max-width: 760px;
    margin-top: 14px;
  }
  #features .feature-card {
    min-height: 198px;
    padding: 20px;
  }
  .band {
    padding: 72px 0;
  }
  .security-layout {
    gap: 52px;
  }
  #deploy.section {
    padding-top: 68px;
  }
  .deploy-flow {
    margin-top: 24px;
    gap: 18px;
  }
  .deploy-grid {
    margin-top: 24px;
  }
  .closing {
    padding: 76px 0 84px;
  }
}
@media (min-width: 1280px) {
  .hero { transform: none; }
}
@media (max-width: 1100px) and (min-width: 981px) {
  .hero {
    grid-template-columns: minmax(0, 1fr) minmax(380px, 440px);
    gap: 38px;
  }
}
@media (max-width: 980px) {
  .hero {
    padding: 42px 0 44px;
  }
  h1 {
    text-wrap: balance;
  }
}
@media (max-width: 640px) {
  .nav-github,
  .nav-action {
    width: 100%;
  }
  h1 {
    font-size: clamp(36px, 10.7vw, 42px);
    line-height: 1.08;
  }
  .lead {
    font-size: 15px;
    line-height: 1.68;
  }
  .hero-buttons {
    margin-top: 22px;
    gap: 10px;
  }
  .stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding-top: 16px;
  }
  .stats div {
    min-height: 58px;
    padding: 0 8px 0 0;
    border-right: 1px solid #dfe8f3;
    border-bottom: 0;
  }
  .stats div:last-child {
    border-right: 0;
  }
  .stats strong {
    font-size: 20px;
  }
  .stats span {
    font-size: 10px;
    line-height: 1.35;
  }
  .product-preview {
    border-radius: 14px;
    transform: none;
  }
  .mini-console {
    grid-template-columns: .95fr 1.05fr;
    min-height: 260px;
  }
  .mini-sidebar,
  .mini-panel {
    padding: 16px;
  }
  .mini-sidebar {
    border-right: 1px solid #e6edf6;
    border-bottom: 0;
  }
  .mini-row {
    gap: 8px;
    padding: 10px 0;
    font-size: 12px;
  }
  .mini-panel h3 {
    font-size: 15px;
  }
  .mini-card {
    padding: 12px;
  }
  .section,
  .band,
  .closing {
    padding: 48px 0;
  }
  #product.section {
    padding-top: 42px;
  }
  #product h2,
  #features h2,
  #security h2,
  #deploy h2,
  .closing h2 {
    font-size: clamp(30px, 8.4vw, 36px);
    line-height: 1.12;
  }
  #product .section-copy {
    max-width: none;
    padding: 0;
    border-left: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .position-card,
  .feature-card,
  .deploy-card {
    min-height: 0;
    padding: 18px;
  }
  .position-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .position-card {
    padding: 16px;
  }
  .position-card strong {
    margin-top: 10px;
  }
  .position-card span {
    font-size: 11px;
    line-height: 1.45;
  }
  .feature-grid,
  .deploy-grid {
    gap: 12px;
  }
  .feature-card h3,
  .deploy-card h3 {
    margin-top: 16px;
  }
  .deploy-flow {
    gap: 12px;
  }
  .deploy-step {
    min-height: 74px;
  }
}
</style>`);

if (!html.includes('https://github.com/nmklio/CoLiPas')) {
  throw new Error(`Unable to add GitHub link to ${file}`);
}

if (changed) {
  fs.writeFileSync(file, html);
}
NODE
    patched=1
    echo "CoLiPas cloud server management panel landing page UI ready: $landing_file"
  done

  if [ "$patched" -eq 0 ]; then
    echo "WARN: CoLiPas cloud server management panel landing page was not found; skipped landing UI patch" >&2
  fi
}

write_docs_page() {
  if [ ! -d "$LANDING_ROOT" ]; then
    return 0
  fi

  cat >"$LANDING_ROOT/colipas-icon.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="title desc">
  <title id="title">CoLiPas云服务器管理面板 icon</title>
  <desc id="desc">A cloud operations terminal mark on a teal and blue rounded square.</desc>
  <defs>
    <linearGradient id="colipas-bg" x1="8" y1="4" x2="58" y2="62" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="0.48" stop-color="#0f766e"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <linearGradient id="colipas-edge" x1="16" y1="13" x2="48" y2="49" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ecfeff"/>
      <stop offset="1" stop-color="#bae6fd"/>
    </linearGradient>
  </defs>
  <rect x="3" y="3" width="58" height="58" rx="16" fill="url(#colipas-bg)"/>
  <path d="M18.6 41.5h27.2c5.3 0 9.5-3.8 9.5-8.7 0-4.4-3.4-8-7.8-8.6C45.8 17.8 40.2 13 33.5 13c-7.2 0-13.2 5.1-14.3 11.9C13.4 25.7 9 30.4 9 36c0 3.2 1.4 5.8 3.9 7.2" fill="none" stroke="url(#colipas-edge)" stroke-width="4.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M22.2 31.8l5 4.2-5 4.2" fill="none" stroke="#5eead4" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M32.4 40.2h10.8" fill="none" stroke="#f8fafc" stroke-width="4" stroke-linecap="round"/>
  <circle cx="45.4" cy="23.2" r="3.2" fill="#67e8f9"/>
</svg>
SVG

  cat >"$LANDING_ROOT/docs.html" <<'HTML'
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/colipas-icon.svg">
  <title>CoLiPas云服务器管理面板 使用文档</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #0f172a;
      --muted: #52627a;
      --line: #dce7f4;
      --soft: #f4f8fc;
      --panel: #ffffff;
      --blue: #2563eb;
      --green: #0f766e;
      --shadow: 0 18px 46px rgba(31, 56, 88, .08);
      font-family: Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background:
        linear-gradient(90deg, rgba(37, 99, 235, .045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(37, 99, 235, .04) 1px, transparent 1px),
        linear-gradient(180deg, #fff 0, #f7faff 520px, #f4f7fb 100%);
      background-size: 44px 44px, 44px 44px, auto;
      color: var(--ink);
    }
    a { color: inherit; }
    .nav {
      position: sticky;
      top: 0;
      z-index: 10;
      min-height: 72px;
      border-bottom: 1px solid rgba(210, 220, 235, .86);
      background: rgba(255, 255, 255, .9);
      backdrop-filter: blur(16px);
    }
    .nav-inner,
    .wrap {
      width: min(1180px, calc(100% - 44px));
      margin: 0 auto;
    }
    .nav-inner {
      min-height: 72px;
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 26px;
    }
    .brand,
    .nav-links,
    .nav-actions,
    .button,
    .quick-card a,
    .doc-card h3,
    .check-line {
      display: flex;
      align-items: center;
    }
    .brand {
      gap: 9px;
      text-decoration: none;
      font-weight: 950;
    }
    .brand svg {
      width: 36px;
      height: 36px;
      display: block;
      flex: 0 0 36px;
      filter: drop-shadow(0 10px 18px rgba(15, 118, 110, .18));
    }
    .nav-links {
      justify-content: center;
      gap: 28px;
    }
    .nav-links a,
    .nav-actions a {
      color: #243449;
      text-decoration: none;
      font-size: 14px;
      font-weight: 850;
    }
    .nav-links a:hover,
    .nav-actions a:hover {
      color: var(--blue);
    }
    .nav-actions { gap: 10px; }
    .nav-action {
      min-height: 42px;
      border-radius: 10px;
      padding: 0 18px;
      border: 1px solid transparent;
      background: var(--blue);
      color: #fff !important;
      box-shadow: 0 16px 34px rgba(37, 99, 235, .2);
    }
    .nav-github {
      min-height: 42px;
      border-radius: 10px;
      padding: 0 16px;
      border: 1px solid var(--line);
      background: #fff;
      display: inline-flex;
      align-items: center;
    }
    .hero {
      padding: 72px 0 58px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
      gap: 48px;
      align-items: end;
    }
    .kicker {
      margin: 0 0 18px;
      color: var(--blue);
      font-size: 13px;
      font-weight: 950;
    }
    .kicker::before {
      content: "";
      width: 22px;
      height: 2px;
      margin-right: 10px;
      display: inline-block;
      vertical-align: middle;
      background: var(--blue);
    }
    h1 {
      margin: 0;
      max-width: 900px;
      font-size: clamp(44px, 6vw, 76px);
      line-height: 1;
      letter-spacing: 0;
    }
    .lead {
      max-width: 820px;
      margin: 24px 0 0;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.75;
    }
    .hero-actions {
      margin-top: 30px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .button {
      min-height: 48px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 18px;
      background: #fff;
      color: #122033;
      text-decoration: none;
      font-weight: 900;
    }
    .button.primary {
      border-color: var(--blue);
      background: var(--blue);
      color: #fff;
    }
    .quick-card,
    .section,
    .doc-card,
    .terminal-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, .92);
      box-shadow: var(--shadow);
    }
    .quick-card {
      padding: 18px;
      display: grid;
      gap: 10px;
    }
    .quick-card strong {
      font-size: 18px;
    }
    .quick-card a {
      min-height: 42px;
      justify-content: space-between;
      border: 1px solid #e3edf8;
      border-radius: 8px;
      padding: 0 12px;
      background: #fbfdff;
      text-decoration: none;
      font-weight: 850;
    }
    .layout {
      display: grid;
      grid-template-columns: 230px minmax(0, 1fr);
      gap: 34px;
      padding-bottom: 88px;
      align-items: start;
    }
    .sidebar {
      position: sticky;
      top: 96px;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: rgba(255, 255, 255, .9);
      box-shadow: var(--shadow);
      display: grid;
      gap: 5px;
    }
    .sidebar a {
      border-radius: 8px;
      padding: 10px 12px;
      color: #405572;
      text-decoration: none;
      font-weight: 850;
    }
    .sidebar a:hover {
      background: #eaf2ff;
      color: var(--blue);
    }
    .content {
      display: grid;
      gap: 18px;
    }
    .section {
      scroll-margin-top: 96px;
      padding: clamp(22px, 4vw, 34px);
    }
    .section h2 {
      margin: 0;
      font-size: clamp(28px, 3.8vw, 42px);
      line-height: 1.1;
    }
    .section p {
      color: var(--muted);
      line-height: 1.72;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .doc-card {
      padding: 20px;
      box-shadow: none;
      display: grid;
      gap: 10px;
    }
    .doc-card h3 {
      gap: 10px;
      margin: 0;
      font-size: 19px;
    }
    .badge {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      color: #fff;
      background: #142037;
      font-weight: 950;
    }
    code,
    pre {
      border: 1px solid #dce8f5;
      border-radius: 8px;
      background: #0f172a;
      color: #dceafe;
      overflow-x: auto;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    code { padding: 10px 12px; }
    pre {
      margin: 0;
      padding: 14px;
      line-height: 1.55;
    }
    .table {
      display: grid;
      gap: 10px;
    }
    .table div {
      border: 1px solid #e1ebf7;
      border-radius: 8px;
      padding: 14px;
      background: #fbfdff;
      display: grid;
      grid-template-columns: minmax(210px, .35fr) minmax(0, 1fr);
      gap: 16px;
      align-items: center;
    }
    .table code {
      background: transparent;
      border: 0;
      padding: 0;
      color: #1e3a8a;
      font-weight: 900;
    }
    .check-list {
      display: grid;
      gap: 10px;
    }
    .check-line {
      gap: 9px;
      margin: 0;
      color: #30445e;
      line-height: 1.6;
    }
    .check-line span {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #e8f5ee;
      color: var(--green);
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      font-size: 12px;
      font-weight: 950;
    }
    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(280px, 390px);
      gap: 20px;
      align-items: start;
    }
    .terminal-card {
      padding: 18px;
      display: grid;
      gap: 12px;
      box-shadow: none;
    }
    details {
      border: 1px solid #e1ebf7;
      border-radius: 8px;
      padding: 14px;
      background: #fbfdff;
    }
    summary {
      cursor: pointer;
      font-weight: 900;
    }
    footer {
      border-top: 1px solid rgba(150, 165, 190, .16);
      padding: 28px 0 42px;
      color: #7b8aa2;
      text-align: center;
      font-weight: 800;
    }
    @media (max-width: 960px) {
      .nav-inner,
      .hero,
      .layout,
      .split {
        grid-template-columns: 1fr;
      }
      .nav-inner {
        padding: 14px 0;
        align-items: start;
      }
      .nav-links,
      .nav-actions {
        justify-content: flex-start;
        flex-wrap: wrap;
      }
      .sidebar {
        position: static;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 640px) {
      .nav { position: static; }
      .nav-inner,
      .wrap {
        width: calc(100% - 32px);
      }
      .nav-links {
        gap: 14px;
        overflow-x: auto;
        flex-wrap: nowrap;
        padding-bottom: 4px;
      }
      .nav-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .nav-action,
      .nav-github,
      .button {
        width: 100%;
        justify-content: center;
      }
      .hero {
        padding: 48px 0 34px;
      }
      h1 {
        font-size: 42px;
      }
      .lead {
        font-size: 16px;
      }
      .grid,
      .table div,
      .sidebar {
        grid-template-columns: 1fr;
      }
      .section {
        padding: 18px;
      }
    }
  </style>
</head>
<body>
  <header class="nav">
    <div class="nav-inner">
      <a class="brand" href="/" aria-label="CoLiPas云服务器管理面板">
        <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="docs-colipas-bg" x1="8" y1="4" x2="58" y2="62" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#0f172a"/>
              <stop offset="0.48" stop-color="#0f766e"/>
              <stop offset="1" stop-color="#2563eb"/>
            </linearGradient>
            <linearGradient id="docs-colipas-edge" x1="16" y1="13" x2="48" y2="49" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#ecfeff"/>
              <stop offset="1" stop-color="#bae6fd"/>
            </linearGradient>
          </defs>
          <rect x="3" y="3" width="58" height="58" rx="16" fill="url(#docs-colipas-bg)"/>
          <path d="M18.6 41.5h27.2c5.3 0 9.5-3.8 9.5-8.7 0-4.4-3.4-8-7.8-8.6C45.8 17.8 40.2 13 33.5 13c-7.2 0-13.2 5.1-14.3 11.9C13.4 25.7 9 30.4 9 36c0 3.2 1.4 5.8 3.9 7.2" fill="none" stroke="url(#docs-colipas-edge)" stroke-width="4.8" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M22.2 31.8l5 4.2-5 4.2" fill="none" stroke="#5eead4" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M32.4 40.2h10.8" fill="none" stroke="#f8fafc" stroke-width="4" stroke-linecap="round"/>
          <circle cx="45.4" cy="23.2" r="3.2" fill="#67e8f9"/>
        </svg>
        <strong>CoLiPas云服务器管理面板</strong>
      </a>
      <nav class="nav-links" aria-label="文档导航">
        <a href="/">产品</a>
        <a href="/#features">功能</a>
        <a href="/#security">安全</a>
        <a href="/#deploy">部署</a>
        <a href="/docs.html">文档</a>
      </nav>
      <div class="nav-actions">
        <a class="nav-github" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">GitHub</a>
        <a class="nav-action" href="/admin/">进入后台</a>
      </div>
    </div>
  </header>

  <section class="hero wrap">
    <div>
      <p class="kicker">使用文档</p>
      <h1>下载、配置、运行，完整落地 CoLiPas云服务器管理面板</h1>
      <p class="lead">这份文档按上线顺序组织：先部署生产服务，再接入服务器，随后验证 SSH、AI、自定义 API、运维编排、数据库持久化和安全审计。所有公开内容只使用示例配置，不包含真实服务器、密码、API Key 或用户数据。</p>
      <div class="hero-actions">
        <a class="button primary" href="#install">开始部署</a>
        <a class="button" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">打开 GitHub</a>
      </div>
    </div>
    <aside class="quick-card" aria-label="快速导航">
      <strong>快速导航</strong>
      <a href="#install">安装部署 <span>→</span></a>
      <a href="#config">环境变量 <span>→</span></a>
      <a href="#server-access">服务器接入 <span>→</span></a>
      <a href="#ai">AI 设置 <span>→</span></a>
      <a href="#security">安全上线 <span>→</span></a>
    </aside>
  </section>

  <div class="layout wrap">
    <aside class="sidebar" aria-label="页面目录">
      <a href="#install">安装部署</a>
      <a href="#config">环境变量</a>
      <a href="#server-access">服务器接入</a>
      <a href="#ai">AI 助手</a>
      <a href="#ssh">SSH 与编排</a>
      <a href="#api">API 与代理</a>
      <a href="#security">安全上线</a>
      <a href="#faq">常见问题</a>
    </aside>

    <main class="content">
      <section id="install" class="section">
        <p class="kicker">安装部署</p>
        <h2>一套源码，支持 Docker 和 Linux systemd</h2>
        <p>生产服务统一监听 8080，构建后的前端资源和后端 API 由同一个 Node 服务提供；公网 HTTPS 建议放在 Nginx、Caddy 或云负载均衡之后。</p>
        <div class="grid">
          <article class="doc-card">
            <h3><span class="badge">1</span> 获取项目</h3>
            <p>从公开仓库获取源码，安装依赖前先确认 Node.js 版本。</p>
            <code>git clone https://github.com/nmklio/CoLiPas.git && cd CoLiPas</code>
          </article>
          <article class="doc-card">
            <h3><span class="badge">2</span> 配置环境</h3>
            <p>复制示例环境变量，替换所有默认密码、密钥和域名配置。</p>
            <code>cp .env.example .env</code>
          </article>
          <article class="doc-card">
            <h3><span class="badge">3</span> 灰度测试</h3>
            <p>上线前先构建、启动临时生产服务并跑 API、浏览器、并发和安全烟测。</p>
            <code>npm test</code>
          </article>
          <article class="doc-card">
            <h3><span class="badge">4</span> 启动服务</h3>
            <p>本机或服务器上只需要一个生产入口，不要把 5173 当作正式服务。</p>
            <code>PORT=8080 npm start</code>
          </article>
        </div>
      </section>

      <section id="config" class="section">
        <p class="kicker">环境变量</p>
        <h2>上线前必须替换默认值</h2>
        <div class="table">
          <div><code>ADMIN_USERNAME / ADMIN_PASSWORD</code><p>管理员账号和初始密码，部署后应立即在后台修改密码。</p></div>
          <div><code>SESSION_SECRET</code><p>会话签名密钥，必须使用长随机字符串。</p></div>
          <div><code>CREDENTIAL_ENCRYPTION_KEY</code><p>SSH 密码和私钥的加密密钥，不能提交到 Git。</p></div>
          <div><code>COLIPAS_DATA_DIR / COLIPAS_DB_PATH</code><p>SQLite 数据库和运行数据目录，默认位于 .data。</p></div>
          <div><code>AI_BASE_URL / AI_API_KEY / AI_MODEL</code><p>OpenAI 兼容 API 配置；不配置密钥时只使用本地模拟分析。</p></div>
          <div><code>CUSTOM_API_ALLOWED_HOSTS</code><p>自定义 API 代理允许访问的域名白名单。</p></div>
        </div>
      </section>

      <section id="server-access" class="section">
        <p class="kicker">服务器接入</p>
        <h2>资产登记、真实 SSH 验证和地图联动</h2>
        <div class="grid">
          <article class="doc-card">
            <h3>资产模式</h3>
            <p>只登记服务器名称、IP、地区、系统和标签，不会显示为已接入，也不会允许执行 SSH 命令。</p>
          </article>
          <article class="doc-card">
            <h3>SSH 模式</h3>
            <p>支持密码和私钥认证。真实验证成功后，服务器状态才会进入可执行运维动作的链路。</p>
          </article>
          <article class="doc-card">
            <h3>小地图</h3>
            <p>总览会按地域聚合服务器，支持悬停详情、点击筛选、缩放、移动端 pinned tooltip 和跳转服务器列表。</p>
          </article>
          <article class="doc-card">
            <h3>生命周期</h3>
            <p>未接入、运行中、已停止分别代表不同能力边界；关机后显示已停止，未验证不会伪装成运行中。</p>
          </article>
        </div>
      </section>

      <section id="ai" class="section split">
        <div>
          <p class="kicker">AI 助手</p>
          <h2>真实流式对话、模型读取和本地缓存</h2>
          <p>AI 面板支持 OpenAI 兼容接口，后端使用 stream:true，并把多轮上下文传给上游。相同问题会在本地缓存窗口内复用结果，也可以强制刷新重新生成。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 模型列表从上游 /v1/models 获取。</p>
            <p class="check-line"><span>✓</span> API Key 不写入 Git，也不会进入浏览器持久化配置。</p>
            <p class="check-line"><span>✓</span> 上游错误会脱敏后再展示。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>AI request contract</strong>
          <pre>POST /api/ai/stream
{
  "provider": {
    "baseUrl": "https://.../v1",
    "model": "model-name",
    "apiKey": "sk-***"
  },
  "messages": [...],
  "forceRefresh": false
}</pre>
        </aside>
      </section>

      <section id="ssh" class="section split">
        <div>
          <p class="kicker">SSH 与运维编排</p>
          <h2>先验证目标，再执行命令</h2>
          <p>实时终端使用 PTY 流式输出，命令执行期间输入框保持可响应；运维编排会拒绝未接入或不存在的服务器，重启、关机等动作需要二次确认。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 支持 Ctrl+C 中断长命令。</p>
            <p class="check-line"><span>✓</span> 支持终端 resize 和实时输出。</p>
            <p class="check-line"><span>✓</span> 任务结果会关联审计 trace。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>常用诊断命令</strong>
          <pre>uptime
whoami
df -h
free -m
systemctl status ssh --no-pager</pre>
        </aside>
      </section>

      <section id="api" class="section">
        <p class="kicker">API 与自定义代理</p>
        <h2>业务 API 需要登录，自定义代理需要白名单</h2>
        <div class="table">
          <div><code>GET /api/health</code><p>公开健康检查，返回运行状态、SQLite 驱动名称和短发布标识，不暴露路径或密钥。</p></div>
          <div><code>POST /api/auth/login</code><p>管理员登录，失败次数会限速并返回 Retry-After。</p></div>
          <div><code>GET /api/overview</code><p>登录后读取账号、服务器、事件和总览指标。</p></div>
          <div><code>POST /api/custom-apis/test</code><p>通过后端代理测试外部接口，阻止内网地址、敏感 Header 和重定向 SSRF。</p></div>
          <div><code>POST /api/audit/remediate</code><p>执行安全风险确认或修复动作，并写入审计记录。</p></div>
        </div>
      </section>

      <section id="security" class="section split">
        <div>
          <p class="kicker">安全上线清单</p>
          <h2>公网部署前逐项确认</h2>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 修改管理员密码，不使用默认演示密码。</p>
            <p class="check-line"><span>✓</span> 使用强随机 SESSION_SECRET 和 CREDENTIAL_ENCRYPTION_KEY。</p>
            <p class="check-line"><span>✓</span> 限制 CUSTOM_API_ALLOWED_HOSTS，避免代理被滥用。</p>
            <p class="check-line"><span>✓</span> 备份 .data/colipas.sqlite，不提交 .env、.data、私钥或截图里的真实资产。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>灰度测试命令</strong>
          <pre>npm test
node scripts/secret-scan.mjs
npm audit --omit=dev --audit-level=high
curl -fsS http://127.0.0.1:8080/api/health</pre>
        </aside>
      </section>

      <section id="faq" class="section">
        <p class="kicker">常见问题</p>
        <h2>排障时先看这里</h2>
        <div class="check-list">
          <details open><summary>后台地址在哪里？</summary><p>生产入口是你的域名或 http://127.0.0.1:8080/，后台登录入口是 /admin/。5173 只用于 Vite 开发服务。</p></details>
          <details><summary>为什么乱填服务器不能显示已接入？</summary><p>真实接入必须通过 SSH 握手。资产模式只登记信息，不会显示已接入，也不会允许执行远程命令。</p></details>
          <details><summary>AI 回答是不是固定的？</summary><p>未配置有效 API Key 时会返回本地模拟分析；配置 OpenAI 兼容 API 并测试成功后，会使用真实流式模型。</p></details>
          <details><summary>数据存在哪里？</summary><p>默认保存在 .data/colipas.sqlite。SSH 凭据会加密后存储，请保护 .env 和 .data。</p></details>
        </div>
      </section>
    </main>
  </div>

  <footer class="wrap">CoLiPas cloud server management panel docs · public-safe deployment guide · no runtime secrets embedded</footer>
</body>
</html>
HTML
  echo "CoLiPas cloud server management panel docs page ready: $LANDING_ROOT/docs.html"
}

install_runtime_update_script() {
  if [ -f "$APP_DIR/deploy/server-update.sh" ]; then
    install -m 0755 "$APP_DIR/deploy/server-update.sh" /usr/local/sbin/colipas-update
  fi
}

verify_release_evidence() {
  if [ ! -f "$APP_DIR/.env" ] || [ ! -f "$APP_DIR/deploy/release-evidence-check.mjs" ]; then
    echo "WARN: release evidence check is unavailable; skipped" >&2
    return 0
  fi

  env \
    $(grep -E '^(RELEASE_VERIFY_TOKEN|RELEASE_TARGET_NAME|RELEASE_DEPLOYMENT_MODE|RELEASE_GIT_COMMIT)=' "$APP_DIR/.env" | xargs) \
    RELEASE_VERIFY_BASE_URL="http://127.0.0.1:8080" \
    node "$APP_DIR/deploy/release-evidence-check.mjs"
}

generate_release_verify_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
}

ensure_fallback_ssl_certificate() {
  local fallback_cert="/etc/ssl/certs/colipas-selfsigned.crt"
  local fallback_key="/etc/ssl/private/colipas-selfsigned.key"

  if [ -f "$fallback_cert" ] && [ -f "$fallback_key" ]; then
    return 0
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    return 1
  fi

  install -d -m 0755 /etc/ssl/certs
  install -d -m 0710 /etc/ssl/private
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$fallback_key" \
    -out "$fallback_cert" \
    -subj "/CN=$SERVER_NAME" \
    -addext "subjectAltName=DNS:$SERVER_NAME" >/dev/null 2>&1
  chmod 0644 "$fallback_cert"
  chmod 0600 "$fallback_key"
}

current_release_verify_token() {
  if [ ! -f "$APP_DIR/.env" ]; then
    return 0
  fi

  grep -E '^RELEASE_VERIFY_TOKEN=' "$APP_DIR/.env" | tail -1 | cut -d= -f2- || true
}

write_release_evidence_env() {
  local deployed_at="${1:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
  local commit_sha="${2:-$REMOTE_HEAD}"
  local release_target_name="${RELEASE_TARGET_NAME:-$SERVER_NAME}"
  local release_channel="${RELEASE_CHANNEL:-production}"
  local release_deployment_mode="${RELEASE_DEPLOYMENT_MODE:-systemd}"
  local release_artifact_id="${RELEASE_ARTIFACT_ID:-systemd-$BRANCH}"
  RELEASE_VERIFY_TOKEN_VALUE="$(current_release_verify_token)"
  if [ "${#RELEASE_VERIFY_TOKEN_VALUE}" -lt 24 ]; then
    RELEASE_VERIFY_TOKEN_VALUE="$(generate_release_verify_token)"
  fi
  if [ -f "$APP_DIR/.env" ]; then
    tmp_env="$(mktemp)"
    grep -Ev '^(RELEASE_VERIFY_TOKEN|RELEASE_TARGET_NAME|RELEASE_CHANNEL|RELEASE_DEPLOYMENT_MODE|RELEASE_PUBLIC_URL|RELEASE_GIT_COMMIT|RELEASE_ARTIFACT_ID|RELEASE_DEPLOYED_AT)=' "$APP_DIR/.env" > "$tmp_env" || true
    {
      cat "$tmp_env"
      printf 'RELEASE_VERIFY_TOKEN=%s\n' "$RELEASE_VERIFY_TOKEN_VALUE"
      printf 'RELEASE_TARGET_NAME=%s\n' "$release_target_name"
      printf 'RELEASE_CHANNEL=%s\n' "$release_channel"
      printf 'RELEASE_DEPLOYMENT_MODE=%s\n' "$release_deployment_mode"
      printf 'RELEASE_PUBLIC_URL=%s\n' "$PUBLIC_URL"
      printf 'RELEASE_GIT_COMMIT=%s\n' "$commit_sha"
      printf 'RELEASE_ARTIFACT_ID=%s\n' "$release_artifact_id"
      printf 'RELEASE_DEPLOYED_AT=%s\n' "$deployed_at"
    } > "$APP_DIR/.env"
    rm -f "$tmp_env"
    if [ "$(id -u)" -eq 0 ]; then
      chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
      chmod 0600 "$APP_DIR/.env"
    fi
  fi

  if [ "$(id -u)" -eq 0 ]; then
    install -d -m 0755 /etc/default
    cat >/etc/default/colipas-release <<DEFAULTS
COLIPAS_SERVER_NAME=$SERVER_NAME
RELEASE_PUBLIC_URL=$PUBLIC_URL
RELEASE_TARGET_NAME=$release_target_name
RELEASE_CHANNEL=$release_channel
RELEASE_DEPLOYMENT_MODE=$release_deployment_mode
RELEASE_GIT_COMMIT=$commit_sha
RELEASE_ARTIFACT_ID=$release_artifact_id
RELEASE_DEPLOYED_AT=$deployed_at
DEFAULTS
    chmod 0644 /etc/default/colipas-release
  fi
}

install_nginx_config() {
  local nginx_ssl_certificate="$SSL_CERTIFICATE"
  local nginx_ssl_certificate_key="$SSL_CERTIFICATE_KEY"

  if [ ! -f "$nginx_ssl_certificate" ] || [ ! -f "$nginx_ssl_certificate_key" ]; then
    if ensure_fallback_ssl_certificate; then
      nginx_ssl_certificate="/etc/ssl/certs/colipas-selfsigned.crt"
      nginx_ssl_certificate_key="/etc/ssl/private/colipas-selfsigned.key"
    fi
  fi

  if [ -f "$LANDING_ROOT/index.html" ] && [ -f "$nginx_ssl_certificate" ] && [ -f "$nginx_ssl_certificate_key" ]; then
    cat >/etc/nginx/sites-available/colipas.conf <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name $SERVER_NAME;

  location ^~ /.well-known/acme-challenge/ {
    root /var/www/html;
  }

  location / {
    return 301 https://\$host\$request_uri;
  }
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name $SERVER_NAME;

  ssl_certificate $nginx_ssl_certificate;
  ssl_certificate_key $nginx_ssl_certificate_key;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 10m;

  root $LANDING_ROOT;
  index index.html;
  client_max_body_size 2m;

  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;

  location = / {
    try_files /index.html =404;
  }

  location = /docs.html {
    try_files /docs.html =404;
  }

  location = /docs {
    return 302 /docs.html;
  }

  location = /colipas-icon.svg {
    try_files /colipas-icon.svg =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }

  location = /admin {
    return 302 /admin/;
  }

  location ^~ /admin/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }

  location ^~ /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }

  location ^~ /assets/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }
}
NGINX
  else
    cat >/etc/nginx/sites-available/colipas.conf <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name $SERVER_NAME;

  root $LANDING_ROOT;
  index index.html;
  client_max_body_size 2m;

  add_header X-Frame-Options "SAMEORIGIN" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;

  location ^~ /.well-known/acme-challenge/ {
    root /var/www/html;
  }

  location = / {
    try_files /index.html =404;
  }

  location = /docs.html {
    try_files /docs.html =404;
  }

  location = /docs {
    return 302 /docs.html;
  }

  location = /colipas-icon.svg {
    try_files /colipas-icon.svg =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }

  location = /admin {
    return 302 /admin/;
  }

  location ^~ /admin/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto http;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }

  location ^~ /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto http;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
  }

  location ^~ /assets/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto http;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }
}
NGINX
  fi

  ln -sfn /etc/nginx/sites-available/colipas.conf /etc/nginx/sites-enabled/colipas.conf
}

cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "ERROR: $APP_DIR is not a git checkout" >&2
  exit 1
fi

run_as_app git fetch --prune origin "$BRANCH"
LOCAL_HEAD="$(run_as_app git rev-parse HEAD)"
REMOTE_HEAD="$(run_as_app git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  ensure_current_build
  DEPLOYED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  write_release_evidence_env "$DEPLOYED_AT" "$REMOTE_HEAD"
  if [ "$(id -u)" -eq 0 ]; then
    install_runtime_update_script
    install_deploy_sudo_env_keep
    install_deploy_forced_command_env_preserve
    patch_landing_page_ui
    write_docs_page
    install_nginx_config
    nginx -t
    systemctl reload nginx
  fi
  reset_admin_password_if_requested
  systemctl restart "$SERVICE_NAME"
  systemctl is-active --quiet "$SERVICE_NAME"
  verify_release_evidence
  echo "CoLiPas cloud server management panel already up to date at $LOCAL_HEAD"
  exit 0
fi

run_as_app git reset --hard "$REMOTE_HEAD"
run_as_app npm ci
ensure_current_build
DEPLOYED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
write_release_evidence_env "$DEPLOYED_AT" "$REMOTE_HEAD"
if [ "$(id -u)" -eq 0 ]; then
  install_runtime_update_script
  install_deploy_sudo_env_keep
  install_deploy_forced_command_env_preserve
  install -m 0644 "$APP_DIR/deploy/colipas.service" /etc/systemd/system/colipas.service
  patch_landing_page_ui
  write_docs_page
  install_nginx_config
  systemctl daemon-reload
  nginx -t
  systemctl reload nginx
fi
reset_admin_password_if_requested
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME"
verify_release_evidence
echo "CoLiPas cloud server management panel updated to $REMOTE_HEAD"
