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
RUNTIME_UPDATE_SCRIPT="/usr/local/sbin/colipas-update"
SCRIPT_REEXECED="${COLIPAS_UPDATE_SCRIPT_REEXECED:-}"

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

function landingIcon(kind, className) {
  const paths = {
    assets: '<path d="M7.2 16.8h9.4a3.5 3.5 0 0 0 .4-6.9 5.5 5.5 0 0 0-10.8 2.4 3.3 3.3 0 0 0 1 4.5Z"/><rect x="7.7" y="12.6" width="3.8" height="3.1" rx=".8"/><rect x="12.9" y="12.6" width="3.8" height="3.1" rx=".8"/><path d="M11.5 14.1h1.4M12.2 9.2v3.4"/>',
    cloud: '<path d="M7.2 17.2h9.2a3.6 3.6 0 0 0 .4-7.1 5.5 5.5 0 0 0-10.7 2.6 3.3 3.3 0 0 0 1.1 4.5Z"/><path d="M8.8 12.5h6.4"/><path d="M10.2 9.6h3.7"/>',
    map: '<path d="M12 21s6-5.1 6-10.2A6 6 0 0 0 6 10.8C6 15.9 12 21 12 21Z"/><circle cx="12" cy="10.8" r="2.2"/>',
    terminal: '<rect x="4.2" y="5" width="15.6" height="14" rx="2.7"/><path d="M4.2 8.6h15.6"/><path d="m8 12 2.5 2L8 16"/><path d="M13.4 16h4.1"/><circle cx="7" cy="6.9" r=".45"/><circle cx="8.8" cy="6.9" r=".45"/>',
    ai: '<rect x="7.1" y="7.1" width="9.8" height="9.8" rx="2.2"/><path d="M12 3.8v3.3M12 16.9v3.3M3.8 12h3.3M16.9 12h3.3M8.5 4.6l1.2 2.8M15.5 4.6l-1.2 2.8M8.5 19.4l1.2-2.8M15.5 19.4l-1.2-2.8"/><circle cx="10.3" cy="11.7" r=".55"/><circle cx="13.7" cy="11.7" r=".55"/><path d="M10.5 14h3"/>',
    checklist: '<rect x="5" y="4.3" width="14" height="15.4" rx="2.4"/><path d="M8.2 9h7.2M8.2 13h7.2M8.2 17h4.2"/><path d="M6.5 9.1 l0.8 0.8 1.4 -1.6M6.5 13.1 l0.8 0.8 1.4 -1.6M6.5 17.1 l0.8 0.8 1.4 -1.6"/>',
    flow: '<circle cx="6.5" cy="7" r="2.2"/><circle cx="17.5" cy="7" r="2.2"/><circle cx="12" cy="17" r="2.2"/><path d="M8.6 7h6.8M7.8 9l3.1 5.7M16.2 9l-3.1 5.7"/>',
    shield: '<path d="M12 3.8 18.3 6v5.3c0 4.1-2.5 7.2-6.3 8.9-3.8-1.7-6.3-4.8-6.3-8.9V6L12 3.8Z"/><path d="M9.2 12.1 11.1 14l3.9-4.3"/><path d="M8.6 17.3h6.8"/>',
    command: '<rect x="4.2" y="5" width="15.6" height="14" rx="2.7"/><path d="M4.2 9.1h15.6"/><path d="m8 12.2 2.5 1.8L8 15.8"/><path d="M13.3 15.7h3.6"/><circle cx="7" cy="7.1" r=".55"/><circle cx="8.9" cy="7.1" r=".55"/>',
    code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/><path d="m13.2 6.8-2.4 10.4"/>',
    database: '<ellipse cx="12" cy="6.4" rx="6.8" ry="2.8"/><path d="M5.2 6.4v7.2c0 1.6 3 2.8 6.8 2.8s6.8-1.2 6.8-2.8V6.4"/><path d="M5.2 10c0 1.6 3 2.8 6.8 2.8s6.8-1.2 6.8-2.8"/>',
  };
  return `<span class="${className} icon-${kind}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${paths[kind]}</svg></span>`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function landingPositionCard(kind, title, description) {
  const stageLabels = {
    assets: '登记',
    terminal: '验证',
    ai: '诊断',
    shield: '留痕',
  };
  const steps = {
    assets: '01',
    terminal: '02',
    ai: '03',
    shield: '04',
  };
  return `<article class="position-card position-card-modern position-flow-card position-flow-${kind}"><span class="position-step">${steps[kind]}</span><div class="position-copy"><strong>${title}</strong><span>${description}</span></div><span class="position-state">${stageLabels[kind]}</span></article>`;
}

function replacePositionCard(title, kind, description) {
  replaceAll(
    new RegExp(`<article class="position-card(?: [^"]*)?">(?:(?!<\\/article>)[\\s\\S])*?<strong>${escapeRegExp(title)}<\\/strong>(?:(?!<\\/article>)[\\s\\S])*?<\\/article>`, 'g'),
    landingPositionCard(kind, title, description),
  );
}

replaceAll(/\/\* colipas landing balanced ui(?: v[0-9]+)? \*\/[\s\S]*?(?=<\/style>)/g, '');
replaceAll(/<title>[\s\S]*?<\/title>/g, '<title>CoLiPas云服务器管理面板</title>');
replaceAll(/<link\s+rel="icon"[^>]*>/g, '');
replaceOnce(/<title>CoLiPas云服务器管理面板<\/title>/, '<title>CoLiPas云服务器管理面板</title>\n<link rel="icon" type="image/svg+xml" href="/colipas-icon.svg?v=20260530-brand3">');
replaceAll(/<a class="button github-button" href="https:\/\/github\.com\/nmklio\/CoLiPas"[^>]*>GitHub<\/a>/g, '');
replaceAll(/<span class="brand-mark">CP<\/span>/g, '<img class="brand-mark" src="/colipas-icon.svg" alt="" aria-hidden="true">');

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
  `${prefix}资产、终端、AI、编排和审计围绕同一批服务器联动，接入状态、命令结果和风险记录都能在后台连续追踪。${suffix}`
));

