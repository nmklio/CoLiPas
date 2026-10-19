#!/usr/bin/env bash
# Self-test for the non-destructive nginx install path in deploy/server-update.sh.
#
# Usage: bash scripts/nginx-preserve-selftest.sh [deploy/server-update.sh] [reference-conf]
#
# Everything runs inside a temp directory. When a real nginx config is unavailable the
# script still proves that an existing edge hardening block survives the merge, that the
# merge is byte-idempotent, and that a template without the preserve anchor is refused.
set -uo pipefail

SCRIPT="${1:-deploy/server-update.sh}"
REFERENCE_CONF="${2:-}"
WORK="$(mktemp -d)"
FAILURES=0

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

[ -f "$SCRIPT" ] || {
  echo "FAIL: $SCRIPT not found" >&2
  exit 1
}

# Pull the helper block plus install_nginx_config out of the deploy script.
awk '/^COLIPAS_NGINX_CONFIG=/{flag=1} /^cd "\$APP_DIR"/{flag=0} flag' "$SCRIPT" >"$WORK/helpers.sh"
[ -s "$WORK/helpers.sh" ] || {
  echo "FAIL: could not extract the nginx helpers from $SCRIPT" >&2
  exit 1
}

# shellcheck disable=SC1091
source "$WORK/helpers.sh"

backup_nginx_config() { return 0; }

if [ -n "$REFERENCE_CONF" ] && [ -f "$REFERENCE_CONF" ]; then
  cp "$REFERENCE_CONF" "$WORK/site.conf"
else
  cat >"$WORK/site.conf" <<'SYNTHETIC'
server {
  listen 443 ssl http2;
  server_name probe.example;
  # MIAO7-CF-GUARD-START
  set_real_ip_from 127.0.0.0/8;
  real_ip_header X-Forwarded-For;
  location = /api/health {
    default_type application/json;
    return 200 '{"status":"ok"}';
  }
  # MIAO7-CF-GUARD-END
  ssl_certificate /tmp/probe.crt;
}
SYNTHETIC
fi

COLIPAS_NGINX_CONFIG="$WORK/site.conf"
COLIPAS_NGINX_SYMLINK="$WORK/enabled.conf"

before_guard="$(sed -n '/MIAO7-CF-GUARD-START/,/MIAO7-CF-GUARD-END/p' "$COLIPAS_NGINX_CONFIG")"
[ -n "$before_guard" ] || fail "reference config has no edge hardening block to preserve"

cat >"$WORK/rendered.conf" <<'TEMPLATE'
server {
  listen 443 ssl http2;
  server_name probe.example;
  # __COLIPAS_EDGE_PRESERVE__
  ssl_certificate /tmp/probe.crt;
}
TEMPLATE

install_edge_preserving_nginx_config "$WORK/rendered.conf" >/dev/null || fail "merge returned non-zero"

grep -q 'MIAO7-CF-GUARD-START' "$COLIPAS_NGINX_CONFIG" || fail "edge hardening missing after merge"
grep -q 'location = /api/health' "$COLIPAS_NGINX_CONFIG" || fail "health probe missing after merge"
if grep -q '__COLIPAS_EDGE_PRESERVE__' "$COLIPAS_NGINX_CONFIG"; then
  fail "anchor placeholder left in output"
fi
after_guard="$(sed -n '/MIAO7-CF-GUARD-START/,/MIAO7-CF-GUARD-END/p' "$COLIPAS_NGINX_CONFIG")"
[ "$before_guard" = "$after_guard" ] || fail "preserved block changed during merge"

hash_first="$(sha256sum "$COLIPAS_NGINX_CONFIG" | cut -d' ' -f1)"
install_edge_preserving_nginx_config "$WORK/rendered.conf" >/dev/null || fail "second merge returned non-zero"
hash_second="$(sha256sum "$COLIPAS_NGINX_CONFIG" | cut -d' ' -f1)"
[ "$hash_first" = "$hash_second" ] || fail "repeated merge was not byte-idempotent"

printf 'server {\n  server_name no-anchor.example;\n}\n' >"$WORK/no-anchor.conf"
if install_edge_preserving_nginx_config "$WORK/no-anchor.conf" >/dev/null 2>&1; then
  fail "merge accepted a template without the preserve anchor"
fi
hash_third="$(sha256sum "$COLIPAS_NGINX_CONFIG" | cut -d' ' -f1)"
[ "$hash_first" = "$hash_third" ] || fail "refused merge still modified the target"

# Render the repository template itself and validate it with nginx when possible.
mkdir -p "$WORK/landing"
printf '<!doctype html><title>probe</title>\n' >"$WORK/landing/index.html"
printf 'probe-cert\n' >"$WORK/cert.pem"
printf 'probe-key\n' >"$WORK/key.pem"
probe_cert_usable=0
if command -v openssl >/dev/null 2>&1 && openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj "/CN=probe.example" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1; then
  probe_cert_usable=1
fi

LANDING_ROOT="$WORK/landing"
SSL_CERTIFICATE="$WORK/cert.pem"
SSL_CERTIFICATE_KEY="$WORK/key.pem"
SERVER_NAME="probe.example"
COLIPAS_NGINX_CONFIG="$WORK/rendered-site.conf"
COLIPAS_NGINX_SYMLINK="$WORK/enabled.conf"
: >"$COLIPAS_NGINX_CONFIG"

nginx() { return 0; }
install_nginx_config >/dev/null || fail "install_nginx_config returned non-zero"
unset -f nginx

if grep -q '__COLIPAS_EDGE_PRESERVE__' "$COLIPAS_NGINX_CONFIG"; then
  fail "rendered template kept the anchor placeholder"
fi
if grep -q 'proxy_add_x_forwarded_for' "$COLIPAS_NGINX_CONFIG"; then
  fail "rendered template still trusts client-supplied X-Forwarded-For"
fi
grep -q 'X-Forwarded-For \$remote_addr' "$COLIPAS_NGINX_CONFIG" || fail "rendered template lost the X-Forwarded-For hardening"

if [ "$probe_cert_usable" -eq 1 ] && [ -f /etc/nginx/conf.d/10-miao-cf-geo.conf ] && command -v nginx >/dev/null 2>&1; then
  cat >"$WORK/nginx-main.conf" <<MAIN
worker_processes 1;
events { worker_connections 64; }
http {
  include /etc/nginx/mime.types;
  include /etc/nginx/conf.d/10-miao-cf-geo.conf;
  include $COLIPAS_NGINX_CONFIG;
}
MAIN
  if nginx -t -p "$WORK" -c "$WORK/nginx-main.conf" >"$WORK/nginx-t.log" 2>&1; then
    echo "ok rendered template passes nginx -t"
  else
    sed -n '1,20p' "$WORK/nginx-t.log" >&2
    fail "rendered template failed nginx -t"
  fi
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "nginx preserve self-test failures: $FAILURES" >&2
  exit 1
fi

echo "ok nginx install preserves server-side edge hardening and renders a valid config"
