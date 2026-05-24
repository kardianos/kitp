// Package comm exposes Gate 3 CRUD handlers for the comm subsystem
// (docs/email_comm_spec.md): comm_channel.set / .list, comm.create,
// comm.list_for_task, and comm_log.list.
//
// All handlers manipulate rows only — no IMAP/SMTP wiring yet. The
// matching gates (Gate 5 SMTP sender, Gate 6 IMAP poller) ship in
// later commits. comm_channel.set encrypts IMAP + SMTP passwords with
// pgcrypto's sym_encrypt; the encryption key is read from the
// per-connection GUC `app.comm_secret_key`, set in
// store.setCommSecretKey / buildPgxPool from the KITP_COMM_SECRET_KEY
// env var (dev default applied when unset, with a one-shot warning).
//
// Authz: every handler is admin-only. The comm_channel + comm +
// reply_body card_types are admin-only configuration surface per the
// install seed's role_grant rows; the handler-level AllowedRoles +
// authzAdmin guard mirrors that. Managers retain the lighter
// card.update / comment.post grants on comm via the existing
// attribute.update / comment.insert handlers; only authoring the
// comm card itself is gated here.
//
// Tests in comm_test.go exercise every handler shape.
package comm

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// ---- comm_channel.set ----

// ChannelSetInput is the wire payload for comm_channel.set. Each non-zero
// field becomes one attribute_value write inside the same tx; password
// fields are pointers so a nil value can be distinguished from an empty
// string on update (omit => keep existing; empty string => clear). On
// create (ID=0), nil password pointers leave the column NULL.
type ChannelSetInput struct {
	ID             int64   `json:"id,string,omitempty" mcp:"desc=existing comm_channel card id to update; omit / 0 to insert a new channel"`
	ProjectID      int64   `json:"project_id,string" mcp:"required,desc=project card id this channel lives under (parent_card_id)"`
	Name           string  `json:"name" mcp:"required,desc=human-readable channel name (becomes the card's title attribute)"`
	ChannelType    string  `json:"channel_type" mcp:"required,desc=channel type; v1 supports 'email'"`
	IMAPHost       string  `json:"imap_host,omitempty" mcp:"desc=IMAP server hostname"`
	IMAPPort       int     `json:"imap_port,omitempty" mcp:"desc=IMAP server port (default 993)"`
	IMAPUsername   string  `json:"imap_username,omitempty" mcp:"desc=IMAP login username"`
	IMAPPassword   *string `json:"imap_password,omitempty" mcp:"desc=IMAP password; omit to leave unchanged on update; sent to pgcrypto sym_encrypt at rest"`
	SMTPHost       string  `json:"smtp_host,omitempty" mcp:"desc=SMTP server hostname"`
	SMTPPort       int     `json:"smtp_port,omitempty" mcp:"desc=SMTP server port (default 587)"`
	SMTPUsername   string  `json:"smtp_username,omitempty" mcp:"desc=SMTP login username"`
	SMTPPassword   *string `json:"smtp_password,omitempty" mcp:"desc=SMTP password; omit to leave unchanged on update; sent to pgcrypto sym_encrypt at rest"`
	FromAddress    string  `json:"from_address,omitempty" mcp:"desc=outbound From: envelope (e.g. support@example.com)"`
	IntakeStatusID int64   `json:"intake_status_id,string,omitempty" mcp:"desc=status card id assigned to new tasks created from inbound mail (falls back to the project flow's default at intake time)"`
	// Status is the tri-state enable/disable knob. Empty string means
	// "leave the existing value unchanged" — admins editing other
	// fields (host, password rotation, …) should not accidentally
	// clear a disabled-fault flag. Set explicitly to 'enabled' to
	// resume polling after a fault, or to 'disabled-admin' to pause.
	// The runtime owns the 'disabled-fault' transition.
	Status string `json:"channel_status,omitempty" mcp:"desc=tri-state status; one of 'enabled' | 'disabled-admin' | 'disabled-fault'; empty leaves the stored value unchanged"`
}