replacePositionCard('资产接入', 'assets', '自建 / 海外 / 私有云 / 其他云');
replacePositionCard('实时运维', 'terminal', 'SSH 终端 / 命令 / 诊断');
replacePositionCard('AI 分析', 'ai', '流式对话 / 模型拉取 / 缓存');
replacePositionCard('审计闭环', 'shield', '登录 / API / 编排 / 修复');

replaceAll(/\u4e91\u7ef4\u7f16\u6392/g, '运维编排');

replaceAll(/<span class="icon">01<\/span>/g, landingIcon('cloud', 'icon feature-icon'));
replaceAll(/<span class="icon">02<\/span>/g, landingIcon('map', 'icon feature-icon'));
replaceAll(/<span class="icon">03<\/span>/g, landingIcon('terminal', 'icon feature-icon'));
replaceAll(/<span class="icon">04<\/span>/g, landingIcon('ai', 'icon feature-icon'));
replaceAll(/<span class="icon">05<\/span>/g, landingIcon('flow', 'icon feature-icon'));
replaceAll(/<span class="icon">06<\/span>/g, landingIcon('shield', 'icon feature-icon'));

if (!html.includes('data-colipas-feature="contextual-launch-summary"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      <article class="feature-card" data-colipas-feature="contextual-launch-summary">${landingIcon('checklist', 'icon feature-icon')}<h3>上下文上线检查</h3><p>总览保留完整上线清单；进入服务器、AI、运维、API 和安全工作区后自动压缩为摘要，需要证据时再一键展开。</p><div class="tags"><span>渐进披露</span><span>性能模式联动</span></div></article>`);
}

if (!html.includes('data-colipas-feature="fleet-views"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      <article class="feature-card" data-colipas-feature="fleet-views">${landingIcon('checklist', 'icon feature-icon')}<h3>资产视图</h3><p>把关键词、厂商、状态、地域和健康筛选保存为浏览器本机视图，排障时可一键恢复工作范围。</p><div class="tags"><span>本机保存</span><span>一键恢复</span></div></article>`);
}

if (!html.includes('data-colipas-feature="command-palette-context"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      <article class="feature-card" data-colipas-feature="command-palette-context">${landingIcon('command', 'icon feature-icon')}<h3>上下文命令面板</h3><p>按当前最高优先级事项、最近使用和全部操作分层展示跨模块入口；最近历史只保存在浏览器中，可随时清除。</p><div class="tags"><span>当前优先级</span><span>本机历史</span></div></article>`);
}

replaceAll(/<article class="deploy-card"><h3>Linux systemd<\/h3>/g, `<article class="deploy-card">${landingIcon('terminal', 'deploy-icon')}<h3>Linux systemd</h3>`);
replaceAll(/<article class="deploy-card"><h3>Node 20\+<\/h3>/g, `<article class="deploy-card">${landingIcon('code', 'deploy-icon')}<h3>Node 20+</h3>`);
replaceAll(/<article class="deploy-card"><h3>Docker Compose<\/h3>/g, `<article class="deploy-card">${landingIcon('database', 'deploy-icon')}<h3>Docker Compose</h3>`);
replaceAll(/<section class="closing">[\s\S]*?<\/section>\s*/g, '');

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

replaceOnce('</style>', `/* colipas landing balanced ui v8 */
.brand .brand-mark {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: block;
  object-fit: contain;
  background: transparent;
  box-shadow: 0 14px 30px rgba(15, 118, 110, .16);
}
.position-card,
.feature-card,
.deploy-card {
  position: relative;
  overflow: hidden;
}
.position-card::before,
.feature-card::before,
.deploy-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: linear-gradient(90deg, rgba(37, 99, 235, .92), rgba(15, 118, 110, .78));
  opacity: .78;
}
.feature-icon,
.position-icon,
.deploy-icon {
  width: 52px;
  height: 52px;
  border: 0;
  border-radius: 14px;
  background:
    radial-gradient(circle at 28% 24%, rgba(255, 255, 255, .95), rgba(255, 255, 255, 0) 34%),
    linear-gradient(135deg, #eaf3ff 0%, #d9e8ff 100%);
  color: #1d4ed8;
  display: inline-grid;
  place-items: center;
  box-shadow: inset 0 0 0 1px rgba(37, 99, 235, .16), 0 14px 28px rgba(37, 99, 235, .13);
}
.position-card-modern {
  min-height: 126px;
  padding: 22px;
  border-color: rgba(37, 99, 235, .14);
  background:
    linear-gradient(180deg, rgba(255, 255, 255, .98), rgba(248, 251, 255, .95)),
    radial-gradient(circle at 92% 0%, rgba(37, 99, 235, .08), transparent 36%);
  box-shadow: 0 18px 38px rgba(17, 34, 58, .06);
}
.position-flow-card {
  display: inline-grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  gap: 14px 16px;
  align-items: start;
  color: #102033;
}
.position-step {
  display: block;
  width: max-content;
  min-width: 48px;
  color: #2563eb;
  font-size: 30px;
  line-height: .92;
  font-weight: 950;
  letter-spacing: 0;
}
.position-copy {
  min-width: 0;
}
.position-state {
  min-height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: #eef5ff;
  color: #2563eb;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 950;
}
.position-card-modern strong {
  display: block;
  margin: 0;
  font-size: 18px;
  letter-spacing: 0;
}
.position-card-modern span {
  display: block;
}
.position-card-modern .position-state {
  display: inline-flex;
}
.position-copy span {
  margin-top: 9px;
  color: #5a6c83;
  line-height: 1.55;
  font-size: 12.5px;
  font-weight: 820;
}
.position-card-modern::after {
  content: "";
  width: 42px;
  height: 2px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(37, 99, 235, .65), rgba(15, 118, 110, .52));
  position: absolute;
  left: 22px;
  bottom: 18px;
  opacity: .75;
}
.position-flow-terminal .position-step,
.position-flow-terminal .position-state {
  color: #0f766e;
}
.position-flow-terminal .position-state {
  background: #e8f7f4;
}
.position-flow-ai .position-step,
.position-flow-ai .position-state {
  color: #6d28d9;
}
.position-flow-ai .position-state {
  background: #f1eaff;
}
.position-flow-shield .position-step,
.position-flow-shield .position-state {
  color: #166534;
}
.position-flow-shield .position-state {
  background: #edf8e8;
}
.position-icon,
.deploy-icon {
  margin-bottom: 14px;
}
.feature-icon svg,
.position-icon svg,
.deploy-icon svg {
  width: 27px;
  height: 27px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.25;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.icon-terminal,
.icon-code {
  color: #122033;
  background:
    radial-gradient(circle at 28% 24%, rgba(255, 255, 255, .95), rgba(255, 255, 255, 0) 34%),
    linear-gradient(135deg, #e5f8f4 0%, #cfeee8 100%);
  box-shadow: inset 0 0 0 1px rgba(15, 118, 110, .18), 0 14px 28px rgba(15, 118, 110, .12);
}
.icon-ai,
.icon-flow {
  color: #122033;
  background:
    radial-gradient(circle at 28% 24%, rgba(255, 255, 255, .96), rgba(255, 255, 255, 0) 34%),
    linear-gradient(135deg, #f2ebff 0%, #e4d8ff 100%);
  box-shadow: inset 0 0 0 1px rgba(124, 58, 237, .18), 0 14px 28px rgba(124, 58, 237, .12);
}
.icon-shield {
  color: #122033;
  background:
    radial-gradient(circle at 28% 24%, rgba(255, 255, 255, .96), rgba(255, 255, 255, 0) 34%),
    linear-gradient(135deg, #edf9e8 0%, #d8f0d0 100%);
  box-shadow: inset 0 0 0 1px rgba(22, 101, 52, .17), 0 14px 28px rgba(22, 101, 52, .11);
}
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
  .band {
    padding: 48px 0;
  }
  #product.section {
    padding-top: 42px;
  }
  #product h2,
  #features h2,
  #security h2,
  #deploy h2 {
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
  .position-card-modern {
    min-height: 112px;
    padding: 16px;
    gap: 5px 12px;
  }
  .position-step {
    min-width: 42px;
    font-size: 26px;
  }
  .position-state {
    min-height: 24px;
    font-size: 11px;
    padding-inline: 8px;
  }
  .position-card strong {
    margin-top: 10px;
  }
  .position-card-modern strong {
    margin-top: 0;
    font-size: 15px;
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
  <desc id="desc">A clear cloud terminal mark on a teal and blue rounded square.</desc>
  <defs>
    <linearGradient id="colipas-bg" x1="7" y1="5" x2="57" y2="60" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0f766e"/>
      <stop offset="0.48" stop-color="#0ea5a5"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
    <linearGradient id="colipas-cloud" x1="16" y1="17" x2="50" y2="46" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#dff9ff"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#colipas-bg)"/>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="none" stroke="rgba(255,255,255,.34)" stroke-width="2"/>
  <path d="M19.2 43.5h26.6c5.9 0 10.7-4.2 10.7-9.8 0-5.1-3.9-9.2-8.9-9.7C45.4 18 39.8 14.2 33.2 14.2c-7.2 0-13.1 4.8-14.7 11.4C12.4 26.2 7.8 31 7.8 36.9c0 3.8 1.9 7.1 4.8 9.1 1.9-1.6 4.1-2.5 6.6-2.5Z" fill="url(#colipas-cloud)" opacity=".96"/>
  <path d="M21.6 33.1 27 37.2l-5.4 4.1" fill="none" stroke="#0f766e" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M33.2 41.2h11.5" fill="none" stroke="#2563eb" stroke-width="4.2" stroke-linecap="round"/>
  <circle cx="45.5" cy="22.8" r="3.4" fill="#67e8f9"/>
  <circle cx="45.5" cy="22.8" r="1.5" fill="#0f766e"/>
</svg>
SVG

  cat >"$LANDING_ROOT/docs.html" <<'HTML'
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/colipas-icon.svg?v=20260530-brand3">
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
    .nav-actions {
      gap: 8px;
    }
    .nav-action,
    .nav-github {
      min-height: 36px;
      border-radius: 8px;
      padding: 0 12px;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, .94);
      color: #243449;
      display: inline-flex;
      align-items: center;
      box-shadow: none;
    }
    .nav-action:hover,
    .nav-github:hover {
      border-color: #b8d5ff;
      background: #f8fbff;
      color: var(--blue);
    }
    .hero {
      padding: 64px 0 48px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 370px);
      gap: 42px;
      align-items: center;
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
      max-width: 760px;
      font-size: clamp(36px, 5vw, 64px);
      line-height: 1.06;
      letter-spacing: 0;
    }
    .lead {
      max-width: 780px;
      margin: 20px 0 0;
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
    .hero-steps {
      margin-top: 24px;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .hero-step {
      min-height: 74px;
      border: 1px solid #dfebf8;
      border-radius: 10px;
      padding: 12px;
      background: rgba(255, 255, 255, .72);
    }
    .hero-step b {
      display: block;
      margin-bottom: 5px;
      color: var(--blue);
      font-size: 12px;
    }
    .hero-step span {
      display: block;
      color: #20324a;
      font-size: 13px;
      font-weight: 850;
      line-height: 1.35;
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
      min-width: 0;
    }
    .section {
      scroll-margin-top: 96px;
      padding: clamp(22px, 4vw, 34px);
      min-width: 0;
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
    .section-note {
      margin: 18px 0 0;
      border: 1px solid #cde7df;
      border-radius: 10px;
      padding: 14px 16px;
      background: #f1fbf8;
      color: #155e57;
      font-weight: 850;
      line-height: 1.65;
    }
    .flow {
      margin-top: 18px;
      display: grid;
      gap: 12px;
    }
    .flow-step {
      border: 1px solid #e1ebf7;
      border-radius: 10px;
      padding: 16px;
      background: #fbfdff;
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 14px;
      align-items: start;
    }
    .flow-step b {
      width: 42px;
      height: 42px;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: #142037;
      color: #fff;
    }
    .flow-step h3 {
      margin: 0 0 6px;
      font-size: 18px;
    }
    .flow-step p {
      margin: 0;
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
      min-width: 0;
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
      min-width: 0;
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
        grid-template-columns: minmax(0, 1fr);
      }
      .hero-steps {
        grid-template-columns: repeat(2, minmax(0, 1fr));
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
        min-width: 0;
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
        font-size: 36px;
      }
      .lead {
        font-size: 16px;
      }
      .grid,
      .flow-step,
      .hero-steps,
      .table div,
      .sidebar {
        grid-template-columns: minmax(0, 1fr);
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
        <a class="nav-action" href="/admin/">体验测试地址</a>
      </div>
    </div>
  </header>

  <section class="hero wrap">
    <div>
      <p class="kicker">使用文档</p>
      <h1>CoLiPas 上线与使用手册</h1>
      <p class="lead">按真实交付顺序整理：先用一键脚本部署生产服务，再完成首次登录、服务器接入、SSH 终端、AI 助手、运维编排、自定义 API 和安全审计。公开页面只保留示例命令，不写入真实服务器、密码、API Key 或用户数据。</p>
      <div class="hero-actions">
        <a class="button primary" href="#install">开始部署</a>
        <a class="button" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">打开 GitHub</a>
      </div>
      <div class="hero-steps" aria-label="上线流程">
        <div class="hero-step"><b>01</b><span>一键部署到 Linux 或 Docker</span></div>
        <div class="hero-step"><b>02</b><span>登录后台并修改管理员密码</span></div>
        <div class="hero-step"><b>03</b><span>验证 SSH 后接入资产</span></div>
        <div class="hero-step"><b>04</b><span>开启 AI、编排与安全审计</span></div>
      </div>
    </div>
    <aside class="quick-card" aria-label="快速导航">
      <strong>快速导航</strong>
      <a href="#install">安装部署 <span>→</span></a>
      <a href="#config">环境变量 <span>→</span></a>
      <a href="#first-run">首次使用 <span>→</span></a>
      <a href="#launch-checklist">上线检查 <span>→</span></a>
      <a href="#server-access">服务器接入 <span>→</span></a>
      <a href="#ssh">SSH 终端 <span>→</span></a>
      <a href="#ai">AI 设置 <span>→</span></a>
      <a href="#security">安全上线 <span>→</span></a>
    </aside>
  </section>

  <div class="layout wrap">
    <aside class="sidebar" aria-label="页面目录">
      <a href="#install">安装部署</a>
      <a href="#config">环境变量</a>
      <a href="#first-run">首次使用</a>
      <a href="#launch-checklist">上线检查</a>
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
        <h2>一键脚本优先，Docker 和 Linux systemd 都能落地</h2>
        <p>推荐直接在 Linux 服务器执行交互式部署脚本。脚本会询问安装目录、公网地址、管理员账号、初始密码和部署模式；已有部署会保留 `.env`、SQLite 数据、SSH 加密凭据、AI 设置和账号配置。</p>
        <div class="grid">
          <article class="doc-card">
            <h3><span class="badge">1</span> Docker 一键部署</h3>
            <p>适合大多数用户。脚本会在支持的发行版上安装 Docker 和 Compose 插件，并启动 CoLiPas。</p>
            <code>curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env COLIPAS_DEPLOY_MODE=docker bash</code>
          </article>
          <article class="doc-card">
            <h3><span class="badge">2</span> Linux systemd 部署</h3>
            <p>适合希望由宿主机 systemd 管理服务的场景。apt 系发行版会自动准备 Node.js 24。</p>
            <code>curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env COLIPAS_DEPLOY_MODE=native bash</code>
          </article>
          <article class="doc-card">
            <h3><span class="badge">3</span> 无人值守部署</h3>
            <p>CI、堡垒机或批量初始化场景可通过受保护的环境变量注入公网地址和初始密码；部署脚本不会在结束时回显已提供的密码。</p>
            <code>COLIPAS_PUBLIC_URL='https://colipas.example.com' COLIPAS_ADMIN_PASSWORD='replace-with-strong-password' COLIPAS_ASSUME_YES=1</code>
          </article>
          <article class="doc-card">
            <h3><span class="badge">4</span> 本地灰度测试</h3>
            <p>代码变更上线前运行。`npm test` 会构建、扫描敏感信息并启动临时生产服务做自动化验证。</p>
            <code>npm test</code>
          </article>
        </div>
        <p class="section-note">公网入口建议放在 Nginx、Caddy 或云负载均衡之后；生产服务统一监听 8080，不要将 Vite 5173 作为生产入口。</p>
      </section>

      <section id="config" class="section">
        <p class="kicker">环境变量</p>
        <h2>上线前必须替换默认值</h2>
        <div class="table">
          <div><code>ADMIN_USERNAME / ADMIN_PASSWORD</code><p>管理员账号和初始密码，部署后应立即在后台修改密码。</p></div>
          <div><code>SESSION_SECRET</code><p>会话签名密钥，必须使用长随机字符串。</p></div>
          <div><code>CREDENTIAL_ENCRYPTION_KEY</code><p>SSH 密码和私钥的加密密钥，不能提交到 Git。</p></div>
          <div><code>COLIPAS_DATA_DIR / COLIPAS_DB_PATH</code><p>SQLite 数据库和运行数据目录，默认位于 .data。</p></div>
          <div><code>AI_BASE_URL / AI_API_KEY / AI_MODEL</code><p>OpenAI 兼容 API 配置；不配置密钥时只使用本地规则分析。</p></div>
          <div><code>CUSTOM_API_ALLOWED_HOSTS</code><p>自定义 API 代理允许访问的域名白名单。</p></div>
        </div>
      </section>

      <section id="first-run" class="section">
        <p class="kicker">首次使用</p>
        <h2>部署完成后按这个顺序检查</h2>
        <div class="flow">
          <div class="flow-step" data-colipas-docs-avatar-guard="true"><b>1</b><div><h3>打开后台并登录</h3><p>访问你的域名 `/admin/`，使用部署脚本里设置的管理员账号和初始密码登录。首次进入后优先在账号设置中修改密码；头像保存前会验证图片可正常解码，历史坏图会自动回退到 CoLiPas 品牌图标。</p></div></div>
          <div class="flow-step"><b>2</b><div><h3>确认系统状态</h3><p>在安全审计和总览页确认健康检查、SQLite、发布信息、会话状态和基础指标正常，再继续接入真实服务器。</p></div></div>
          <div class="flow-step"><b>3</b><div><h3>添加第一台服务器</h3><p>先填写名称、IP、地区、系统和标签；需要远程操作时必须选择 SSH 验证模式并通过密码或私钥握手。</p></div></div>
          <div class="flow-step"><b>4</b><div><h3>验证 SSH、AI 与编排联动</h3><p>打开终端执行只读诊断命令，再配置 AI Provider、加载模型、测试自定义 API 白名单，最后执行一条低风险编排任务。</p></div></div>
        </div>
        <p class="section-note">忘记管理员密码时只能重置，不能找回明文密码。Docker 部署可在 `/opt/colipas` 执行 `docker compose exec -e COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' colipas npm run reset:admin` 后重启容器；systemd 部署可执行 `sudo -u colipas env COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' npm run reset:admin` 后重启服务。</p>
      </section>

      <section id="launch-checklist" class="section split">
        <div>
          <p class="kicker">上下文上线检查</p>
          <h2>总览看完整证据，工作区只保留当前需要的摘要</h2>
          <p>总览页默认展示运行安全、资产接入、SSH、AI、运维预检和审计六项完整检查，以及按优先级排序的修复队列。进入服务器、AI、运维、API 或安全工作区后，面板会自动收敛为进度、整体状态和下一步修复，避免重复占用操作空间。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 摘要状态仍会显示当前完成度和最高优先级操作。</p>
            <p class="check-line"><span>✓</span> 需要排障或上线留证时，可一键展开完整检查、修复队列和脱敏报告。</p>
            <p class="check-line"><span>✓</span> 展开或摘要偏好仅保存在当前浏览器，切换页面后仍会保持。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>推荐使用顺序</strong>
          <pre>总览：确认六项完整检查
工作区：按摘要处理下一步
性能模式：保持摘要，减少首屏负担
上线前：展开完整证据并复检</pre>
        </aside>
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

      <section id="ai" class="section split" data-colipas-docs-ai-starters="true">
        <div>
          <p class="kicker">AI 助手</p>
          <h2>真实流式对话、模型读取和本地缓存</h2>
          <p>AI 面板支持 OpenAI 兼容接口，后端使用 stream:true，并把多轮上下文传给上游。相同问题会在本地缓存窗口内复用结果，也可以强制刷新重新生成。新会话提供风险、SSH 健康检查和今日优先级三个安全起步入口；它们只会填充输入框，发送与远程执行始终需要操作员明确确认。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 模型列表从上游 /v1/models 获取。</p>
            <p class="check-line"><span>✓</span> API Key 可加密保存到数据库，也可以由服务器环境变量托管。</p>
            <p class="check-line"><span>✓</span> 上游错误会脱敏后再展示。</p>
            <p class="check-line"><span>✓</span> 起步入口不会自动发送或执行。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>AI 常用接口</strong>
          <pre>GET /api/ai/provider
PUT /api/ai/provider
POST /api/ai/models
POST /api/ai/test
POST /api/ai/stream
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
          <h2>浏览器 xterm 交互终端，关闭即释放后端会话</h2>
          <p>SSH 终端在浏览器中以 WebSocket + PTY 流式交互，输入不需要等上一条命令结束。可持久化的操作、专注、诊断工作区会分别收敛轻量摘要、终端优先布局和完整证据面板。实时通道中断会切到兼容流；兼容流断开时会显示安全的手动重连入口，且不会重放已输入命令。关闭弹窗、断开连接或页面退出时，后端 shell 会同步销毁；运维编排会拒绝未接入或不存在的服务器，重启、关机等动作需要二次确认。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 支持密码和私钥认证，只有握手成功的服务器才能远程执行。</p>
            <p class="check-line"><span>✓</span> 支持 Ctrl+C 中断长命令。</p>
            <p class="check-line"><span>✓</span> 支持终端 resize 和实时输出。</p>
            <p class="check-line"><span>✓</span> WebSocket 中断会自动降级到兼容流；恢复失败时可手动重连，已输入命令不会自动重放。</p>
            <p class="check-line"><span>✓</span> 关闭终端后继续输入会被拒绝，避免后台残留 shell。</p>
            <p class="check-line"><span>✓</span> 任务结果和 AI 执行证据会关联审计 trace。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>上线前建议验证</strong>
          <pre>uptime
whoami
df -h
free -m
systemctl status ssh --no-pager
按 Ctrl+C 中断 ping
关闭弹窗后确认会话消失</pre>
        </aside>
      </section>

      <section id="api" class="section">
        <p class="kicker">API 与自定义代理</p>
        <h2>业务 API 需要登录，自定义代理需要白名单</h2>
        <div class="table">
          <div><code>GET /api/health</code><p>公开健康检查，返回运行状态、SQLite 驱动名称和短发布标识，不暴露路径或密钥。</p></div>
          <div><code>POST /api/auth/login</code><p>管理员登录，失败次数会限速并返回 Retry-After。</p></div>
          <div><code>GET /api/overview</code><p>登录后读取账号、服务器、事件和总览指标。</p></div>
          <div><code>GET / PUT /api/ai/provider</code><p>读取和保存 AI Provider 设置；API Key 只返回是否已托管，不回显明文。</p></div>
          <div><code>POST /api/custom-apis/test</code><p>通过后端代理测试外部接口，阻止内网地址、敏感 Header 和重定向 SSRF。</p></div>
          <div><code>GET /api/servers/shells/status</code><p>登录后查看 SSH shell 连接数和诊断信息，用于排查终端卡顿或残留会话。</p></div>
          <div><code>POST /api/audit/remediate</code><p>执行安全风险确认或修复动作，并写入审计记录。</p></div>
        </div>
      </section>

      <section id="security" class="section split">
        <div>
          <p class="kicker">安全上线清单</p>
          <h2>公网部署前逐项确认</h2>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 修改管理员密码，不使用默认初始密码。</p>
            <p class="check-line"><span>✓</span> 使用强随机 SESSION_SECRET 和 CREDENTIAL_ENCRYPTION_KEY。</p>
            <p class="check-line"><span>✓</span> 限制 CUSTOM_API_ALLOWED_HOSTS，避免代理被滥用。</p>
            <p class="check-line"><span>✓</span> 反向代理关闭 AI/SSH 流式接口缓冲，并把头像上传限制保持为 2m。</p>
            <p class="check-line"><span>✓</span> 备份 .data/colipas.sqlite，.env、.data、私钥和真实资产信息只保存在受控运行环境。</p>
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
        <h2>常见问题与排障</h2>
        <div class="check-list">
          <details open><summary>后台地址在哪里？</summary><p>生产入口是你的域名或 http://127.0.0.1:8080/，后台登录入口是 /admin/。5173 只用于 Vite 开发服务。</p></details>
          <details><summary>为什么未验证的服务器不会显示已接入？</summary><p>真实接入必须通过 SSH 握手。资产模式只登记信息，不会显示已接入，也不会允许执行远程命令。</p></details>
          <details><summary>AI 回答是否固定？</summary><p>未配置有效 API Key 时会返回本地规则分析；配置 OpenAI 兼容 API 并测试成功后，会使用真实流式模型。</p></details>
          <details><summary>SSH 终端关闭后为什么命令不能继续发？</summary><p>这是正常保护。终端窗口关闭会销毁后端 shell，会话失效后继续输入会被拒绝，避免服务器上残留交互进程。</p></details>
          <details><summary>数据存在哪里？</summary><p>默认保存在 .data/colipas.sqlite。SSH 凭据会加密后存储，请保护 .env 和 .data。</p></details>
        </div>
      </section>
    </main>
  </div>

  <footer class="wrap">CoLiPas cloud server management panel docs · public-safe deployment guide · no runtime secrets embedded</footer>
</body>
</html>
HTML
  DOCS_FILE="$LANDING_ROOT/docs.html" node <<'NODE'
const fs = require('node:fs');

const file = process.env.DOCS_FILE;
let html = fs.readFileSync(file, 'utf8');
if (!html.includes('data-colipas-docs-fleet-views="true"')) {
  html = html.replace(
    /(<section id="server-access"[\s\S]*?<div class="grid">)/,
    `$1
          <article class="doc-card" data-colipas-docs-fleet-views="true">
            <h3>资产视图</h3>
            <p>保存当前的关键词、厂商、状态、地域、地图范围和健康筛选；点击已保存视图即可恢复同一排障范围。视图最多保存 8 个，只存在当前浏览器，不会上传筛选内容或资产信息。</p>
          </article>`,
  );
}
if (!html.includes('data-colipas-docs-mobile-controls="true"')) {
  html = html.replace(
    /(<section id="server-access")/,
    `      <section class="section" data-colipas-docs-mobile-controls="true">
        <p class="kicker">移动端快捷控制</p>
        <h2>主操作保持在首行，其余控制集中在快捷抽屉</h2>
        <div class="grid">
          <article class="doc-card">
            <h3>更紧凑的工作区</h3>
            <p>手机端首行保留导航、上线检查和命令面板，避免多行工具栏持续挤占服务器、SSH 和 AI 的操作空间。</p>
          </article>
          <article class="doc-card">
            <h3>快捷控制</h3>
            <p>点击顶部“…”可打开性能模式、三种语言、资产刷新、账户设置和退出登录；点击遮罩或关闭按钮即可返回当前模块。</p>
          </article>
        </div>
      </section>

$1`,
  );
}
if (!html.includes('data-colipas-docs-command-palette="true"')) {
  html = html.replace(
    /(<section id="ai")/,
    `      <section class="section" data-colipas-docs-command-palette="true">
        <p class="kicker">上下文命令面板</p>
        <h2>按优先级、最近使用和全部操作继续处理</h2>
        <div class="grid">
          <article class="doc-card">
            <h3>当前最高优先级</h3>
            <p>使用 Ctrl/⌘ + K 打开命令面板；“继续处理”会定位当前最高优先级的上线修复事项，减少在模块间反复查找。</p>
          </article>
          <article class="doc-card">
            <h3>可清除的本机历史</h3>
            <p>最近使用最多保留 5 条浏览器本地操作 ID，不保存密码、密钥、IP、API Key 或任何服务器内容；可在面板内一键清除。</p>
          </article>
        </div>
      </section>

$1`,
  );
}
fs.writeFileSync(file, html);
NODE
  echo "CoLiPas cloud server management panel docs page ready: $LANDING_ROOT/docs.html"
}

install_runtime_update_script() {
  if [ -f "$APP_DIR/deploy/server-update.sh" ]; then
    install -m 0755 "$APP_DIR/deploy/server-update.sh" "$RUNTIME_UPDATE_SCRIPT"
  fi
}

reexec_runtime_update_script_if_needed() {
  if [ "$(id -u)" -ne 0 ] || [ -n "$SCRIPT_REEXECED" ] || [ ! -f "$APP_DIR/deploy/server-update.sh" ]; then
    return 0
  fi
  if [ ! -f "$RUNTIME_UPDATE_SCRIPT" ] || cmp -s "$APP_DIR/deploy/server-update.sh" "$RUNTIME_UPDATE_SCRIPT"; then
    return 0
  fi

  install_runtime_update_script
  export COLIPAS_UPDATE_SCRIPT_REEXECED=1
  exec "$RUNTIME_UPDATE_SCRIPT"
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
    add_header Cache-Control "no-store, max-age=0" always;
    try_files /index.html =404;
  }

  location = /docs.html {
    add_header Cache-Control "no-store, max-age=0" always;
    try_files /docs.html =404;
  }

  location = /docs {
    return 302 /docs.html;
  }

  location = /colipas-icon.svg {
    try_files /colipas-icon.svg =404;
    expires -1;
    add_header Cache-Control "no-store, max-age=0" always;
  }

  location = /favicon.ico {
    try_files /colipas-icon.svg =404;
    expires -1;
    add_header Cache-Control "no-store, max-age=0" always;
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
    add_header Cache-Control "no-store, max-age=0" always;
    try_files /index.html =404;
  }

  location = /docs.html {
    add_header Cache-Control "no-store, max-age=0" always;
    try_files /docs.html =404;
  }

  location = /docs {
    return 302 /docs.html;
  }

  location = /colipas-icon.svg {
    try_files /colipas-icon.svg =404;
    expires -1;
    add_header Cache-Control "no-store, max-age=0" always;
  }

  location = /favicon.ico {
    try_files /colipas-icon.svg =404;
    expires -1;
    add_header Cache-Control "no-store, max-age=0" always;
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
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  run_as_app git reset --hard "$REMOTE_HEAD"
  reexec_runtime_update_script_if_needed
fi

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
