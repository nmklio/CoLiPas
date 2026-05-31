#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${COLIPAS_REPO_URL:-https://github.com/nmklio/CoLiPas.git}"
APP_DIR="${COLIPAS_APP_DIR:-/opt/colipas}"
BRANCH="${COLIPAS_BRANCH:-master}"
MODE="${COLIPAS_DEPLOY_MODE:-docker}"
PUBLIC_URL="${COLIPAS_PUBLIC_URL:-http://127.0.0.1:8080}"
ADMIN_USERNAME="${COLIPAS_ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${COLIPAS_ADMIN_PASSWORD:-}"
ADMIN_PASSWORD_GENERATED=0
ASSUME_YES="${COLIPAS_ASSUME_YES:-0}"
NON_INTERACTIVE="${COLIPAS_NON_INTERACTIVE:-0}"
TTY_DEVICE="${COLIPAS_TTY:-/dev/tty}"
ENV_CREATED=0
DRY_RUN="${COLIPAS_DRY_RUN:-0}"

if [ "$NON_INTERACTIVE" = "1" ] || [ "$ASSUME_YES" = "1" ]; then
  INTERACTIVE=0
elif [ -r "$TTY_DEVICE" ] && [ -w "$TTY_DEVICE" ]; then
  INTERACTIVE=1
else
  INTERACTIVE=0
fi

need_command() {
  command -v "$1" >/dev/null 2>&1
}

say() {
  printf '%s\n' "$*"
}

restore_tty_echo() {
  if [ "$INTERACTIVE" = "1" ]; then
    stty echo <"$TTY_DEVICE" 2>/dev/null || true
  fi
}

trap restore_tty_echo EXIT INT TERM

ask_text() {
  prompt="$1"
  default_value="$2"
  if [ "$INTERACTIVE" != "1" ]; then
    printf '%s\n' "$default_value"
    return
  fi
  printf '%s [%s]: ' "$prompt" "$default_value" >"$TTY_DEVICE"
  IFS= read -r answer <"$TTY_DEVICE" || answer=""
  if [ -n "$answer" ]; then
    printf '%s\n' "$answer"
  else
    printf '%s\n' "$default_value"
  fi
}

ask_secret() {
  prompt="$1"
  if [ "$INTERACTIVE" != "1" ]; then
    printf '%s\n' "$ADMIN_PASSWORD"
    return
  fi
  printf '%s: ' "$prompt" >"$TTY_DEVICE"
  stty -echo <"$TTY_DEVICE" 2>/dev/null || true
  IFS= read -r answer <"$TTY_DEVICE" || answer=""
  stty echo <"$TTY_DEVICE" 2>/dev/null || true
  printf '\n' >"$TTY_DEVICE"
  printf '%s\n' "$answer"
}

ask_yes_no() {
  prompt="$1"
  default_value="$2"
  if [ "$INTERACTIVE" != "1" ]; then
    [ "$default_value" = "y" ]
    return
  fi
  while true; do
    if [ "$default_value" = "y" ]; then
      suffix="Y/n"
    else
      suffix="y/N"
    fi
    printf '%s [%s]: ' "$prompt" "$suffix" >"$TTY_DEVICE"
    IFS= read -r answer <"$TTY_DEVICE" || answer=""
    answer="${answer:-$default_value}"
    case "$answer" in
      y|Y|yes|YES|Yes) return 0 ;;
      n|N|no|NO|No) return 1 ;;
      *) say "Please answer yes or no." >"$TTY_DEVICE" ;;
    esac
  done
}

choose_mode() {
  default_value="$1"
  if [ "$INTERACTIVE" != "1" ]; then
    printf '%s\n' "$default_value"
    return
  fi
  while true; do
    printf 'Deployment mode: 1) Docker Compose  2) Native systemd [%s]: ' "$default_value" >"$TTY_DEVICE"
    IFS= read -r answer <"$TTY_DEVICE" || answer=""
    answer="${answer:-$default_value}"
    case "$answer" in
      1|docker|Docker|compose|Compose) printf 'docker\n'; return ;;
      2|native|Native|systemd|Systemd) printf 'native\n'; return ;;
      *) say "Choose docker or native." >"$TTY_DEVICE" ;;
    esac
  done
}

