#!/usr/bin/env bash
# scripts/check-recursive-depth.sh — CI guard for the CLAUDE.md
# "Recursive CTE depth cap" rule (A1 / BE-C1 / SEC-1).
#
# Any PL/pgSQL function that walks a self-referential card edge with a
# `WITH RECURSIVE` CTE MUST carry a `depth < 16` cap on the recursive
# arm, or a malicious/accidental parent_card_id cycle can pin a backend
# connection until statement_timeout. Rather than trust every author to
# remember the rule, this script fails the build when a function file
# mentions both `RECURSIVE` and a card self-reference (`parent_card_id`
# or `parent_task`) but never mentions `depth < 16`.
#
# The canonical capped walk lives in
# db/schema/functions/card_ancestors.sql; prefer calling
# card_ancestors() / card_enclosing_project() over hand-rolling a new
# recursive walk.
#
# The same rule covers Go: every non-test .go file under server/ that
# embeds a recursive card-tree walk in a SQL string is checked too (Go
# `//` comments are stripped the same way as SQL `--` ones).
#
# Exit 0 when every recursive card-tree walk is capped; exit 1 (with a
# per-file report) otherwise.
set -euo pipefail
cd "$(dirname "$0")/.."

FUNC_DIR="db/schema/functions"

fail=0
report() {
    echo "FAIL: $1 uses WITH RECURSIVE over a card self-reference but has no 'depth < 16' cap"
    echo "      (see CLAUDE.md 'Recursive CTE depth cap'; reuse card_ancestors / card_enclosing_project)"
    fail=1
}

check_file() {
    local f="$1"
    [ -f "$f" ] || return 0
    # Only consider files with an actual `WITH RECURSIVE` SQL construct
    # (not a prose "recursive" in a doc comment) that recurse over a card
    # self-reference (parent_card_id / parent_task). Strip `--` line
    # comments first so a stale comment can't trip — or mask — the check.
    local stripped
    case "$f" in
        *.go) stripped="$(sed -e 's#^[[:space:]]*//.*$##' -e 's/--.*$//' "$f")" ;;
        *) stripped="$(sed 's/--.*$//' "$f")" ;;
    esac
    if printf '%s' "$stripped" | grep -Eqi 'WITH[[:space:]]+RECURSIVE' \
        && printf '%s' "$stripped" | grep -Eq 'parent_card_id|parent_task'; then
        if ! printf '%s' "$stripped" | grep -Eq 'depth[[:space:]]*<[[:space:]]*16'; then
            report "$f"
        fi
    fi
}

for f in "$FUNC_DIR"/*.sql; do
    check_file "$f"
done
# Go-side SQL strings (tests excluded: they may build deliberately
# uncapped fixtures).
while IFS= read -r f; do
    check_file "$f"
done < <(find server -name '*.go' ! -name '*_test.go' -print | sort)

if [ "$fail" -ne 0 ]; then
    echo
    echo "Recursive-depth check failed. Add 'WHERE depth < 16' to the recursive arm,"
    echo "or route the walk through card_ancestors()/card_enclosing_project()."
    exit 1
fi

echo "recursive-depth check: OK (all recursive card-tree walks carry depth < 16)"
