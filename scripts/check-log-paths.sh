#!/usr/bin/env bash
# scripts/check-log-paths.sh — CI guard for the CLAUDE.md "Secrets in URL
# paths" rule (docs/MAIL_INTAKE_AND_CALENDARS.md §2).
#
# Calendar feeds and inbound mail routes carry a secret in the URL path, so
# every log line that prints a request path must pass it through
# logpath.Of, which replaces the secret with a placeholder. This fails the
# build on a non-test .go line that hands r.URL.Path (or URL.String() /
# RequestURI) to a log call or a "path" log attribute without logpath.Of.
#
# Exit 0 when clean; exit 1 with the offending lines otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(grep -rnE --include='*.go' '(URL\.Path|URL\.String\(\)|RequestURI)' server \
  | grep -v '_test\.go:' \
  | grep -E '(slog\.|\.Log(Attrs)?\(|\.(Debug|Info|Warn|Error)\(|log\.Print|"path")' \
  | grep -v 'logpath\.Of(' || true)

if [ -n "$hits" ]; then
  echo "check-log-paths: a request path is logged without logpath.Of:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "check-log-paths: OK"