// ChannelSetOutput surfaces the channel card id so the caller can chain.
type ChannelSetOutput struct {
	ChannelID int64 `json:"channel_id,string" mcp:"desc=id of the created or updated comm_channel card"`
}

// ---- comm_channel.list ----

// ChannelListInput filters channels by project. Required; channels do not
// exist outside a project scope.
type ChannelListInput struct {
	ProjectID int64 `json:"project_id,string" mcp:"required,desc=project card id whose channels to list"`
}

// ChannelRow is one comm_channel card, joined with its comm_secret row to
// surface the Has* flags without exposing the encrypted password bytes.
type ChannelRow struct {
	ID              int64  `json:"id,string" mcp:"desc=comm_channel card id"`
	Name            string `json:"name" mcp:"desc=display name (title attribute)"`
	ChannelType     string `json:"channel_type" mcp:"desc=channel type (email in v1)"`
	IMAPHost        string `json:"imap_host" mcp:"desc=IMAP server hostname"`
	IMAPPort        int    `json:"imap_port" mcp:"desc=IMAP server port"`
	IMAPUsername    string `json:"imap_username" mcp:"desc=IMAP login username"`
	SMTPHost        string `json:"smtp_host" mcp:"desc=SMTP server hostname"`
	SMTPPort        int    `json:"smtp_port" mcp:"desc=SMTP server port"`
	SMTPUsername    string `json:"smtp_username" mcp:"desc=SMTP login username"`
	FromAddress     string `json:"from_address" mcp:"desc=outbound From: envelope"`
	IntakeStatusID  int64  `json:"intake_status_id,string,omitempty" mcp:"desc=intake status card id; 0/omitted = use project flow default"`
	Status          string `json:"channel_status" mcp:"desc=tri-state status: 'enabled' | 'disabled-admin' | 'disabled-fault'"`
	FaultReason     string `json:"channel_fault_reason,omitempty" mcp:"desc=free-form reason set by the runtime when status='disabled-fault'; empty otherwise"`
	HasIMAPPassword bool   `json:"has_imap_password" mcp:"desc=true if a non-null encrypted IMAP password is stored"`
	HasSMTPPassword bool   `json:"has_smtp_password" mcp:"desc=true if a non-null encrypted SMTP password is stored"`
	CreatedAt       string `json:"created_at" mcp:"desc=RFC3339 creation timestamp of the channel card"`
}

// ChannelListOutput wraps the rows in a stable envelope.
type ChannelListOutput struct {
	Rows []ChannelRow `json:"rows" mcp:"desc=comm_channel cards under the project"`
}

// ---- comm.create ----

// CommCreateInput is the wire shape for comm.create.
type CommCreateInput struct {
	TaskID             int64   `json:"task_id,string" mcp:"required,desc=task card id this comm attaches to"`
	ChannelID          int64   `json:"channel_id,string" mcp:"required,desc=comm_channel card id this comm uses"`
	Subject            string  `json:"subject,omitempty" mcp:"desc=display title on the comm card; defaults to the task's title when empty (outbound replies always use {thread_id} + task.title for the email Subject header at send time, regardless of this value)"`
	InitialMessage     string  `json:"initial_message,omitempty" mcp:"desc=optional inbound message text; when set, a reply_body row with delivery_status='received' is created and appended to the comm's replies attribute"`
	RecipientPersonIDs reg.IDs `json:"recipient_person_ids,omitempty" mcp:"desc=initial participants; each id must reference a person card. Stored in the comm_recipients attribute and used as the To: list when an operator authors a reply"`
}

// CommCreateOutput carries the new comm card id and the generated
// thread_id so callers can render the appended-to-task immediately.
type CommCreateOutput struct {
	CommID   int64  `json:"comm_id,string" mcp:"desc=id of the new comm card"`
	ThreadID string `json:"thread_id" mcp:"desc=10-char base62 thread id used for inbound threading"`
}

// ---- comm.list_for_task ----

// CommListForTaskInput identifies the task whose comms we want.
type CommListForTaskInput struct {
	TaskID int64 `json:"task_id,string" mcp:"required,desc=task card id whose comms to list"`
}

