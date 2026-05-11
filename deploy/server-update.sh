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

replaceAll(/\/\* colipas landing balanced ui(?: v2)? \*\/[\s\S]*?(?=<\/style>)/g, '');
replaceAll(/<a class="button github-button" href="https:\/\/github\.com\/nmklio\/CoLiPas"[^>]*>GitHub<\/a>/g, '');

if (!html.includes('https://github.com/nmklio/CoLiPas')) {
  replaceOnce(/<a class="nav-action" href="\/admin\/">([\s\S]*?)<\/a>/, (_match, label) => (
    `<div class="nav-actions"><a class="nav-github" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">GitHub</a><a class="nav-action" href="/admin/">${label}</a></div>`
  ));
}

replaceOnce(/(<section class="hero wrap">[\s\S]*?)<h1>[\s\S]*?<\/h1>/, (_match, prefix) => (
  `${prefix}<h1><span class="hero-title-main">多云服务器管理面板</span><span class="hero-title-accent">接入、监控、修复一体化</span></h1>`
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

replaceOnce('</style>', `/* colipas landing balanced ui v2 */
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
    min-height: clamp(590px, calc(100vh - 210px), 680px);
    padding: clamp(36px, 5.2vh, 60px) 0 34px;
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
    margin-top: 28px;
    padding-top: 22px;
  }
  .section {
    padding: 74px 0;
  }
  #product.section {
    padding-top: 44px;
  }
  #product .split {
    grid-template-columns: minmax(0, .9fr) minmax(360px, .74fr);
    gap: 36px;
    align-items: center;
    padding-top: 8px;
  }
  #product h2 {
    max-width: 680px;
    font-size: clamp(32px, 2.85vw, 40px);
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
    min-height: 116px;
    padding: 20px;
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
    padding: 46px 0 48px;
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
    font-size: clamp(38px, 11vw, 46px);
    line-height: 1.08;
  }
  .product-preview {
    border-radius: 14px;
    transform: none;
  }
  #product .section-copy {
    max-width: none;
    padding: 0;
    border-left: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
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
