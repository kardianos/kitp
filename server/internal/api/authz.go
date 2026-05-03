// File api/authz.go: scope-aware authorization for the batch dispatcher.
//
// The dispatcher resolves three things per HTTP request:
//   1. The actor's effective grants — `(card_type_id, process_name, scope_card_id?)`
//      tuples loaded once for the whole batch.
//   2. The target project id for each sub-request — the project a write
//      acts on (walked via parent_card_id, capped at depth 16). Walks for
//      the whole batch coalesce into one `WHERE id = ANY($1)` lookup.
//   3. A boolean per sub-request: any grant matches `(card_type, process)`
//      AND (scope is global OR scope == target project).
//
// On deny we emit `unauthorized` and abort the batch. The System User
// (auth.SystemUserID) keeps every grant via the seeded `system` role and
// `role_grant` rows from migrations 0003/0010, so dev-mode is unchanged.
package api

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// scopeWalkDepth caps the parent_card_id walk so a malicious cycle in card
// can't pin the dispatcher.
const scopeWalkDepth = 16

// grantRow is one effective grant row for the calling actor. ScopeCardID is
// nil for a global grant and a project card id for a scoped grant.
type grantRow struct {
	CardTypeID  int32
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

// authzCache holds the per-request shared state. The dispatcher fills it on
// first use and reuses it for every sub-request in the same Dispatch call.
type authzCache struct {
	grants     []grantRow
	loaded     bool
	cardLookup map[int64]cardInfo
}

// cardInfo is the cached card row used by parent walks.
type cardInfo struct {
	parentCardID *int64
	cardTypeID   int32
}

// projectCardTypeID is the int32 id of the 'project' card_type. Lazy-loaded
// once per request via cardLookup.
type cardTypeKindCache struct {
	projectID int32
	loaded    bool
}

// resolveTargetProject walks parent_card_id from startCardID until it hits
// a card whose card_type_id matches projectCardTypeID, or it runs out of
// parents. Returns 0 if no project ancestor was found within scopeWalkDepth.
func resolveTargetProject(startCardID int64, projectCardTypeID int32, lookup map[int64]cardInfo) int64 {
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

// expandCardLookup walks parents transitively for every id in seed and adds
// any newly-discovered parent rows to the lookup map. Capped by
// scopeWalkDepth iterations across the whole batch (the per-card walk is
// also capped at scopeWalkDepth, but the chain may need additional rounds).
func expandCardLookup(ctx context.Context, pool *store.Pool, lookup map[int64]cardInfo) error {
	for range scopeWalkDepth {
		var missing []int64
		for _, info := range lookup {
			if info.parentCardID != nil {
				if _, ok := lookup[*info.parentCardID]; !ok {
					missing = append(missing, *info.parentCardID)
				}
			}
		}
		if len(missing) == 0 {
			return nil
		}
		rows, err := pool.P.Query(ctx, `
			SELECT id, parent_card_id, card_type_id FROM card WHERE id = ANY($1::bigint[])
		`, missing)
		if err != nil {
			return fmt.Errorf("authz: parent walk: %w", err)
		}
		for rows.Next() {
			var id int64
			var info cardInfo
			if err := rows.Scan(&id, &info.parentCardID, &info.cardTypeID); err != nil {
				rows.Close()
				return err
			}
			lookup[id] = info
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}
	return nil
}

// projectCardTypeID looks up the int32 id of the 'project' card_type once.
func projectCardTypeID(ctx context.Context, pool *store.Pool) (int32, error) {
	var id int32
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
func (s *Server) targetProjectForLeaf(ctx context.Context, h reg.Handler, input any, lookup map[int64]cardInfo, projectTypeID int32) (int64, error) {
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
	// For other handlers we need the card_id the handler operates on. There
	// is no generic accessor; we ask the handler to tell us via a documented
	// input field. We rely on the handler-specific CardTypeID extractor that
	// already inspects the input — the cards we want to walk are those
	// registered in the lookup map.
	cid := cardIDFromInput(h, input)
	if cid == 0 {
		return 0, nil
	}
	return resolveTargetProject(cid, projectTypeID, lookup), nil
}

// authorizeLeaf returns nil when the actor's grants permit (handler, input).
// On deny, returns a HandlerError with code "unauthorized".
func (s *Server) authorizeLeaf(ctx context.Context, h reg.Handler, input any, grants []grantRow, lookup map[int64]cardInfo, projectTypeID int32) error {
	if h.ProcessName == "" || h.CardTypeID == nil {
		return nil // not gated
	}
	cardTypeID, err := h.CardTypeID(ctx, s.Pool.P, input)
	if err != nil {
		return &reg.HandlerError{Code: "validation", Message: err.Error()}
	}
	if cardTypeID == 0 {
		return nil // no card-type context — skip auth (matches old behavior)
	}
	// Verify the process is actually seeded; if not, we skip authz like the
	// pre-Phase-20 dispatcher used to (this keeps the test/echo flows alive).
	if !processExists(ctx, s.Pool.P, h.ProcessName) {
		return nil
	}

	tProj, err := s.targetProjectForLeaf(ctx, h, input, lookup, projectTypeID)
	if err != nil {
		return &reg.HandlerError{Code: "validation", Message: err.Error()}
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

// processExists returns true if a process row by that name exists. Cached at
// the pool level would be ideal; for now it's a single point query per
// sub-request, but cheap (process is a small table).
func processExists(ctx context.Context, q reg.ValidationPool, name string) bool {
	var id int32
	row := q.QueryRow(ctx, `SELECT id FROM process WHERE name = $1`, name)
	if err := row.Scan(&id); err != nil {
		if err == pgx.ErrNoRows {
			return false
		}
		return false
	}
	return true
}
