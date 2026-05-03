#!/usr/bin/env bash
# scripts/e2e.sh — convenience wrapper around `make e2e`.
#
# Walks kitp through the full v1 user journey end-to-end (server +
# client + database all live), capturing one PNG per step into
# docs/screenshots/e2e/ and verifying state via direct API calls.
#
# Usage:
#   scripts/e2e.sh                # default: build, run e2e, exit code = pass/fail
#   KITP_E2E_FORCE_BUILD=1 scripts/e2e.sh   # force flutter rebuild
set -euo pipefail
cd "$(dirname "$0")/.."
make e2e