// CommRow is one comm card with its replies hydrated.
type CommRow struct {
	ID         int64      `json:"id,string" mcp:"desc=comm card id"`
	Title      string     `json:"title" mcp:"desc=comm title (typically the subject)"`
	ThreadID   string     `json:"thread_id" mcp:"desc=10-char base62 thread id"`
	ChannelID  int64      `json:"channel_id,string" mcp:"desc=comm_channel card id"`
	CommStatus int64      `json:"comm_status,string" mcp:"desc=value-card id of the comm's comm_status attribute"`
	Recipients reg.IDs    `json:"recipients" mcp:"desc=person card ids on the comm_recipients attribute; current thread-level To: list for outbound replies"`
	Replies    []ReplyRow `json:"replies" mcp:"desc=reply_body rows attached via the replies card_ref[] attribute"`
}

// ReplyRow is one reply_body card materialised for the comms screen.
type ReplyRow struct {
	ID             int64  `json:"id,string" mcp:"desc=reply_body card id"`
	To             string `json:"to" mcp:"desc=To: envelope"`
	From           string `json:"from" mcp:"desc=From: envelope"`
	Subject        string `json:"subject" mcp:"desc=subject line"`
	BodyText       string `json:"body_text" mcp:"desc=plain-text body"`
	DeliveryStatus string `json:"delivery_status" mcp:"desc=pending / sent / bounced / failed / received"`
	CreatedAt      string `json:"created_at" mcp:"desc=RFC3339 creation timestamp"`
}

// CommListForTaskOutput wraps the rows in a stable envelope.
type CommListForTaskOutput struct {
	Rows []CommRow `json:"rows" mcp:"desc=comm cards under the task, with their replies"`
}

// ---- reply.post ----

// ReplyPostInput is the wire payload for reply.post. Operators
// (worker / manager / admin) author outbound replies on a comm; the
// SMTP sender goroutine (Gate 5) picks up pending rows on its next
// tick and ships them. The handler itself only writes the reply_body
// card and appends its id to the comm's replies attribute — no
// network I/O happens here.
//
// The To: list and Subject line are derived server-side from the
// comm's recipient and thread_id state, not supplied by the caller:
//   - To: comma-joined emails from comm.comm_recipients (person.email)
//   - Subject: "{thread_id} {task.title}" of the comm's parent task
//
// Editing recipients goes through comm.set_recipients; subject is
// always derived from the thread / task and not separately editable.
type ReplyPostInput struct {
	CommID int64  `json:"comm_id,string" mcp:"required,desc=comm card id to reply on"`
	Body   string `json:"body" mcp:"required,desc=plain-text body"`
	// AttachmentIDs lists existing attachment rows on the comm's
	// parent task to send alongside the reply. SMTP joins through
	// reply_body_attachment on send; IMAP joins on receive to skip
	// duplicate ingestion when the reply round-trips back. Empty list
	// means a body-only reply (the pre-V2 behaviour).
	AttachmentIDs reg.IDs `json:"attachment_ids,omitempty" mcp:"desc=existing attachment ids on the parent task to include"`
}

// ReplyPostOutput carries the new reply_body card id so the caller
// can render the new entry inline without re-listing.
type ReplyPostOutput struct {
	ReplyID int64 `json:"reply_id,string" mcp:"desc=new reply_body card id"`
}

// ---- comm_log.list ----

// CommLogListInput filters the per-project comm_log stream.
type CommLogListInput struct {
	ProjectID int64  `json:"project_id,string" mcp:"required,desc=project card id whose comm_log to read"`
	Kind      string `json:"kind,omitempty" mcp:"desc=optional kind filter (poll / send_ok / send_bounce / send_fail / imap_auth_fail / parse_error / unmatched_thread / attachment_too_large)"`
	Since     string `json:"since,omitempty" mcp:"desc=ISO timestamp; rows older than this are excluded; empty defaults to 24h ago"`
	Limit     int    `json:"limit,omitempty" mcp:"desc=max rows to return; default 200, max 1000"`
}

