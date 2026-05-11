#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${COLIPAS_APP_DIR:-/opt/colipas}"
SERVICE_NAME="${COLIPAS_SERVICE_NAME:-colipas}"
BRANCH="${COLIPAS_BRANCH:-master}"
APP_USER="${COLIPAS_APP_USER:-colipas}"

run_as_app() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$APP_USER" -- "$@"
  else
    "$@"
  fi
}

patch_landing_github_link() {
  if ! command -v node >/dev/null 2>&1; then
    echo "WARN: node is unavailable; skipping landing page GitHub link patch" >&2
    return 0
  fi

  local candidates=(
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
if (html.includes('https://github.com/nmklio/CoLiPas')) {
  process.exit(0);
}

let changed = false;
html = html.replace(/<a class="nav-action" href="\/admin\/">([\s\S]*?)<\/a>/, (_match, label) => {
  changed = true;
  return `<div class="nav-actions"><a class="nav-github" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">GitHub</a><a class="nav-action" href="/admin/">${label}</a></div>`;
});

html = html.replace(/<a class="button" href="#deploy">([\s\S]*?)<\/a>/, (_match, label) => {
  changed = true;
  return `<a class="button" href="#deploy">${label}</a><a class="button github-button" href="https://github.com/nmklio/CoLiPas" target="_blank" rel="noreferrer">GitHub</a>`;
});

if (!html.includes('.nav-actions {')) {
  html = html.replace('.nav-action {', `.nav-actions {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.nav-action,
.nav-github {`);
  html = html.replace(/box-shadow: 0 16px 34px rgba\(37, 99, 235, \.22\);\n}\n\.hero \{/, `box-shadow: 0 16px 34px rgba(37, 99, 235, .22);
}
.nav-github {
  color: #122033;
  background: #fff;
  border: 1px solid #dce7f4;
  box-shadow: none;
}
.hero {`);
  changed = true;
}

if (!html.includes('.github-button {')) {
  html = html.replace('.button:hover {', `.github-button {
  color: #fff;
  background: var(--blue);
  border-color: var(--blue);
  box-shadow: 0 16px 34px rgba(37, 99, 235, .18);
}
.button:hover {`);
  changed = true;
}

if (!html.includes('@media (max-width: 640px) {\n  .nav-actions')) {
  html = html.replace('@media (max-width: 640px) {', `@media (max-width: 640px) {
  .nav-actions {
    justify-self: stretch;
    display: grid;
    grid-template-columns: 1fr 1fr;
  }`);
  changed = true;
}

if (!html.includes('https://github.com/nmklio/CoLiPas')) {
  throw new Error(`Unable to add GitHub link to ${file}`);
}

if (changed) {
  fs.writeFileSync(file, html);
}
NODE
    patched=1
    echo "CoLiPas landing page GitHub link ready: $landing_file"
  done

  if [ "$patched" -eq 0 ]; then
    echo "WARN: CoLiPas landing page was not found; skipped GitHub link patch" >&2
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

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    patch_landing_github_link
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
  install -m 0644 "$APP_DIR/deploy/colipas.service" /etc/systemd/system/colipas.service
  install -m 0644 "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/colipas.conf
  ln -sfn /etc/nginx/sites-available/colipas.conf /etc/nginx/sites-enabled/colipas.conf
  patch_landing_github_link
  systemctl daemon-reload
  nginx -t
  systemctl reload nginx
fi
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME"
echo "CoLiPas updated to $REMOTE_HEAD"
