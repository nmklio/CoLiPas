#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${COLIPAS_APP_DIR:-/opt/colipas}"
SERVICE_NAME="${COLIPAS_SERVICE_NAME:-colipas}"
BRANCH="${COLIPAS_BRANCH:-master}"
APP_USER="${COLIPAS_APP_USER:-colipas}"
SERVER_NAME="${COLIPAS_SERVER_NAME:-c.miao7777.com}"
LANDING_ROOT="${COLIPAS_LANDING_ROOT:-/var/www/colipas-landing}"
SSL_CERTIFICATE="${COLIPAS_SSL_CERTIFICATE:-/etc/letsencrypt/live/$SERVER_NAME/fullchain.pem}"
SSL_CERTIFICATE_KEY="${COLIPAS_SSL_CERTIFICATE_KEY:-/etc/letsencrypt/live/$SERVER_NAME/privkey.pem}"

run_as_app() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$APP_USER" -- "$@"
  else
    "$@"
  fi
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

if (!html.includes('https://github.com/nmklio/CoLiPas')) {
  replaceOnce(/<a class="nav-action" href="\/admin\/">([\s\S]*?)<\/a>/, (_match, label) => (
    `<div class="nav-actions"><a class="nav-github" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">GitHub</a><a class="nav-action" href="/admin/">${label}</a></div>`
  ));
}

replaceOnce(/(<section class="hero wrap">[\s\S]*?)<h1>[\s\S]*?<\/h1>/, (_match, prefix) => (
  `${prefix}<h1><span class="hero-title-main">多云服务器管理面板</span><span class="hero-title-accent">接入、监控、修复一体化</span></h1>`
));

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
    echo "CoLiPas landing page UI ready: $landing_file"
  done

  if [ "$patched" -eq 0 ]; then
    echo "WARN: CoLiPas landing page was not found; skipped landing UI patch" >&2
  fi
}

install_runtime_update_script() {
  if [ -f "$APP_DIR/deploy/server-update.sh" ]; then
    install -m 0755 "$APP_DIR/deploy/server-update.sh" /usr/local/sbin/colipas-update
  fi
}

install_nginx_config() {
  if [ -f "$LANDING_ROOT/index.html" ] && [ -f "$SSL_CERTIFICATE" ] && [ -f "$SSL_CERTIFICATE_KEY" ]; then
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

  ssl_certificate $SSL_CERTIFICATE;
  ssl_certificate_key $SSL_CERTIFICATE_KEY;
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
    try_files /index.html =404;
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
    install -m 0644 "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/colipas.conf
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
  if [ "$(id -u)" -eq 0 ]; then
    install_runtime_update_script
    install_nginx_config
    patch_landing_page_ui
    nginx -t
    systemctl reload nginx
  fi
  echo "CoLiPas already up to date at $LOCAL_HEAD"
  exit 0
fi

run_as_app git reset --hard "$REMOTE_HEAD"
run_as_app npm ci
run_as_app npm run build
if [ "$(id -u)" -eq 0 ]; then
  install_runtime_update_script
  install -m 0644 "$APP_DIR/deploy/colipas.service" /etc/systemd/system/colipas.service
  install_nginx_config
  patch_landing_page_ui
  systemctl daemon-reload
  nginx -t
  systemctl reload nginx
fi
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME"
echo "CoLiPas updated to $REMOTE_HEAD"
