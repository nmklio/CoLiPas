#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${COLIPAS_DOCKER_APP_DIR:-/opt/colipas-cp}"
BRANCH="${COLIPAS_DOCKER_BRANCH:-master}"
SERVER_NAME="${COLIPAS_DOCKER_SERVER_NAME:-cp.example.com}"
COMPOSE_PROJECT="${COLIPAS_DOCKER_COMPOSE_PROJECT:-colipas_cp}"
COMPOSE_FILE="${COLIPAS_DOCKER_COMPOSE_FILE:-docker-compose.prod.yml}"

cd "$APP_DIR"
git fetch --prune origin "$BRANCH"
git reset --hard "origin/$BRANCH"

HEAD_SHA="$(git rev-parse HEAD)"
DEPLOYED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
TARGET_NAME="${RELEASE_TARGET_NAME:-secondary-docker}"
CHANNEL="${RELEASE_CHANNEL:-production}"
MODE="${RELEASE_DEPLOYMENT_MODE:-docker}"
PUBLIC_URL="${RELEASE_PUBLIC_URL:-https://$SERVER_NAME}"
ARTIFACT_ID="${RELEASE_ARTIFACT_ID:-docker-$BRANCH}"
COMMIT="${RELEASE_GIT_COMMIT:-$HEAD_SHA}"

if [ -f .env ]; then
  tmp_env="$(mktemp)"
  grep -Ev '^(RELEASE_TARGET_NAME|RELEASE_CHANNEL|RELEASE_DEPLOYMENT_MODE|RELEASE_PUBLIC_URL|RELEASE_GIT_COMMIT|RELEASE_ARTIFACT_ID|RELEASE_DEPLOYED_AT)=' .env > "$tmp_env" || true
  {
    cat "$tmp_env"
    printf 'RELEASE_TARGET_NAME=%s\n' "$TARGET_NAME"
    printf 'RELEASE_CHANNEL=%s\n' "$CHANNEL"
    printf 'RELEASE_DEPLOYMENT_MODE=%s\n' "$MODE"
    printf 'RELEASE_PUBLIC_URL=%s\n' "$PUBLIC_URL"
    printf 'RELEASE_GIT_COMMIT=%s\n' "$COMMIT"
    printf 'RELEASE_ARTIFACT_ID=%s\n' "$ARTIFACT_ID"
    printf 'RELEASE_DEPLOYED_AT=%s\n' "$DEPLOYED_AT"
  } > .env
  rm -f "$tmp_env"
  chmod 0600 .env
fi

export RELEASE_TARGET_NAME="$TARGET_NAME"
export RELEASE_CHANNEL="$CHANNEL"
export RELEASE_DEPLOYMENT_MODE="$MODE"
export RELEASE_PUBLIC_URL="$PUBLIC_URL"
export RELEASE_GIT_COMMIT="$COMMIT"
export RELEASE_ARTIFACT_ID="$ARTIFACT_ID"
export RELEASE_DEPLOYED_AT="$DEPLOYED_AT"

docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --build --remove-orphans
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" ps
curl -fsS -H "Host: $SERVER_NAME" http://127.0.0.1/api/health >/dev/null
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" exec -T colipas node deploy/release-evidence-check.mjs
echo "CoLiPas docker target updated to $(git rev-parse --short HEAD)"