// CommLogRow is one comm_log row.
type CommLogRow struct {
	ID          int64           `json:"id,string" mcp:"desc=comm_log row id"`
	ChannelID   int64           `json:"channel_id,string,omitempty" mcp:"desc=channel card id; 0 / omitted for pre-identification rows (e.g. IMAP auth failures)"`
	ChannelName string          `json:"channel_name,omitempty" mcp:"desc=channel display name (title attribute on the channel card); empty when channel_id is 0 or the channel has been deleted"`
	Kind        string          `json:"kind" mcp:"desc=event kind"`
	Detail      json.RawMessage `json:"detail,omitempty" mcp:"desc=kind-specific structured detail jsonb"`
	At          string          `json:"at" mcp:"desc=RFC3339 row timestamp"`
}

// CommLogListOutput wraps the rows in a stable envelope.
type CommLogListOutput struct {
	Rows []CommLogRow `json:"rows" mcp:"desc=comm_log rows matching the filter, ordered by at desc"`
}

// ---- Register + authz ----

// authzPool is set by Register so the package-level authzAdmin closure
// can reach the database. Mirrors dom/flow + dom/rolemapping.
var authzPool *store.Pool

// Register installs every comm.* handler. The pool reference lets the
// arrayPath writers note one statement-group per Run for the write
// counter and lets authzAdmin reach a read-only connection before the
// transaction opens.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "comm_channel",
		Action:       "set",
		Doc:          "Admin-only: create or update a comm_channel card (id=0 to insert) plus its paired comm_secret row holding pgcrypto-encrypted IMAP + SMTP passwords. Password fields are optional on update; omitted passwords leave the stored value unchanged.",
		InputType:    reflect.TypeFor[ChannelSetInput](),
		OutputType:   reflect.TypeFor[ChannelSetOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/comm_channel_set_batch.sql. Per Phase 4
		// of docs/UNIFIED_HANDLER_PLAN.md the SQL function owns the
		// full validate + INSERT/UPDATE + comm_secret pgcrypto upsert
		// pipeline. Authz still runs in Go (admin global gate).
		SQLFunc: "comm_channel_set_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm_channel",
		Action:       "list",
		Doc:          "Admin-only: list comm_channel cards configured under a project, joined with their comm_secret row so has_imap_password / has_smtp_password indicate which passwords have been set without exposing the encrypted bytes.",
		InputType:    reflect.TypeFor[ChannelListInput](),
		OutputType:   reflect.TypeFor[ChannelListOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/comm_channel_list_batch.sql.
		SQLFunc: "comm_channel_list_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm",
		Action:       "create",
		Doc:          "Admin-only: create a comm card under a task. Generates a 10-char alphanumeric thread_id, sets channel_ref + comm_status (the project's comm flow default_create_status_id), appends the new comm to the task's comms attribute, and (when initial_message is provided) creates a received-direction reply_body row.",
		InputType:    reflect.TypeFor[CommCreateInput](),
		OutputType:   reflect.TypeFor[CommCreateOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/comm_create_batch.sql. Per Phase 4 of
		// docs/UNIFIED_HANDLER_PLAN.md the SQL function owns the full
		// validate + write pipeline. The Go-side generateThreadID /
		// uniqueThreadID / loadTaskAndChannel / commFlowDefaultStatus /
		// appendCardRefList / insertReceivedReply helpers stay because
		// imap.go materialises new comms from inbound mail inside its
		// own tx (not via the dispatcher).
		SQLFunc: "comm_create_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm",
		Action:       "list_for_task",
		Doc:          "Return every comm card under the task, hydrated with its replies (reply_body cards listed in the comm's replies attribute). Read-side affordance for the task detail screen; any authenticated user may call.",
		InputType:    reflect.TypeFor[CommListForTaskInput](),
		OutputType:   reflect.TypeFor[CommListForTaskOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/comm_list_for_task_batch.sql.
		SQLFunc: "comm_list_for_task_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "reply",
		Action:       "post",
		Doc:          "Author an outbound reply on a comm. Inserts a reply_body card with delivery_status='pending', inherits reply_from from the comm's channel from_address attribute, and appends the new id to the comm's replies attribute. The SMTP sender (Gate 5) picks up pending rows on its next tick. worker / manager / admin may author.",
		InputType:    reflect.TypeFor[ReplyPostInput](),
		OutputType:   reflect.TypeFor[ReplyPostOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromReplyPostInput,
		// The input carries comm_id, not a plain card_id, so the
		// per-row scope pass needs an explicit walk-start (comm → task
		// → project) or a project-scoped manager is denied (BE-H3 / A2).
		ScopeCardID: scopeCardFromReplyPostInput,
		// Unified handler — body lives in
		// db/schema/functions/reply_post_batch.sql. Per Phase 3 of
		// docs/UNIFIED_HANDLER_PLAN.md the SQL function now owns the
		// full validate + write pipeline (lookup comm, resolve
		// recipients / from_address, insert reply_body + 5 attrs,
		// append to comm.replies, optional attachment link).
		SQLFunc: "reply_post_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm_log",
		Action:       "list",
		Doc:          "Admin-only: paginated read of comm_log rows for a project, optionally filtered by kind and a since timestamp (defaults to last 24h).",
		InputType:    reflect.TypeFor[CommLogListInput](),
		OutputType:   reflect.TypeFor[CommLogListOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		// Unified handler — body lives in
		// db/schema/functions/comm_log_list_batch.sql.
		SQLFunc: "comm_log_list_batch",
	})
	registerPersonUpsertByEmail(p)
	registerPersonCreate(p)
	registerCommSetRecipients(p)
}

// cardTypeFromReplyPostInput walks comm → parent task and returns the
// task's card_type so the dispatcher can scope-check against the
// actor's task-level grant. Workers are granted `card.update` on
// task only (not on comm directly — see db/schema/seed.hcsv); gating
// on the parent task lets a project-scoped worker still author
// replies on tasks they own without giving them blanket comm
// access. Returns 0 (skip authz) on a missing comm — the handler's
// validation surfaces the proper not-found error.
func cardTypeFromReplyPostInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	commID := raw.(ReplyPostInput).CommID
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

// scopeCardFromReplyPostInput returns the comm card id the per-row
// scope pass walks up from (comm → task → project). Used as
// reg.Handler.ScopeCardID for reply.post (BE-H3 / A2).
func scopeCardFromReplyPostInput(_ context.Context, _ reg.ValidationPool, raw any) (int64, error) {
	return raw.(ReplyPostInput).CommID, nil
}

// authzAdmin requires the actor to hold the admin or system role
// globally. Mirrors flow.authzAdmin / rolemapping.authzAdmin.
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)
	var n int
	if err := authzPool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name = 'admin' AND ur.scope_card_id IS NULL
	`, userID).Scan(&n); err != nil {
		return fmt.Errorf("comm.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("comm: actor %d is not an admin", userID)
	}
	return nil
}

// ---- thread id generation ----

// base62Alphabet is the encoding alphabet for thread_id. Stable ordering
// matters because the inbound parser splits on `[0-9A-Za-z]` and we
// want the encoder to share it.
const base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// generateThreadID returns a fresh 10-character base62 token derived
// from 8 random bytes pulled out of crypto/rand. 8 bytes = 64 bits of
// entropy; we emit 10 base62 chars (~59.5 bits) by stripping the high
// 5 bits before encoding, which keeps the output uniform across the
// 62-char alphabet (the spec's ~58 bits estimate accounts for this).
//
// Format: [0-9A-Za-z]{10}. Stored case-sensitively. The inbound parser
// (Gate 6) matches this exact regex when scanning header / subject /
// body-trailer locations.
//
// Audit trail: this is THE only randomness source for thread_id. No
// other generator exists. Callers go through CommCreate.Run which
// retries on the (vanishingly rare) collision against the
// attribute_value index.
func generateThreadID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("comm: rand: %w", err)
	}
	// Treat the 8 random bytes as a 64-bit unsigned int; base62-encode
	// the low 60 bits across 10 chars (each char = ~5.95 bits). Reading
	// from buf[0] lets us keep the high-order entropy and discard the
	// low-order bits that would otherwise repeat as we shift by 6 ten
	// times. We use uint64 arithmetic so the divmod chain is constant
	// time and free of branch surprises.
	v := uint64(buf[0])<<56 | uint64(buf[1])<<48 | uint64(buf[2])<<40 |
		uint64(buf[3])<<32 | uint64(buf[4])<<24 | uint64(buf[5])<<16 |
		uint64(buf[6])<<8 | uint64(buf[7])
	var out [10]byte
	for i := 9; i >= 0; i-- {
		out[i] = base62Alphabet[v%62]
		v /= 62
	}
	return string(out[:]), nil
}

// ---- helpers ----

// resolveCardType returns the card_type id for a card_type name, or an
// error if the row is missing — Gate 1 should have seeded every name we
// reference, so a miss here is a fatal misconfiguration.
func resolveCardType(snap *schema.Snapshot, name string) (int64, error) {
	ct, ok := snap.CardTypeByName[name]
	if !ok {
		return 0, fmt.Errorf("comm: card_type %q not found in snapshot", name)
	}
	return ct.ID, nil
}

// resolveAttr returns the attribute_def id for an attribute name or
// errors similarly.
func resolveAttr(snap *schema.Snapshot, name string) (int64, error) {
	a, ok := snap.AttrByName[name]
	if !ok {
		return 0, fmt.Errorf("comm: attribute_def %q not found in snapshot", name)
	}
	return a.ID, nil
}

// writeCardCreateActivity inserts a card_create activity row. Mirrors
// the in-tx helper in dom/projectstamp.
func writeCardCreateActivity(ctx context.Context, tx pgx.Tx, cardID, actorID int64) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', $2)
	`, cardID, actorID)
	return err
}

