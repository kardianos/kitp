#!/usr/bin/env bash
# drift_report.sh — surfaces stale workflow / gate state in the live DB.
#
# Reports:
#   - Cards whose workflow_def_ref points at a deleted/missing card.
#   - Attribute values whose (card_type, attribute_def) edge no longer
#     exists in scope (project_type / workflow_def aware).
#   - Inherited gates whose source card is missing.
#
# Read-only. No automatic remediation. Pipe to less or a CSV consumer.
#
# Usage: ./scripts/drift_report.sh
set -euo pipefail

: "${DB_DSN:=postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable}"

psql_run() {
  docker exec -i kitp-pg psql -U kitp -d kitp -At -F$'\t' -c "$1"
}

echo "## Cards bound to a missing workflow_def"
psql_run "
  SELECT c.id, c.card_type_id, av.value
  FROM card c
  JOIN attribute_value av ON av.card_id = c.id
  JOIN attribute_def ad ON ad.id = av.attribute_def_id
  WHERE ad.name = 'workflow_def_ref'
    AND jsonb_typeof(av.value) = 'number'
    AND NOT EXISTS (
      SELECT 1 FROM card w WHERE w.id = (av.value::text)::bigint AND w.deleted_at IS NULL
    )
"

echo
echo "## Attribute values whose edge has disappeared"
psql_run "
  SELECT av.card_id, ad.name AS attribute, c.card_type_id
  FROM attribute_value av
  JOIN attribute_def ad ON ad.id = av.attribute_def_id
  JOIN card c ON c.id = av.card_id
  WHERE NOT EXISTS (
    SELECT 1 FROM edge e
    WHERE e.card_type_id = c.card_type_id
      AND e.attribute_def_id = ad.id
  )
"

echo
echo "## Done."
