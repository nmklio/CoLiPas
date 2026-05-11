#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${COLIPAS_REPO_URL:-https://github.com/nmklio/CoLiPas.git}"
APP_DIR="${COLIPAS_APP_DIR:-/opt/colipas}"
BRANCH="${COLIPAS_BRANCH:-master}"
MODE="${COLIPAS_DEPLOY_MODE:-docker}"
PUBLIC_URL="${COLIPAS_PUBLIC_URL:-http://127.0.0.1:8080}"
ADMIN_USERNAME="${COLIPAS_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${COLIPAS_ADMIN_PASSWORD:-}"
ASSUME_YES="${COLIPAS_ASSUME_YES:-0}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root or with sudo so the script can install packages and write ${APP_DIR}." >&2
  exit 1
fi

need_command() {
  command -v "$1" >/dev/null 2>&1
}

random_secret() {
  if need_command openssl; then
    openssl rand -hex 32
    return
  fi
  random_value=""
  while [ "${#random_value}" -lt 64 ]; do
    next="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$((64 - ${#random_value}))" || true)"
    random_value="${random_value}${next}"
  done
  printf '%s\n' "$random_value"
}

install_base_packages() {
  if need_command apt-get; then
    apt-get update
    apt-get install -y git curl ca-certificates
  elif need_command dnf; then
    dnf install -y git curl ca-certificates
  elif need_command yum; then
    yum install -y git curl ca-certificates
  elif need_command apk; then
    apk add --no-cache git curl ca-certificates
  fi
}

install_docker_if_needed() {
  if need_command docker && docker compose version >/dev/null 2>&1; then
    return
  fi
  if need_command apt-get; then
    apt-get install -y docker.io docker-compose-plugin
  elif need_command dnf; then
    dnf install -y docker docker-compose-plugin
  elif need_command yum; then
    yum install -y docker docker-compose-plugin
  elif need_command apk; then
    apk add --no-cache docker docker-cli-compose
  else
    echo "Install Docker and the docker compose plugin, then rerun this script." >&2
    exit 1
  fi
  systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1 || true
}

install_node_if_needed() {
  if need_command node && node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >/dev/null 2>&1; then
    return
  fi
  if ! need_command apt-get; then
    echo "Native mode requires Node.js 24+. Install Node.js first or use COLIPAS_DEPLOY_MODE=docker." >&2
    exit 1
  fi
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
}

sync_source() {
  mkdir -p "$(dirname "$APP_DIR")"
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --prune origin "$BRANCH"
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  else
    if [ -e "$APP_DIR" ] && [ -n "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      if [ "$ASSUME_YES" != "1" ]; then
        echo "${APP_DIR} exists and is not a CoLiPas git checkout." >&2
        echo "Move it aside or rerun with COLIPAS_ASSUME_YES=1 to replace that directory." >&2
        exit 1
      fi
      rm -rf "$APP_DIR"
    fi
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  cd "$APP_DIR"
}

write_env_if_missing() {
  if [ -f .env ]; then
    chmod 0600 .env
    return
  fi

  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(random_secret)"
  fi

  cat > .env <<EOF
NODE_ENV=production
PORT=8080
CORS_ORIGIN=${PUBLIC_URL}
CUSTOM_API_ALLOWED_HOSTS=httpbin.org,api.example.com
CUSTOM_API_TIMEOUT_MS=8000
AI_API_KEY=
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SESSION_SECRET=$(random_secret)
SESSION_TTL_HOURS=12
COLIPAS_DATA_DIR=.data
CREDENTIAL_ENCRYPTION_KEY=$(random_secret)
RELEASE_VERIFY_TOKEN=
RELEASE_TARGET_NAME=one-click-${MODE}
RELEASE_CHANNEL=production
RELEASE_DEPLOYMENT_MODE=${MODE}
RELEASE_PUBLIC_URL=${PUBLIC_URL}
RELEASE_GIT_COMMIT=
RELEASE_ARTIFACT_ID=
RELEASE_DEPLOYED_AT=
EOF
  chmod 0600 .env
}

deploy_docker() {
  install_docker_if_needed
  export RELEASE_GIT_COMMIT
  RELEASE_GIT_COMMIT="$(git rev-parse HEAD)"
  export RELEASE_ARTIFACT_ID="one-click-docker-$(date -u +%Y%m%d%H%M%S)"
  docker compose up -d --build
  docker compose ps
}

deploy_native() {
  install_node_if_needed
  id -u colipas >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin colipas
  chown -R colipas:colipas "$APP_DIR"
  run_as_colipas npm ci
  run_as_colipas npm run build
  awk -v app_dir="$APP_DIR" '{ gsub("/opt/colipas", app_dir); print }' deploy/colipas.service > /tmp/colipas.service
  install -m 0644 /tmp/colipas.service /etc/systemd/system/colipas.service
  rm -f /tmp/colipas.service
  systemctl daemon-reload
  systemctl enable --now colipas
  systemctl restart colipas
  systemctl status colipas --no-pager || true
}

run_as_colipas() {
  if need_command runuser; then
    runuser -u colipas -- "$@"
  elif need_command sudo; then
    sudo -u colipas "$@"
  else
    su -s /bin/sh colipas -c "$(printf '%q ' "$@")"
  fi
}

install_base_packages
sync_source
write_env_if_missing

case "$MODE" in
  docker)
    deploy_docker
    ;;
  native|systemd)
    deploy_native
    ;;
  *)
    echo "Unknown COLIPAS_DEPLOY_MODE=${MODE}. Use docker or native." >&2
    exit 1
    ;;
esac

curl -fsS http://127.0.0.1:8080/api/health >/dev/null

echo
echo "CoLiPas deployed successfully."
echo "URL: ${PUBLIC_URL}"
echo "Username: ${ADMIN_USERNAME}"
if [ -n "$ADMIN_PASSWORD" ]; then
  echo "Initial password: ${ADMIN_PASSWORD}"
else
  echo "Initial password was generated and saved in ${APP_DIR}/.env."
fi
echo "Change the admin password after first login."
