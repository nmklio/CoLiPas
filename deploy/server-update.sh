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
    assets: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .4-9 6 6 0 0 0-11.6 1.7A3.5 3.5 0 0 0 7 19Z"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z"/><path d="M9 4v14M15 6v14"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
    ai: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M8 19v2M16 19v2M2 12h2M20 12h2"/><path d="M9 13h.01M15 13h.01"/>',
    flow: '<rect x="3" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/><path d="M6.5 9v6a3 3 0 0 0 3 3H14"/>',
    shield: '<path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
    checklist: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
    command: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m8 10 3 2-3 2M14 14h3"/>',
    alert: '<path d="M12 3a6 6 0 0 0-6 6c0 4-2 5-2 5h16s-2-1-2-5a6 6 0 0 0-6-6Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13 5l-2 14"/>',
    controls: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    database: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    inbox: '<path d="M3 12h4l2 3h6l2-3h4"/><path d="M5 5h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2-7Z"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  };
  return `<span class="${className} icon-${kind}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths[kind]}</svg></span>`;
}

function landingFeatureCard({ kind, title, description, tags, featureId = '', wide = false }) {
  const idAttribute = featureId ? ` data-colipas-feature="${featureId}"` : '';
  const wideClass = wide ? ' feature-card-wide' : '';
  return `<article class="feature-card${wideClass}"${idAttribute}>${landingIcon(kind, 'icon feature-icon')}<h3>${title}</h3><p>${description}</p><div class="tags">${tags.map((tag) => `<span>${tag}</span>`).join('')}</div></article>`;
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
replaceAll(/\/\* colipas landing live release ui(?: v[0-9]+)? \*\/[\s\S]*?(?=<\/style>)/g, '');
replaceAll(/\/\* colipas landing dynamic globe ui(?: v[0-9]+)? \*\/[\s\S]*?(?=<\/style>)/g, '');
replaceAll(/\/\* colipas landing hero split ui(?: v[0-9]+)? \*\/[\s\S]*?(?=<\/style>)/g, '');
replaceAll(/\/\* colipas landing density ui(?: v[0-9]+)? \*\/[\s\S]*?(?=<\/style>)/g, '');
replaceAll(/\/\* colipas landing light surface ui(?: v[0-9]+)? \*\/[\s\S]*?(?=<\/style>)/g, '');
replaceAll(/\s*<script id="colipas-landing-dynamic">[\s\S]*?<\/script>\s*/g, '\n');
replaceAll(/\s*<script id="colipas-landing-globe">[\s\S]*?<\/script>\s*/g, '\n');
replaceAll(/<title>[\s\S]*?<\/title>/g, '<title>CoLiPas云服务器管理面板</title>');
replaceAll(/\s*<link\s+rel="icon"[^>]*>\s*/g, '\n');
replaceOnce(/<title>CoLiPas云服务器管理面板<\/title>/, '<title>CoLiPas云服务器管理面板</title>\n<link rel="icon" type="image/svg+xml" href="/colipas-icon.svg?v=20261021-brand4">');
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

const landingHero = `<section class="hero wrap">
    <div class="hero-globe-scene" aria-hidden="true"><canvas class="hero-globe"></canvas></div>
    <div class="hero-copy">
      <p class="pill">自托管控制面 · SSH 实时终端 · AI 运维</p>
      <h1><span class="hero-title-main">CoLiPas</span><span class="hero-title-accent">云服务器管理面板</span></h1>
      <p class="lead">把分散的云服务器放回一个清晰的工作流：接入资产、观察状态、进入实时终端、让 AI 辅助诊断，并为每次关键操作保留审计证据。</p>
      <div class="hero-buttons">
        <a class="button hero-primary" href="/admin/">进入管理后台</a>
        <a class="button hero-secondary" href="#product">查看工作流</a>
      </div>
      <div class="live-release" data-live-release data-live-state="loading">
        <span class="live-dot" aria-hidden="true"></span>
        <span class="live-label">线上发布</span>
        <b class="live-commit" data-live-commit>读取中</b>
        <span class="live-divider" aria-hidden="true"></span>
        <span class="live-metric">运行 <b data-live-uptime>—</b></span>
        <span class="live-divider" aria-hidden="true"></span>
        <span class="live-metric">P95 <b data-live-latency>—</b></span>
        <a class="live-link" href="/api/health/" target="_blank" rel="noreferrer">健康检查</a>
      </div>
      <div class="stats" aria-label="产品能力">
        <div><strong>PTY</strong><span>实时 SSH 交互</span></div>
        <div><strong>7 天</strong><span>可信资源历史</span></div>
        <div><strong>3</strong><span>中文 / EN / 日本語</span></div>
      </div>
    </div>

    <figure class="product-preview product-tour is-cycling" data-product-tour aria-label="CoLiPas 脱敏产品动态演示">
      <div class="preview-top"><i></i><i></i><i></i><span data-tour-title>全局资产总览 · 实时状态</span><em><b></b>自动演示</em></div>
      <div class="preview-stage">
        <div id="tour-scene-overview" class="preview-scene scene scene-overview is-active" data-tour-scene="overview" data-scene="overview" role="tabpanel" aria-labelledby="tour-tab-overview" aria-hidden="false">
          <div class="scene-top">
            <i class="scene-live" aria-hidden="true"></i>
            <strong>全局资产总览</strong>
            <span class="scene-meta">18 台在线 · 6 条待处理</span>
            <em class="scene-clock" data-scene-clock>--:--:--</em>
          </div>
          <div class="scene-kpis">
            <div><span>在线服务器</span><b data-scene-count="18">0</b></div>
            <div><span>CPU 均值</span><b data-scene-count="38" data-scene-suffix="%">0%</b></div>
            <div><span>待处理事件</span><b data-scene-count="6">0</b></div>
            <div><span>SSH 通道</span><b data-scene-count="12">0</b></div>
          </div>
          <div class="scene-split">
            <div class="scene-map">
              <svg viewBox="0 0 320 170" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
                <defs>
                  <radialGradient id="scene-map-glow" cx="50%" cy="42%" r="62%">
                    <stop offset="0%" stop-color="rgba(114,222,196,.18)" />
                    <stop offset="100%" stop-color="rgba(114,222,196,0)" />
                  </radialGradient>
                </defs>
                <rect class="scene-map-ocean" x="0" y="0" width="320" height="170" fill="url(#scene-map-glow)" />
                <path class="scene-map-graticule" d="M0 42h320M0 85h320M0 128h320M80 0v170M160 0v170M240 0v170" />
                <path class="scene-map-land" d="M109,151L109,152L105,152L104,151L105,151L108,151L108,150ZM121,149L123,150L123,151L120,151L117,152L114,151L116,151L117,150L118,149L119,149L120,149ZM75,144L77,144L77,144L75,144L73,144L73,144L74,144ZM101,143L101,144L100,144L98,144L97,144L96,144L97,143L98,143L99,142L99,141L100,142L101,142L101,143ZM6,155L6,155L7,154L8,155L9,154L9,154L10,154L12,154L15,154L16,154L20,155L25,155L31,155L35,155L38,155L32,154L29,154L29,153L29,152L27,152L28,152L31,152L34,151L34,151L32,150L29,150L27,150L25,149L25,148L27,148L29,149L32,148L34,148L35,147L35,147L37,147L39,147L41,146L43,146L45,146L47,146L49,146L51,146L54,146L56,146L58,146L61,146L63,145L63,146L65,146L67,146L69,147L72,146L74,147L74,146L72,146L72,145L72,145L74,145L76,145L78,145L80,145L82,145L84,144L85,145L87,145L89,145L91,145L92,145L94,145L96,145L98,145L100,145L102,145L103,144L102,143L102,143L101,142L102,141L102,141L102,140L103,139L104,139L105,138L106,138L107,137L109,137L110,137L111,137L110,137L109,137L108,138L107,138L106,139L106,139L105,139L104,140L104,141L105,141L106,142L107,142L107,143L108,144L108,145L107,146L106,146L105,147L103,147L100,147L98,148L95,148L94,148L96,149L96,149L93,149L93,150L94,151L97,151L100,152L104,152L107,152L110,153L111,153L114,153L117,152L122,152L124,152L127,152L131,152L134,151L135,151L135,150L131,150L129,150L130,149L132,149L135,148L136,148L138,148L141,147L143,147L145,147L147,146L146,145L147,145L149,144L150,144L151,143L153,144L154,143L155,143L156,143L158,143L160,144L162,143L164,143L165,143L167,142L168,142L169,143L171,142L173,142L174,142L176,142L177,142L179,143L180,143L182,143L184,142L186,142L187,142L188,141L190,141L191,142L192,142L194,142L195,141L197,141L198,141L200,140L201,140L203,140L204,139L205,139L207,139L208,139L209,139L210,140L212,140L213,140L215,140L216,140L218,140L220,141L220,142L218,142L219,143L219,143L219,144L221,144L222,143L223,143L223,142L225,142L226,142L227,141L229,141L230,140L231,140L232,140L234,140L235,139L236,140L238,140L239,140L241,140L242,140L244,140L245,140L246,139L248,138L249,139L251,140L252,140L254,139L256,139L257,139L258,139L260,139L261,140L263,140L265,139L266,139L268,139L269,139L271,139L273,139L275,139L276,139L276,138L277,139L278,140L280,139L282,139L284,139L285,140L285,140L287,141L290,141L291,141L293,141L294,142L296,142L298,142L299,143L301,143L303,143L305,143L306,144L306,144L305,145L304,145L302,146L301,147L300,147L300,148L300,149L301,149L303,150L300,150L298,150L297,151L298,152L299,152L301,153L304,154L307,154L308,155L313,155L314,159L6,159ZM102,128L104,129L103,130L102,130L101,130L99,129L97,128L97,128L99,129L100,128L101,127L102,128ZM284,117L286,117L287,117L287,119L286,119L285,120L284,119L284,117L284,117ZM308,117L309,117L309,118L308,119L308,120L307,120L306,122L305,122L304,122L302,122L304,120L305,120L306,119L307,118L308,117ZM309,113L310,114L311,114L312,115L313,115L312,116L311,116L311,117L311,118L310,118L310,117L309,116L309,115L309,114L309,114L308,112L308,112L309,112ZM303,101L302,101L301,100L300,99L301,100L302,100L303,101ZM203,94L203,95L203,96L202,96L203,97L202,98L202,100L201,103L200,104L198,104L197,103L197,102L197,101L198,100L198,99L198,98L198,97L198,96L199,96L200,95L201,94L201,94L202,93L202,93L203,93ZM283,94L284,94L284,95L284,96L285,97L285,98L286,99L287,100L288,100L288,101L289,101L290,103L291,104L291,105L291,106L291,107L291,109L290,110L289,111L289,112L288,113L288,114L287,115L286,115L284,115L284,115L283,115L282,115L280,115L280,114L279,113L278,112L278,112L278,112L278,111L277,111L276,112L276,111L275,110L274,110L272,109L270,110L268,110L266,110L266,111L265,111L263,111L262,112L261,112L260,112L259,112L258,111L259,111L259,110L259,108L258,107L258,107L258,106L257,105L257,104L258,105L257,104L257,103L257,102L257,102L258,102L259,101L260,100L260,100L262,100L262,99L263,99L264,98L265,98L265,96L266,97L266,96L266,96L267,95L268,94L268,94L269,94L270,95L271,95L271,94L271,93L272,93L273,93L273,92L274,92L275,93L276,93L277,93L277,93L277,94L276,94L276,95L277,96L278,96L279,97L279,97L281,97L281,96L281,95L281,94L281,93L281,93L282,92L282,91L282,92L282,93L283,94ZM266,91L266,91L266,90L267,90L268,89L269,89L268,90L267,90ZM253,88L255,88L257,89L259,89L257,89L255,89L254,89L253,89L251,88L251,87L252,88L253,88ZM290,87L289,87L289,88L287,87L287,87L288,87L288,87L289,87L290,86L290,86L290,86ZM291,86L291,86L290,85L289,85L290,85L290,85L291,86ZM275,83L276,85L278,84L279,84L281,85L284,86L285,86L286,87L286,88L287,89L288,90L288,91L289,91L288,91L287,91L286,90L285,89L283,89L283,90L282,90L280,89L279,89L278,89L278,88L276,86L274,85L274,86L274,85L274,84L274,84L273,84L272,83L273,83L275,83ZM267,81L266,82L264,82L263,83L264,83L265,83L265,84L265,85L265,86L265,87L265,86L264,86L263,85L263,85L263,87L262,87L262,85L262,85L262,83L263,82L264,81L266,81L267,81ZM270,81L270,82L270,83L269,83L269,81L270,81L270,81ZM251,87L249,87L247,85L246,84L245,82L244,81L243,79L242,78L242,78L244,79L245,80L247,80L248,82L248,83L249,83L250,84L251,85L251,86ZM261,81L261,82L261,83L260,84L259,85L258,85L257,85L256,85L254,85L254,83L253,82L254,81L255,81L256,80L257,79L258,78L259,77L260,76L261,77L262,78L261,78L261,79L261,80ZM268,75L268,76L268,76L268,77L266,77L266,76L265,76L264,76L265,75L266,75L267,75L267,75L268,74L268,75ZM267,72L267,73L267,73L267,73L266,72L267,72L267,72ZM264,66L265,66L265,67L265,68L264,69L265,70L266,70L266,71L265,71L265,71L264,71L263,70L263,70L263,69L263,68L263,67L263,66ZM98,65L99,65L100,65L100,66L101,66L102,66L101,67L100,67L100,67L99,67L99,67L98,67L97,67L96,67L97,66L98,66L98,66L97,65ZM27,66L27,66L26,65L27,65L27,65L27,65L27,65L28,66L27,66ZM92,63L93,63L94,64L95,64L95,65L97,65L96,65L95,65L94,65L93,65L93,64L91,64L90,63L90,63L89,63L88,64L87,64L88,63L89,63L90,62L91,63ZM281,51L280,52L279,53L276,54L276,53L273,53L273,54L272,56L272,55L271,54L272,53L273,52L276,52L278,51L279,50L280,48L281,47L281,49L281,50ZM283,44L284,44L283,46L281,46L280,47L280,45L281,44L282,44ZM54,41L52,41L51,40L50,40L50,39L52,39L53,40L54,40ZM112,39L112,39L112,40L113,40L114,41L115,41L115,42L114,42L114,41L112,42L112,42L109,42L110,41L110,40L111,38L113,38L112,38ZM283,39L282,40L283,42L282,42L281,42L281,40L282,39L281,37L282,36L282,36L283,38ZM157,32L157,33L158,34L158,34L160,36L160,37L161,38L161,38L159,39L157,39L156,39L155,39L157,38L155,38L156,37L157,37L157,36L156,35L156,35L155,34L155,33L156,32ZM87,26L88,26L89,27L90,28L91,28L89,28L88,28L87,28L86,27L87,26ZM148,25L148,27L145,28L143,28L141,27L141,27L139,26L141,25L144,26L146,25ZM202,47L203,48L202,48L202,49L202,49L203,50L205,51L206,50L206,49L206,48L205,47L207,47L206,46L205,47L205,46L205,46L204,45L203,44L204,44L205,44L205,42L204,42L202,43L201,43L201,45L202,47ZM314,27L313,27L313,27L313,28L313,29L309,29L307,30L306,31L302,31L301,31L300,32L299,33L300,34L298,35L297,36L296,37L294,39L293,37L293,34L294,33L297,32L300,30L300,29L297,30L294,30L293,32L289,32L288,31L284,32L279,33L277,36L278,36L280,36L281,38L280,39L279,42L277,44L275,45L274,46L272,46L272,46L271,47L271,47L270,48L269,48L269,49L270,49L271,51L270,52L269,53L268,52L268,51L268,50L267,50L267,50L267,50L267,49L267,49L267,48L265,48L264,49L264,48L264,47L262,48L261,49L261,50L262,50L263,50L265,50L264,51L262,52L263,53L264,55L264,56L264,56L264,57L264,58L262,60L260,62L258,63L257,63L256,64L254,65L254,64L253,64L251,65L250,66L252,68L253,69L253,72L252,73L250,75L250,74L249,73L248,72L246,71L246,71L245,73L245,74L246,75L246,76L247,77L248,78L248,79L248,79L249,80L249,81L248,81L247,79L246,78L246,77L245,76L245,76L244,76L244,75L244,73L244,72L244,71L244,69L243,68L241,69L241,68L240,66L240,65L239,64L239,63L237,63L237,64L237,64L236,63L235,64L234,65L233,66L231,67L230,68L229,69L228,69L229,71L228,73L227,74L227,75L226,75L225,73L225,72L224,70L223,69L222,66L222,64L220,64L220,63L218,62L217,61L215,61L213,61L210,60L209,59L208,59L206,59L204,58L203,56L202,56L201,57L201,57L202,59L202,59L203,60L203,60L203,61L203,60L204,60L204,61L204,62L204,62L206,62L207,61L208,60L208,60L208,60L209,62L210,62L211,63L211,63L211,64L210,64L210,65L209,65L209,66L208,66L208,67L207,67L207,68L206,68L205,68L205,69L202,70L201,70L201,71L199,71L199,71L198,71L198,72L197,71L197,70L196,69L197,69L197,68L196,68L196,67L195,66L194,65L193,63L193,62L192,62L192,61L191,60L190,59L190,58L190,58L190,57L189,58L189,59L188,58L188,57L189,59L189,60L191,62L190,63L192,63L192,64L192,66L193,67L194,69L195,70L196,71L197,71L197,72L197,72L197,73L198,73L200,73L201,73L202,73L203,72L203,72L204,72L204,73L203,74L202,76L201,79L199,81L197,82L196,84L195,84L194,84L194,85L194,86L193,88L194,88L194,89L194,90L194,91L195,92L195,94L195,95L194,97L192,97L191,98L190,99L190,100L190,101L190,102L190,103L190,103L188,104L188,105L188,105L188,106L187,107L186,108L186,109L184,110L183,111L182,111L181,111L180,111L178,112L177,112L176,112L176,111L176,111L175,110L176,109L175,108L174,107L173,105L173,104L172,102L172,101L171,99L170,98L170,97L170,95L171,94L171,93L172,92L171,91L171,90L171,90L171,88L171,88L170,87L169,85L168,83L168,83L168,81L168,80L168,79L167,79L167,78L166,78L165,79L164,77L163,77L162,77L160,78L158,78L157,78L156,78L154,78L153,79L152,78L151,77L150,76L149,76L149,75L148,74L148,74L147,73L147,72L146,72L146,72L146,71L145,70L145,70L146,68L146,68L146,66L146,65L145,64L145,64L146,63L146,62L147,61L147,60L148,60L149,58L151,58L152,57L152,55L153,54L154,53L155,52L156,52L158,52L159,52L160,51L163,51L165,51L166,51L167,51L169,50L169,51L169,51L169,52L169,53L169,53L170,54L171,54L173,55L174,56L176,56L177,56L177,55L178,54L180,55L180,55L182,55L183,55L185,56L186,55L187,55L188,56L189,56L190,55L190,55L190,54L190,53L191,53L191,52L191,51L190,51L188,51L186,51L185,51L184,51L183,50L182,49L185,48L187,47L189,46L192,47L194,47L196,47L195,46L194,45L193,44L191,44L193,43L193,42L193,42L191,42L190,43L190,43L191,44L189,44L189,44L188,43L188,43L187,42L186,43L185,44L185,44L184,45L184,46L185,47L184,47L183,48L182,47L181,47L181,48L180,48L179,48L180,49L180,49L181,50L180,50L180,51L179,51L178,50L177,49L177,48L177,48L177,47L177,46L176,46L175,46L174,45L173,44L173,44L172,44L172,43L172,43L171,43L170,44L172,45L173,46L174,47L174,47L176,48L176,48L174,48L175,49L174,49L173,50L174,49L173,48L173,48L172,47L171,47L170,46L169,45L168,44L167,45L166,45L163,45L163,46L161,47L160,48L160,49L159,50L158,51L156,51L155,52L155,51L154,51L153,51L153,50L152,49L152,49L152,48L152,47L152,46L152,45L154,45L156,45L158,45L159,43L157,42L156,41L159,41L159,40L161,39L163,38L164,37L166,37L167,36L168,36L167,35L167,34L167,33L168,33L169,33L169,34L169,34L168,35L169,36L169,36L171,36L172,36L174,36L176,35L177,36L178,35L178,34L179,33L181,33L181,32L180,32L181,31L183,31L185,31L182,31L180,31L178,30L178,29L179,28L182,27L180,26L178,27L177,28L175,30L176,31L174,32L174,34L172,35L171,34L169,32L167,32L165,32L164,29L167,28L171,26L174,24L178,22L181,22L184,21L186,22L187,22L191,23L195,25L194,26L189,25L190,26L191,27L192,27L192,27L195,27L196,25L198,26L197,25L197,24L200,24L199,25L201,25L203,24L207,23L207,24L209,24L211,24L211,23L214,23L219,24L218,23L217,23L217,22L219,21L220,20L222,20L222,21L222,23L223,24L222,26L223,25L224,24L224,23L223,23L223,21L224,20L225,20L225,21L226,20L230,21L229,19L232,19L234,19L236,18L239,17L242,17L245,17L246,17L249,16L250,16L252,17L255,17L258,17L256,18L254,19L256,19L257,20L259,19L262,20L265,19L269,19L270,20L271,21L273,21L276,21L278,21L279,20L288,21L291,22L296,22L297,23L299,23L302,23L305,24L305,23L309,23L313,23L314,27ZM6,23L6,23L10,25L11,26L13,25L14,26L12,27L11,27L9,27L8,26L7,26L6,26L6,27L6,23ZM83,23L84,23L84,24L86,24L87,22L89,23L91,24L90,24L89,25L87,25L86,26L84,27L82,28L81,29L79,30L79,32L81,33L82,33L85,34L86,35L89,35L89,36L90,38L92,38L92,36L93,35L95,34L94,33L94,31L93,29L95,29L97,29L99,30L100,30L101,32L102,32L104,31L105,31L107,34L108,35L110,35L111,36L112,37L112,38L110,39L107,39L104,39L102,40L100,41L100,42L103,40L105,41L105,42L106,43L108,42L109,43L106,44L104,45L103,44L104,44L103,44L101,45L100,45L99,46L100,47L100,46L100,47L99,47L98,47L98,47L97,48L97,47L97,48L96,49L96,49L96,49L96,49L95,50L95,50L95,49L95,50L95,50L95,51L95,52L94,53L93,53L92,54L91,55L90,56L91,57L91,58L91,60L91,61L91,61L90,60L89,59L89,58L88,57L87,57L87,56L85,56L84,56L84,57L84,57L83,57L82,57L81,57L80,57L78,58L77,58L77,59L77,60L77,60L76,62L76,63L77,64L77,65L78,66L79,67L81,66L82,66L83,65L83,64L84,64L86,64L86,64L85,65L85,66L85,66L84,67L85,67L85,67L85,68L84,68L84,69L84,69L85,69L85,69L85,69L86,69L86,69L87,69L87,69L88,69L88,69L89,69L89,70L89,70L89,71L89,72L88,72L88,73L88,73L89,74L90,74L90,75L90,75L91,74L92,74L92,74L93,74L94,75L95,74L95,74L96,73L97,73L98,72L99,72L99,72L99,72L99,73L98,74L99,74L99,74L100,73L100,72L101,72L102,73L103,73L104,74L105,73L107,73L107,74L108,74L109,75L109,75L110,76L111,77L112,77L113,77L114,77L116,78L116,79L117,81L117,81L117,82L118,83L120,83L122,84L123,84L126,85L128,86L130,87L130,88L130,90L128,92L127,93L127,94L126,97L126,98L125,100L124,101L123,102L121,103L119,104L118,105L118,106L118,107L116,109L115,111L114,112L112,112L111,112L110,111L111,112L111,113L111,115L108,116L107,116L107,117L105,118L104,117L105,119L106,119L104,119L104,121L102,121L103,123L104,123L102,125L101,126L102,127L101,127L99,128L99,128L97,127L96,126L95,125L96,123L95,122L96,120L98,119L97,119L97,118L97,116L97,114L98,113L99,110L99,108L99,106L100,102L100,99L99,97L97,96L95,95L95,94L93,91L92,89L91,88L91,87L91,86L92,85L91,85L91,84L91,83L92,82L92,81L92,81L93,80L93,80L94,79L94,78L94,77L93,76L93,75L93,75L92,75L92,75L91,75L92,76L91,76L91,76L90,76L90,75L89,75L89,75L88,75L88,75L88,74L88,74L87,74L87,74L87,74L87,73L87,73L86,72L85,72L85,71L85,71L85,71L84,71L84,71L83,71L82,70L81,70L80,69L79,68L77,69L76,69L75,68L73,67L72,67L71,66L70,65L70,65L70,64L70,64L69,63L68,61L67,60L66,60L66,59L65,58L64,58L63,57L63,56L62,55L62,55L62,56L63,57L63,58L63,58L64,59L65,59L65,61L65,61L66,62L66,62L66,63L65,62L64,61L64,60L63,59L63,59L62,59L62,59L62,58L61,57L61,56L60,54L59,54L59,53L58,53L57,53L56,51L55,50L54,49L54,48L54,46L54,45L54,42L53,41L55,41L55,42L55,40L53,40L51,39L51,38L49,36L48,35L47,35L46,33L44,32L42,32L40,31L37,31L34,30L33,31L32,31L30,32L30,30L31,30L29,31L29,32L27,33L26,34L24,34L23,35L21,35L19,36L20,35L22,34L23,34L24,33L25,32L25,32L24,32L23,32L22,32L21,32L21,31L19,31L19,30L18,29L19,28L20,28L22,28L22,27L22,27L21,27L20,27L18,27L16,26L19,25L20,26L21,25L19,24L17,24L19,23L21,23L22,22L25,22L27,21L28,22L30,22L32,22L35,22L37,22L39,23L42,23L44,23L46,23L49,22L50,22L51,22L54,22L55,23L56,23L59,23L61,23L61,24L65,24L67,25L67,24L68,24L70,24L72,24L75,24L76,24L78,24L78,24L79,23L77,22L79,21L81,21L81,23ZM62,20L64,20L66,20L67,21L67,20L69,20L70,21L72,22L74,23L73,23L71,23L68,23L64,24L63,23L61,23L60,22L63,22L62,22L59,22L61,21L58,21L59,20L61,20ZM86,20L87,20L91,20L93,20L95,20L97,21L99,22L102,22L101,23L105,24L107,25L105,27L103,25L102,26L104,27L105,28L103,28L102,28L103,29L99,28L98,28L96,27L94,27L93,26L97,26L97,26L98,24L96,24L95,23L93,23L92,23L87,22L84,22L84,21L83,20L84,19L87,19ZM74,19L77,19L76,20L77,21L75,21L72,20L74,20L73,20ZM57,21L54,21L53,21L54,19L56,19L59,19L61,19L58,20L57,21ZM76,17L76,17L75,18L74,18L72,17L74,17L76,17ZM67,17L69,17L70,18L66,18L63,19L64,18L59,18L61,17L65,18L65,17L67,17ZM209,22L206,22L204,21L205,20L207,19L208,18L210,18L215,17L218,16L218,17L213,18L209,20L208,21ZM79,16L82,17L82,17L84,18L86,18L89,17L92,18L91,18L89,18L85,19L81,18L81,17L78,17L77,16ZM176,14L176,15L175,16L174,17L173,16L170,15L171,14L173,14L175,14ZM204,13L202,14L201,14L200,13L200,13L202,13L203,13L204,13ZM86,14L85,15L82,15L80,15L80,14L78,14L78,13L79,13L81,13L83,13L85,14ZM101,11L106,11L107,12L103,12L104,13L101,13L97,14L94,14L95,15L95,15L93,16L92,16L93,17L89,17L85,17L83,16L84,16L87,16L85,15L87,15L86,14L88,14L90,13L85,13L83,13L82,12L84,12L87,12L89,12L91,11L95,11L98,11L100,11ZM137,11L141,12L133,12L136,12L140,12L140,13L147,12L150,13L146,14L145,14L143,15L144,16L141,17L143,18L143,19L143,19L141,20L141,20L139,20L140,21L141,22L139,22L138,22L140,22L139,23L134,24L132,24L129,26L127,26L125,27L125,28L124,29L123,31L120,30L118,30L116,28L115,27L114,25L115,24L116,23L115,23L114,23L113,22L114,22L115,21L113,21L113,20L112,19L110,18L108,17L103,17L100,17L101,16L99,16L97,15L104,14L102,14L106,13L106,12L111,12L115,12L119,12L122,12L120,12L126,11L130,11Z" />
                <path class="scene-arc scene-arc-1" d="M258 63 Q300 30 55 50" />
                <path class="scene-arc scene-arc-2" d="M258 63 Q262 92 249 81" />
                <path class="scene-arc scene-arc-3" d="M249 81 Q300 70 280 52" />
                <g class="scene-node-group" data-scene-node="hk">
                  <circle class="scene-node-halo" cx="258" cy="63" r="9" />
                  <circle class="scene-node" cx="258" cy="63" r="3.2" />
                  <text class="scene-node-label" x="266" y="56">HK</text>
                  <text class="scene-node-value" x="266" y="67">42%</text>
                </g>
                <g class="scene-node-group" data-scene-node="sg">
                  <circle class="scene-node-halo" cx="249" cy="81" r="9" />
                  <circle class="scene-node" cx="249" cy="81" r="3.2" />
                  <text class="scene-node-label" x="238" y="94">SG</text>
                  <text class="scene-node-value" x="238" y="105">67%</text>
                </g>
                <g class="scene-node-group" data-scene-node="us">
                  <circle class="scene-node-halo" cx="55" cy="50" r="9" />
                  <circle class="scene-node" cx="55" cy="50" r="3.2" />
                  <text class="scene-node-label" x="63" y="45">US</text>
                  <text class="scene-node-value" x="63" y="57">28%</text>
                </g>
                <g class="scene-node-group" data-scene-node="jp">
                  <circle class="scene-node-halo" cx="280" cy="52" r="9" />
                  <circle class="scene-node" cx="280" cy="52" r="3.2" />
                  <text class="scene-node-label" x="288" y="47">JP</text>
                  <text class="scene-node-value" x="288" y="59">55%</text>
                </g>
              </svg>
              <div class="scene-map-legend">
                <span><i class="scene-legend-dot ok"></i>在线 18</span>
                <span><i class="scene-legend-dot warn"></i>告警 6</span>
                <span><i class="scene-legend-dot info"></i>平均延迟 38ms</span>
              </div>
            </div>
            <div class="scene-rows">
              <div class="scene-row"><span>hk-prod-01</span><i style="--v:42%"></i><b>42%</b></div>
              <div class="scene-row"><span>sg-edge-02</span><i style="--v:67%"></i><b>67%</b></div>
              <div class="scene-row"><span>us-core-03</span><i style="--v:28%"></i><b>28%</b></div>
              <div class="scene-row"><span>jp-lab-04</span><i style="--v:55%"></i><b>55%</b></div>
              <div class="scene-row"><span>hk-edge-05</span><i style="--v:34%"></i><b>34%</b></div>
              <div class="scene-row"><span>de-cdn-06</span><i style="--v:61%"></i><b>61%</b></div>
              <div class="scene-events">
                <div><b>P1</b><span>hk-prod-01 CPU 82% 持续 5 分钟</span></div>
                <div><b>P2</b><span>sg-edge-02 SSH 握手 210ms</span></div>
              </div>
            </div>
          </div>
          <div class="scene-spark" aria-hidden="true">
            <svg viewBox="0 0 300 54" preserveAspectRatio="none">
              <defs>
                <linearGradient id="scene-spark-stroke" x1="0" y1="0" x2="300" y2="0" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="#38bdf8"/>
                  <stop offset="1" stop-color="#60a5fa"/>
                </linearGradient>
                <linearGradient id="scene-spark-fill" x1="0" y1="0" x2="0" y2="54" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stop-color="#38bdf8" stop-opacity=".26"/>
                  <stop offset="1" stop-color="#38bdf8" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <path class="scene-spark-area" d="M0 40 C4.3 39 17.3 33.3 26 34 C34.7 34.7 43.3 45 52 44 C60.7 43 69.3 29.3 78 28 C86.7 26.7 95.3 37 104 36 C112.7 35 121.3 23 130 22 C138.7 21 147.3 30.7 156 30 C164.7 29.3 173.3 18.7 182 18 C190.7 17.3 199.3 26.7 208 26 C216.7 25.3 225.3 14.7 234 14 C242.7 13.3 251.3 22.7 260 22 C268.7 21.3 279.3 11 286 10 C292.7 9 297.7 15 300 16 L300 54 L0 54 Z"/>
              <path class="scene-spark-line" d="M0 40 C4.3 39 17.3 33.3 26 34 C34.7 34.7 43.3 45 52 44 C60.7 43 69.3 29.3 78 28 C86.7 26.7 95.3 37 104 36 C112.7 35 121.3 23 130 22 C138.7 21 147.3 30.7 156 30 C164.7 29.3 173.3 18.7 182 18 C190.7 17.3 199.3 26.7 208 26 C216.7 25.3 225.3 14.7 234 14 C242.7 13.3 251.3 22.7 260 22 C268.7 21.3 279.3 11 286 10 C292.7 9 297.7 15 300 16"/>
              <path class="scene-spark-baseline" d="M0 53 H300"/>
            </svg>
            <i class="scene-spark-dot"></i>
          </div>
        </div>
        <div id="tour-scene-terminal" class="preview-scene scene scene-terminal" data-tour-scene="terminal" data-scene="terminal" role="tabpanel" aria-labelledby="tour-tab-terminal" aria-hidden="true">
          <div class="scene-top">
            <i class="scene-live" aria-hidden="true"></i>
            <strong>低延迟 SSH</strong>
            <span class="scene-meta">RTT <b data-scene-rtt>18</b>ms · 首包 <b data-scene-first>42</b>ms</span>
            <em class="scene-clock">连续交互</em>
          </div>
          <pre class="scene-term" data-scene-term></pre>
        </div>
        <div id="tour-scene-ai" class="preview-scene scene scene-ai" data-tour-scene="ai" data-scene="ai" role="tabpanel" aria-labelledby="tour-tab-ai" aria-hidden="true">
          <div class="scene-top">
            <i class="scene-live" aria-hidden="true"></i>
            <strong>上下文 AI</strong>
            <span class="scene-meta">引用当前资产与事件</span>
            <em class="scene-clock">确认后执行</em>
          </div>
          <div class="scene-chat">
            <p class="scene-msg scene-msg-user">hk-prod-01 的 CPU 抖动需要处理吗？</p>
            <p class="scene-msg scene-msg-ai" data-scene-ai-text></p>
            <div class="scene-approve" data-scene-approve>
              <span>待确认</span>
              <b>执行低风险诊断命令</b>
              <i>确认后执行</i>
            </div>
          </div>
        </div>
      </div>
      <figcaption class="preview-tabs" role="tablist" aria-label="产品场景">
        <button id="tour-tab-overview" type="button" role="tab" aria-selected="true" aria-controls="tour-scene-overview" data-tour-tab="overview"><span>01</span>资产总览</button>
        <button id="tour-tab-terminal" type="button" role="tab" aria-selected="false" aria-controls="tour-scene-terminal" data-tour-tab="terminal" tabindex="-1"><span>02</span>实时 SSH</button>
        <button id="tour-tab-ai" type="button" role="tab" aria-selected="false" aria-controls="tour-scene-ai" data-tour-tab="ai" tabindex="-1"><span>03</span>AI 诊断</button>
      </figcaption>
      <div class="preview-terminal" data-live-terminal>
        <div class="terminal-bar">
          <i></i><i></i><i></i>
          <span>operator@colipas · /api/health</span>
          <em data-terminal-state>连接中</em>
        </div>
        <div class="terminal-body">
          <p class="terminal-prompt"><b>operator@colipas</b><span>:</span><i>~</i><span>$</span> curl -s /api/health/</p>
          <pre class="terminal-output" data-live-terminal-output></pre>
          <p class="terminal-status"><span data-live-terminal-status>等待首个响应…</span><i class="terminal-cursor" aria-hidden="true"></i></p>
        </div>
      </div>
      <div class="preview-progress" aria-hidden="true"><i></i></div>
    </figure>

    <div class="capability-ticker" aria-hidden="true">
      <div class="ticker-track">
        <span>PTY 实时 SSH 交互</span>
        <span>7 天可信资源历史</span>
        <span>3 语言界面</span>
        <span>500 行批量资产导入</span>
        <span>240 点历史曲线</span>
        <span>60 秒运维预检</span>
        <span>PTY 实时 SSH 交互</span>
        <span>7 天可信资源历史</span>
        <span>3 语言界面</span>
        <span>500 行批量资产导入</span>
        <span>240 点历史曲线</span>
        <span>60 秒运维预检</span>
      </div>
    </div>
  </section>`;
replaceOnce(/<section class="hero wrap">[\s\S]*?<\/section>/, landingHero);

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
      <article class="feature-card" data-colipas-feature="contextual-launch-summary">${landingIcon('checklist', 'icon feature-icon')}<h3>上下文上线检查</h3><p>六项完整上线检查只在总览页出现；其它模块通过顶栏「待办 N 项」一键回到概览，修复顺序直接标在清单条目上。</p><div class="tags"><span>单一表达位置</span><span>顶栏待办入口</span></div></article>`);
}

if (!html.includes('data-colipas-feature="fleet-views"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      <article class="feature-card" data-colipas-feature="fleet-views">${landingIcon('checklist', 'icon feature-icon')}<h3>资产视图</h3><p>把关键词、厂商、状态、地域和健康筛选保存为浏览器本机视图，排障时可一键恢复工作范围。</p><div class="tags"><span>本机保存</span><span>一键恢复</span></div></article>`);
}

