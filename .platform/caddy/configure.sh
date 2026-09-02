#!/usr/bin/env bash
# Renders /etc/caddy/Caddyfile and (re)starts Caddy.
#
# Shared by .platform/hooks/predeploy (application deployments) and
# .platform/confighooks/predeploy (configuration changes) — EB keeps those
# trees separate and will not run one for the other, so both call in here
# rather than the logic being duplicated.
#
# Driven by EB environment properties, which makes the cutover from a
# self-signed certificate to a real Let's Encrypt one a configuration change
# rather than a redeploy:
#
#   CADDY_DOMAIN    hostname to serve       (default api.strive-learning.com)
#   CADDY_TLS_MODE  "internal" | "acme"     (default internal)
#   CADDY_EMAIL     ACME contact, optional  (certificate expiry notices only)
#
# "internal" issues a self-signed certificate from Caddy's local CA. That is
# the safe state while the ALB is still in front: Caddy can be installed,
# started and curl'd on :443 without sitting in any real user's path. Flip to
# "acme" only once DNS points at this instance, because the TLS-ALPN-01
# challenge has to reach *this* box on :443 to succeed.
set -euo pipefail

log() { echo "[caddy-config] $*"; }

get_env() {
  local key="$1" default="${2-}" val=""
  val="$(/opt/elasticbeanstalk/bin/get-config environment -k "$key" 2>/dev/null || true)"
  if [[ -n "$val" && "$val" != "null" ]]; then echo "$val"; else echo "$default"; fi
}

DOMAIN="$(get_env CADDY_DOMAIN 'api.strive-learning.com')"
TLS_MODE="$(get_env CADDY_TLS_MODE 'internal')"
EMAIL="$(get_env CADDY_EMAIL '')"

log "domain=${DOMAIN} tls_mode=${TLS_MODE}"

GLOBAL_EMAIL=""
case "$TLS_MODE" in
  internal)
    TLS_BLOCK=$'\ttls internal'
    ;;
  acme)
    # nginx owns :80 on this instance, so an HTTP-01 challenge would never
    # reach Caddy. TLS-ALPN-01 runs entirely on :443, which Caddy does own.
    TLS_BLOCK=$'\ttls {\n\t\tissuer acme {\n\t\t\tdisable_http_challenge\n\t\t}\n\t}'
    [[ -n "$EMAIL" ]] && GLOBAL_EMAIL=$'\temail '"${EMAIL}"
    ;;
  *)
    log "ERROR: CADDY_TLS_MODE must be 'internal' or 'acme', got '${TLS_MODE}'"
    exit 1
    ;;
esac

cat > /etc/caddy/Caddyfile <<CADDYFILE
# Managed by .platform/caddy/configure.sh — edits here are lost on the next
# deploy. Change the EB environment properties instead.
{
	admin off
	# Caddy's automatic HTTPS otherwise stands up an HTTP->HTTPS redirect
	# listener on :80, which EB's nginx already owns — Caddy would fail to
	# bind and take the whole service down with it. Certificate management is
	# unaffected; this disables only the redirect listener, leaving Caddy
	# bound to :443 alone.
	auto_https disable_redirects
${GLOBAL_EMAIL}
}

${DOMAIN} {
${TLS_BLOCK}

	# Upstream is EB's own nginx on :80, which in turn proxies to node on
	# :8080. Keeping nginx in the chain preserves the two-hop proxy depth the
	# ALB setup had — see the note in .platform/caddy/install.sh — and keeps
	# its 55M client_max_body_size governing source-document uploads.
	#
	# flush_interval -1 disables response buffering. The lesson and mentor
	# endpoints stream tokens with res.write(); buffering would hold output
	# back until generation finished and defeat the feature.
	reverse_proxy 127.0.0.1:80 {
		flush_interval -1
	}
}
CADDYFILE

chown root:caddy /etc/caddy/Caddyfile
chmod 0640 /etc/caddy/Caddyfile

# Fail the deploy on a bad config rather than reloading into a broken state.
# Under the Immutable deployment policy that rolls the new instance back and
# leaves the previous one serving.
if ! /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile 2>&1 | sed 's/^/[caddy-validate] /'; then
  log "ERROR: Caddyfile failed validation"
  exit 1
fi

systemctl enable caddy >/dev/null 2>&1 || true
if systemctl is-active --quiet caddy; then
  log "reloading caddy"
  systemctl reload caddy
else
  log "starting caddy"
  systemctl start caddy
fi

# Type=notify means systemd reports the unit active only once Caddy is really
# serving, so this check is meaningful rather than a race.
sleep 2
if ! systemctl is-active --quiet caddy; then
  log "ERROR: caddy is not active after start/reload"
  systemctl status caddy --no-pager --lines=40 || true
  journalctl -u caddy --no-pager --lines=40 || true
  exit 1
fi

log "caddy active on :443 -> 127.0.0.1:80 (${DOMAIN}, ${TLS_MODE})"
