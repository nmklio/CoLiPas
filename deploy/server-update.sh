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

cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "ERROR: $APP_DIR is not a git checkout" >&2
  exit 1
fi

run_as_app git fetch --prune origin "$BRANCH"
LOCAL_HEAD="$(run_as_app git rev-parse HEAD)"
REMOTE_HEAD="$(run_as_app git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
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
  systemctl daemon-reload
  nginx -t
  systemctl reload nginx
fi
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME"
echo "CoLiPas updated to $REMOTE_HEAD"
