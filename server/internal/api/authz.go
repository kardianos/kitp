// File api/authz.go: scope-aware authorization for the batch dispatcher.
//
// The dispatcher resolves three things per HTTP request:
//  1. The actor's effective grants — `(card_type_id, process_name, scope_card_id?)`
//     tuples loaded once for the whole batch.
//  2. The target project id for each sub-request — the project a write
//     acts on (walked via parent_card_id, capped at depth 16). Walks for
//     the whole batch coalesce into one `WHERE id = ANY($1)` lookup.
//  3. A boolean per sub-request: any grant matches `(card_type, process)`
//     AND (scope is global OR scope == target project).
//
// On deny we emit `unauthorized` and abort the batch. The System User
// (auth.SystemUserID) keeps every grant via the seeded `system` role and
// `role_grant` rows from migrations 0003/0010, so dev-mode is unchanged.
package api

import (
	"context"
	"fmt"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// scopeWalkDepth caps the parent_card_id walk so a malicious cycle in card
// can't pin the dispatcher.
const scopeWalkDepth = 16

// grantRow is one effective grant row for the calling actor. ScopeCardID is
// nil for a global grant and a project card id for a scoped grant.
type grantRow struct {
	CardTypeID  int64
	ProcessName string
	ScopeCardID *int64
}

// loadActorGrants returns the calling actor's effective grants, joined to
// process names so the dispatcher can match by string. We do one query per
// HTTP request (cached on the dispatcher's request context — see
// withAuthzCache below).
func loadActorGrants(ctx context.Context, pool *store.Pool, userID int64) ([]grantRow, error) {
	rows, err := pool.P.Query(ctx, `
		SELECT rg.card_type_id, p.name, ur.scope_card_id
		FROM user_role ur
		JOIN role r        ON r.id  = ur.role_id
		JOIN role_grant rg ON rg.role_id = r.id
		JOIN process p     ON p.id  = rg.process_id
		WHERE ur.user_id = $1
	`, userID)
	if err != nil {
		return nil, fmt.Errorf("authz: load grants: %w", err)
	}
	defer rows.Close()
	var out []grantRow
	for rows.Next() {
		var g grantRow
		if err := rows.Scan(&g.CardTypeID, &g.ProcessName, &g.ScopeCardID); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// cardInfo is the cached card row used by parent walks.
type cardInfo struct {
	parentCardID *int64
	cardTypeID   int64
}

// resolveTargetProject walks parent_card_id from startCardID until it hits
// a card whose card_type_id matches projectCardTypeID, or it runs out of
// parents. Returns 0 if no project ancestor was found within scopeWalkDepth.
func resolveTargetProject(startCardID int64, projectCardTypeID int64, lookup map[int64]cardInfo) int64 {
	cur := startCardID
	for range scopeWalkDepth {
		info, ok := lookup[cur]
		if !ok {
			return 0
		}
		if info.cardTypeID == projectCardTypeID {
			return cur
		}
		if info.parentCardID == nil {
			return 0
		}
		cur = *info.parentCardID
	}
	return 0
}

// preloadCards looks up every card id referenced by the batch in one query
// so the per-sub-request scope walk is purely in-memory.
func preloadCards(ctx context.Context, pool *store.Pool, ids []int64) (map[int64]cardInfo, error) {
	out := map[int64]cardInfo{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := pool.P.Query(ctx, `
		SELECT id, parent_card_id, card_type_id FROM card WHERE id = ANY($1::bigint[])
	`, ids)
	if err != nil {
		return nil, fmt.Errorf("authz: preload cards: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var info cardInfo
		if err := rows.Scan(&id, &info.parentCardID, &info.cardTypeID); err != nil {
			return nil, err
		}
		out[id] = info
	}
	return out, rows.Err()
}

// expandCardLookup adds every transitive parent of the cards already in
// `lookup` to the map, so the per-sub-request scope walk is purely
// in-memory. The whole ancestor closure is resolved in ONE capped
// recursive CTE (A12 / BE-M4) — the previous implementation issued one
// query per BFS level (O(depth) round-trips). The recursive arm carries
// `WHERE depth < 16` (matching scopeWalkDepth and
// db/schema/functions/card_ancestors.sql) so a parent_card_id cycle
// can't loop (A1 / SEC-1).
func expandCardLookup(ctx context.Context, pool *store.Pool, lookup map[int64]cardInfo) error {
	if len(lookup) == 0 {
		return nil
	}
	seed := make([]int64, 0, len(lookup))
	for id := range lookup {
		seed = append(seed, id)
	}
	// Walk parent_card_id up from every seed id in a single statement.
	// Seed rows are already in `lookup`; the CTE re-emits them (depth 0)
	// plus every ancestor up to the cap, and we merge any new rows.
	rows, err := pool.P.Query(ctx, `
		WITH RECURSIVE up(id, parent_card_id, card_type_id, depth) AS (
			SELECT c.id, c.parent_card_id, c.card_type_id, 0
			FROM card c WHERE c.id = ANY($1::bigint[])
			UNION ALL
			SELECT p.id, p.parent_card_id, p.card_type_id, up.depth + 1
			FROM card p JOIN up ON p.id = up.parent_card_id
			WHERE up.depth < 16
		)
		SELECT DISTINCT id, parent_card_id, card_type_id FROM up
	`, seed)
	if err != nil {
		return fmt.Errorf("authz: parent closure: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var info cardInfo
		if err := rows.Scan(&id, &info.parentCardID, &info.cardTypeID); err != nil {
			return err
		}
		lookup[id] = info
	}
	return rows.Err()
}

// projectCardTypeID looks up the id of the 'project' card_type once.
func projectCardTypeID(ctx context.Context, pool *store.Pool) (int64, error) {
	var id int64
	row := pool.P.QueryRow(ctx, `SELECT id FROM card_type WHERE name = 'project'`)
	if err := row.Scan(&id); err != nil {
		return 0, fmt.Errorf("authz: project card_type lookup: %w", err)
	}
	return id, nil
}

// targetProjectForLeaf returns the project id that a (handler, input) pair
// targets for scope checking. Returns (0, nil) when scope is irrelevant (no
// CardTypeID extractor on the handler).
//
// For card.insert the input has no card_id; we use the supplied parent or
// recognize a top-level 'project' insert.
func (s *Server) targetProjectForLeaf(ctx context.Context, h reg.Handler, input any, lookup map[int64]cardInfo, projectTypeID int64) (int64, error) {
	// Special case: top-level project insert. We resolve the parent through
	// the card.insert input shape; the input type is not exported by the
	// dispatcher so we use a duck-typed extractor lookup.
	if h.Endpoint == "card" && h.Action == "insert" {
		// We don't have a stable typed handle here; the card.Register
		// installed CardTypeID resolves the card_type_id from the input's
		// CardTypeName. The parent comes from the input's ParentCardID.
		parent, isProject, err := cardInsertParent(input)
		if err != nil {
			return 0, err
		}
		if isProject && parent == nil {
			// Top-level project insert: the new project IS its own scope.
			// We can't authorize against it (it doesn't exist yet). Return
			// 0 so the dispatcher allows global grants only — which is the
			// intent for project creation (manager/admin-only).
			return 0, nil
		}
		if parent != nil {
			return resolveTargetProject(*parent, projectTypeID, lookup), nil
		}
		return 0, nil
	}

	if h.CardTypeID == nil {
		return 0, nil
	}
	// For other handlers we need the card_id the handler operates on.
	// Handlers whose input doesn't carry a plain `card_id` /
	// `target_card_id` field expose an explicit ScopeCardID resolver
	// (e.g. comm.set_recipients(comm_id), comment.update(activity_id));
	// everything else falls back to reflecting the conventional field.
	// (BE-H3 / A2.)
	cid, err := s.scopeCardID(ctx, h, input)
	if err != nil {
		return 0, err
	}
	if cid == 0 {
		return 0, nil
	}
	return resolveTargetProject(cid, projectTypeID, lookup), nil
}

// scopeCardID resolves the card id the per-row scope pass should walk
// up from. Prefers the handler's explicit ScopeCardID resolver (which
// may query the DB to dereference an indirect id like comm_id /
// activity_id); falls back to the reflection-based card_id /
// target_card_id field extractor. Returns (0, nil) when there's no
// card context — the dispatcher then skips scoped-grant matching for
// that leaf (only global grants pass), which is the intended behaviour
// for handlers with no project anchor.
func (s *Server) scopeCardID(ctx context.Context, h reg.Handler, input any) (int64, error) {
	if h.ScopeCardID != nil {
		return h.ScopeCardID(ctx, s.Pool.P, input)
	}
	return cardIDFromInput(h, input), nil
}

// authorizeLeaf returns nil when the actor's grants permit (handler, input).
// On deny, returns a HandlerError with code "unauthorized".
func (s *Server) authorizeLeaf(ctx context.Context, h reg.Handler, input any, grants []grantRow, lookup map[int64]cardInfo, projectTypeID int64) error {
	if h.ProcessName == "" || h.CardTypeID == nil {
		return nil // not gated
	}
	cardTypeID, err := h.CardTypeID(ctx, s.Pool.P, input)
	if err != nil {
		// Internal lookup failure — return the wrapped error raw so the
		// dispatcher's errEnvelope redacts it (no err.Error() on the
		// wire). Wrapping it into a HandlerError{Message: err.Error()}
		// here would defeat that redaction (A5 / SEC-2).
		return fmt.Errorf("authz: resolve card_type for %s.%s: %w", h.Endpoint, h.Action, err)
	}
	if cardTypeID == 0 {
		return nil // no card-type context — skip auth (matches old behavior)
	}
	// Verify the process is actually seeded; if not, we skip authz like the
	// pre-Phase-20 dispatcher used to (this keeps the test/echo flows alive).
	// Answered from the pool's once-loaded process-name cache, not a
	// per-leaf point query (A15c / BE-L3).
	exists, err := s.Pool.ProcessExists(ctx, h.ProcessName)
	if err != nil {
		return fmt.Errorf("authz: process lookup for %s.%s: %w", h.Endpoint, h.Action, err)
	}
	if !exists {
		return nil
	}

	tProj, err := s.targetProjectForLeaf(ctx, h, input, lookup, projectTypeID)
	if err != nil {
		return fmt.Errorf("authz: resolve target project for %s.%s: %w", h.Endpoint, h.Action, err)
	}

	for _, g := range grants {
		if g.CardTypeID != cardTypeID {
			continue
		}
		if g.ProcessName != h.ProcessName {
			continue
		}
		if g.ScopeCardID == nil {
			return nil // global grant always wins
		}
		if tProj != 0 && *g.ScopeCardID == tProj {
			return nil
		}
	}
	return &reg.HandlerError{
		Code:    "unauthorized",
		Message: fmt.Sprintf("user lacks grant on (card_type=%d, process=%q, project=%d)", cardTypeID, h.ProcessName, tProj),
	}
}

// process existence is resolved via store.Pool.ProcessExists, which
// answers from a once-loaded in-memory snapshot of the (tiny,
// schema-immutable) process table rather than a per-leaf point query
// (A15c / BE-L3).