interactive_config() {
  if [ "$INTERACTIVE" != "1" ]; then
    return
  fi

  cat >"$TTY_DEVICE" <<'BANNER'

CoLiPas cloud server management panel interactive deployment
This installer will clone or update the project, create a private .env if needed,
install the selected runtime, start the service, and run a local health check.

BANNER

  APP_DIR="$(ask_text "Install directory" "$APP_DIR")"
  BRANCH="$(ask_text "Git branch" "$BRANCH")"
  PUBLIC_URL="$(ask_text "Public URL or domain" "$PUBLIC_URL")"
  ADMIN_USERNAME="$(ask_text "Admin username" "$ADMIN_USERNAME")"
  MODE="$(choose_mode "$MODE")"

  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(ask_secret "Initial admin password, leave blank to generate one")"
  fi

  cat >"$TTY_DEVICE" <<SUMMARY

Deployment summary
  Mode:          ${MODE}
  Install dir:   ${APP_DIR}
  Branch:        ${BRANCH}
  Public URL:    ${PUBLIC_URL}
  Admin user:    ${ADMIN_USERNAME}
  Admin pass:    $([ -n "$ADMIN_PASSWORD" ] && printf 'provided' || printf 'auto-generate')

SUMMARY

  if ! ask_yes_no "Start deployment now" "y"; then
    say "Deployment cancelled." >"$TTY_DEVICE"
    exit 0
  fi
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
    say "Updating existing CoLiPas cloud server management panel checkout in ${APP_DIR}."
    git -C "$APP_DIR" fetch --prune origin "$BRANCH"
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
  else
    if [ -e "$APP_DIR" ] && [ -n "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
      if [ "$ASSUME_YES" != "1" ]; then
        if [ "$INTERACTIVE" = "1" ] && ask_yes_no "${APP_DIR} exists and is not a CoLiPas cloud server management panel checkout. Replace it" "n"; then
          :
        else
          echo "${APP_DIR} exists and is not a CoLiPas cloud server management panel git checkout." >&2
          echo "Move it aside or rerun with COLIPAS_ASSUME_YES=1 to replace that directory." >&2
          exit 1
        fi
      fi
      if [ "$ASSUME_YES" = "1" ] || [ "$INTERACTIVE" = "1" ]; then
        say "Replacing ${APP_DIR}."
      else
        echo "${APP_DIR} exists and is not a CoLiPas cloud server management panel git checkout." >&2
        echo "Move it aside or rerun with COLIPAS_ASSUME_YES=1 to replace that directory." >&2
        exit 1
      fi
      rm -rf "$APP_DIR"
    fi
    say "Cloning CoLiPas cloud server management panel into ${APP_DIR}."
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
  cd "$APP_DIR"
}

write_env_if_missing() {
  if [ -f .env ]; then
    chmod 0600 .env
    say "Existing .env found; keeping current secrets and runtime settings."
    return
  fi

  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(random_secret)"
    ADMIN_PASSWORD_GENERATED=1
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
  ENV_CREATED=1
  say "Created private .env with generated secrets."
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

if [ "$DRY_RUN" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  echo "Run as root or with sudo so the script can install packages and write ${APP_DIR}." >&2
  exit 1
fi

interactive_config

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run complete. No packages installed, files changed, or services started."
  say "Mode: ${MODE}"
  say "Install dir: ${APP_DIR}"
  say "Public URL: ${PUBLIC_URL}"
  exit 0
fi

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
echo "CoLiPas cloud server management panel deployed successfully."
echo "URL: ${PUBLIC_URL}"
echo "Username: ${ADMIN_USERNAME}"
if [ "$ENV_CREATED" = "1" ]; then
  if [ "$ADMIN_PASSWORD_GENERATED" = "1" ]; then
    echo "Initial password: ${ADMIN_PASSWORD}"
  else
    echo "Initial password: provided by installer input; not printed again."
  fi
else
  echo "Existing ${APP_DIR}/.env was kept; use the current admin password for that deployment."
fi
echo "Change the admin password after first login."
