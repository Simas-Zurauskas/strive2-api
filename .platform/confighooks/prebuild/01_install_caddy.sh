#!/usr/bin/env bash
# Configuration-change entry point for the Caddy install step. Normally a
# no-op — the instance already has Caddy by the time any config change lands —
# but it keeps a config change on a not-yet-provisioned instance from failing
# in configure.sh with a missing binary.
set -euo pipefail
exec "$(dirname "$0")/../../caddy/install.sh"