// writeAttributeValue emits one attr_update activity + one
// attribute_value upsert, linked through last_activity_id. Same shape
// as projectstamp.writeAttributeValue — duplicated here so the comm
// package doesn't depend on projectstamp.
func writeAttributeValue(
	ctx context.Context,
	tx pgx.Tx,
	cardID, attributeDefID int64,
	value json.RawMessage,
	actorID int64,
) error {
	var activityID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
		VALUES ($1, 'attr_update', $2, NULL, $3::jsonb, $4)
		RETURNING id
	`, cardID, attributeDefID, value, actorID).Scan(&activityID); err != nil {
		return fmt.Errorf("comm: write activity: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
		VALUES ($1, $2, $3::jsonb, $4)
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE
			SET value = EXCLUDED.value,
			    last_activity_id = EXCLUDED.last_activity_id
	`, cardID, attributeDefID, value, activityID); err != nil {
		return fmt.Errorf("comm: upsert attribute_value: %w", err)
	}
	return nil
}

// readAttributeValueRaw fetches the current jsonb value of (cardID,
// attrName) or returns ("null", false) when no row exists.
func readAttributeValueRaw(ctx context.Context, tx pgx.Tx, cardID int64, attrName string) (json.RawMessage, bool, error) {
	var raw []byte
	err := tx.QueryRow(ctx, `
		SELECT av.value
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1 AND ad.name = $2
	`, cardID, attrName).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return json.RawMessage(`null`), false, nil
		}
		return nil, false, err
	}
	return json.RawMessage(raw), true, nil
}

