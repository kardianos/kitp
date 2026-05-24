package schema

import "fmt"

// VisibilityClause returns a SQL EXISTS fragment that filters cards
// to only those visible to the supplied user. AND-join it into a
// WHERE clause of any read that exposes card rows (or rows that
// reference a card, like `activity`).
//
// Semantics: a card is visible if the caller, OR their parent user
// when the caller is an agent (`user_account.parent_user_id`), holds
// at least one `user_role` row that is either
//
//   - globally scoped (`scope_card_id IS NULL`) — admins and the
//     System User; or
//   - scoped to the project the target card chains up to via
//     `parent_card_id`.
//
// The agent → parent fall-through mirrors the rest of the codebase
// (`session/http.go`, `usercardagent`): agents act on behalf of
// their owner, so they inherit the owner's visibility. Agents
// without a parent (data model says this shouldn't happen) see
// nothing.
//
// The CTE walks parent_card_id from the target card to its
// `card_type='project'` ancestor; bounded by Postgres' planner +
// the btree on `parent_card_id`. In practice cards are 1-3 hops
// from their project (task→project, comm→task→project,
// reply→comm→task→project).
//
// `cardIDExpr` is the SQL expression yielding the target card id —
// typically `"c.id"` for queries with a `FROM card c` alias, or
// `"a.card_id"` for activity rows. `userArg` is the `$N`
// placeholder for the user id (caller adds the int64 to its args
// slice).
//
// Closes issues/backend/07-med-reads-across-projects.md.
func VisibilityClause(cardIDExpr, userArg string) string {
	return fmt.Sprintf(`EXISTS (
		WITH RECURSIVE up(id, parent_card_id, card_type_id) AS (
			SELECT id, parent_card_id, card_type_id
			FROM card WHERE id = %s
			UNION ALL
			SELECT p.id, p.parent_card_id, p.card_type_id
			FROM card p JOIN up ON p.id = up.parent_card_id
		)
		SELECT 1
		FROM user_account caller
		JOIN user_role ur
		  ON ur.user_id = caller.id
		  OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
		WHERE caller.id = %s
		  AND (
		    ur.scope_card_id IS NULL
		    OR ur.scope_card_id IN (
		      SELECT up.id
		      FROM up JOIN card_type ct ON ct.id = up.card_type_id
		      WHERE ct.name = 'project'
		    )
		  )
	)`, cardIDExpr, userArg)
}
