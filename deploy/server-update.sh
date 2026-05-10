#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${COLIPAS_APP_DIR:-/opt/colipas}"
SERVICE_NAME="${COLIPAS_SERVICE_NAME:-colipas}"
BRANCH="${COLIPAS_BRANCH:-master}"

cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "ERROR: $APP_DIR is not a git checkout" >&2
  exit 1
fi

git fetch --prune origin "$BRANCH"
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  echo "CoLiPas already up to date at $LOCAL_HEAD"
  exit 0
fi

git reset --hard "$REMOTE_HEAD"
npm ci
npm run build
systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME"
echo "CoLiPas updated to $REMOTE_HEAD"
