#!/usr/bin/env bash
# Application-deployment entry point for the Caddy install step.
# The logic lives in .platform/caddy/install.sh, shared with the confighooks/
# counterpart that runs on configuration changes.
set -euo pipefail
exec "$(dirname "$0")/../../caddy/install.sh"
