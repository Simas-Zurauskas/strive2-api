#!/usr/bin/env bash
# Installs Caddy as the public TLS terminator on this instance.
#
# Why this exists: the environment used to sit behind an ALB purely so that
# ACM could terminate TLS — $20/mo for a load balancer fronting a single
# instance an ASG pinned to min=max=1. Caddy does the same job on the box for
# free, which lets the ALB (and two of the three public IPv4 addresses) go.
#
# Caddy binds :443 ONLY. EB's own nginx keeps :80 and stays untouched, so the
# request chain is Caddy -> nginx -> node: the same two proxy hops the ALB
# setup had. That is deliberate — `app.set('trust proxy', 1)` in src/index.ts
# is calibrated for that depth, and collapsing a hop would silently change
# which address the rate limiter buckets on.
#
# Idempotent: re-running on an already-provisioned instance is a no-op.
set -euo pipefail

CADDY_VERSION="2.11.4"
CADDY_SHA256="52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904"
CADDY_BIN="/usr/local/bin/caddy"
# Pulled from the EB bucket rather than GitHub: the instance role already has
# read access to elasticbeanstalk-*, and a deploy shouldn't be able to fail
# because a third-party release host is having a bad day.
S3_URI="s3://elasticbeanstalk-eu-central-1-172914246201/vendor/caddy/caddy_${CADDY_VERSION}_linux_arm64.tar.gz"

log() { echo "[caddy-install] $*"; }

if [[ -x "$CADDY_BIN" ]] && "$CADDY_BIN" version 2>/dev/null | grep -q "v${CADDY_VERSION}"; then
  log "caddy v${CADDY_VERSION} already installed, skipping"
else
  log "installing caddy v${CADDY_VERSION}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  aws s3 cp "$S3_URI" "$TMP/caddy.tar.gz" --quiet

  # Verify before anything is unpacked or executed.
  echo "${CADDY_SHA256}  ${TMP}/caddy.tar.gz" | sha256sum -c - >/dev/null
  log "checksum ok"

  tar -xzf "$TMP/caddy.tar.gz" -C "$TMP" caddy
  install -m 0755 "$TMP/caddy" "$CADDY_BIN"
  log "installed $($CADDY_BIN version | head -1)"
fi

# Unprivileged service account; :443 comes from a capability, not from root.
if ! id -u caddy >/dev/null 2>&1; then
  log "creating caddy system user"
  groupadd --system caddy
  useradd --system --gid caddy --home-dir /var/lib/caddy \
          --shell /sbin/nologin --comment "Caddy web server" caddy
fi

install -d -o caddy -g caddy -m 0750 /var/lib/caddy   # ACME account + certs
install -d -o caddy -g caddy -m 0750 /var/log/caddy
install -d -o root  -g root  -m 0755 /etc/caddy

cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy (public TLS terminator, proxies to EB nginx on :80)
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
Restart=on-failure
RestartSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
# Caddy derives its data directory (ACME account keys and issued certificates)
# from HOME. Set it explicitly rather than relying on systemd populating it
# from the passwd entry — if it ever resolved elsewhere, Caddy would silently
# re-issue certificates on every restart and burn Let's Encrypt rate limit.
Environment=HOME=/var/lib/caddy
# Lets an unprivileged process bind 443 without granting it root.
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
log "done"