const serverBulkImportFeatureCard = `<article class="feature-card" data-colipas-feature="server-bulk-import">${landingIcon('assets', 'icon feature-icon')}<h3>安全批量资产导入</h3><p>选择或粘贴 CSV / JSON 后先预览校验，可下载带表格公式注入防护的本地校验报告；单次最多导入 500 台无凭据资产。</p><div class="tags"><span>批量迁移</span><span>本地校验报告</span></div></article>`;
if (!html.includes('data-colipas-feature="server-bulk-import"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      ${serverBulkImportFeatureCard}`);
} else {
  replaceOnce(/<article class="feature-card" data-colipas-feature="server-bulk-import">[\s\S]*?<\/article>/, serverBulkImportFeatureCard);
}

if (!html.includes('data-colipas-feature="command-palette-context"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      <article class="feature-card" data-colipas-feature="command-palette-context">${landingIcon('command', 'icon feature-icon')}<h3>上下文命令面板</h3><p>按当前最高优先级事项、最近使用和全部操作分层展示跨模块入口；最近历史只保存在浏览器中，可随时清除。</p><div class="tags"><span>当前优先级</span><span>本机历史</span></div></article>`);
}

const resourceAlertPolicyFeatureCard = `<article class="feature-card" data-colipas-feature="resource-alert-policy">${landingIcon('alert', 'icon feature-icon')}<h3>资源告警策略</h3><p>仅用已验证、运行中且遥测新鲜的 SSH 资产生成资源告警；过期或不可用样本会明确标记并跳过。</p><div class="tags"><span>可信遥测</span><span>周期提醒</span></div></article>`;
if (!html.includes('data-colipas-feature="resource-alert-policy"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      ${resourceAlertPolicyFeatureCard}`);
} else {
  replaceOnce(/<article class="feature-card" data-colipas-feature="resource-alert-policy">[\s\S]*?<\/article>/, resourceAlertPolicyFeatureCard);
}

const serverMetricHistoryFeatureCard = `<article class="feature-card" data-colipas-feature="server-metric-history">${landingIcon('trend', 'icon feature-icon')}<h3>可信资源历史</h3><p>只在 SSH 指标采集成功后记录 CPU、内存和磁盘，支持 1 小时至 7 天趋势；失败与仅登记资产不会混入。</p><div class="tags"><span>有界历史</span><span>来源可辨</span></div></article>`;
if (!html.includes('data-colipas-feature="server-metric-history"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      ${serverMetricHistoryFeatureCard}`);
} else {
  replaceOnce(/<article class="feature-card" data-colipas-feature="server-metric-history">[\s\S]*?<\/article>/, serverMetricHistoryFeatureCard);
}

const operationsInboxFeatureCard = `<article class="feature-card" data-colipas-feature="operations-inbox">${landingIcon('inbox', 'icon feature-icon')}<h3>全局运维收件箱</h3><p>汇总资源越线、上线阻塞、SSH 与资产覆盖缺口和开放事件；持续越线会按策略周期再次提醒，本机只保存安全事项 ID 与时间。</p><div class="tags"><span>跨模块聚合</span><span>本机审阅</span></div></article>`;
if (!html.includes('data-colipas-feature="operations-inbox"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      ${operationsInboxFeatureCard}`);
} else {
  replaceOnce(/<article class="feature-card" data-colipas-feature="operations-inbox">[\s\S]*?<\/article>/, operationsInboxFeatureCard);
}

const accountSessionFeatureCard = `<article class="feature-card" data-colipas-feature="account-session-control">${landingIcon('shield', 'icon feature-icon')}<h3>登录会话控制</h3><p>只把令牌哈希与脱敏设备信息写入 SQLite，不保存原始 Cookie、IP 或 User-Agent；服务重启后会话仍保持且可撤销。账户设置仅在前台且在线时同步，隐藏或离线自动暂停。</p><div class="tags"><span>令牌哈希入库</span><span>前台在线同步</span><span>隐藏即暂停</span></div></article>`;
if (!html.includes('data-colipas-feature="account-session-control"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      ${accountSessionFeatureCard}`);
} else {
  replaceOnce(/<article class="feature-card" data-colipas-feature="account-session-control">[\s\S]*?<\/article>/, accountSessionFeatureCard);
}

const operatorControlsFeatureCard = `<article class="feature-card" data-colipas-feature="operator-controls">${landingIcon('controls', 'icon feature-icon')}<h3>自适应操作员控制</h3><p>桌面和手机端把刷新、语言、账户与退出集中到同一个溢出面板，顶栏始终保留登录名称、同步状态和核心运维入口。</p><div class="tags"><span>单行顶栏</span><span>键盘可关闭</span></div></article>`;
if (!html.includes('data-colipas-feature="operator-controls"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      ${operatorControlsFeatureCard}`);
} else {
  replaceOnce(/<article class="feature-card" data-colipas-feature="operator-controls">[\s\S]*?<\/article>/, operatorControlsFeatureCard);
}

const adaptiveRefreshFeatureCard = `<article class="feature-card" data-colipas-feature="adaptive-refresh">${landingIcon('refresh', 'icon feature-icon')}<h3>智能刷新调度</h3><p>标准模式每 15 秒、性能模式每 30 秒同步总览；隐藏或离线暂停，多标签页共享主同步快照，资产未变化时使用私有 ETag 和 304 响应复用载荷，并量化节省的请求与字节。</p><div class="tags"><span>同步健康</span><span>载荷复用</span></div></article>`;
if (!html.includes('data-colipas-feature="adaptive-refresh"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      ${adaptiveRefreshFeatureCard}`);
} else {
  replaceOnce(/<article class="feature-card" data-colipas-feature="adaptive-refresh">[\s\S]*?<\/article>/, adaptiveRefreshFeatureCard);
}

const intentReadyNavigationFeatureCard = `<article class="feature-card" data-colipas-feature="intent-ready-navigation">${landingIcon('flow', 'icon feature-icon')}<h3>意图就绪导航</h3><p>目标工作区准备完成前保留当前界面，连续切换只响应最后一次选择；标准模式按网络条件分阶段准备，性能模式只加载明确选择的模块。</p><div class="tags"><span>原子切换</span><span>竞态保护</span></div></article>`;
if (!html.includes('data-colipas-feature="intent-ready-navigation"')) {
  replaceOnce(/(<div class="feature-grid">)/, `$1
      ${intentReadyNavigationFeatureCard}`);
} else {
  replaceOnce(/<article class="feature-card" data-colipas-feature="intent-ready-navigation">[\s\S]*?<\/article>/, intentReadyNavigationFeatureCard);
}

const landingFeatureGrid = [
  landingFeatureCard({ kind: 'terminal', title: '实时 SSH 工作区', description: '浏览器内直接进入 PTY 终端，连续读取输出、调整窗口、中断前台命令，并在关闭界面时释放远端会话。', tags: ['xterm', '低延迟输入'], wide: true }),
  landingFeatureCard({ kind: 'ai', title: '上下文 AI 运维助手', description: '把当前服务器与终端上下文交给自定义 OpenAI 兼容模型分析；命令先确认，再交给真实 SSH 会话执行。', tags: ['流式对话', '执行确认'], wide: true }),
  landingFeatureCard({ kind: 'checklist', title: '上下文上线检查', description: '六项检查只在总览页渲染，其它模块通过顶栏「待办 N 项」回到概览；修复顺序直接标在清单条目上。', tags: ['单一表达位置', '顶栏待办入口'], featureId: 'contextual-launch-summary' }),
  landingFeatureCard({ kind: 'assets', title: '资产视图', description: '保存关键词、厂商、状态、地域和健康筛选，排障时一键恢复常用工作范围。', tags: ['本机保存', '快速恢复'], featureId: 'fleet-views' }),
  landingFeatureCard({ kind: 'assets', title: '安全批量资产导入', description: 'CSV / JSON 先预览校验再登记，单次最多 500 台无凭据资产，并提供本地校验报告。', tags: ['2 MB 上限', '公式注入防护'], featureId: 'server-bulk-import' }),
  landingFeatureCard({ kind: 'command', title: '上下文命令面板', description: '按当前优先级、最近使用和全部操作组织跨模块入口，减少重复搜索与页面跳转。', tags: ['最近使用', '跨模块'], featureId: 'command-palette-context' }),
  landingFeatureCard({ kind: 'alert', title: '资源告警策略', description: '仅使用已验证、运行中且新鲜的 SSH 遥测判断 CPU、内存和磁盘越线。', tags: ['可信遥测', '周期提醒'], featureId: 'resource-alert-policy' }),
  landingFeatureCard({ kind: 'trend', title: '可信资源历史', description: '成功采样后记录 CPU、内存和磁盘，按 1 小时到 7 天查看趋势、峰值和来源。', tags: ['有界历史', '来源可辨'], featureId: 'server-metric-history' }),
  landingFeatureCard({ kind: 'inbox', title: '全局运维收件箱', description: '跨模块汇总资源越线、上线阻塞、SSH 覆盖缺口与开放事件，持续异常会再次提醒。', tags: ['值班入口', '本机审阅'], featureId: 'operations-inbox' }),
  landingFeatureCard({ kind: 'shield', title: '登录会话控制', description: 'SQLite 只保存令牌哈希和脱敏设备信息；服务重启后会话仍可管理和撤销。', tags: ['令牌哈希', '容量控制'], featureId: 'account-session-control' }),
  landingFeatureCard({ kind: 'controls', title: '自适应操作员控制', description: '桌面与手机端统一收纳刷新、语言、账户和退出，同时保留登录名称与同步状态。', tags: ['单行顶栏', '键盘可用'], featureId: 'operator-controls' }),
  landingFeatureCard({ kind: 'refresh', title: '智能刷新调度', description: '可见时同步，隐藏或离线时暂停；多标签页复用快照，并用 ETag 和 304 避免重复载荷。', tags: ['退避恢复', '载荷复用'], featureId: 'adaptive-refresh' }),
  landingFeatureCard({ kind: 'flow', title: '意图就绪导航', description: '目标工作区准备完成前保留当前页面，连续切换只响应最后一次选择，避免竞态闪烁。', tags: ['原子切换', '竞态保护'], featureId: 'intent-ready-navigation' }),
  landingFeatureCard({ kind: 'shield', title: '安全审计闭环', description: '登录、AI、API、SSH 和编排动作进入统一审计链路，风险可定位、结果可复盘。', tags: ['敏感脱敏', '修复留痕'] }),
].join('\n      ');
replaceOnce(
  /(<div class="feature-grid">)[\s\S]*?(<\/div>\s*<\/section>\s*<section id="security")/,
  `$1\n      ${landingFeatureGrid}\n    $2`,
);

const landingWorkflow = `<section id="product" class="section wrap workflow-section">
    <div class="workflow-heading">
      <div>
        <p class="kicker">运维链路</p>
        <h2>每一步都有输入、状态和下一步</h2>
      </div>
      <p class="section-copy">从资产登记到审计复盘，CoLiPas 把原本分散的操作串成一条可观测链路；当前状态、执行边界和证据去向始终清晰。</p>
    </div>
    <div class="workflow-shell" aria-label="CoLiPas 运维工作流">
      <div class="workflow-rail" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <article class="workflow-stage workflow-stage-assets">
        <div class="workflow-stage-head"><span class="workflow-index">01</span>${landingIcon('assets', 'workflow-stage-icon')}</div>
        <p class="workflow-overline">Inventory</p>
        <h3>登记资产</h3>
        <p>统一记录厂商、地域、系统和标签，批量导入先校验再写入。</p>
        <div class="workflow-signal"><b></b><span>资产上下文已建立</span></div>
      </article>
      <article class="workflow-stage workflow-stage-terminal">
        <div class="workflow-stage-head"><span class="workflow-index">02</span>${landingIcon('terminal', 'workflow-stage-icon')}</div>
        <p class="workflow-overline">Live session</p>
        <h3>验证与操作</h3>
        <p>连接真实 PTY，连续读取输出、调整窗口并安全中断前台命令。</p>
        <div class="workflow-signal"><b></b><span>SSH 会话可追踪</span></div>
      </article>
      <article class="workflow-stage workflow-stage-ai">
        <div class="workflow-stage-head"><span class="workflow-index">03</span>${landingIcon('ai', 'workflow-stage-icon')}</div>
        <p class="workflow-overline">Diagnosis</p>
        <h3>分析与修复</h3>
        <p>AI 读取当前服务器证据，建议命令经过确认后再进入 SSH 执行。</p>
        <div class="workflow-signal"><b></b><span>人机确认边界明确</span></div>
      </article>
      <article class="workflow-stage workflow-stage-shield">
        <div class="workflow-stage-head"><span class="workflow-index">04</span>${landingIcon('shield', 'workflow-stage-icon')}</div>
        <p class="workflow-overline">Evidence</p>
        <h3>审计与复盘</h3>
        <p>登录、API、命令和编排结果汇入统一审计链，风险可定位、结果可复核。</p>
        <div class="workflow-signal"><b></b><span>关键动作已留痕</span></div>
      </article>
    </div>
    <div class="workflow-handoff" aria-label="工作流交接关系">
      <span>资产上下文</span><i></i><span>实时证据</span><i></i><span>确认后执行</span><i></i><span>审计记录</span>
    </div>
  </section>`;
replaceOnce(/<section id="product" class="section wrap[^"]*">[\s\S]*?<\/section>/, landingWorkflow);

const deployCommand = 'curl -fsSL https://raw.githubusercontent.com/nmklio/CoLiPas/master/scripts/one-click-deploy.sh | sudo env COLIPAS_DEPLOY_MODE=docker bash';
const landingDeploy = `<section id="deploy" class="section wrap deploy-section-modern">
    <div class="deploy-heading-modern">
      <div>
        <p class="kicker">私有化部署</p>
        <h2>一条命令开始，数据始终留在自己的服务器</h2>
      </div>
      <p class="section-copy">交互式脚本会引导选择目录、域名、管理员和运行方式；已有 .env 与 .data 会原样保留，不覆盖用户数据。</p>
    </div>
    <div class="deploy-command-center">
      <div class="deploy-console">
        <div class="deploy-console-head"><span><i></i><i></i><i></i></span><b>推荐 · Docker Compose</b><em>约 3 分钟</em></div>
        <div class="deploy-console-body">
          <p>在 Linux 服务器中运行</p>
          <div class="deploy-command-line"><code>${deployCommand}</code><button type="button" data-copy-deploy data-copy-value="${deployCommand}" aria-label="复制一键部署命令">${landingIcon('copy', 'copy-icon')}<span>复制</span></button></div>
          <div class="deploy-console-result"><b></b><span>自动检查 Docker、创建私有配置并验证健康接口</span></div>
        </div>
      </div>
      <div class="deploy-methods" aria-label="部署方式">
        <article class="deploy-method deploy-method-primary">${landingIcon('database', 'deploy-method-icon')}<div><span>推荐</span><h3>Docker Compose</h3><p>运行环境隔离，挂载 .data 持久化，升级和迁移路径更直接。</p></div><strong>容器化</strong></article>
        <article class="deploy-method">${landingIcon('terminal', 'deploy-method-icon')}<div><span>原生</span><h3>Linux systemd</h3><p>Node 24+ 直接运行，由 systemd 守护并配合 Nginx 提供 HTTPS。</p></div><strong>长期运行</strong></article>
      </div>
    </div>
    <div class="deploy-flow-modern" aria-label="部署完成路径">
      <article><span>01</span><div><strong>环境预检</strong><p>检测系统、Docker 或 Node 版本</p></div></article>
      <article><span>02</span><div><strong>安全配置</strong><p>交互填写域名与管理员信息</p></div></article>
      <article><span>03</span><div><strong>启动验证</strong><p>构建服务并检查 /api/health</p></div></article>
      <article><span>04</span><div><strong>进入后台</strong><p>使用配置的账号开始接入资产</p></div></article>
    </div>
    <div class="deploy-runtime-row"><span><b></b>数据目录持久化</span><span><b></b>现有配置保留</span><span><b></b>健康检查内置</span><a href="/docs.html">查看完整部署文档</a></div>
  </section>`;
replaceOnce(/<section id="deploy" class="section wrap[^"]*">[\s\S]*?<\/section>/, landingDeploy);

const landingFooter = `<footer class="footer">
  <div class="wrap footer-main">
    <div class="footer-brand-block"><a href="#top" class="footer-brand-link"><img src="/colipas-icon.svg" alt="" aria-hidden="true"><span><strong>CoLiPas</strong><small>云服务器管理面板</small></span></a><p>云服务器管理与 AI 运维后台，把资产、SSH、编排与审计留在同一个自托管工作区。</p></div>
    <nav aria-label="产品"><strong>产品</strong><a href="#product">运维链路</a><a href="#features">功能模块</a><a href="#security">安全机制</a></nav>
    <nav aria-label="资源"><strong>资源</strong><a href="/docs.html">使用文档</a><a href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">GitHub</a><a href="#deploy">部署指南</a></nav>
    <div class="footer-action"><span>准备管理自己的服务器？</span><a href="/admin/">进入管理后台</a></div>
  </div>
  <div class="wrap footer-bottom"><span>© 2026 CoLiPas · 自托管云服务器运维后台</span><div class="footer-runtime"><span><i></i>服务在线</span><span>数据自主保留</span><span>开源部署</span></div></div>
</footer>`;
replaceOnce(/<footer class="footer">[\s\S]*?<\/footer>/, landingFooter);

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

replaceOnce('</style>', `/* colipas landing immersive product ui v2 */
:root {
  --landing-dark: #090d0f;
  --landing-dark-soft: #111718;
  --landing-dark-line: #273132;
  --landing-paper: #f4f6f4;
  --landing-panel: #ffffff;
  --landing-ink: #101817;
  --landing-muted: #5f6c69;
  --landing-mint: #72dec4;
  --landing-mint-strong: #137c69;
  --landing-amber: #e8b968;
}
body {
  color: var(--landing-ink);
  background: var(--landing-paper);
}
body::selection {
  color: #07110f;
  background: #9cebd8;
}
.top-line {
  height: 3px;
  background: rgba(114, 222, 196, .12);
}
.top-line span {
  background: #72dec4;
}
.wrap,
.nav-inner {
  width: min(1200px, calc(100% - 64px));
}
.nav {
  height: 72px;
  border-bottom-color: rgba(255, 255, 255, .07);
  background: rgba(9, 13, 15, .88);
  backdrop-filter: blur(18px);
}
.brand {
  color: #f7faf9;
  font-size: 17px;
}
.brand-mark {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  box-shadow: none;
}
.nav-links {
  color: #aab4b2;
  font-weight: 760;
}
.nav-links a {
  border-radius: 6px;
}
.nav-links a:hover {
  color: #ffffff;
  background: rgba(255, 255, 255, .06);
}
.nav-github,
.nav-action {
  min-height: 40px;
  border-radius: 7px;
  padding: 0 17px;
  box-shadow: none;
}
.nav-github {
  color: #c4cecc;
  border-color: rgba(255, 255, 255, .12);
  background: rgba(255, 255, 255, .035);
}
.nav-action {
  color: #0a1311;
  border: 1px solid #f5f8f7;
  background: #f5f8f7;
}
.nav-github:hover {
  color: #ffffff;
  border-color: rgba(255, 255, 255, .25);
  background: rgba(255, 255, 255, .07);
}
.nav-action:hover {
  color: #07110f;
  background: #dff8f1;
  border-color: #dff8f1;
}
.hero {
  position: relative;
  z-index: 0;
  min-height: 0;
  padding: 94px 0 72px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  text-align: center;
  transform: none;
}
.hero::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 0 50% 0 auto;
  width: 100vw;
  transform: translateX(50%);
  background: var(--landing-dark);
}
.hero-copy {
  width: min(1000px, 100%);
  display: grid;
  justify-items: center;
  animation: landing-rise .65s ease-out both;
}
.pill {
  min-height: 30px;
  padding: 0 12px;
  color: #b8c4c1;
  border-color: rgba(255, 255, 255, .11);
  border-radius: 999px;
  background: rgba(255, 255, 255, .035);
  box-shadow: none;
  font-size: 12px;
  font-weight: 720;
}
.pill::before {
  background: var(--landing-mint);
  box-shadow: 0 0 0 4px rgba(114, 222, 196, .09);
}
.hero h1,
.hero h1 .hero-title-main,
.hero h1 .hero-title-accent {
  max-width: none;
  color: #f4f7f6;
}
.hero h1 {
  margin: 27px 0 20px;
  font-size: 72px;
  line-height: 1.02;
  font-weight: 820;
  letter-spacing: 0;
  text-wrap: balance;
}
.hero h1 .hero-title-main,
.hero h1 .hero-title-accent {
  display: inline;
}
.hero h1 .hero-title-main::after {
  content: ' ';
}
.hero h1 .hero-title-accent {
  color: #aeb8b6;
}
.lead {
  max-width: 720px;
  color: #a8b2b0;
  font-size: 17px;
  line-height: 1.75;
}
.hero-buttons {
  justify-content: center;
  margin-top: 30px;
  gap: 10px;
}
.hero .button {
  min-width: 154px;
  min-height: 48px;
  border-radius: 7px;
  padding: 0 20px;
  box-shadow: none;
}
.hero .hero-primary {
  color: #07110f;
  border-color: #f4f7f6;
  background: #f4f7f6;
}
.hero .hero-secondary {
  color: #d6dddb;
  border-color: rgba(255, 255, 255, .14);
  background: rgba(255, 255, 255, .035);
}
.hero .hero-primary:hover {
  color: #07110f;
  border-color: #dff8f1;
  background: #dff8f1;
}
.hero .hero-secondary:hover {
  color: #ffffff;
  border-color: rgba(255, 255, 255, .28);
  background: rgba(255, 255, 255, .07);
}
.hero .stats {
  width: min(600px, 100%);
  max-width: none;
  margin-top: 34px;
  padding-top: 18px;
  border-top-color: rgba(255, 255, 255, .09);
}
.hero .stats div {
  min-height: 48px;
  border-right-color: rgba(255, 255, 255, .09);
}
.hero .stats strong {
  color: #eef5f3;
  font-size: 19px;
}
.hero .stats span {
  color: #7f8c89;
  font-size: 11px;
}
.product-preview {
  position: relative;
  width: min(1040px, 100%);
  max-width: none;
  margin: 52px auto 0;
  overflow: hidden;
  justify-self: auto;
  border: 1px solid rgba(255, 255, 255, .12);
  border-radius: 8px;
  background: #071016;
  box-shadow: 0 36px 80px rgba(0, 0, 0, .38);
  transform: none;
  animation: landing-rise .75s .12s ease-out both;
}
.preview-top {
  height: 42px;
  border-bottom-color: rgba(255, 255, 255, .08);
  background: #111719;
}
.preview-top span {
  color: #7d8987;
  font-size: 11px;
}
.product-preview > img {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 1600 / 980;
  object-fit: cover;
  object-position: top center;
}
.product-preview figcaption {
  min-height: 42px;
  padding: 0 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  border-top: 1px solid rgba(255, 255, 255, .07);
  color: #73807d;
  background: #0d1315;
  font: 700 10px ui-monospace, SFMono-Regular, Consolas, monospace;
  text-transform: uppercase;
}
#product.section {
  position: relative;
  z-index: 0;
  padding-top: 82px;
  padding-bottom: 86px;
  color: #edf3f1;
}
#product.section::before {  content: '';
  position: absolute;
  z-index: -1;
  inset: 0 50% 0 auto;
  width: 100vw;
  transform: translateX(50%);
  background: transparent;
}
#product .split {
  grid-template-columns: minmax(0, .92fr) minmax(360px, .7fr);
  gap: 64px;
}
#product .kicker,
#security .kicker {
  color: var(--landing-mint);
}
#product h2,
#security h2 {
  color: #f3f7f5;
}
#product .section-copy {
  color: #a9b5b2;
  border-left-color: var(--landing-mint);
}
.position-grid {
  position: relative;
  margin-top: 48px;
  gap: 0;
  border-top: 1px solid var(--landing-dark-line);
  border-bottom: 1px solid var(--landing-dark-line);
}
.position-card,
.position-card-modern {
  min-height: 142px;
  padding: 25px 22px;
  border: 0;
  border-right: 1px solid var(--landing-dark-line);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.position-card:last-child {
  border-right: 0;
}
.position-card::before,
.position-card::after {
  display: none;
}
.position-step {
  color: #64716e;
  font-size: 24px;
}
.position-card-modern strong {
  color: #f0f5f3;
  font-size: 17px;
}
.position-card-modern .position-copy > span {
  color: #899692;
}
.position-card-modern .position-state {
  color: #a4ecda;
  border-color: rgba(114, 222, 196, .18);
  background: rgba(114, 222, 196, .08);
}
#features.section {
  position: relative;
  z-index: 0;
  padding-top: 96px;
  padding-bottom: 104px;
}
#features.section::before,
#deploy.section::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 0 50% 0 auto;
  width: 100vw;
  transform: translateX(50%);
  background: var(--landing-paper);
}
#features .feature-head {
  max-width: none;
  margin-bottom: 44px;
  display: grid;
  grid-template-columns: minmax(0, .85fr) minmax(360px, .55fr);
  align-items: end;
  gap: 54px;
}
#features h2,
#deploy h2 {
  color: var(--landing-ink);
}
#features .section-copy,
#deploy .section-copy {
  color: var(--landing-muted);
}
.feature-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}
.feature-card {
  min-height: 232px;
  padding: 22px;
  border-color: #dfe5e2;
  border-radius: 8px;
  background: rgba(255, 255, 255, .78);
  box-shadow: none;
}
.feature-card::before {
  display: none;
}
.feature-card:hover {
  border-color: #b7c8c3;
  background: #ffffff;
  box-shadow: 0 18px 42px rgba(16, 36, 31, .07);
  transform: translateY(-2px);
}
.feature-card-wide {
  grid-column: span 2;
  min-height: 250px;
  padding: 28px;
  color: #edf5f2;
  border-color: #263433;
  background: #14201f;
}
.feature-card-wide:hover {
  border-color: #3e5753;
  background: #182624;
  box-shadow: 0 22px 52px rgba(9, 19, 17, .15);
}
.feature-icon {
  width: 44px;
  height: 44px;
  border: 1px solid #d6e2de;
  border-radius: 7px;
  color: var(--landing-mint-strong);
  background: #edf7f4;
  box-shadow: none;
}
.feature-icon svg {
  width: 23px;
  height: 23px;
  stroke-width: 1.7;
}
.feature-card-wide .feature-icon {
  color: var(--landing-mint);
  border-color: rgba(114, 222, 196, .18);
  background: rgba(114, 222, 196, .08);
}
.feature-card h3 {
  margin-top: 20px;
  color: #17201f;
  font-size: 18px;
}
.feature-card-wide h3 {
  color: #f0f6f4;
  font-size: 23px;
}
.feature-card p {
  color: #61706c;
  font-size: 13px;
  line-height: 1.68;
}
.feature-card-wide p {
  max-width: 520px;
  color: #a9b7b3;
  font-size: 15px;
}
.tags span {
  min-height: 24px;
  padding: 0 8px;
  color: #63746f;
  border-color: #d9e5e1;
  border-radius: 5px;
  background: #f4f8f6;
  font-size: 10px;
}
.feature-card-wide .tags span {
  color: #9ee7d6;
  border-color: rgba(114, 222, 196, .15);
  background: rgba(114, 222, 196, .07);
}
.band {
  padding: 92px 0;
  color: #eef5f3;
  background: #16211f;
}
.security-layout {
  gap: 70px;
}
#security .section-copy {
  color: #9faca8;
}
.security-list {
  border-top: 1px solid #33413e;
}
.security-list div {
  min-height: 60px;
  padding: 0 12px;
  border-left: 0;
  border-right: 0;
  border-radius: 0;
  border-bottom-color: #33413e;
  color: #dce5e2;
  background: transparent;
  box-shadow: none;
}
.security-list b {
  background: var(--landing-mint);
}
#deploy.section {
  position: relative;
  z-index: 0;
  padding-top: 96px;
  padding-bottom: 104px;
}
.deploy-step {
  border-radius: 7px;
  border-color: #dfe6e3;
  background: rgba(255, 255, 255, .7);
  box-shadow: none;
}
.deploy-step b {
  color: #0c1714;
  background: var(--landing-mint);
}
.deploy-card {
  min-height: 210px;
  border-color: #dfe5e2;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: none;
}
.deploy-icon {
  color: var(--landing-mint-strong);
  border-color: #d6e2de;
  border-radius: 7px;
  background: #edf7f4;
  box-shadow: none;
}
.deploy-card code {
  color: #36554d;
  border-color: #dce6e2;
  background: #f3f7f5;
}
.footer {
  border-top-color: rgba(255, 255, 255, .07);
  background: var(--landing-dark);
}
.footer strong {
  color: #f2f6f5;
}
.footer span,
.footer p,
.footer a {
  color: #84918e;
}
a:focus-visible,
button:focus-visible {
  outline: 3px solid rgba(114, 222, 196, .5);
  outline-offset: 3px;
}
@keyframes landing-rise {
  from { opacity: 0; transform: translateY(18px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (max-width: 1100px) {
  .hero h1 { font-size: 60px; }
  .feature-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .feature-card-wide { grid-column: span 3; }
}
@media (max-width: 980px) {
  .wrap,
  .nav-inner { width: min(100% - 40px, 760px); }
  .hero { padding: 78px 0 62px; }
  .hero h1 { font-size: 54px; }
  .product-preview { margin-top: 44px; }
  #product .split,
  #features .feature-head { grid-template-columns: 1fr; gap: 22px; }
  #product .section-copy { padding-left: 0; border-left: 0; }
  .position-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .position-card:nth-child(2) { border-right: 0; }
  .position-card:nth-child(-n + 2) { border-bottom: 1px solid var(--landing-dark-line); }
  .feature-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .feature-card-wide { grid-column: span 2; }
}
@media (max-width: 640px) {
  .wrap,
  .nav-inner { width: calc(100% - 32px); }
  .nav { height: 64px; }
  .nav-inner { grid-template-columns: 1fr auto; gap: 12px; }
  .brand { font-size: 16px; }
  .brand-mark { width: 34px; height: 34px; }
  .nav-links { display: none; }
  .nav-actions { width: auto; }
  .nav-github,
  .nav-action { width: auto; min-height: 38px; padding: 0 11px; font-size: 12px; }
  .hero { padding: 66px 0 48px; }
  .hero-copy { width: 100%; }
  .pill { min-height: 28px; padding: 0 10px; font-size: 10px; }
  .hero h1 { margin: 23px 0 18px; font-size: 42px; line-height: 1.06; }
  .hero h1 .hero-title-main,
  .hero h1 .hero-title-accent { display: block; }
  .hero h1 .hero-title-main::after { content: ''; }
  .lead { font-size: 15px; line-height: 1.7; }
  .hero-buttons { width: 100%; margin-top: 26px; }
  .hero .button { width: 100%; min-height: 48px; }
  .hero .stats { margin-top: 28px; }
  .hero .stats div { padding: 0 6px; }
  .hero .stats strong { font-size: 17px; }
  .hero .stats span { font-size: 9px; line-height: 1.35; }
  .product-preview { width: calc(100% + 8px); margin-top: 40px; }
  .preview-top { height: 36px; padding: 0 12px; }
  .preview-top span { margin-left: 6px; font-size: 9px; }
  .product-preview figcaption { min-height: 36px; gap: 12px; padding: 0 10px; font-size: 8px; }
  #product.section,
  #features.section,
  #deploy.section,
  .band { padding-top: 64px; padding-bottom: 68px; }
  #product h2,
  #features h2,
  #security h2,
  #deploy h2 { font-size: 34px; }
  .position-grid { margin-top: 34px; grid-template-columns: 1fr; }
  .position-card,
  .position-card-modern { min-height: 96px; padding: 18px 0; border-right: 0; border-bottom: 1px solid var(--landing-dark-line); }
  .position-card:last-child { border-bottom: 0; }
  .position-card:nth-child(-n + 2) { border-bottom: 1px solid var(--landing-dark-line); }
  .feature-grid { grid-template-columns: 1fr; }
  .feature-card,
  .feature-card-wide { grid-column: auto; min-height: 0; padding: 20px; }
  .feature-card-wide h3 { font-size: 21px; }
  .security-layout { gap: 36px; }
  .deploy-flow,
  .deploy-grid { grid-template-columns: 1fr; }
}
/* Continuous dark product system */
body {
  color: #e7efed;
  background: #090e10;
}
.preview-top {
  justify-content: flex-start;
}
.preview-top span {
  margin-left: 4px;
  color: #b9c4c1;
  font-weight: 760;
}
.preview-top em {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #7e8c89;
  font-size: 10px;
  font-style: normal;
  font-weight: 760;
}
.preview-top em b {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 5px rgba(52, 211, 153, .08);
}
.preview-stage {
  position: relative;
  overflow: hidden;
  width: 100%;
  aspect-ratio: 1600 / 980;
  background: #071016;
}
.preview-scene {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
  opacity: 0;
  transform: scale(1.015);
  transition: opacity .55s ease, transform 1.1s ease;
  pointer-events: none;
}
.preview-scene.is-active {
  z-index: 1;
  opacity: 1;
  transform: scale(1);
}
.product-preview .preview-tabs {
  min-height: 54px;
  padding: 0 16px;
  gap: 8px;
  text-transform: none;
}
.preview-tabs button {
  position: relative;
  min-width: 124px;
  min-height: 38px;
  border: 0;
  border-radius: 6px;
  padding: 0 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #758380;
  background: transparent;
  font: 760 11px Inter, "Segoe UI", "PingFang SC", sans-serif;
  cursor: pointer;
  transition: color .2s ease, background .2s ease;
}
.preview-tabs button span {
  color: #52605d;
  font: 800 9px ui-monospace, SFMono-Regular, Consolas, monospace;
}
.preview-tabs button:hover {
  color: #dce5e2;
  background: rgba(255, 255, 255, .04);
}
.preview-tabs button[aria-selected="true"] {
  color: #eaf3f0;
  background: rgba(114, 222, 196, .08);
}
.preview-tabs button[aria-selected="true"] span {
  color: var(--landing-mint);
}
.preview-progress {
  height: 2px;
  background: rgba(255, 255, 255, .055);
}
.preview-progress i {
  display: block;
  width: 0;
  height: 100%;
  background: linear-gradient(90deg, #5eead4, #38bdf8, #a78bfa);
}
.product-tour.is-cycling .preview-progress i {
  animation: product-tour-progress 5.2s linear forwards;
}
@keyframes product-tour-progress {
  from { width: 0; }
  to { width: 100%; }
}

#product.workflow-section,
#features.section,
#deploy.deploy-section-modern {
  position: relative;
  z-index: 0;
  color: #e7efed;
}
#product.workflow-section::before,
#features.section::before,
#deploy.deploy-section-modern::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: 0 50% 0 auto;
  width: 100vw;
  transform: translateX(50%);
}
#product.workflow-section::before { background: transparent; }
#features.section::before { background: transparent; }
#deploy.deploy-section-modern::before { background: transparent; }
.workflow-section {
  padding-top: 92px;
  padding-bottom: 96px;
}
.workflow-heading,
.deploy-heading-modern {
  display: grid;
  grid-template-columns: minmax(0, .9fr) minmax(340px, .62fr);
  align-items: end;
  gap: 64px;
}
.workflow-heading h2,
.deploy-heading-modern h2,
#features h2,
#deploy h2 {
  color: #f1f6f4;
}
.workflow-heading .section-copy,
.deploy-heading-modern .section-copy,
#features .section-copy,
#deploy .section-copy {
  color: #98a6a2;
}
.workflow-shell {
  position: relative;
  margin-top: 48px;
  border: 1px solid #293536;
  border-radius: 10px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  background: #0b1113;
  overflow: hidden;
}
.workflow-rail {
  position: absolute;
  z-index: 2;
  left: 12.5%;
  right: 12.5%;
  top: 61px;
  height: 1px;
  display: flex;
  justify-content: space-between;
  background: linear-gradient(90deg, #5eead4, #38bdf8 38%, #a78bfa 70%, #fb7185);
  opacity: .72;
}
.workflow-rail i {
  width: 9px;
  height: 9px;
  margin-top: -4px;
  border: 2px solid #0b1113;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 4px rgba(114, 222, 196, .08);
}
.workflow-stage {
  position: relative;
  min-height: 302px;
  padding: 30px 25px 26px;
  border-right: 1px solid #293536;
  display: flex;
  flex-direction: column;
  background: transparent;
}
.workflow-stage:last-child { border-right: 0; }
.workflow-stage::after {
  content: '';
  position: absolute;
  inset: auto 24px 0;
  height: 3px;
  border-radius: 3px 3px 0 0;
  background: #5eead4;
  opacity: .7;
}
.workflow-stage-terminal::after { background: #38bdf8; }
.workflow-stage-ai::after { background: #a78bfa; }
.workflow-stage-shield::after { background: #fb7185; }
.workflow-stage-head {
  position: relative;
  z-index: 3;
  min-height: 62px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.workflow-index {
  color: #66736f;
  font: 850 13px ui-monospace, SFMono-Regular, Consolas, monospace;
}
.workflow-stage-icon {
  width: 40px;
  height: 40px;
  border: 1px solid #324241;
  border-radius: 8px;
  color: #79e7ce;
  display: grid;
  place-items: center;
  background: #13201f;
}
.workflow-stage-terminal .workflow-stage-icon { color: #67d8ff; background: #101e25; }
.workflow-stage-ai .workflow-stage-icon { color: #c4adff; background: #1b1827; }
.workflow-stage-shield .workflow-stage-icon { color: #ff9aa8; background: #24181d; }
.workflow-stage-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.workflow-overline {
  margin: 20px 0 0;
  color: #697874;
  font: 780 10px ui-monospace, SFMono-Regular, Consolas, monospace;
  text-transform: uppercase;
}
.workflow-stage h3 {
  margin: 8px 0 12px;
  color: #edf4f2;
  font-size: 21px;
}
.workflow-stage > p:not(.workflow-overline) {
  margin: 0;
  color: #8d9b97;
  font-size: 13px;
  line-height: 1.72;
}
.workflow-signal {
  margin-top: auto;
  padding-top: 22px;
  display: flex;
  align-items: center;
  gap: 9px;
  color: #b0bdb9;
  font-size: 11px;
  font-weight: 760;
}
.workflow-signal b {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #5eead4;
  box-shadow: 0 0 0 5px rgba(94, 234, 212, .07);
}
.workflow-stage-terminal .workflow-signal b { background: #38bdf8; box-shadow: 0 0 0 5px rgba(56, 189, 248, .07); }
.workflow-stage-ai .workflow-signal b { background: #a78bfa; box-shadow: 0 0 0 5px rgba(167, 139, 250, .07); }
.workflow-stage-shield .workflow-signal b { background: #fb7185; box-shadow: 0 0 0 5px rgba(251, 113, 133, .07); }
.workflow-handoff {
  min-height: 48px;
  margin-top: 16px;
  padding: 0 20px;
  border: 1px solid #263234;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: #71807c;
  background: rgba(8, 13, 15, .54);
  font: 720 10px ui-monospace, SFMono-Regular, Consolas, monospace;
}
.workflow-handoff i {
  width: 28px;
  height: 1px;
  background: #364341;
}

#features.section {
  padding-top: 96px;
  padding-bottom: 104px;
}
#features .kicker,
#deploy .kicker { color: #69d7bd; }
.feature-card {
  border-color: #273335;
  color: #e8efed;
  background: #11191b;
}
.feature-card:hover {
  border-color: #3a4a49;
  background: #151f21;
  box-shadow: 0 18px 42px rgba(0, 0, 0, .18);
}
.feature-card-wide,
.feature-card-wide:hover {
  border-color: #2f4241;
  background: #14201f;
}
.feature-card h3 { color: #e7efed; }
.feature-card p { color: #8f9d99; }
.feature-icon,
.feature-card-wide .feature-icon {
  color: #75dfc6;
  border-color: #31413f;
  background: #172422;
}
.tags span,
.feature-card-wide .tags span {
  color: #88a59e;
  border-color: #2a3a37;
  background: #14201e;
}
.band {
  border-top: 1px solid #24302f;
  border-bottom: 1px solid #24302f;
  background: #101917;
}

.deploy-section-modern {
  padding-top: 96px;
  padding-bottom: 104px;
}
.deploy-command-center {
  margin-top: 48px;
  display: grid;
  grid-template-columns: minmax(0, 1.28fr) minmax(320px, .72fr);
  gap: 14px;
}
.deploy-console {
  overflow: hidden;
  min-height: 300px;
  border: 1px solid #304042;
  border-radius: 10px;
  background: #080e10;
  box-shadow: 0 24px 70px rgba(0, 0, 0, .24);
}
.deploy-console-head {
  min-height: 52px;
  padding: 0 18px;
  border-bottom: 1px solid #293638;
  display: flex;
  align-items: center;
  gap: 14px;
  color: #93a19e;
  background: #11191b;
  font-size: 11px;
}
.deploy-console-head > span { display: inline-flex; gap: 6px; }
.deploy-console-head i { width: 8px; height: 8px; border-radius: 50%; background: #fb7185; }
.deploy-console-head i:nth-child(2) { background: #fbbf24; }
.deploy-console-head i:nth-child(3) { background: #34d399; }
.deploy-console-head b { color: #cbd5d2; }
.deploy-console-head em { margin-left: auto; color: #687672; font-style: normal; }
.deploy-console-body {
  min-height: 246px;
  padding: 30px;
  display: flex;
  flex-direction: column;
}
.deploy-console-body > p {
  margin: 0 0 16px;
  color: #7f8e8a;
  font-size: 12px;
  font-weight: 740;
}
.deploy-command-line {
  min-height: 90px;
  border: 1px solid #2c3a3c;
  border-radius: 8px;
  padding: 18px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 18px;
  background: #0d1517;
}
.deploy-command-line code {
  color: #b8c9c5;
  font: 650 13px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace;
  overflow-wrap: anywhere;
}
.deploy-command-line button {
  min-width: 84px;
  min-height: 40px;
  border: 1px solid #3a4a49;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: #dce6e3;
  background: #182224;
  font-weight: 800;
  cursor: pointer;
}
.deploy-command-line button:hover { border-color: #65cdb5; color: #8ce8d2; }
.copy-icon { width: 16px; height: 16px; display: inline-grid; place-items: center; }
.copy-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.deploy-console-result {
  margin-top: auto;
  padding-top: 22px;
  display: flex;
  align-items: center;
  gap: 10px;
  color: #81908c;
  font-size: 11px;
}
.deploy-console-result b {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 5px rgba(52, 211, 153, .07);
}
.deploy-methods { display: grid; gap: 14px; }
.deploy-method {
  min-height: 143px;
  border: 1px solid #293638;
  border-radius: 10px;
  padding: 20px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: 16px;
  background: #11191b;
}
.deploy-method-primary { border-color: #35514b; background: #12201e; }
.deploy-method-icon {
  width: 42px;
  height: 42px;
  border: 1px solid #334441;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #78e4ca;
  background: #182624;
}
.deploy-method-icon svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.8; }
.deploy-method div > span { color: #6ddcc1; font-size: 10px; font-weight: 800; }
.deploy-method h3 { margin: 6px 0 7px; color: #e9f1ef; font-size: 17px; }
.deploy-method p { margin: 0; color: #82908d; font-size: 12px; line-height: 1.6; }
.deploy-method > strong { color: #677571; font-size: 10px; white-space: nowrap; }
.deploy-flow-modern {
  margin-top: 18px;
  border: 1px solid #293638;
  border-radius: 9px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  overflow: hidden;
  background: #101719;
}
.deploy-flow-modern article {
  min-height: 94px;
  padding: 20px;
  border-right: 1px solid #293638;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 13px;
}
.deploy-flow-modern article:last-child { border-right: 0; }
.deploy-flow-modern article > span { color: #63d8bd; font: 850 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
.deploy-flow-modern strong { color: #dce6e3; font-size: 13px; }
.deploy-flow-modern p { margin: 5px 0 0; color: #71807c; font-size: 11px; line-height: 1.5; }
.deploy-runtime-row {
  min-height: 54px;
  padding: 0 18px;
  display: flex;
  align-items: center;
  gap: 24px;
  color: #768580;
  font-size: 11px;
  font-weight: 740;
}
.deploy-runtime-row span { display: inline-flex; align-items: center; gap: 7px; }
.deploy-runtime-row b { width: 5px; height: 5px; border-radius: 50%; background: #4fae9a; }
.deploy-runtime-row a { margin-left: auto; color: #7ee4cc; text-decoration: none; font-weight: 800; }
.deploy-runtime-row a:hover { color: #b1f4e4; }

.footer {
  min-height: 0;
  padding: 66px 0 26px;
  border-top: 1px solid #202b2c;
  background: #070b0d;
}
.footer-main {
  display: grid;
  grid-template-columns: minmax(260px, 1.35fr) repeat(2, minmax(120px, .55fr)) minmax(220px, .8fr);
  gap: 48px;
  align-items: start;
}
.footer-brand-link {
  width: fit-content;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  color: #f0f5f3;
  text-decoration: none;
}
.footer-brand-link img { width: 42px; height: 42px; border-radius: 9px; }
.footer-brand-link span,
.footer-brand-link strong,
.footer-brand-link small { display: block; }
.footer-brand-link strong { color: #f2f7f5; font-size: 17px; }
.footer-brand-link small { margin-top: 3px; color: #788682; font-size: 10px; font-weight: 720; }
.footer-brand-block p { max-width: 360px; margin: 18px 0 0; color: #71807c; font-size: 12px; line-height: 1.72; }
.footer-main nav { display: grid; gap: 12px; }
.footer-main nav strong { margin-bottom: 4px; color: #dfe7e5; font-size: 12px; }
.footer-main nav a { color: #71807c; font-size: 11px; text-decoration: none; }
.footer-main nav a:hover { color: #9cebd8; }
.footer-action {
  border-left: 1px solid #243032;
  padding-left: 30px;
}
.footer-action span { color: #83918d; font-size: 11px; }
.footer-action a {
  width: fit-content;
  min-height: 42px;
  margin-top: 14px;
  border: 1px solid #dfe7e5;
  border-radius: 7px;
  padding: 0 16px;
  display: inline-flex;
  align-items: center;
  color: #0a1211;
  background: #e7eeec;
  text-decoration: none;
  font-size: 12px;
  font-weight: 850;
}
.footer-bottom {
  min-height: 58px;
  margin-top: 50px;
  border-top: 1px solid #1e292a;
  padding: 20px 0 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  color: #596763;
  font-size: 10px;
}
.footer-runtime { display: inline-flex; align-items: center; gap: 18px; }
.footer-runtime span { display: inline-flex; align-items: center; gap: 7px; color: #66736f; }
.footer-runtime i { width: 6px; height: 6px; border-radius: 50%; background: #34d399; box-shadow: 0 0 0 4px rgba(52, 211, 153, .06); }

@media (max-width: 980px) {
  .workflow-heading,
  .deploy-heading-modern { grid-template-columns: 1fr; gap: 20px; }
  .workflow-shell { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .workflow-rail { display: none; }
  .workflow-stage:nth-child(3) { border-right: 0; }
  .workflow-stage:nth-child(-n + 3) { border-bottom: 1px solid #293536; }
  .deploy-command-center { grid-template-columns: 1fr; }
  .deploy-methods { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .deploy-flow-modern { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .deploy-flow-modern article:nth-child(2) { border-right: 0; }
  .deploy-flow-modern article:nth-child(-n + 2) { border-bottom: 1px solid #293638; }
  .footer-main { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .footer-action { border-left: 0; padding-left: 0; }
}
@media (max-width: 640px) {
  .preview-top em { display: none; }
  .product-preview .preview-tabs { min-height: 48px; padding: 0 6px; gap: 2px; }
  .preview-tabs button { min-width: 0; flex: 1; min-height: 36px; padding: 0 6px; font-size: 9px; }
  .preview-tabs button span { display: none; }
  .workflow-section,
  .deploy-section-modern { padding-top: 68px; padding-bottom: 72px; }
  .workflow-shell { grid-template-columns: 1fr; }
  .workflow-stage { min-height: 236px; border-right: 0; border-bottom: 1px solid #293536; }
  .workflow-stage:last-child { border-bottom: 0; }
  .workflow-handoff { justify-content: flex-start; overflow-x: auto; white-space: nowrap; }
  .deploy-console-body { padding: 20px; }
  .deploy-command-line { grid-template-columns: 1fr; }
  .deploy-command-line button { width: 100%; }
  .deploy-methods,
  .deploy-flow-modern { grid-template-columns: 1fr; }
  .deploy-method { grid-template-columns: auto minmax(0, 1fr); }
  .deploy-method > strong { display: none; }
  .deploy-flow-modern article { border-right: 0; border-bottom: 1px solid #293638; }
  .deploy-flow-modern article:last-child { border-bottom: 0; }
  .deploy-runtime-row { padding: 16px 0 0; flex-wrap: wrap; gap: 12px 18px; }
  .deploy-runtime-row a { width: 100%; margin-left: 0; }
  .footer { padding-top: 50px; }
  .footer-main { grid-template-columns: 1fr 1fr; gap: 34px 24px; }
  .footer-brand-block,
  .footer-action { grid-column: 1 / -1; }
  .footer-bottom { align-items: flex-start; flex-direction: column; }
  .footer-runtime { width: 100%; gap: 12px; flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .hero-copy,
  .product-preview,
  .preview-scene { animation: none; transition: none; }
  .preview-progress { display: none; }
  .feature-card,
  .button { transition: none; }
}
</style>`);

replaceOnce('</style>', `/* colipas landing live release ui v1 */
@keyframes lp-aurora-drift {
  0% { transform: translate3d(-3%, -2%, 0) scale(1); opacity: .5; }
  50% { transform: translate3d(2%, 2%, 0) scale(1.05); opacity: .82; }
  100% { transform: translate3d(-3%, -2%, 0) scale(1); opacity: .5; }
}
@keyframes lp-grid-drift {
  from { background-position: 0 0, 0 0; }
  to { background-position: 44px 44px, 44px 44px; }
}
@keyframes lp-title-sheen {
  0% { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}
@keyframes lp-cta-glow {
  0%, 68%, 100% { filter: brightness(1); }
  80% { filter: brightness(1.14); }
  90% { filter: brightness(1.04); }
}
@keyframes lp-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(114, 222, 196, .55); }
  55% { box-shadow: 0 0 0 7px rgba(114, 222, 196, 0); }
}
@keyframes lp-ticker {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}
.hero {
  overflow-x: clip;
}
.hero::after {
  content: '';
  position: absolute;
  z-index: -1;
  top: -150px;
  left: 50%;
  width: min(1120px, 94vw);
  height: 640px;
  transform: translateX(-50%);
  pointer-events: none;
  background:
    radial-gradient(38% 44% at 22% 30%, rgba(114, 222, 196, .22), transparent 70%),
    radial-gradient(34% 40% at 77% 26%, rgba(88, 140, 255, .17), transparent 72%),
    radial-gradient(46% 50% at 50% 80%, rgba(232, 185, 104, .10), transparent 74%);
  filter: blur(6px);
  animation: lp-aurora-drift 22s ease-in-out infinite;
}
.hero::before {
  background-image:
    linear-gradient(rgba(255, 255, 255, .035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, .035) 1px, transparent 1px);
  background-size: 44px 44px, 44px 44px;
  animation: lp-grid-drift 32s linear infinite;
}
.hero h1 .hero-title-accent {
  background-image: linear-gradient(100deg, #f4f7f6 0%, #9cebd8 32%, #f4f7f6 58%, #cfe9ff 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: lp-title-sheen 7.5s linear infinite;
}
.hero .hero-primary {
  animation: lp-cta-glow 5.4s ease-in-out infinite;
}
.live-release {
  margin-top: 26px;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px 10px;
  max-width: 100%;
  padding: 9px 15px;
  border: 1px solid rgba(114, 222, 196, .22);
  border-radius: 999px;
  background: linear-gradient(120deg, rgba(114, 222, 196, .10), rgba(9, 13, 15, .74) 46%, rgba(88, 140, 255, .10));
  color: #c7d3d0;
  font-size: 12px;
  font-weight: 700;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06);
}
.live-release .live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #72dec4;
  animation: lp-pulse 2.4s ease-out infinite;
}
.live-release .live-label {
  color: #8fa09c;
  font-size: 10px;
  font-weight: 820;
  letter-spacing: .08em;
  text-transform: uppercase;
}
.live-release .live-commit {
  color: #9cebd8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  letter-spacing: .02em;
}
.live-release .live-metric b {
  color: #f4f7f6;
  font-weight: 820;
}
.live-release .live-divider {
  width: 1px;
  height: 12px;
  background: rgba(255, 255, 255, .16);
}
.live-release .live-link {
  color: #9cebd8;
  text-decoration: none;
  border-bottom: 1px dashed rgba(156, 235, 216, .42);
}
.live-release .live-link:hover,
.live-release .live-link:focus-visible {
  color: #ffffff;
  border-bottom-color: #ffffff;
  outline: none;
}
.live-release[data-live-state='offline'] {
  border-color: rgba(232, 185, 104, .3);
}
.live-release[data-live-state='offline'] .live-dot {
  background: #e8b968;
  animation: none;
}
.capability-ticker {
  width: 100%;
  margin: 52px 0 0;
  padding: 12px 0;
  border-top: 1px solid rgba(255, 255, 255, .07);
  border-bottom: 1px solid rgba(255, 255, 255, .07);
  overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent);
}
.ticker-track {
  display: flex;
  width: max-content;
  gap: 34px;
  animation: lp-ticker 34s linear infinite;
}
.ticker-track span {
  color: #93a3a0;
  font-size: 12px;
  font-weight: 720;
  letter-spacing: .04em;
  white-space: nowrap;
}
.ticker-track span::before {
  content: '';
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 10px;
  border-radius: 50%;
  background: rgba(114, 222, 196, .72);
  vertical-align: middle;
}
.is-reveal-pending {
  opacity: 0;
  transform: translateY(18px);
}
.is-revealed {
  opacity: 1;
  transform: none;
  transition: opacity .6s ease, transform .6s cubic-bezier(.22, .61, .36, 1);
}
.feature-card,
.position-card {
  position: relative;
}
.feature-card::after,
.position-card::after {
  content: '';
  display: block;
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  transition: opacity .35s ease;
  background: radial-gradient(240px circle at var(--lp-x, 50%) var(--lp-y, 0%), rgba(114, 222, 196, .15), transparent 72%);
}
.feature-card:hover::after,
.position-card:hover::after,
.feature-card:focus-within::after,
.position-card:focus-within::after {
  opacity: 1;
}
@keyframes lp-scan {
  0% { transform: translateY(-120%); }
  100% { transform: translateY(320%); }
}
@keyframes lp-scene-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, .45); }
  55% { box-shadow: 0 0 0 6px rgba(74, 222, 128, 0); }
}
@keyframes lp-scene-ping {
  0% { box-shadow: 0 0 0 0 rgba(114, 222, 196, .5); }
  70% { box-shadow: 0 0 0 14px rgba(114, 222, 196, 0); }
  100% { box-shadow: 0 0 0 0 rgba(114, 222, 196, 0); }
}
@keyframes lp-scene-bar {
  from { width: calc(var(--v, 50%) * .7); }
  to { width: var(--v, 50%); }
}
.scene {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 16px;
  background: linear-gradient(180deg, #0b1316, #081013);
  color: #cfe0dc;
  font-size: 12px;
  overflow: hidden;
}
.scene-top {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.scene-top strong {
  color: #eaf6f3;
  font-size: 13px;
}
.scene-meta {
  color: #7f938f;
  font-size: 11px;
}
.scene-clock {
  margin-left: auto;
  font-style: normal;
  color: #9cebd8;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.scene-live {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4ade80;
  animation: lp-scene-pulse 2.2s infinite;
}
.scene-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.scene-kpis div {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, .07);
  border-radius: 8px;
  background: rgba(255, 255, 255, .02);
}
.scene-kpis span {
  color: #7f938f;
  font-size: 10px;
  letter-spacing: .04em;
}
.scene-kpis b {
  color: #eaf6f3;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
}
.scene-split {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr);
  gap: 10px;
  flex: 0 0 auto;
  height: 232px;
}
.scene-map {
  position: relative;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .07);
  border-radius: 8px;
  background: rgba(9, 20, 22, .7);
}
.scene-map svg {
  display: block;
  width: 100%;
  height: 100%;
}
.scene-map-grid {
  fill: none;
  stroke: rgba(114, 222, 196, .12);
  stroke-width: 1;
}
.scene-map-graticule {
  fill: none;
  stroke: rgba(114, 222, 196, .10);
  stroke-width: .8;
}
.scene-map-ocean {
  opacity: .9;
}
.scene-node-halo {
  fill: rgba(114, 222, 196, .16);
  stroke: rgba(114, 222, 196, .34);
  stroke-width: .8;
  animation: lp-scene-halo 3.4s ease-in-out infinite;
}
.scene-node {
  fill: #72dec4;
}
.scene-node-label {
  fill: #eaf6f3;
  font-size: 7px;
  font-weight: 800;
  letter-spacing: .04em;
}
.scene-node-value {
  fill: #9cebd8;
  font-size: 6px;
  font-weight: 700;
}
.scene-arc {
  fill: none;
  stroke: rgba(114, 222, 196, .5);
  stroke-width: 1;
  stroke-dasharray: 4 6;
  stroke-linecap: round;
  animation: lp-scene-arc 3.6s linear infinite;
}
.scene-arc-2 { animation-duration: 4.4s; stroke: rgba(90, 169, 255, .5); }
.scene-arc-3 { animation-duration: 5.2s; }
.scene-map-legend {
  position: absolute;
  left: 10px;
  bottom: 8px;
  display: flex;
  gap: 10px;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, .07);
  border-radius: 999px;
  background: rgba(6, 14, 16, .72);
  color: #9fb0ac;
  font-size: 9px;
}
.scene-map-legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.scene-legend-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #4ade80;
}
.scene-legend-dot.warn { background: #e8b968; }
.scene-legend-dot.info { background: #5aa9ff; }
@keyframes lp-scene-arc {
  to { stroke-dashoffset: -20; }
}
@keyframes lp-scene-halo {
  0%, 100% { opacity: .45; r: 7.5px; }
  50% { opacity: 1; r: 11px; }
}
.scene-map-land {
  fill: rgba(114, 222, 196, .08);
  stroke: rgba(114, 222, 196, .22);
  stroke-width: 1;
}
.scene-tag {
  position: absolute;
  transform: translate(-50%, -50%);
  color: #9cebd8;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .06em;
}
.scene-node {
  fill: #72dec4;
  opacity: .85;
}
.scene-ping {
  position: absolute;
  width: 8px;
  height: 8px;
  margin: -4px;
  border-radius: 50%;
  background: rgba(114, 222, 196, .9);
  animation: lp-scene-ping 2.6s infinite;
}
.scene-ping-slow {
  animation-duration: 3.6s;
  animation-delay: .8s;
}
.scene-rows {
  display: grid;
  gap: 6px;
  align-content: start;
}
.scene-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  color: #a9bcb8;
  font-size: 11px;
}
.scene-row i {
  height: 5px;
  width: var(--v, 50%);
  border-radius: 999px;
  background: linear-gradient(90deg, #72dec4, #5aa9ff);
  animation: lp-scene-bar 5s ease-in-out infinite alternate;
}
.scene-row b {
  color: #eaf6f3;
  font-variant-numeric: tabular-nums;
}
.scene-events {
  display: grid;
  gap: 4px;
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, .08);
}
.scene-events div {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: #9fb0ac;
}
.scene-events b {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(232, 185, 104, .16);
  color: #e8b968;
  font-size: 9px;
}
.scene-events span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scene-spark {
  position: relative;
  flex: 1;
  min-height: 64px;
  padding: 4px 0 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .07);
  border-radius: 8px;
  background:
    linear-gradient(180deg, rgba(56, 189, 248, .08), rgba(9, 20, 22, 0) 62%),
    rgba(9, 20, 22, .7);
}
.scene-spark svg {
  display: block;
  width: 100%;
  height: 100%;
}
.scene-spark-area {
  fill: url(#scene-spark-fill);
}
.scene-spark-baseline {
  fill: none;
  stroke: rgba(255, 255, 255, .08);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.scene-spark-line {
  fill: none;
  stroke: url(#scene-spark-stroke);
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.scene-spark-dot {
  position: absolute;
  top: calc(30% - 4px);
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #e0f2fe;
  filter: drop-shadow(0 0 6px rgba(56, 189, 248, .85));
  animation: lp-spark-dot 2.8s ease-out infinite;
}
@keyframes lp-spark-dot {
  0% { box-shadow: 0 0 0 0 rgba(56, 189, 248, .5); }
  70%, 100% { box-shadow: 0 0 0 9px rgba(56, 189, 248, 0); }
}
.scene-term {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 10px 12px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .07);
  border-radius: 8px;
  background: rgba(6, 14, 16, .85);
  color: #b9cbc7;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
}
.scene-term .ok { color: #4ade80; }
.scene-term .cmd { color: #9cebd8; }
.scene-chat {
  display: grid;
  gap: 8px;
  align-content: start;
}
.scene-msg {
  max-width: 88%;
  margin: 0;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.6;
}
.scene-msg-user {
  justify-self: end;
  border: 1px solid rgba(90, 169, 255, .28);
  background: rgba(90, 169, 255, .16);
  color: #eaf6f3;
}
.scene-msg-ai {
  justify-self: start;
  min-height: 52px;
  border: 1px solid rgba(255, 255, 255, .08);
  background: rgba(255, 255, 255, .04);
  color: #cfe0dc;
}
.scene-approve {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-self: start;
  padding: 8px 12px;
  border: 1px dashed rgba(232, 185, 104, .5);
  border-radius: 10px;
  background: rgba(232, 185, 104, .1);
  color: #e8b968;
  font-size: 11px;
}
.scene-approve b {
  color: #f6e3bd;
  font-size: 12px;
}
.scene-approve i {
  font-style: normal;
  color: #9fb0ac;
}
.scene-approve.is-approved {
  border-color: rgba(74, 222, 128, .55);
  background: rgba(74, 222, 128, .12);
  color: #4ade80;
}
@media (max-width: 720px) {
  .scene {
    padding: 10px 10px 12px;
    gap: 8px;
  }
  /* A 16:10 stage collapses the map to a ~50px strip on phones: the KPI row and
     the fixed 232px split do not shrink with the width. Give the stage a taller
     ratio, put the four KPIs on one line and keep the map at 150px. */
  .preview-stage {
    aspect-ratio: 4 / 3;
  }
  .scene-kpis {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
  }
  .scene-kpis div {
    padding: 5px 6px;
  }
  .scene-kpis span {
    font-size: 9px;
    white-space: nowrap;
  }
  .scene-kpis b {
    font-size: 14px;
  }
  .scene-split {
    grid-template-columns: 1fr;
    height: 150px;
  }
  .scene-rows {
    display: none;
  }
  .scene-spark {
    display: none;
  }
  .scene-term {
    font-size: 10.5px;
  }
  .scene-msg {
    max-width: 100%;
  }
}
@media (max-width: 360px) {
  .scene-split {
    height: 118px;
  }
}
/* one page surface for every section */
body {
  background-color: #090d0f;
  background-image:
    linear-gradient(rgba(255, 255, 255, .026) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, .026) 1px, transparent 1px);
  background-size: 44px 44px;
}
#product::before,
#features::before,
#deploy::before,
#security,
.band,
.footer {
  background-color: transparent;
  background-image: none;
}
#security,
.band {
  border-top: 1px solid rgba(255, 255, 255, .06);
  border-bottom: 1px solid rgba(255, 255, 255, .06);
}
.section,
.workflow-section,
.deploy-section-modern {
  padding-top: 88px;
  padding-bottom: 88px;
}
@media (max-width: 720px) {
  .section,
  .workflow-section,
  .deploy-section-modern {
    padding-top: 56px;
    padding-bottom: 56px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .scene-live,
  .scene-arc,
  .scene-ping,
  .scene-row i,
  .scene-spark-line {
    animation: none;
  }
  /* Breathing is an opacity change, not movement, so the map stays alive
     for visitors who ask the system to reduce motion. */
  .scene-node-halo {
    animation: lp-scene-halo-soft 3.4s ease-in-out infinite;
  }
}
@keyframes lp-scene-halo-soft {
  0%, 100% { opacity: .4; }
  50% { opacity: .95; }
}
@keyframes lp-cursor {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
.preview-stage {
  position: relative;
}
.preview-stage::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(180deg, transparent, rgba(114, 222, 196, .12) 46%, rgba(114, 222, 196, .02) 56%, transparent 72%);
  transform: translateY(-120%);
  animation: lp-scan 7s linear infinite;
  mix-blend-mode: screen;
}
.preview-terminal {
  margin: 0;
  border-top: 1px solid rgba(255, 255, 255, .07);
  background: #0b1112;
  text-align: left;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.terminal-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, .06);
  background: rgba(255, 255, 255, .02);
}
.terminal-bar i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(255, 255, 255, .18);
}
.terminal-bar i:nth-child(1) { background: #ff5f57; }
.terminal-bar i:nth-child(2) { background: #febc2e; }
.terminal-bar i:nth-child(3) { background: #28c840; }
.terminal-bar span {
  color: #7d8b88;
  font-size: 11px;
}
.terminal-bar em {
  margin-left: auto;
  font-style: normal;
  font-size: 10px;
  font-weight: 820;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #9cebd8;
}
.terminal-bar em[data-terminal-state='offline'] {
  color: #e8b968;
}
.terminal-body {
  display: grid;
  gap: 4px;
  padding: 12px 16px 14px;
}
.terminal-prompt {
  margin: 0;
  color: #9fb0ac;
  font-size: 12px;
}
.terminal-prompt b {
  color: #72dec4;
  font-weight: 700;
}
.terminal-prompt i {
  color: #60a5fa;
  font-style: normal;
}
.terminal-output {
  margin: 0;
  max-height: 132px;
  overflow: hidden;
  color: #c7d3d0;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre;
}
.terminal-output .k { color: #60a5fa; }
.terminal-output .s { color: #e8b968; }
.terminal-output .n { color: #22d3ee; }
.terminal-output .ok { color: #4ade80; }
.terminal-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: #7d8b88;
  font-size: 11px;
}
.terminal-status span[data-live-terminal-status='ok'] {
  color: #4ade80;
}
.terminal-status span[data-live-terminal-status='offline'] {
  color: #e8b968;
}
.terminal-cursor {
  width: 7px;
  height: 13px;
  background: #72dec4;
  animation: lp-cursor 1.1s steps(1) infinite;
}
@media (max-width: 720px) {
  .terminal-body {
    padding: 10px 12px 12px;
  }
  .terminal-output {
    font-size: 11px;
    max-height: 120px;
  }
  .terminal-prompt {
    font-size: 11px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .hero::after,
  .hero::before,
  .hero h1 .hero-title-accent,
  .hero .hero-primary,
  .live-release .live-dot,
  .ticker-track,
  .preview-stage::after,
  .terminal-cursor {
    animation: none;
  }
  .is-reveal-pending {
    opacity: 1;
    transform: none;
  }
}
@media (max-width: 720px) {
  .live-release {
    margin-top: 20px;
    padding: 9px 12px;
    border-radius: 16px;
    font-size: 11px;
    gap: 6px 8px;
  }
  .live-release .live-divider {
    display: none;
  }
  .capability-ticker {
    margin-top: 38px;
  }
}
</style>`);
replaceOnce('</style>', `/* colipas landing dynamic globe ui v1 */
.hero {
  position: relative;
}
.hero .hero-copy,
.hero .product-preview {
  position: relative;
  z-index: 1;
}
.hero-globe-scene {
  position: absolute;
  top: -128px;
  right: -150px;
  z-index: 0;
  width: min(640px, 54vw);
  aspect-ratio: 1;
  pointer-events: none;
  -webkit-mask-image: radial-gradient(closest-side, #000 58%, transparent 97%);
  mask-image: radial-gradient(closest-side, #000 58%, transparent 97%);
}
.hero-globe {
  display: block;
  width: 100%;
  height: 100%;
}
@media (max-width: 720px) {
  .hero-globe-scene {
    top: -190px;
    right: -200px;
    width: 430px;
    opacity: .82;
  }
}
</style>`);
replaceOnce('</style>', `/* colipas landing hero split ui v2 */
.hero {
  align-items: stretch;
  text-align: left;
}
.hero-copy {
  width: min(620px, 100%);
  justify-items: start;
  text-align: left;
}
.hero-copy h1,
.hero-copy .lead {
  text-align: left;
}
.hero .hero-buttons {
  justify-content: flex-start;
}
.hero .hero-copy .stats {
  justify-content: start;
  text-align: left;
}
.hero .live-release {
  justify-content: flex-start;
}
@media (min-width: 1024px) {
  .hero.wrap {
    display: grid;
    grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
    gap: 14px 40px;
    align-items: center;
    padding: 64px 0 52px;
  }
  .hero .product-preview {
    align-self: center;
    width: 100%;
    max-width: 660px;
    justify-self: end;
  }
  .hero .capability-ticker {
    grid-column: 1 / -1;
    align-self: center;
  }
  .hero-globe-scene {
    top: -170px;
    right: -130px;
    width: min(520px, 42vw);
  }
}
@media (max-width: 1023px) {
  .hero {
    padding: 64px 0 48px;
  }
  .hero .product-preview,
  .hero .capability-ticker {
    align-self: center;
  }
  .hero-globe-scene {
    top: -110px;
    right: -150px;
    width: min(480px, 52vw);
  }
}
@media (max-width: 720px) {
  .hero {
    padding: 56px 0 44px;
  }
  .hero-globe-scene {
    top: -168px;
    right: -224px;
    width: 400px;
    opacity: .6;
  }
}
/* Two-column hero: the demo card is narrow on wide screens, so key the scene
   layout off the card, not the viewport. Mid-width keeps every block (2x2 KPIs,
   map, spark) inside a 4/3 stage; narrow cards drop the spark like phones. */
@media (min-width: 721px) {
  .product-preview {
    container-type: inline-size;
  }
  @container (max-width: 760px) {
    .preview-stage {
      aspect-ratio: 4 / 3;
    }
    .scene {
      padding: 12px 12px 14px;
      gap: 8px;
    }
    .scene-kpis {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .scene-kpis div {
      padding: 6px 8px;
    }
    .scene-kpis span {
      font-size: 10px;
    }
    .scene-split {
      height: 180px;
    }
  }
  @container (max-width: 560px) {
    .scene-split {
      height: 150px;
    }
    .scene-spark {
      display: none;
    }
  }
}
</style>`);
replaceOnce('</style>', `/* colipas landing density ui v1 */
.section,
.workflow-section {
  padding-top: 60px;
  padding-bottom: 56px;
}
.deploy-section-modern {
  padding-top: 64px;
  padding-bottom: 64px;
}
.band {
  padding: 56px 0;
}
.hero.wrap {
  padding-bottom: 40px;
}
.feature-card,
#features .feature-card {
  min-height: 0;
  padding: 18px;
}
.feature-grid {
  align-content: start;
}
@media (min-width: 721px) {
  .feature-card,
  #features .feature-card {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr);
    grid-template-rows: auto auto auto;
    gap: 3px 14px;
    align-content: start;
    padding: 15px 16px;
  }
  .feature-icon,
  .feature-card-wide .feature-icon {
    grid-column: 1;
    grid-row: 1 / 4;
    width: 38px;
    height: 38px;
  }
  .feature-card h3 {
    grid-column: 2;
    margin-top: 0;
    font-size: 15px;
  }
  .feature-card p {
    grid-column: 2;
    font-size: 12.5px;
    line-height: 1.55;
  }
  .feature-card .tags {
    grid-column: 2;
  }
}
.workflow-stage {
  min-height: 0;
  padding: 22px 22px 20px;
}
.deploy-card,
.deploy-console {
  min-height: 0;
}
@media (max-width: 720px) {
  .section,
  .workflow-section,
  .deploy-section-modern {
    padding-top: 44px;
    padding-bottom: 40px;
  }
  .band {
    padding: 44px 0;
  }
  .workflow-stage {
    min-height: 0;
  }
}
</style>`);
replaceOnce('</style>', `/* colipas landing light surface ui v1 */
body {
  color: #16201e;
  background: #f5f7f6;
}
.nav {
  background: rgba(255, 255, 255, .92);
  border-bottom: 1px solid #e2e8e6;
}
.nav .nav-links a,
.nav-github,
.nav .nav-action {
  color: #33413e;
}
.hero::before {
  background-color: #f5f7f6;
  background-image:
    linear-gradient(rgba(15, 23, 42, .05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(15, 23, 42, .05) 1px, transparent 1px);
}
.hero::after {
  background:
    radial-gradient(38% 44% at 22% 30%, rgba(114, 222, 196, .20), transparent 70%),
    radial-gradient(34% 40% at 77% 26%, rgba(37, 99, 235, .10), transparent 72%),
    radial-gradient(46% 50% at 50% 80%, rgba(232, 185, 104, .08), transparent 74%);
}
.hero-copy h1,
.hero h1 .hero-title-main {
  color: #0f1a17;
}
.hero h1 .hero-title-accent {
  background-image: linear-gradient(100deg, #0f1a17 0%, #137c69 32%, #0f1a17 58%, #1d4ed8 100%);
}
.hero-copy .lead,
.section p,
.workflow-heading p,
.workflow-section p {
  color: #46534f;
}
.pill {
  color: #3f4d49;
  border-color: #dbe3e0;
  background: #ffffff;
}
.hero .hero-secondary {
  color: #1c2a26;
  border-color: #d3dcda;
  background: #ffffff;
}
.hero .hero-secondary:hover {
  border-color: #9cc9bc;
  background: #f2faf7;
}
.live-release {
  color: #26332f;
  border-color: #dbe3e0;
  background: #ffffff;
}
.live-release .live-commit {
  color: #0f766e;
}
.stats strong,
.hero .stats strong {
  color: #0f1a17;
}
.stats span {
  color: #5b6a66;
}
.workflow-heading h2,
.deploy-heading-modern h2,
#features h2,
#deploy h2,
#security h2,
#product h2 {
  color: #0f1a17;
}
.workflow-heading .section-copy,
.deploy-heading-modern .section-copy,
#features .section-copy {
  color: #46534f;
}
.workflow-shell {
  background: #ffffff;
  border: 1px solid #e2e8e6;
}
.workflow-stage {
  color: #1c2a26;
  border-color: #e6ecea;
}
.workflow-stage h3,
.workflow-stage strong {
  color: #0f1a17;
}
.workflow-stage p {
  color: #4d5b57;
}
.workflow-handoff {
  background: rgba(15, 23, 42, .03);
  border-color: #e2e8e6;
  color: #3d4a46;
}
.section h2,
.workflow-section h2,
.deploy-section-modern h2 {
  color: #0f1a17;
}
.feature-card,
#features .feature-card,
.feature-card.is-revealed,
.feature-card-wide {
  color: #1c2a26;
  background: #ffffff;
  border-color: #e2e8e6;
}
.feature-card h3,
.feature-card-wide h3 {
  color: #0f1a17;
}
.feature-card p {
  color: #556360;
}
.feature-card .tags span {
  color: #46534f;
  border-color: #dbe3e0;
  background: #f1f5f3;
}
.feature-icon {
  color: #137c69;
  border-color: #cfe8df;
  background: #edf8f4;
}
.feature-card-wide .feature-icon {
  color: #0f766e;
  border-color: #cfe8df;
  background: #edf8f4;
}
.deploy-flow-modern {
  background: #ffffff;
  border: 1px solid #e2e8e6;
}
.deploy-method,
.deploy-method-primary {
  background: #ffffff;
  border-color: #e2e8e6;
  color: #1c2a26;
}
.deploy-method h3,
.deploy-method strong {
  color: #0f1a17;
}
.deploy-method p {
  color: #556360;
}
.capability-ticker {
  color: #3d4a46;
  border-color: #e2e8e6;
  background: #ffffff;
}
#security {
  background-color: transparent;
}
.hero::before {
  background-color: #f5f7f6;
}
#product.section::before,
#features.section::before,
#deploy.section::before,
#product.workflow-section::before,
#deploy.deploy-section-modern::before {
  background: transparent;
}
.footer {
  background: #ffffff;
  border-top: 1px solid #e2e8e6;
  color: #3d4a46;
}
.footer a,
.footer strong,
.footer small {
  color: #26332f;
}
</style>`);

replaceAll(/\s*<script id="colipas-product-tour">[\s\S]*?<\/script>\s*/g, '\n');
const landingProductTourScript = `<script id="colipas-product-tour">
(function () {
  var tour = document.querySelector('[data-product-tour]');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var timer = 0;
  var current = 0;
  var titles = {
    overview: '全局资产总览 · 实时状态',
    terminal: '低延迟 SSH · 连续交互',
    ai: '上下文 AI · 确认后执行'
  };

  function activate(index, moveFocus) {
    if (!tour) return;
    var tabs = Array.prototype.slice.call(tour.querySelectorAll('[data-tour-tab]'));
    var scenes = Array.prototype.slice.call(tour.querySelectorAll('[data-tour-scene]'));
    if (!tabs.length || tabs.length !== scenes.length) return;
    current = (index + tabs.length) % tabs.length;
    tabs.forEach(function (tab, tabIndex) {
      var active = tabIndex === current;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      scenes[tabIndex].classList.toggle('is-active', active);
      scenes[tabIndex].setAttribute('aria-hidden', active ? 'false' : 'true');
    });
    var title = tour.querySelector('[data-tour-title]');
    if (title) title.textContent = titles[tabs[current].getAttribute('data-tour-tab')] || '';
    tour.classList.remove('is-cycling');
    void tour.offsetWidth;
    tour.classList.add('is-cycling');
    if (moveFocus) tabs[current].focus();
  }

  function stop() {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    if (tour) tour.classList.remove('is-cycling');
  }

  function schedule() {
    stop();
    if (!tour || document.hidden || tour.matches(':hover') || tour.contains(document.activeElement)) return;
    tour.classList.add('is-cycling');
    timer = window.setTimeout(function () {
      activate(current + 1, false);
      schedule();
    }, 5200);
  }

  if (tour) {
    var tabs = Array.prototype.slice.call(tour.querySelectorAll('[data-tour-tab]'));
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () {
        activate(index, false);
        schedule();
      });
      tab.addEventListener('keydown', function (event) {
        var target = null;
        if (event.key === 'ArrowRight') target = index + 1;
        if (event.key === 'ArrowLeft') target = index - 1;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = tabs.length - 1;
        if (target === null) return;
        event.preventDefault();
        activate(target, true);
        schedule();
      });
    });
    tour.addEventListener('pointerenter', stop);
    tour.addEventListener('pointerleave', schedule);
    tour.addEventListener('focusin', stop);
    tour.addEventListener('focusout', function () {
      window.setTimeout(function () {
        if (!tour.contains(document.activeElement)) schedule();
      }, 0);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else schedule();
    });
    activate(0, false);
    schedule();
  }

  var copyButton = document.querySelector('[data-copy-deploy]');
  if (copyButton) {
    copyButton.addEventListener('click', function () {
      var value = copyButton.getAttribute('data-copy-value') || '';
      var write = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(value)
        : Promise.reject(new Error('clipboard unavailable'));
      write.then(function () {
        var label = copyButton.querySelector('span:last-child');
        if (!label) return;
        label.textContent = '已复制';
        window.setTimeout(function () { label.textContent = '复制'; }, 1600);
      }).catch(function () {
        var area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      });
    });
  }
}());
</script>`;
replaceOnce(/\s*<\/body>/, `\n${landingProductTourScript}\n</body>`);

const landingDynamicScript = `<script id="colipas-landing-dynamic">
(function () {
  var root = document.documentElement;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('lp-dynamic');

  // Live product scenes: keep the three tour panels moving with scripted data
  // instead of static screenshots.
  var sceneTerm = document.querySelector('[data-scene-term]');
  var sceneAiText = document.querySelector('[data-scene-ai-text]');
  var sceneApprove = document.querySelector('[data-scene-approve]');
  var sceneClock = document.querySelector('[data-scene-clock]');
  var sceneRtt = document.querySelector('[data-scene-rtt]');
  var sceneFirst = document.querySelector('[data-scene-first]');
  var sceneCounters = Array.prototype.slice.call(document.querySelectorAll('[data-scene-count]'));
  // A literal dollar followed by a quote would be expanded by String.replace
  // in the deploy patch, so the prompt marker is built from its code point.
  var dollarChar = String.fromCharCode(36);
  var sceneTimers = [];

  function sceneLater(fn, ms) {
    sceneTimers.push(window.setTimeout(fn, ms));
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function animateCounters() {
    sceneCounters.forEach(function (node) {
      var target = Number(node.getAttribute('data-scene-count')) || 0;
      var suffix = node.getAttribute('data-scene-suffix') || '';
      var startedAt = performance.now();
      var step = function (now) {
        var progress = Math.min(1, (now - startedAt) / 900);
        node.textContent = Math.round(target * progress) + suffix;
        if (progress < 1) {
          window.requestAnimationFrame(step);
        }
      };
      window.requestAnimationFrame(step);
    });
  }

  function tickSceneClock() {
    if (!sceneClock) {
      return;
    }
    var now = new Date();
    sceneClock.textContent = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds());
  }

  var terminalScript = [
    '$ ssh operator@hk-prod-01',
    'Connected · PTY ready · 18ms',
    '$ uptime && df -h /',
    ' 14:22:07 up 12 days,  load average 0.42',
    ' /dev/vda1  79G  41G  38G  52% /',
    '$ systemctl status nginx --no-pager',
    ' nginx.service - active (running)'
  ];

  function playTerminalScene() {
    if (!sceneTerm) {
      return;
    }
    var lines = [];
    var index = 0;
    sceneTerm.innerHTML = '';
    var push = function () {
      if (index >= terminalScript.length) {
        sceneLater(function () {
          sceneTerm.innerHTML = '';
          playTerminalScene();
        }, 2600);
        return;
      }
      var line = terminalScript[index];
      index += 1;
      var isCommand = line.charAt(0) === dollarChar;
      var isOk = line.indexOf('active') >= 0;
      lines.push(isCommand ? '<span class="cmd">' + line + '</span>' : isOk ? '<span class="ok">' + line + '</span>' : line);
      sceneTerm.innerHTML = lines.join('\\n');
      sceneLater(push, isCommand ? 620 : 520);
    };
    push();
  }

  var aiAnswer = '读取 hk-prod-01 最近 6 小时指标：CPU 峰值 82%，来自 2 次备份任务，内存稳定。建议先跑只读诊断确认负载来源，再决定是否扩容。';

  function playAiScene() {
    if (!sceneAiText) {
      return;
    }
    sceneAiText.textContent = '';
    if (sceneApprove) {
      sceneApprove.classList.remove('is-approved');
    }
    var index = 0;
    var type = function () {
      index += 2;
      sceneAiText.textContent = aiAnswer.slice(0, index);
      if (index < aiAnswer.length) {
        sceneLater(type, 26);
        return;
      }
      sceneLater(function () {
        if (sceneApprove) {
          sceneApprove.classList.add('is-approved');
        }
        sceneLater(playAiScene, 4200);
      }, 1200);
    };
    type();
  }

  function jitterSceneLatency() {
    if (sceneRtt) {
      sceneRtt.textContent = String(14 + Math.floor(Math.random() * 9));
    }
    if (sceneFirst) {
      sceneFirst.textContent = String(38 + Math.floor(Math.random() * 16));
    }
  }

  tickSceneClock();
  jitterSceneLatency();
  animateCounters();
  window.setInterval(tickSceneClock, 1000);
  window.setInterval(jitterSceneLatency, 2200);
  playAiScene();
  if (reduceMotion) {
    if (sceneTerm) {
      sceneTerm.innerHTML = terminalScript.map(function (line) {
        return line.charAt(0) === dollarChar ? '<span class="cmd">' + line + '</span>' : line;
      }).join('\\n');
    }
  }
  playTerminalScene();

  if (!reduceMotion && 'IntersectionObserver' in window) {
    var targets = document.querySelectorAll('#product .position-card, #product .workflow-stage, #features .feature-card, #deploy .deploy-card');
    var pending = [];
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) {
          return;
        }
        entry.target.classList.remove('is-reveal-pending');
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.1 });
    var revealAll = function () {
      pending.forEach(function (element) {
        element.classList.remove('is-reveal-pending');
        element.classList.add('is-revealed');
        observer.unobserve(element);
      });
      pending = [];
    };
    Array.prototype.forEach.call(targets, function (element, index) {
      var box = element.getBoundingClientRect();
      if (box.top < window.innerHeight * 0.88) {
        return;
      }
      element.style.transitionDelay = Math.min(index % 6, 5) * 55 + 'ms';
      element.classList.add('is-reveal-pending');
      observer.observe(element);
      pending.push(element);
    });
    // Safety net: reveal anything still hidden after 2.5s (print, screenshots,
    // reduced-motion emulation, or a browser without usable intersection data).
    window.setTimeout(revealAll, 2500);
    window.addEventListener('beforeprint', revealAll);
  }

  if (!reduceMotion) {
    document.addEventListener('pointermove', function (event) {
      var card = event.target && event.target.closest ? event.target.closest('.feature-card, .position-card') : null;
      if (!card) {
        return;
      }
      var box = card.getBoundingClientRect();
      if (!box.width || !box.height) {
        return;
      }
      card.style.setProperty('--lp-x', ((event.clientX - box.left) / box.width * 100).toFixed(1) + '%');
      card.style.setProperty('--lp-y', ((event.clientY - box.top) / box.height * 100).toFixed(1) + '%');
    }, { passive: true });
  }

  var strip = document.querySelector('[data-live-release]');
  if (!strip) {
    return;
  }
  var commitNode = strip.querySelector('[data-live-commit]');
  var uptimeNode = strip.querySelector('[data-live-uptime]');
  var latencyNode = strip.querySelector('[data-live-latency]');

  function formatUptime(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) {
      return '—';
    }
    var days = Math.floor(seconds / 86400);
    var hours = Math.floor((seconds % 86400) / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
      return days + ' 天 ' + hours + ' 小时';
    }
    if (hours > 0) {
      return hours + ' 小时 ' + minutes + ' 分';
    }
    return Math.max(minutes, 1) + ' 分钟';
  }

  function render(payload) {
    var release = payload && payload.release ? payload.release : {};
    var metrics = payload && payload.metrics ? payload.metrics : {};
    var latency = metrics.requests && metrics.requests.latencyMs ? metrics.requests.latencyMs : {};
    var commit = typeof release.gitCommit === 'string' ? release.gitCommit.slice(0, 12) : '';
    if (commitNode) {
      commitNode.textContent = commit || '未知版本';
    }
    if (uptimeNode) {
      uptimeNode.textContent = formatUptime(payload && payload.uptime);
    }
    if (latencyNode) {
      latencyNode.textContent = typeof latency.p95 === 'number' ? latency.p95 + 'ms' : '—';
    }
    strip.setAttribute('data-live-state', payload && payload.status === 'ok' ? 'live' : 'degraded');
    renderTerminal(payload);
  }

  // Live terminal: streams the same health payload line by line so the hero
  // visual keeps moving with real data instead of a static screenshot.
  var terminal = document.querySelector('[data-live-terminal]');
  var terminalOutput = terminal ? terminal.querySelector('[data-live-terminal-output]') : null;
  var terminalStatusNode = terminal ? terminal.querySelector('[data-live-terminal-status]') : null;
  var terminalStateNode = terminal ? terminal.querySelector('[data-terminal-state]') : null;
  var terminalTimers = [];

  function clearTerminalTimers() {
    while (terminalTimers.length) {
      window.clearTimeout(terminalTimers.pop());
    }
  }

  function terminalLines(payload) {
    var release = payload && payload.release ? payload.release : {};
    var metrics = payload && payload.metrics ? payload.metrics : {};
    var latency = metrics.requests && metrics.requests.latencyMs ? metrics.requests.latencyMs : {};
    var requests = metrics.requests || {};
    var commit = typeof release.gitCommit === 'string' ? release.gitCommit.slice(0, 12) : 'unknown';
    var target = typeof release.targetName === 'string' ? release.targetName : 'unknown';
    var p95 = typeof latency.p95 === 'number' ? latency.p95 : null;
    return [
      '{',
      '  <span class="k">"release"</span>: {',
      '    <span class="k">"commit"</span>: <span class="s">"' + commit + '"</span>,',
      '    <span class="k">"target"</span>: <span class="s">"' + target + '"</span>',
      '  },',
      '  <span class="k">"uptime"</span>: <span class="n">' + Math.max(0, Math.round(payload && payload.uptime ? payload.uptime : 0)) + '</span>,',
      '  <span class="k">"p95"</span>: ' + (p95 === null ? '<span class="s">"n/a"</span>' : '<span class="n">' + p95 + '</span>') + ',',
      '  <span class="k">"requests"</span>: <span class="n">' + (typeof requests.total === 'number' ? requests.total : 0) + '</span>,',
      '  <span class="k">"status"</span>: <span class="ok">"' + (payload && payload.status === 'ok' ? 'ok' : 'degraded') + '"</span>',
      '}'
    ];
  }

  function renderTerminal(payload) {
    if (!terminalOutput) {
      return;
    }
    var lines = terminalLines(payload);
    clearTerminalTimers();
    terminalOutput.innerHTML = '';
    if (reduceMotion) {
      terminalOutput.innerHTML = lines.join('\\n');
    } else {
      lines.forEach(function (line, index) {
        terminalTimers.push(window.setTimeout(function () {
          terminalOutput.insertAdjacentHTML('beforeend', (index ? '\\n' : '') + line);
        }, index * 90));
      });
    }
    if (terminalStatusNode) {
      var metrics = payload && payload.metrics ? payload.metrics : {};
      var latency = metrics.requests && metrics.requests.latencyMs ? metrics.requests.latencyMs : {};
      terminalStatusNode.setAttribute('data-live-terminal-status', 'ok');
      terminalStatusNode.textContent = '→ 200 OK · p95 ' + (typeof latency.p95 === 'number' ? latency.p95 + 'ms' : 'n/a') + ' · 运行 ' + formatUptime(payload && payload.uptime);
    }
    if (terminalStateNode) {
      terminalStateNode.setAttribute('data-terminal-state', 'live');
      terminalStateNode.textContent = '实时';
    }
  }

  function failTerminal() {
    clearTerminalTimers();
    if (terminalOutput) {
      terminalOutput.innerHTML = '<span class="s">"status"</span>: <span class="s">"unreachable"</span>';
    }
    if (terminalStatusNode) {
      terminalStatusNode.setAttribute('data-live-terminal-status', 'offline');
      terminalStatusNode.textContent = '→ 连接失败，稍后自动重试';
    }
    if (terminalStateNode) {
      terminalStateNode.setAttribute('data-terminal-state', 'offline');
      terminalStateNode.textContent = '离线';
    }
  }

  function fail() {
    strip.setAttribute('data-live-state', 'offline');
    if (commitNode) {
      commitNode.textContent = '暂不可用';
    }
    if (uptimeNode) {
      uptimeNode.textContent = '—';
    }
    if (latencyNode) {
      latencyNode.textContent = '—';
    }
  }

  function load() {
    var controller = 'AbortController' in window ? new AbortController() : null;
    var timer = controller ? window.setTimeout(function () { controller.abort(); }, 6000) : null;
    var options = { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (controller) {
      options.signal = controller.signal;
    }
    fetch('/api/health/', options)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('health status ' + response.status);
        }
        return response.json();
      })
      .then(function (payload) {
        if (timer) {
          window.clearTimeout(timer);
        }
        render(payload);
      })
      .catch(function () {
        if (timer) {
          window.clearTimeout(timer);
        }
        fail();
        failTerminal();
      });
  }

  load();
  window.setInterval(load, 15000);
}());
</script>`;
if (!html.includes('id="colipas-landing-dynamic"')) {
  replaceOnce(/\s*<\/body>/, `\n${landingDynamicScript}\n</body>`);
}

const landingGlobeScript = `<script id="colipas-landing-globe">
(function () {
  var scene = document.querySelector('.hero-globe-scene');
  var canvas = document.querySelector('.hero-globe');
  if (!scene || !canvas || !canvas.getContext) { return; }
  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var nodes = [
    { name: 'HK', lat: 22.3, lng: 114.2 },
    { name: 'SG', lat: 1.35, lng: 103.8 },
    { name: 'JP', lat: 35.7, lng: 139.7 },
    { name: 'US', lat: 37.0, lng: -96.0 },
    { name: 'DE', lat: 50.1, lng: 8.7 }
  ];
  var links = [
    [3, 0],
    [0, 1],
    [4, 3],
    [2, 0]
  ];

  var DOT_COUNT = 640;
  var dots = [];
  for (var i = 0; i < DOT_COUNT; i += 1) {
    var y = 1 - (i / (DOT_COUNT - 1)) * 2;
    var r = Math.sqrt(Math.max(0, 1 - y * y));
    var theta = i * 2.399963229728653;
    dots.push({ x: Math.cos(theta) * r, y: y, z: Math.sin(theta) * r });
  }

  function toRad(deg) { return (deg * Math.PI) / 180; }
  function nodeVector(node) {
    var lat = toRad(node.lat);
    var lng = toRad(node.lng);
    return { x: Math.cos(lat) * Math.cos(lng), y: Math.sin(lat), z: Math.cos(lat) * Math.sin(lng) };
  }
  var nodeVectors = nodes.map(nodeVector);

  var size = 0;
  var dpr = 1;
  function resize() {
    var rect = scene.getBoundingClientRect();
    var next = Math.max(1, Math.round(rect.width));
    if (next === size && canvas.width === Math.round(next * dpr)) { return; }
    size = next;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }

  function rotate(vec, yaw, tilt) {
    var x = vec.x * Math.cos(yaw) + vec.z * Math.sin(yaw);
    var z = -vec.x * Math.sin(yaw) + vec.z * Math.cos(yaw);
    var y = vec.y * Math.cos(tilt) - z * Math.sin(tilt);
    z = vec.y * Math.sin(tilt) + z * Math.cos(tilt);
    return { x: x, y: y, z: z };
  }

  function project(vec, radius, center) {
    return {
      x: center + vec.x * radius,
      y: center - vec.y * radius,
      z: vec.z
    };
  }

  function draw(timeMs) {
    resize();
    var css = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    var center = css / 2;
    var radius = css * 0.4;
    var yaw = timeMs * 0.00016;
    var tilt = -0.32;
    var t = timeMs * 0.001;

    var glow = ctx.createRadialGradient(center, center, radius * 0.2, center, center, radius * 1.25);
    glow.addColorStop(0, 'rgba(19, 124, 105, 0.12)');
    glow.addColorStop(0.7, 'rgba(19, 124, 105, 0.06)');
    glow.addColorStop(1, 'rgba(19, 124, 105, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, css, css);

    for (var i = 0; i < dots.length; i += 1) {
      var rotated = rotate(dots[i], yaw, tilt);
      var point = project(rotated, radius, center);
      var front = rotated.z > 0;
      var shade = front ? 0.35 + rotated.z * 0.6 : 0.08 + Math.abs(rotated.z) * 0.06;
      ctx.fillStyle = 'rgba(15, 118, 110, ' + shade.toFixed(3) + ')';
      var dotSize = front ? 1.25 : 0.9;
      ctx.fillRect(point.x - dotSize / 2, point.y - dotSize / 2, dotSize, dotSize);
    }

    var screen = [];
    for (var n = 0; n < nodeVectors.length; n += 1) {
      var rotatedNode = rotate(nodeVectors[n], yaw, tilt);
      screen.push({ vec: rotatedNode, point: project(rotatedNode, radius, center) });
    }

    for (var l = 0; l < links.length; l += 1) {
      var a = screen[links[l][0]];
      var b = screen[links[l][1]];
      if (!a || !b || a.vec.z < -0.05 || b.vec.z < -0.05) { continue; }
      var mx = (a.point.x + b.point.x) / 2;
      var my = (a.point.y + b.point.y) / 2;
      var dx = mx - center;
      var dy = my - center;
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var lift = radius * 0.38;
      var cx = mx + (dx / dist) * lift;
      var cy = my + (dy / dist) * lift;
      ctx.beginPath();
      ctx.moveTo(a.point.x, a.point.y);
      ctx.quadraticCurveTo(cx, cy, b.point.x, b.point.y);
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.30)';
      ctx.lineWidth = 1;
      ctx.stroke();

      var phase = (t * 0.22 + l * 0.27) % 1;
      var inv = 1 - phase;
      var px = inv * inv * a.point.x + 2 * inv * phase * cx + phase * phase * b.point.x;
      var py = inv * inv * a.point.y + 2 * inv * phase * cy + phase * phase * b.point.y;
      ctx.beginPath();
      ctx.arc(px, py, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(29, 78, 216, 0.95)';
      ctx.fill();
    }

    for (var k = 0; k < screen.length; k += 1) {
      var item = screen[k];
      if (item.vec.z < 0.02) { continue; }
      var pulse = 0.5 + 0.5 * Math.sin(t * 2.1 + k * 1.3);
      ctx.beginPath();
      ctx.arc(item.point.x, item.point.y, 5.5 + pulse * 3.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(19, 124, 105, ' + (0.12 + pulse * 0.16).toFixed(3) + ')';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(item.point.x, item.point.y, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(6, 95, 82, 0.95)';
      ctx.fill();
    }
  }

  var running = false;
  var frameHandle = 0;
  var visible = true;
  var pageVisible = !document.hidden;

  function frame(now) {
    if (!running) { return; }
    draw(now);
    frameHandle = window.requestAnimationFrame(frame);
  }

  function shouldRun() {
    return visible && pageVisible;
  }

  function restart() {
    var want = shouldRun();
    if (want && !running) {
      running = true;
      frameHandle = window.requestAnimationFrame(frame);
    } else if (!want && running) {
      running = false;
      window.cancelAnimationFrame(frameHandle);
    }
  }

  resize();
  draw(performance.now());
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      restart();
    }, { rootMargin: '80px' }).observe(scene);
  }
  document.addEventListener('visibilitychange', function () {
    pageVisible = !document.hidden;
    restart();
  });
  window.addEventListener('resize', function () {
    draw(performance.now());
  });
  restart();
  scene.setAttribute('data-globe-state', 'live');
}());
</script>`;
if (!html.includes('id="colipas-landing-globe"')) {
  replaceOnce(/\s*<\/body>/, `\n${landingGlobeScript}\n</body>`);
}

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

  if [ -f "$APP_DIR/.github/assets/colipas-dashboard-preview.svg" ]; then
    install -m 0644 "$APP_DIR/.github/assets/colipas-dashboard-preview.svg" "$LANDING_ROOT/colipas-dashboard-preview.svg"
  fi
  if [ -f "$APP_DIR/.github/assets/colipas-terminal-preview.svg" ]; then
    install -m 0644 "$APP_DIR/.github/assets/colipas-terminal-preview.svg" "$LANDING_ROOT/colipas-terminal-preview.svg"
  fi
  if [ -f "$APP_DIR/.github/assets/colipas-ai-preview.svg" ]; then
    install -m 0644 "$APP_DIR/.github/assets/colipas-ai-preview.svg" "$LANDING_ROOT/colipas-ai-preview.svg"
  fi

  cat >"$LANDING_ROOT/colipas-icon.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="title desc">
  <title id="title">CoLiPas云服务器管理面板 icon</title>
  <desc id="desc">A bold white terminal prompt on a teal to blue rounded square with a faint cloud behind it.</desc>
  <defs>
    <linearGradient id="colipas-bg" x1="8" y1="6" x2="56" y2="59" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0f766e"/>
      <stop offset="0.52" stop-color="#0d9488"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <rect x="3" y="3" width="58" height="58" rx="15" fill="url(#colipas-bg)"/>
  <rect x="3" y="3" width="58" height="58" rx="15" fill="none" stroke="#ffffff" stroke-opacity=".26" stroke-width="1.6"/>
  <path d="M13 47C7.2 47 4.4 42.2 7 37.6c1.8-3.1 5.1-4.5 8.5-4 1.3-9.1 8.8-15.9 17.9-15.9 8.5 0 15.7 6.2 17.1 14.8 4.8-.2 8.4 3.2 8.4 7.4 0 4.1-3.3 7.1-7.7 7.1Z" fill="#ffffff" fill-opacity=".18"/>
  <path d="M18 23 31 32l-13 9" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M37 41h12" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
</svg>
SVG

  cat >"$LANDING_ROOT/docs.html" <<'HTML'
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/colipas-icon.svg?v=20261021-brand4">
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
            <linearGradient id="docs-colipas-bg" x1="8" y1="6" x2="56" y2="59" gradientUnits="userSpaceOnUse">
              <stop offset="0" stop-color="#0f766e"/>
              <stop offset="0.52" stop-color="#0d9488"/>
              <stop offset="1" stop-color="#2563eb"/>
            </linearGradient>
          </defs>
          <rect x="3" y="3" width="58" height="58" rx="15" fill="url(#docs-colipas-bg)"/>
          <rect x="3" y="3" width="58" height="58" rx="15" fill="none" stroke="#ffffff" stroke-opacity=".26" stroke-width="1.6"/>
          <path d="M13 47C7.2 47 4.4 42.2 7 37.6c1.8-3.1 5.1-4.5 8.5-4 1.3-9.1 8.8-15.9 17.9-15.9 8.5 0 15.7 6.2 17.1 14.8 4.8-.2 8.4 3.2 8.4 7.4 0 4.1-3.3 7.1-7.7 7.1Z" fill="#ffffff" fill-opacity=".18"/>
          <path d="M18 23 31 32l-13 9" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M37 41h12" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
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
      <a href="#metric-history">资源历史 <span>→</span></a>
      <a href="#resource-alerts">资源告警 <span>→</span></a>
      <a href="#operations-inbox">运维收件箱 <span>→</span></a>
      <a href="#account-sessions">会话管理 <span>→</span></a>
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
      <a href="#metric-history">资源历史</a>
      <a href="#resource-alerts">资源告警</a>
      <a href="#operations-inbox">运维收件箱</a>
      <a href="#account-sessions">会话管理</a>
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
          <div><code>SESSION_MAX_ACTIVE</code><p>管理员最大活跃会话数，可设置为 2–64，默认 12；达到上限后自动退出最旧会话。</p></div>
          <div><code>CREDENTIAL_ENCRYPTION_KEY</code><p>SSH 密码和私钥的加密密钥，不能提交到 Git。</p></div>
          <div><code>COLIPAS_DATA_DIR / COLIPAS_DB_PATH</code><p>SQLite 数据库和运行数据目录，默认位于 .data。</p></div>
          <div><code>COLIPAS_METRIC_HISTORY_INTERVAL_MS / COLIPAS_METRIC_HISTORY_RETENTION_MS / COLIPAS_METRIC_HISTORY_MAX_POINTS_PER_SERVER</code><p>成功 SSH 指标的历史采样间隔、保留时长和单服务器行数上限，默认 5 分钟、7 天和 2016 行。</p></div>
          <div><code>AI_BASE_URL / AI_API_KEY / AI_MODEL</code><p>OpenAI 兼容 API 配置；不配置密钥时只使用本地规则分析。</p></div>
          <div><code>CUSTOM_API_ALLOWED_HOSTS</code><p>自定义 API 代理允许访问的域名白名单。</p></div>
        </div>
      </section>

      <section id="first-run" class="section">
        <p class="kicker">首次使用</p>
        <h2>部署完成后按这个顺序检查</h2>
        <div class="flow">
          <div class="flow-step" data-colipas-docs-avatar-guard="true"><b>1</b><div><h3>打开后台并登录</h3><p>访问你的域名 `/admin/`，使用部署脚本里设置的管理员账号和初始密码登录。首次进入后优先修改密码并检查登录会话；头像保存前会验证图片可正常解码，历史坏图会自动回退到 CoLiPas 品牌图标。</p></div></div>
          <div class="flow-step"><b>2</b><div><h3>确认系统状态</h3><p>在安全审计和总览页确认健康检查、SQLite、发布信息、会话状态和基础指标正常，再继续接入真实服务器。</p></div></div>
          <div class="flow-step"><b>3</b><div><h3>添加第一台服务器</h3><p>先填写名称、IP、地区、系统和标签；需要远程操作时必须选择 SSH 验证模式并通过密码或私钥握手。</p></div></div>
          <div class="flow-step"><b>4</b><div><h3>验证 SSH、AI 与编排联动</h3><p>打开终端执行只读诊断命令，再配置 AI Provider、加载模型、测试自定义 API 白名单，最后执行一条低风险编排任务。</p></div></div>
        </div>
        <p class="section-note">忘记管理员密码时只能重置，不能找回明文密码。Docker 部署可在 `/opt/colipas` 执行 `docker compose exec -e COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' colipas npm run reset:admin`；systemd 部署可执行 `sudo -u colipas env COLIPAS_RESET_PASSWORD='replace-with-new-strong-password' npm run reset:admin`。脚本会立即撤销该账号的持久化登录会话，不需要重启服务，也不会删除服务器或其他用户数据。</p>
      </section>

      <section id="launch-checklist" class="section split">
        <div>
          <p class="kicker">上下文上线检查</p>
          <h2>完整证据只在一个地方，其它模块只做引用</h2>
          <p>六项上线检查（运行安全、资产接入、SSH、AI、运维预检、审计）只在总览页渲染。其它模块通过顶栏唯一的「待办 N 项」入口回到概览，同一份上线状态不会在多个页面重复出现。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 修复顺序（P1–Pn）和修复原因直接标在检查清单条目上，不再额外复制一份修复队列。</p>
            <p class="check-line"><span>✓</span> 需要留证时可复制脱敏报告或重新采集证据，报告只包含聚合状态与模块入口。</p>
            <p class="check-line"><span>✓</span> 顶栏只保留一个运行状态 chip，具体计数交给运维收件箱角标，避免同一批数字出现两次。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>推荐使用顺序</strong>
          <pre>概览：确认六项检查与 P1
其它模块：点顶栏「待办 N 项」回到概览
资源：清单 / 监控与历史 / 告警
上线前：复制脱敏报告并复检</pre>
        </aside>
      </section>

      <section id="information-architecture" class="section split">
        <div>
          <p class="kicker">信息架构</p>
          <h2>一个状态只有一个表达位置</h2>
          <p>每个模块只承载一个工作对象，二级界面拆成视图，进入模块时回到首个视图，视图选择不做持久化，避免与深链冲突。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 资源页分为清单 / 监控与历史 / 告警：清单保留服务器表格，监控与历史列出全量遥测并直达单机历史曲线，告警承载资源告警策略。</p>
            <p class="check-line"><span>✓</span> 安全页分为总览 / 发布门禁 / SSH 诊断 / 审计记录，一次只展开一个视图，页面高度从 9340px 降到 1000–5500px。</p>
            <p class="check-line"><span>✓</span> 低频工具进二级视图：自定义 API 测试从一级导航移到「运维 → 工具」，一级导航不再承载工具类入口。</p>
            <p class="check-line"><span>✓</span> 运维页拆成编排 / 维护窗口 / 任务队列 / 预检 / 工具五个视图，一次只展开一个，构建器、值班窗口与预检证据不再挤在同一屏。</p>
            <p class="check-line"><span>✓</span> AI 助手以右下角常驻 dock 提供，不占一级导航；需要完整工作区时用命令面板或 <code>#ai</code> 深链打开。</p>
            <p class="check-line"><span>✓</span> 资源、运维、安全三个模块会记住上次停留的视图（浏览器本地），刷新或重新进入时恢复；trace 等深链优先于记忆。</p>
            <p class="check-line"><span>✓</span> 顶栏只保留一个运行状态 chip，具体计数交给收件箱角标；修复顺序合并进上线检查清单，不再复制第二份队列。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>三条判定规则</strong>
          <pre>1 一个状态只有一个表达位置
2 其它位置只能引用（链接 / 角标）
3 一级导航承载工作对象，不承载工具</pre>
        </aside>
      </section>

      <section id="metric-history" class="section split" data-colipas-docs-feature="server-metric-history">
        <div>
          <p class="kicker">可信资源历史</p>
          <h2>从成功采样回看 CPU、内存和磁盘趋势</h2>
          <p>在服务器列表点击桌面端遥测状态，或点击移动端 CPU 指标打开时间线。历史只在 SSH 指标采集成功后写入 SQLite，并明确区分真实与模拟来源。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 支持 1 小时、6 小时、24 小时和 7 天范围，默认每 5 分钟记录。</p>
            <p class="check-line"><span>✓</span> 默认保留 7 天且每台服务器最多 2016 行；API 降采样后最多返回 240 点。</p>
            <p class="check-line"><span>✓</span> 最新值、平均值、峰值、变化和连续性集中展示，键盘方向键可逐点读取。</p>
            <p class="check-line"><span>✓</span> 仅登记资产和失败采样不会写入，响应不包含 IP、SSH 凭据或命令内容。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>历史读取接口</strong>
          <pre>GET /api/servers/:serverId/metric-history?window=24h

window: 1h | 6h | 24h | 7d
retention: 7 days
response limit: 240 points</pre>
        </aside>
      </section>

      <section id="resource-alerts" class="section split" data-colipas-docs-feature="resource-alert-policy">
        <div>
          <p class="kicker">资源告警策略</p>
          <h2>把资源越线变成可持续跟进的值班事项</h2>
          <p>在「资源 → 告警」打开策略抽屉，为 CPU、内存和磁盘设置独立阈值，并选择未解消越线的再次提醒周期。策略保存在 SQLite，告警只消费最近一次成功采集的可信遥测；总览健康基线只保留一个指向该视图的入口。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 阈值范围为 50%–95%，再次提醒可选 15 分钟至 24 小时。</p>
            <p class="check-line"><span>✓</span> 只评估 SSH 已验证、未停止且遥测新鲜的服务器；过期或不可用样本会跳过。</p>
            <p class="check-line"><span>✓</span> 策略读取完成前或读取失败时保持告警暂停，重试成功后再恢复评估。</p>
            <p class="check-line"><span>✓</span> 点击告警会按服务器名称定位资产，浏览器不会保存地址、指标正文或凭据。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>默认策略</strong>
          <pre>CPU：85%
内存：85%
磁盘：80%
再次提醒：60 分钟</pre>
        </aside>
      </section>

      <section id="operations-inbox" class="section split">
        <div>
          <p class="kicker">全局运维收件箱</p>
          <h2>把跨模块待办收拢到同一个值班入口</h2>
          <p>桌面端从后台顶栏打开，移动端从快捷控制进入。收件箱会汇总资源越线、上线阻塞、SSH 与资产覆盖缺口和开放事件，并按上线阻塞、需处理、已审阅分组；点击事项可直接进入服务器、运维、AI 或安全模块。</p>
          <div class="check-list">
            <p class="check-line"><span>✓</span> 单项审阅、全部已读和清除本机审阅状态都不会修改服务器或用户数据。</p>
            <p class="check-line"><span>✓</span> 浏览器仅保存稳定事项 ID 与审阅时间，不保存事件正文、IP、密码、API Key 或私钥。</p>
            <p class="check-line"><span>✓</span> 持续资源越线会按策略周期重新进入未审阅状态，其他开放事项随总览刷新更新。</p>
          </div>
        </div>
        <aside class="terminal-card">
          <strong>值班处理顺序</strong>
          <pre>P0：先处理上线阻塞
P1：补齐 SSH、资产和预检证据
事件：进入安全审计确认或关闭
完成：标为已审阅，保留当前工作焦点</pre>
        </aside>
      </section>

      <section id="server-access" class="section">
        <p class="kicker">服务器接入</p>
        <h2>单台接入、批量迁移、真实 SSH 验证和地图联动</h2>
        <div class="grid">
          <article class="doc-card" data-colipas-docs-feature="server-bulk-import">
            <h3>安全批量导入</h3>
            <p>支持 CSV、JSON、文件选择和粘贴预览，文件最大 2 MB、单次最多 500 行。可下载本地 CSV 校验报告，导出值会防护表格公式注入且不会额外上传数据；重复名称或公网 IP 自动跳过，密码、私钥、Passphrase、API Key、Token 和 SSH 凭据字段会被拒绝。</p>
          </article>
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

      <section id="account-sessions" class="section" data-colipas-docs-feature="account-session-control">
        <p class="kicker">账户安全</p>
        <h2>识别并撤销不再需要的登录会话</h2>
        <div class="grid">
          <article class="doc-card">
            <h3>识别当前设备</h3>
            <p>账户设置会突出显示当前浏览器，并列出其他活跃登录设备的登录时间、最近活动和到期时间；页面可见且在线时每 15 秒自动同步，隐藏或离线会暂停，恢复连接后立即同步。</p>
          </article>
          <article class="doc-card">
            <h3>主动撤销访问</h3>
            <p>可逐个撤销其他会话，也可保留当前浏览器并一键撤销其他全部会话；当前会话需要通过退出登录关闭。</p>
          </article>
          <article class="doc-card">
            <h3>容量与隐私边界</h3>
            <p>默认最多保留 12 个活跃会话，可用 SESSION_MAX_ACTIVE 调整。SQLite 只保存 SHA-256 令牌哈希和脱敏元数据，不保存原始 Cookie、IP 或 User-Agent；达到上限后自动退出最旧会话。</p>
          </article>
        </div>
      </section>

      <section id="api" class="section">
        <p class="kicker">API 与自定义代理</p>
        <h2>业务 API 需要登录，自定义代理需要白名单</h2>
        <div class="table">
          <div><code>GET /api/health</code><p>公开健康检查：边缘静态探针，只返回运行状态，供监控探活，不暴露路径或密钥。</p></div>
          <div><code>GET /api/health/</code><p>应用健康详情：SQLite 驱动名称、部署目标与模式、短发布标识和运行时间。</p></div>
          <div><code>POST /api/auth/login</code><p>管理员登录，失败次数会限速并返回 Retry-After。</p></div>
          <div><code>GET /api/account/sessions</code><p>读取重启安全的活跃登录设备、最近活动、到期时间、容量与持久化状态。</p></div>
          <div><code>DELETE /api/account/sessions/:id</code><p>撤销指定的其他登录会话，不允许误删当前会话。</p></div>
          <div><code>POST /api/account/sessions/revoke-others</code><p>保留当前浏览器并撤销其他全部登录会话。</p></div>
          <div><code>GET /api/overview</code><p>登录后读取账号、服务器、事件和总览指标。</p></div>
          <div><code>GET /api/monitoring/resource-alert-policy</code><p>读取持久化的 CPU、内存、磁盘阈值与再次提醒周期。</p></div>
          <div><code>PUT /api/monitoring/resource-alert-policy</code><p>校验并保存资源告警策略，同时写入脱敏审计记录。</p></div>
          <div><code>GET /api/servers/:serverId/metric-history</code><p>按 1h、6h、24h 或 7d 读取脱敏且有界的 CPU、内存和磁盘历史。</p></div>
          <div><code>GET / PUT /api/ai/provider</code><p>读取和保存 AI Provider 设置；API Key 只返回是否已托管，不回显明文。</p></div>
          <div><code>POST /api/custom-apis/test</code><p>通过后端代理测试外部接口，阻止内网地址、敏感 Header 和重定向 SSRF。</p></div>
          <div><code>POST /api/servers/import</code><p>批量导入最多 500 台无凭据资产，重复名称或公网 IP 自动跳过，不覆盖已有用户数据。</p></div>
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
            <p class="check-line"><span>✓</span> 在账户设置中检查活跃登录设备并撤销不再需要的会话。</p>
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
          <details><summary>数据存在哪里？</summary><p>默认保存在 .data/colipas.sqlite。SSH 凭据会加密存储，登录会话只保存令牌哈希与脱敏元数据；请保护 .env 和 .data。</p></details>
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
const operatorControlsDocsSection = `      <section class="section" data-colipas-docs-mobile-controls="true" data-colipas-docs-operator-controls="true" data-colipas-docs-adaptive-refresh="true">
        <p class="kicker">自适应操作员控制</p>
        <h2>登录名称与同步状态常驻，次要动作集中到一个控制面板</h2>
        <div class="grid">
          <article class="doc-card">
            <h3>桌面端保持单行</h3>
            <p>顶栏保留运维收件箱、上线检查、命令面板和性能模式；刷新、语言、账户设置与退出登录收进带登录名称的操作员控制器，避免实时指标被挤掉。</p>
          </article>
          <article class="doc-card">
            <h3>移动端自动压缩</h3>
            <p>手机端继续使用“…”打开同一组控制；三种语言始终可用，并支持 Escape、遮罩或关闭按钮返回当前模块。</p>
          </article>
          <article class="doc-card">
            <h3>智能刷新与失败退避</h3>
            <p>总览在标准模式每 15 秒、性能模式每 30 秒同步；标签页隐藏或网络离线时停止轮询，多标签页通过 BroadcastChannel/localStorage 共享主同步快照。资产未变化时服务端返回 304，浏览器复用最近一次已认证快照；操作员菜单会展示快照数、减少轮询、载荷复用次数和节省字节。返回前台或恢复网络后按数据新鲜度续传，连续失败最长等待 120 秒，同时保留手动刷新入口。</p>
          </article>
        </div>
      </section>`;
if (!html.includes('data-colipas-docs-mobile-controls="true"')) {
  html = html.replace(
    /(<section id="server-access")/,
    `${operatorControlsDocsSection}

$1`,
  );
} else {
  html = html.replace(
    /<section class="section" data-colipas-docs-mobile-controls="true"[\s\S]*?<\/section>/,
    operatorControlsDocsSection,
  );
}
const intentReadyNavigationDocsSection = `      <section class="section" data-colipas-docs-intent-navigation="true">
        <p class="kicker">意图就绪导航</p>
        <h2>目标准备完成后再切换，较早请求不会覆盖最后一次选择</h2>
        <div class="grid">
          <article class="doc-card">
            <h3>当前工作区保持可用</h3>
            <p>侧栏等待状态不会替换当前内容；指针悬停、键盘焦点与点击共享同一次准备请求，目标工作区就绪后再完成切换。</p>
          </article>
          <article class="doc-card">
            <h3>按网络条件准备</h3>
            <p>标准模式仅在页面可见、网络在线且未启用 Save-Data 或 2G 网络时分阶段准备其他模块；性能模式不做后台准备，但明确点击、键盘操作和深链仍可正常进入。</p>
          </article>
        </div>
      </section>`;
if (!html.includes('data-colipas-docs-intent-navigation="true"')) {
  html = html.replace(
    /(<section id="server-access")/,
    `${intentReadyNavigationDocsSection}

$1`,
  );
} else {
  html = html.replace(
    /<section class="section" data-colipas-docs-intent-navigation="true">[\s\S]*?<\/section>/,
    intentReadyNavigationDocsSection,
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

COLIPAS_NGINX_CONFIG="/etc/nginx/sites-available/colipas.conf"
COLIPAS_NGINX_SYMLINK="/etc/nginx/sites-enabled/colipas.conf"
COLIPAS_NGINX_EDGE_ANCHOR="# __COLIPAS_EDGE_PRESERVE__"
COLIPAS_NGINX_GUARD_START="# MIAO7-CF-GUARD-START"
COLIPAS_NGINX_GUARD_END="# MIAO7-CF-GUARD-END"

backup_nginx_config() {
  local backup_dir="/var/backups/colipas"
  local stamp
  local stale

  install -d -m 0700 "$backup_dir" || return 1
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "$COLIPAS_NGINX_CONFIG" "$backup_dir/nginx-colipas.conf.$stamp" || return 1

  for stale in $(ls -1t "$backup_dir"/nginx-colipas.conf.* 2>/dev/null | tail -n +11); do
    rm -f "$stale"
  done

  return 0
}

extract_edge_hardening_block() {
  local output_file="$1"

  : >"$output_file"
  if [ ! -f "$COLIPAS_NGINX_CONFIG" ]; then
    return 1
  fi

  awk -v start="$COLIPAS_NGINX_GUARD_START" -v end="$COLIPAS_NGINX_GUARD_END" '
    index($0, start) > 0 { capture = 1 }
    capture { print }
    capture && index($0, end) > 0 { capture = 0 }
  ' "$COLIPAS_NGINX_CONFIG" >"$output_file"

  [ -s "$output_file" ]
}

install_edge_preserving_nginx_config() {
  local rendered_file="$1"
  local preserved_file
  local staged_file
  local restore_file=""
  local preserve_required=0

  preserved_file="$(mktemp)"
  staged_file="$(mktemp)"

  if extract_edge_hardening_block "$preserved_file"; then
    preserve_required=1
  fi

  if [ "$preserve_required" -eq 1 ]; then
    if ! grep -qF "$COLIPAS_NGINX_EDGE_ANCHOR" "$rendered_file"; then
      echo "ERROR: refusing to replace $COLIPAS_NGINX_CONFIG because the repository template no longer exposes $COLIPAS_NGINX_EDGE_ANCHOR; replacing it would silently drop the server-side edge hardening." >&2
      rm -f "$preserved_file" "$staged_file"
      return 1
    fi

    if grep -q 'miao_cf_only' "$preserved_file" && [ ! -f /etc/nginx/conf.d/10-miao-cf-geo.conf ]; then
      echo "ERROR: refusing to replace $COLIPAS_NGINX_CONFIG because the preserved edge hardening uses \$miao_cf_only while /etc/nginx/conf.d/10-miao-cf-geo.conf is missing; nginx would fail to start." >&2
      rm -f "$preserved_file" "$staged_file"
      return 1
    fi

    awk -v anchor="$COLIPAS_NGINX_EDGE_ANCHOR" -v block="$preserved_file" '
      index($0, anchor) > 0 {
        while ((getline line < block) > 0) {
          print line
        }
        close(block)
        next
      }
      { print }
    ' "$rendered_file" >"$staged_file"

    if ! grep -qF "$COLIPAS_NGINX_GUARD_START" "$staged_file"; then
      echo "ERROR: edge hardening was extracted from $COLIPAS_NGINX_CONFIG but could not be re-applied to the rendered template." >&2
      rm -f "$preserved_file" "$staged_file"
      return 1
    fi
  else
    grep -vF "$COLIPAS_NGINX_EDGE_ANCHOR" "$rendered_file" >"$staged_file" || true
  fi

  if [ -f "$COLIPAS_NGINX_CONFIG" ] && cmp -s "$staged_file" "$COLIPAS_NGINX_CONFIG"; then
    rm -f "$preserved_file" "$staged_file"
    echo "nginx configuration already current; edge hardening preserved."
    return 0
  fi

  if ! backup_nginx_config; then
    echo "WARN: unable to back up $COLIPAS_NGINX_CONFIG before replacing it." >&2
  fi

  install -m 0644 "$staged_file" "$COLIPAS_NGINX_CONFIG" || {
    rm -f "$preserved_file" "$staged_file"
    return 1
  }
  ln -sfn "$COLIPAS_NGINX_CONFIG" "$COLIPAS_NGINX_SYMLINK"

  if ! nginx -t; then
    echo "ERROR: the updated nginx configuration failed validation; restoring the previous configuration." >&2
    restore_file="$( { ls -1t /var/backups/colipas/nginx-colipas.conf.* 2>/dev/null || true; } | head -n 1)"
    if [ -n "$restore_file" ]; then
      install -m 0644 "$restore_file" "$COLIPAS_NGINX_CONFIG"
      nginx -t || true
    fi
    rm -f "$preserved_file" "$staged_file"
    return 1
  fi

  rm -f "$preserved_file" "$staged_file"
  if [ "$preserve_required" -eq 1 ]; then
    echo "nginx configuration updated with the existing edge hardening preserved."
  else
    echo "nginx configuration updated."
  fi
}

install_nginx_config() {
  local nginx_ssl_certificate="$SSL_CERTIFICATE"
  local nginx_ssl_certificate_key="$SSL_CERTIFICATE_KEY"
  local rendered_nginx_config

  rendered_nginx_config="$(mktemp)"

  if [ ! -f "$nginx_ssl_certificate" ] || [ ! -f "$nginx_ssl_certificate_key" ]; then
    if ensure_fallback_ssl_certificate; then
      nginx_ssl_certificate="/etc/ssl/certs/colipas-selfsigned.crt"
      nginx_ssl_certificate_key="/etc/ssl/private/colipas-selfsigned.key"
    fi
  fi

  if [ -f "$LANDING_ROOT/index.html" ] && [ -f "$nginx_ssl_certificate" ] && [ -f "$nginx_ssl_certificate_key" ]; then
    cat >"$rendered_nginx_config" <<NGINX
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

  # __COLIPAS_EDGE_PRESERVE__
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

  location = /colipas-dashboard-preview.svg {
    try_files /colipas-dashboard-preview.svg =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600" always;
  }

  location = /colipas-terminal-preview.svg {
    try_files /colipas-terminal-preview.svg =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600" always;
  }

  location = /colipas-ai-preview.svg {
    try_files /colipas-ai-preview.svg =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600" always;
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
    proxy_set_header X-Forwarded-For \$remote_addr;  # never trust client-supplied X-Forwarded-For
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
    proxy_set_header X-Forwarded-For \$remote_addr;  # never trust client-supplied X-Forwarded-For
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
    proxy_set_header X-Forwarded-For \$remote_addr;  # never trust client-supplied X-Forwarded-For
    proxy_set_header X-Forwarded-Proto https;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }
}
NGINX
  else
    cat >"$rendered_nginx_config" <<NGINX
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

  location = /colipas-dashboard-preview.svg {
    try_files /colipas-dashboard-preview.svg =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600" always;
  }

  location = /colipas-terminal-preview.svg {
    try_files /colipas-terminal-preview.svg =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600" always;
  }

  location = /colipas-ai-preview.svg {
    try_files /colipas-ai-preview.svg =404;
    expires 1h;
    add_header Cache-Control "public, max-age=3600" always;
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
    proxy_set_header X-Forwarded-For \$remote_addr;  # never trust client-supplied X-Forwarded-For
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
    proxy_set_header X-Forwarded-For \$remote_addr;  # never trust client-supplied X-Forwarded-For
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
    proxy_set_header X-Forwarded-For \$remote_addr;  # never trust client-supplied X-Forwarded-For
    proxy_set_header X-Forwarded-Proto http;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }
}
NGINX
  fi

  local install_status=0
  if ! install_edge_preserving_nginx_config "$rendered_nginx_config"; then
    install_status=1
  fi
  rm -f "$rendered_nginx_config"
  if [ "$install_status" -ne 0 ]; then
    echo "ERROR: nginx configuration was not replaced; the previous configuration stays in place." >&2
    return 1
  fi
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