// comm_channel.set is migrated to
// db/schema/functions/comm_channel_set_batch.sql per Phase 4 of
// docs/UNIFIED_HANDLER_PLAN.md. The Go-side runChannelSet /
// validateChannelSet / channelFieldWrites / upsertCommSecret bodies
// are gone; the SQL function owns the full validate + write +
// pgcrypto secret upsert pipeline.

// comm_channel.list is migrated to
// db/schema/functions/comm_channel_list_batch.sql per Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. The Go-side runChannelList is gone.

// comm.create is migrated to db/schema/functions/comm_create_batch.sql
// per Phase 4 of docs/UNIFIED_HANDLER_PLAN.md. The Go-side runCommCreate
// is gone; the SQL function owns the full validate + write pipeline.
// The helpers below (commFlowDefaultStatus, uniqueThreadID,
// appendCardRefList) stay because imap.go materialises new comms from
// inbound mail inside its own tx (not via the dispatcher).

// commFlowDefaultStatus reads the default_create_status_id of the comm
// flow (the flow on attribute_def comm_status) scoped to projectID.
// Returns 0 if no flow / default is set.
func commFlowDefaultStatus(ctx context.Context, tx pgx.Tx, projectID, commStatusAttrID int64) (int64, error) {
	var defaultID int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(default_create_status_id, 0)
		FROM flow
		WHERE scope_card_id = $1 AND attribute_def_id = $2
		LIMIT 1
	`, projectID, commStatusAttrID).Scan(&defaultID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return defaultID, nil
}

// uniqueThreadID generates a thread_id and confirms no comm card
// already carries it. Retries up to 5 times before giving up.
func uniqueThreadID(ctx context.Context, tx pgx.Tx) (string, error) {
	for attempt := 0; attempt < 5; attempt++ {
		candidate, err := generateThreadID()
		if err != nil {
			return "", err
		}
		var n int
		err = tx.QueryRow(ctx, `
			SELECT count(*)
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE ad.name = 'thread_id' AND av.value = to_jsonb($1::text)
		`, candidate).Scan(&n)
		if err != nil {
			return "", fmt.Errorf("comm.create: thread uniqueness: %w", err)
		}
		if n == 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("comm.create: failed to generate unique thread_id after 5 attempts")
}

// appendCardRefList reads the current value of a card_ref[] attribute
// on cardID, appends appendID to it, and writes it back via the same
// activity + attribute_value path.
func appendCardRefList(ctx context.Context, tx pgx.Tx, cardID int64, attrName string, appendID int64, snap *schema.Snapshot, actorID int64) error {
	ad, ok := snap.AttrByName[attrName]
	if !ok {
		return fmt.Errorf("comm: append: attribute_def %q missing", attrName)
	}
	cur, _, err := readAttributeValueRaw(ctx, tx, cardID, attrName)
	if err != nil {
		return err
	}
	var ids []int64
	if len(cur) > 0 {
		// Tolerate string + numeric forms in storage, then canonicalise
		// to numbers on write.
		var arr []json.RawMessage
		if err := json.Unmarshal(cur, &arr); err == nil {
			for _, el := range arr {
				var n int64
				if err := json.Unmarshal(el, &n); err == nil {
					ids = append(ids, n)
					continue
				}
				var s string
				if err := json.Unmarshal(el, &s); err == nil {
					var sid int64
					if _, e := fmt.Sscanf(s, "%d", &sid); e == nil {
						ids = append(ids, sid)
					}
				}
			}
		}
	}
	ids = append(ids, appendID)
	newVal, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	return writeAttributeValue(ctx, tx, cardID, ad.ID, newVal, actorID)
}

// comm.list_for_task is migrated to
// db/schema/functions/comm_list_for_task_batch.sql per Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. The SQL function inlines the
// loadRepliesByID hydration in a single jsonb aggregate. The
// decodeCardRefArray helper stays — recipients.go still calls it on
// the inbound IMAP path (outside the dispatcher).

// decodeCardRefArray pulls bigints out of a stored card_ref[] jsonb
// value, tolerating both string and numeric forms (the canonicaliser
// writes numbers, but historical seed rows could be either).
func decodeCardRefArray(raw []byte) []int64 {
	if len(raw) == 0 {
		return nil
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil
	}
	var out []int64
	for _, el := range arr {
		var n int64
		if err := json.Unmarshal(el, &n); err == nil {
			out = append(out, n)
			continue
		}
		var s string
		if err := json.Unmarshal(el, &s); err == nil {
			var sid int64
			if _, e := fmt.Sscanf(s, "%d", &sid); e == nil {
				out = append(out, sid)
			}
		}
	}
	return out
}

// reply.post is migrated to db/schema/functions/reply_post_batch.sql
// per Phase 3 of docs/UNIFIED_HANDLER_PLAN.md. The Go-side runReplyPost
// is gone; the SQL function owns lookup + validation + writes.

// comm_log.list is migrated to
// db/schema/functions/comm_log_list_batch.sql per Phase 5 of
// docs/UNIFIED_HANDLER_PLAN.md. The Go-side runCommLogList is gone.
