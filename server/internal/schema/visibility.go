package schema

import "fmt"

// VisibilityClause returns a SQL EXISTS fragment that filters cards
// to only those visible to the supplied user. AND-join it into a
// WHERE clause of any read that exposes card rows (or rows that
// reference a card, like `activity`).
//
// Semantics: a card is visible if the caller — or, when the caller is
// an agent (`user_account.parent_user_id`), its owner — holds at least
// one `user_role` row (user_role_visible) that is either
//
//   - globally scoped (`scope_card_id IS NULL`) — admins and the
//     System User; or
//   - scoped to the project the target card chains up to via
//     `parent_card_id`.
//
// The agent → owner fall-through mirrors the rest of the codebase
// (`session/http.go`, `usercardagent`): agents act on behalf of
// their owner, so they see exactly what the owner sees — the owner's
// rows, never the agent's own, so an agent can't be granted its way
// past its owner (review B1). What an agent can DO is a separate,
// narrower set (user_role_effective: roles it was granted that the
// owner also holds).
//
// The CTE walks parent_card_id from the target card to its
// `card_type='project'` ancestor; the recursive arm carries a
// `WHERE depth < 16` cap (CLAUDE.md "Recursive CTE depth cap"; 16
// matches internal/api/authz.go's scopeWalkDepth and the
// db/schema/functions/card_ancestors.sql helper) so a malicious or
// accidental parent_card_id cycle can't pin a connection (A1 / SEC-1).
// In practice cards are 1-3 hops from their project (task→project,
// comm→task→project, reply→comm→task→project).
//
// `cardIDExpr` is the SQL expression yielding the target card id —
// typically `"c.id"` for queries with a `FROM card c` alias, or
// `"a.card_id"` for activity rows. `userArg` is the `$N`
// placeholder for the user id (caller adds the int64 to its args
// slice).
//
// A card in an area that is switched off (card_in_off_area,
// docs/AREAS.md) is hidden from everyone, global roles included. That
// test runs on this same parent walk rather than as a second walk per
// row (review A14), and a message (reply_body, which has no parent)
// walks on from its thread. card_visible_to is the same predicate as a
// function; TestVisibilityAgrees keeps them and card_in_off_area in step.
//
// Closes DI-6 (docs/DESIGN_INVARIANTS.md).
func VisibilityClause(cardIDExpr, userArg string) string {
	return fmt.Sprintf(`EXISTS (
		WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (
			SELECT id, parent_card_id, card_type_id, 0
			FROM card WHERE id = %[1]s
			UNION ALL
			-- A message (reply_body) has no parent card: its chain goes on
			-- from the thread whose replies list it.
			SELECT th.id, th.parent_card_id, th.card_type_id, 1
			FROM card r
			JOIN attribute_value rv
			  ON rv.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'replies')
			 AND jsonb_typeof(rv.value) = 'array' AND rv.value @> to_jsonb(r.id)
			JOIN card th ON th.id = rv.card_id
			WHERE r.id = %[1]s
			  -- the type first, so other cards never probe the replies index
			  AND r.card_type_id = (SELECT id FROM card_type WHERE name = 'reply_body')
			UNION ALL
			SELECT p.id, p.parent_card_id, p.card_type_id, up.depth + 1
			FROM card p JOIN up ON p.id = up.parent_card_id
			WHERE up.depth < 16
		),
		chain AS (
			SELECT up.id, ct.name FROM up JOIN card_type ct ON ct.id = up.card_type_id
		)
		SELECT 1
		FROM user_account caller
		CROSS JOIN LATERAL user_role_visible(caller.id) ur
		WHERE caller.id = %[2]s
		  AND (ur.scope_card_id IS NULL
		       OR ur.scope_card_id IN (SELECT chain.id FROM chain WHERE chain.name = 'project'))
		  -- card_in_off_area, on this same walk: nothing off anywhere is
		  -- answered once per query; otherwise no card in the chain may
		  -- belong to an area that is off.
		  AND ((NOT EXISTS (SELECT 1 FROM project_area WHERE state = 'off')
		        AND NOT EXISTS (SELECT 1 FROM workspace_area WHERE state = 'off'))
		       OR NOT EXISTS (
		         SELECT 1 FROM chain x JOIN area a ON a.card_types ? x.name
		         WHERE (a.scope = 'workspace'
		                AND EXISTS (SELECT 1 FROM workspace_area w WHERE w.area_key = a.key AND w.state = 'off'))
		            OR (a.scope = 'project'
		                AND EXISTS (SELECT 1 FROM project_area pa
		                            WHERE pa.area_key = a.key AND pa.state = 'off'
		                              AND pa.project_id IN (SELECT y.id FROM chain y WHERE y.name = 'project')))))
	)`, cardIDExpr, userArg)
}
