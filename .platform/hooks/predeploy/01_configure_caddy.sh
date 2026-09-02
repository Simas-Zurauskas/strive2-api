#!/usr/bin/env bash
# Application-deployment entry point for the Caddy configuration step.
# The logic lives in .platform/caddy/configure.sh, shared with the
# confighooks/ counterpart that runs on configuration changes.
set -euo pipefail
exec "$(dirname "$0")/../../caddy/configure.sh"
