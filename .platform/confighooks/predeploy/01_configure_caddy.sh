#!/usr/bin/env bash
# Configuration-change entry point for the Caddy configuration step. This is
# what re-renders the Caddyfile when CADDY_TLS_MODE is flipped from "internal"
# to "acme", without needing an application redeploy.
set -euo pipefail
exec "$(dirname "$0")/../../caddy/configure.sh"
