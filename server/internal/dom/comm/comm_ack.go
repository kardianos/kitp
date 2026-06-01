// comm.set_ack — the per-thread "handled" acknowledgement on a comm card.
//
// ACK is thread-level (on the comm), not per-message. A received inbound
// reply clears the comm's `acked` flag (imap.go appendReceivedReply writes
// acked=false) so the thread surfaces in the comms screen's "Needs ACK"
// filter. An operator marks the thread handled (acked=true) — or re-opens
// it (acked=false) — via this handler.
//
// Authz mirrors comm.set_recipients: worker / manager / admin, gated on the
// parent task's card.update grant (workers hold card.update on task, not on
// comm directly — see db/schema/seed.hcsv). The SQL body lives in
// db/schema/functions/comm_set_ack_batch.sql.

package comm

import (
	"context"
	"errors"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// CommSetAckInput toggles the per-thread acked flag on a comm card. acked
// defaults to true (the common "mark handled" case) when omitted.
type CommSetAckInput struct {
	CommID int64 `json:"comm_id,string" mcp:"required,desc=comm card id to acknowledge"`
	Acked  bool  `json:"acked" mcp:"desc=true marks the thread handled (default); false re-opens it"`
}

// CommSetAckOutput echoes the stored flag so the UI can confirm without a
// re-fetch.
type CommSetAckOutput struct {
	Acked bool `json:"acked" mcp:"desc=the acked flag now stored on the comm"`
}

func registerCommSetAck(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "comm",
		Action:       "set_ack",
		Doc:          "Set the per-thread `acked` flag on a comm card (true = handled, default; false = re-open). A received inbound reply clears it automatically. Authz: worker / manager / admin (matches the manager grant on comm).",
		InputType:    reflect.TypeFor[CommSetAckInput](),
		OutputType:   reflect.TypeFor[CommSetAckOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromCommSetAckInput,
		// comm_id, not a plain card_id — the dispatcher's per-row scope pass
		// needs an explicit walk start (comm → task → project) so a
		// project-scoped manager isn't denied (BE-H3 / A2).
		ScopeCardID: scopeCardFromCommSetAckInput,
		SQLFunc:     "comm_set_ack_batch",
	})
}

// cardTypeFromCommSetAckInput walks comm → parent task and returns the
// task's card_type so the dispatcher scope-checks against the actor's
// task-level grant (mirrors cardTypeFromCommSetRecipientsInput).
func cardTypeFromCommSetAckInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	commID := raw.(CommSetAckInput).CommID
	var parentCardTypeID int64
	err := pool.QueryRow(ctx, `
		SELECT parent.card_type_id
		FROM card c
		JOIN card parent ON parent.id = c.parent_card_id
		WHERE c.id = $1
	`, commID).Scan(&parentCardTypeID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return parentCardTypeID, nil
}

// scopeCardFromCommSetAckInput returns the comm card id the per-row scope
// pass walks up from (comm → task → project).
func scopeCardFromCommSetAckInput(_ context.Context, _ reg.ValidationPool, raw any) (int64, error) {
	return raw.(CommSetAckInput).CommID, nil
}
