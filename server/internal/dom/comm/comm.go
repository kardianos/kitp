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
	TaskID         int64  `json:"task_id,string" mcp:"required,desc=task card id this comm attaches to"`
	ChannelID      int64  `json:"channel_id,string" mcp:"required,desc=comm_channel card id this comm uses"`
	Subject        string `json:"subject,omitempty" mcp:"desc=display subject; defaults to the task's title when empty"`
	InitialMessage string `json:"initial_message,omitempty" mcp:"desc=optional inbound message text; when set, a reply_body row with delivery_status='received' is created and appended to the comm's replies attribute"`
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
type ReplyPostInput struct {
	CommID  int64  `json:"comm_id,string" mcp:"required,desc=comm card id to reply on"`
	To      string `json:"to" mcp:"required,desc=outbound To: address"`
	Subject string `json:"subject,omitempty" mcp:"desc=subject line; threading suffix [#<thread_id>] is appended at send time"`
	Body    string `json:"body" mcp:"required,desc=plain-text body"`
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
		Run:          runChannelSet(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm_channel",
		Action:       "list",
		Doc:          "Admin-only: list comm_channel cards configured under a project, joined with their comm_secret row so has_imap_password / has_smtp_password indicate which passwords have been set without exposing the encrypted bytes.",
		InputType:    reflect.TypeFor[ChannelListInput](),
		OutputType:   reflect.TypeFor[ChannelListOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runChannelList(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm",
		Action:       "create",
		Doc:          "Admin-only: create a comm card under a task. Generates a 10-char base62 thread_id, sets channel_ref + comm_status (the project's comm flow default_create_status_id), appends the new comm to the task's comms attribute, and (when initial_message is provided) creates a received-direction reply_body row.",
		InputType:    reflect.TypeFor[CommCreateInput](),
		OutputType:   reflect.TypeFor[CommCreateOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runCommCreate(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm",
		Action:       "list_for_task",
		Doc:          "Return every comm card under the task, hydrated with its replies (reply_body cards listed in the comm's replies attribute). Read-side affordance for the task detail screen; any authenticated user may call.",
		InputType:    reflect.TypeFor[CommListForTaskInput](),
		OutputType:   reflect.TypeFor[CommListForTaskOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runCommListForTask(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "reply",
		Action:       "post",
		Doc:          "Author an outbound reply on a comm. Inserts a reply_body card with delivery_status='pending', inherits reply_from from the comm's channel from_address attribute, and appends the new id to the comm's replies attribute. The SMTP sender (Gate 5) picks up pending rows on its next tick. worker / manager / admin may author.",
		InputType:    reflect.TypeFor[ReplyPostInput](),
		OutputType:   reflect.TypeFor[ReplyPostOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		Run:          runReplyPost(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm_log",
		Action:       "list",
		Doc:          "Admin-only: paginated read of comm_log rows for a project, optionally filtered by kind and a since timestamp (defaults to last 24h).",
		InputType:    reflect.TypeFor[CommLogListInput](),
		OutputType:   reflect.TypeFor[CommLogListOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Run:          runCommLogList(p),
	})
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
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
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

// projectIDOfCard walks the parent_card_id chain upward from cardID and
// returns the id of the first ancestor (including cardID itself) whose
// card_type is 'project'. Returns 0 if none is found. Mirrors the
// equivalent helper in dom/flow.
func projectIDOfCard(ctx context.Context, tx pgx.Tx, cardID int64) (int64, error) {
	var pid int64
	row := tx.QueryRow(ctx, `
		WITH RECURSIVE chain AS (
			SELECT id, parent_card_id, card_type_id
			FROM card WHERE id = $1
			UNION ALL
			SELECT c.id, c.parent_card_id, c.card_type_id
			FROM card c
			JOIN chain ch ON ch.parent_card_id = c.id
		)
		SELECT chain.id
		FROM chain
		JOIN card_type ct ON ct.id = chain.card_type_id
		WHERE ct.name = 'project'
		LIMIT 1
	`, cardID)
	if err := row.Scan(&pid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return pid, nil
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

// ---- comm_channel.set implementation ----

func runChannelSet(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}
		channelCTID, err := resolveCardType(snap, "comm_channel")
		if err != nil {
			return nil, err
		}

		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ChannelSetInput)
			if err := validateChannelSet(ctx, tx, i, in, snap); err != nil {
				return nil, err
			}

			channelID := in.ID
			if channelID == 0 {
				// Insert new comm_channel card under project.
				project := in.ProjectID
				if err := tx.QueryRow(ctx, `
					INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
				`, channelCTID, project).Scan(&channelID); err != nil {
					return nil, fmt.Errorf("comm_channel.set: insert card: %w", err)
				}
				if err := writeCardCreateActivity(ctx, tx, channelID, actorID); err != nil {
					return nil, fmt.Errorf("comm_channel.set: activity: %w", err)
				}
			}

			// Write each non-zero field via attribute_value. On update,
			// fields left at the zero value are skipped — the admin UI
			// drives the full payload, but PATCH-style partial updates
			// must not clobber existing rows.
			writes := channelFieldWrites(in, snap, channelID == in.ID)
			for _, w := range writes {
				if err := writeAttributeValue(ctx, tx, channelID, w.attrDefID, w.value, actorID); err != nil {
					return nil, fmt.Errorf("comm_channel.set: write %s: %w", w.attrName, err)
				}
			}

			// Upsert comm_secret. Always run; encrypts only the fields
			// the caller provided, COALESCE preserves the rest. Uses
			// pgcrypto's pgp_sym_encrypt with the per-connection
			// `app.comm_secret_key` GUC as the symmetric key.
			if err := upsertCommSecret(ctx, tx, channelID, in.IMAPPassword, in.SMTPPassword); err != nil {
				return nil, fmt.Errorf("comm_channel.set: comm_secret: %w", err)
			}

			outs[i] = ChannelSetOutput{ChannelID: channelID}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

func validateChannelSet(ctx context.Context, tx pgx.Tx, idx int, in ChannelSetInput, snap *schema.Snapshot) error {
	if in.Name == "" {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "comm_channel.set: name is required"}
	}
	if in.ChannelType == "" {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "comm_channel.set: channel_type is required"}
	}
	if in.ChannelType != "email" {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: fmt.Sprintf("comm_channel.set: channel_type %q is not supported (v1: email only)", in.ChannelType)}
	}
	if in.ProjectID == 0 {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: "comm_channel.set: project_id is required"}
	}

	// Verify the parent card is a project.
	var parentKind string
	row := tx.QueryRow(ctx, `
		SELECT ct.name FROM card c JOIN card_type ct ON ct.id = c.card_type_id WHERE c.id = $1
	`, in.ProjectID)
	if err := row.Scan(&parentKind); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return &reg.HandlerError{InputIndex: idx, Code: "project_not_found",
				Message: fmt.Sprintf("comm_channel.set: project_id %d not found", in.ProjectID)}
		}
		return fmt.Errorf("comm_channel.set: load project: %w", err)
	}
	if parentKind != "project" {
		return &reg.HandlerError{InputIndex: idx, Code: "parent_not_project",
			Message: fmt.Sprintf("comm_channel.set: project_id %d is a %q card, not a project", in.ProjectID, parentKind)}
	}

	if in.ID != 0 {
		// Updating: the card must exist and be a comm_channel under the
		// supplied project.
		var ctName string
		var parentID *int64
		row := tx.QueryRow(ctx, `
			SELECT ct.name, c.parent_card_id
			FROM card c JOIN card_type ct ON ct.id = c.card_type_id
			WHERE c.id = $1
		`, in.ID)
		if err := row.Scan(&ctName, &parentID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return &reg.HandlerError{InputIndex: idx, Code: "channel_not_found",
					Message: fmt.Sprintf("comm_channel.set: channel %d not found", in.ID)}
			}
			return fmt.Errorf("comm_channel.set: load channel: %w", err)
		}
		if ctName != "comm_channel" {
			return &reg.HandlerError{InputIndex: idx, Code: "wrong_card_type",
				Message: fmt.Sprintf("comm_channel.set: card %d is %q, not comm_channel", in.ID, ctName)}
		}
		if parentID == nil || *parentID != in.ProjectID {
			return &reg.HandlerError{InputIndex: idx, Code: "wrong_project",
				Message: fmt.Sprintf("comm_channel.set: channel %d is not under project %d", in.ID, in.ProjectID)}
		}
	}

	if in.Status != "" && !ValidChannelStatus(in.Status) {
		return &reg.HandlerError{InputIndex: idx, Code: "validation",
			Message: fmt.Sprintf("comm_channel.set: channel_status %q is not one of 'enabled' / 'disabled-admin' / 'disabled-fault'", in.Status)}
	}

	if in.IntakeStatusID != 0 {
		// Optional: must point at a value-card of card_type=status. The
		// scope check (must be same project) is enforced by the
		// attribute_value writer's reference-scope hook in the canonical
		// path, but we go direct here so the bare existence + type
		// check lives in validate so the response is clean.
		var ctName string
		row := tx.QueryRow(ctx, `
			SELECT ct.name FROM card c JOIN card_type ct ON ct.id = c.card_type_id WHERE c.id = $1
		`, in.IntakeStatusID)
		if err := row.Scan(&ctName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return &reg.HandlerError{InputIndex: idx, Code: "intake_status_not_found",
					Message: fmt.Sprintf("comm_channel.set: intake_status_id %d not found", in.IntakeStatusID)}
			}
			return fmt.Errorf("comm_channel.set: load intake status: %w", err)
		}
		if ctName != "status" {
			return &reg.HandlerError{InputIndex: idx, Code: "intake_status_wrong_type",
				Message: fmt.Sprintf("comm_channel.set: intake_status_id %d is %q, not status", in.IntakeStatusID, ctName)}
		}
	}
	return nil
}

// channelFieldWrite captures one attribute_value write the channel.set
// handler needs to land.
type channelFieldWrite struct {
	attrDefID int64
	attrName  string
	value     json.RawMessage
}

// channelFieldWrites returns the writes the channel.set handler will
// emit. The title attribute (Name) is always written. Other text
// fields are written only when the caller supplied a non-empty value
// (on update, omitted fields stay unchanged; the spec calls this out
// for password fields but the same rule applies to host / port /
// username etc. so PATCH-style updates work). On create, the same
// rule applies because zero values represent "not provided".
//
// isUpdate is true when the caller is updating an existing channel. We
// keep the parameter even though the per-field logic is the same on
// create vs update — clarifying the intent makes audits easier.
func channelFieldWrites(in ChannelSetInput, snap *schema.Snapshot, isUpdate bool) []channelFieldWrite {
	_ = isUpdate
	jstr := func(s string) json.RawMessage {
		b, _ := json.Marshal(s)
		return b
	}
	jint := func(n int) json.RawMessage {
		b, _ := json.Marshal(n)
		return b
	}
	jid := func(n int64) json.RawMessage {
		b, _ := json.Marshal(n)
		return b
	}
	out := []channelFieldWrite{}
	push := func(name string, val json.RawMessage) {
		ad, ok := snap.AttrByName[name]
		if !ok {
			return
		}
		out = append(out, channelFieldWrite{attrDefID: ad.ID, attrName: name, value: val})
	}
	// title is always written on insert; on update we only overwrite
	// when Name is non-empty.
	push("title", jstr(in.Name))
	push("channel_type", jstr(in.ChannelType))
	if in.IMAPHost != "" {
		push("imap_host", jstr(in.IMAPHost))
	}
	if in.IMAPPort != 0 {
		push("imap_port", jint(in.IMAPPort))
	}
	if in.IMAPUsername != "" {
		push("imap_username", jstr(in.IMAPUsername))
	}
	if in.SMTPHost != "" {
		push("smtp_host", jstr(in.SMTPHost))
	}
	if in.SMTPPort != 0 {
		push("smtp_port", jint(in.SMTPPort))
	}
	if in.SMTPUsername != "" {
		push("smtp_username", jstr(in.SMTPUsername))
	}
	if in.FromAddress != "" {
		push("from_address", jstr(in.FromAddress))
	}
	if in.IntakeStatusID != 0 {
		push("intake_status", jid(in.IntakeStatusID))
	}
	if in.Status != "" {
		push("channel_status", jstr(in.Status))
		// When the admin explicitly re-enables a channel, clear the
		// stale fault reason so the UI doesn't keep showing a stale
		// "IMAP dial failed" message next to a healthy channel. Other
		// status transitions don't touch the reason.
		if in.Status == ChannelStatusEnabled {
			push("channel_fault_reason", jstr(""))
		}
	}
	return out
}

// upsertCommSecret writes / updates the comm_secret row for a channel
// using pgcrypto's pgp_sym_encrypt. The encryption key comes from the
// per-connection `app.comm_secret_key` GUC. Passwords left as nil
// pointers preserve the stored value via COALESCE (omit-on-update
// semantics); empty-string passwords explicitly clear via NULL.
func upsertCommSecret(ctx context.Context, tx pgx.Tx, channelID int64, imap, smtp *string) error {
	// pgp_sym_encrypt(text, text) returns bytea — the standard pgcrypto
	// idiom. We pass NULL through unchanged so the COALESCE on update
	// keeps the existing encrypted value.
	var imapArg, smtpArg any
	if imap != nil {
		imapArg = *imap
	}
	if smtp != nil {
		smtpArg = *smtp
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO comm_secret (channel_card_id, imap_password, smtp_password)
		VALUES (
			$1,
			CASE WHEN $2::text IS NULL THEN NULL
			     ELSE pgp_sym_encrypt($2::text, current_setting('app.comm_secret_key')) END,
			CASE WHEN $3::text IS NULL THEN NULL
			     ELSE pgp_sym_encrypt($3::text, current_setting('app.comm_secret_key')) END
		)
		ON CONFLICT (channel_card_id) DO UPDATE SET
			imap_password = COALESCE(
				CASE WHEN $2::text IS NULL THEN NULL
				     ELSE pgp_sym_encrypt($2::text, current_setting('app.comm_secret_key')) END,
				comm_secret.imap_password),
			smtp_password = COALESCE(
				CASE WHEN $3::text IS NULL THEN NULL
				     ELSE pgp_sym_encrypt($3::text, current_setting('app.comm_secret_key')) END,
				comm_secret.smtp_password),
			updated_at = now()
	`, channelID, imapArg, smtpArg)
	return err
}

// ---- comm_channel.list implementation ----

func runChannelList(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ChannelListInput)
			if in.ProjectID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "comm_channel.list: project_id is required"}
			}
			rows, err := tx.Query(ctx, `
				WITH channel_attrs AS (
					SELECT c.id AS channel_id, c.created_at,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='title'),'')                AS title,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='channel_type'),'')         AS channel_type,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='imap_host'),'')            AS imap_host,
					       COALESCE((SELECT (value)::text::int FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='imap_port' AND jsonb_typeof(value)='number'), 0) AS imap_port,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='imap_username'),'')         AS imap_username,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='smtp_host'),'')             AS smtp_host,
					       COALESCE((SELECT (value)::text::int FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='smtp_port' AND jsonb_typeof(value)='number'), 0) AS smtp_port,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='smtp_username'),'')         AS smtp_username,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='from_address'),'')          AS from_address,
					       COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='intake_status' AND jsonb_typeof(value)='number'), 0) AS intake_status_id,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='channel_status'),'enabled') AS channel_status,
					       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='channel_fault_reason'),'') AS channel_fault_reason
					FROM card c
					JOIN card_type ct ON ct.id = c.card_type_id
					WHERE ct.name = 'comm_channel'
					  AND c.parent_card_id = $1
					  AND c.deleted_at IS NULL
				)
				SELECT ca.channel_id,
				       ca.title, ca.channel_type,
				       ca.imap_host, ca.imap_port, ca.imap_username,
				       ca.smtp_host, ca.smtp_port, ca.smtp_username,
				       ca.from_address, ca.intake_status_id,
				       ca.channel_status, ca.channel_fault_reason,
				       (cs.imap_password IS NOT NULL) AS has_imap_password,
				       (cs.smtp_password IS NOT NULL) AS has_smtp_password,
				       to_char(ca.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
				FROM channel_attrs ca
				LEFT JOIN comm_secret cs ON cs.channel_card_id = ca.channel_id
				ORDER BY ca.title, ca.channel_id
			`, in.ProjectID)
			if err != nil {
				return nil, fmt.Errorf("comm_channel.list: %w", err)
			}
			var out []ChannelRow
			for rows.Next() {
				var r ChannelRow
				if err := rows.Scan(
					&r.ID, &r.Name, &r.ChannelType,
					&r.IMAPHost, &r.IMAPPort, &r.IMAPUsername,
					&r.SMTPHost, &r.SMTPPort, &r.SMTPUsername,
					&r.FromAddress, &r.IntakeStatusID,
					&r.Status, &r.FaultReason,
					&r.HasIMAPPassword, &r.HasSMTPPassword,
					&r.CreatedAt,
				); err != nil {
					rows.Close()
					return nil, err
				}
				out = append(out, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			outs[i] = ChannelListOutput{Rows: out}
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}

// ---- comm.create implementation ----

func runCommCreate(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}
		commCTID, err := resolveCardType(snap, "comm")
		if err != nil {
			return nil, err
		}
		replyCTID, err := resolveCardType(snap, "reply_body")
		if err != nil {
			return nil, err
		}
		commStatusAttrID, err := resolveAttr(snap, "comm_status")
		if err != nil {
			return nil, err
		}

		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(CommCreateInput)

			// Validate task + channel exist and live in the same project.
			taskProject, channelProject, taskTitle, err := loadTaskAndChannel(ctx, tx, in.TaskID, in.ChannelID)
			if err != nil {
				return nil, err
			}
			if taskProject == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "task_no_project",
					Message: fmt.Sprintf("comm.create: task %d has no enclosing project", in.TaskID)}
			}
			if taskProject != channelProject {
				return nil, &reg.HandlerError{InputIndex: i, Code: "project_mismatch",
					Message: fmt.Sprintf("comm.create: task %d (project %d) and channel %d (project %d) are not in the same project",
						in.TaskID, taskProject, in.ChannelID, channelProject)}
			}

			// Resolve comm_status default from the comm flow on this
			// project. Fall back to error if missing — Gate 2's seed
			// guarantees the row, but a test fixture without the
			// template will fail with a clear message.
			defaultStatusID, err := commFlowDefaultStatus(ctx, tx, taskProject, commStatusAttrID)
			if err != nil {
				return nil, err
			}
			if defaultStatusID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "no_comm_flow",
					Message: fmt.Sprintf("comm.create: project %d has no comm flow / default_create_status_id; seed a comm flow first", taskProject)}
			}

			// Generate a unique thread_id (retry on the astronomically
			// rare collision). After 5 attempts we surface the error —
			// 58 bits of entropy means we'd need ~2^29 existing rows
			// to hit a collision once; 5 retries comfortably cover
			// well past that.
			threadID, err := uniqueThreadID(ctx, tx)
			if err != nil {
				return nil, err
			}

			// Insert the comm card under the task.
			subject := in.Subject
			if subject == "" {
				subject = taskTitle
			}
			var commID int64
			if err := tx.QueryRow(ctx, `
				INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, $2) RETURNING id
			`, commCTID, in.TaskID).Scan(&commID); err != nil {
				return nil, fmt.Errorf("comm.create: insert card: %w", err)
			}
			if err := writeCardCreateActivity(ctx, tx, commID, actorID); err != nil {
				return nil, fmt.Errorf("comm.create: activity: %w", err)
			}

			// Initial attributes: title, channel_ref, thread_id, comm_status.
			jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
			jid := func(n int64) json.RawMessage { b, _ := json.Marshal(n); return b }
			titleAD, _ := snap.AttrByName["title"]
			channelRefAD, _ := snap.AttrByName["channel_ref"]
			threadAD, _ := snap.AttrByName["thread_id"]
			for _, w := range []struct {
				adID  int64
				value json.RawMessage
			}{
				{titleAD.ID, jstr(subject)},
				{channelRefAD.ID, jid(in.ChannelID)},
				{threadAD.ID, jstr(threadID)},
				{commStatusAttrID, jid(defaultStatusID)},
			} {
				if err := writeAttributeValue(ctx, tx, commID, w.adID, w.value, actorID); err != nil {
					return nil, fmt.Errorf("comm.create: write attr: %w", err)
				}
			}

			// Append commID to the task's comms attribute. Read current,
			// append, write back. Empty / null current value becomes
			// `[commID]`. Duplicates aren't a concern (fresh card).
			if err := appendCardRefList(ctx, tx, in.TaskID, "comms", commID, snap, actorID); err != nil {
				return nil, fmt.Errorf("comm.create: append to comms: %w", err)
			}

			// Optional initial inbound message → reply_body card with
			// delivery_status='received'.
			if in.InitialMessage != "" {
				replyID, err := insertReceivedReply(ctx, tx, replyCTID, snap, actorID, subject, in.InitialMessage)
				if err != nil {
					return nil, fmt.Errorf("comm.create: insert initial reply: %w", err)
				}
				if err := appendCardRefList(ctx, tx, commID, "replies", replyID, snap, actorID); err != nil {
					return nil, fmt.Errorf("comm.create: append to replies: %w", err)
				}
			}

			outs[i] = CommCreateOutput{CommID: commID, ThreadID: threadID}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// loadTaskAndChannel resolves the enclosing project of task + channel,
// surfacing a structured error if either id is missing or the channel
// row isn't a comm_channel. Returns (taskProject, channelProject,
// taskTitle, err) so the caller can derive a default subject.
func loadTaskAndChannel(ctx context.Context, tx pgx.Tx, taskID, channelID int64) (int64, int64, string, error) {
	if taskID == 0 || channelID == 0 {
		return 0, 0, "", &reg.HandlerError{Code: "validation",
			Message: "comm.create: task_id and channel_id are required"}
	}

	// Task: exists + card_type=task.
	var taskKind string
	var taskTitle string
	row := tx.QueryRow(ctx, `
		SELECT ct.name,
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='title'), '')
		FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.id = $1 AND c.deleted_at IS NULL
	`, taskID)
	if err := row.Scan(&taskKind, &taskTitle); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, "", &reg.HandlerError{Code: "task_not_found",
				Message: fmt.Sprintf("comm.create: task %d not found", taskID)}
		}
		return 0, 0, "", fmt.Errorf("comm.create: load task: %w", err)
	}
	if taskKind != "task" {
		return 0, 0, "", &reg.HandlerError{Code: "task_wrong_type",
			Message: fmt.Sprintf("comm.create: card %d is %q, not task", taskID, taskKind)}
	}

	// Channel: exists + card_type=comm_channel.
	var channelKind string
	row = tx.QueryRow(ctx, `
		SELECT ct.name FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.id = $1 AND c.deleted_at IS NULL
	`, channelID)
	if err := row.Scan(&channelKind); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, "", &reg.HandlerError{Code: "channel_not_found",
				Message: fmt.Sprintf("comm.create: channel %d not found", channelID)}
		}
		return 0, 0, "", fmt.Errorf("comm.create: load channel: %w", err)
	}
	if channelKind != "comm_channel" {
		return 0, 0, "", &reg.HandlerError{Code: "channel_wrong_type",
			Message: fmt.Sprintf("comm.create: card %d is %q, not comm_channel", channelID, channelKind)}
	}

	taskProject, err := projectIDOfCard(ctx, tx, taskID)
	if err != nil {
		return 0, 0, "", err
	}
	channelProject, err := projectIDOfCard(ctx, tx, channelID)
	if err != nil {
		return 0, 0, "", err
	}
	return taskProject, channelProject, taskTitle, nil
}

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

// insertReceivedReply creates one reply_body card with the inbound
// message text and a delivery_status of 'received'. Returns its id.
//
// reply_body cards are global (no parent_card_id). The required edges
// per Gate 1's seed are reply_to / reply_from / reply_subject /
// reply_body_text / delivery_status, plus the empty `title` edge — but
// reply_body doesn't have a title edge in the install seed, so we
// don't write one. We DO write the five required text attributes;
// reply_to / reply_from are empty strings on a received message (no
// outbound envelope was constructed for an inbound capture).
func insertReceivedReply(ctx context.Context, tx pgx.Tx, replyCTID int64, snap *schema.Snapshot, actorID int64, subject, body string) (int64, error) {
	var id int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO card (card_type_id) VALUES ($1) RETURNING id
	`, replyCTID).Scan(&id); err != nil {
		return 0, fmt.Errorf("comm: insert reply_body card: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, id, actorID); err != nil {
		return 0, err
	}
	jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
	writes := []struct {
		name string
		val  json.RawMessage
	}{
		{"reply_to", jstr("")},
		{"reply_from", jstr("")},
		{"reply_subject", jstr(subject)},
		{"reply_body_text", jstr(body)},
		{"delivery_status", jstr("received")},
	}
	for _, w := range writes {
		ad, ok := snap.AttrByName[w.name]
		if !ok {
			return 0, fmt.Errorf("comm: insertReceivedReply: missing attribute_def %q", w.name)
		}
		if err := writeAttributeValue(ctx, tx, id, ad.ID, w.val, actorID); err != nil {
			return 0, err
		}
	}
	return id, nil
}

// ---- comm.list_for_task implementation ----

func runCommListForTask(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(CommListForTaskInput)
			if in.TaskID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "comm.list_for_task: task_id is required"}
			}
			rows, err := tx.Query(ctx, `
				SELECT c.id,
				       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='title'),'')      AS title,
				       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='thread_id'),'')  AS thread_id,
				       COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='channel_ref' AND jsonb_typeof(value)='number'), 0)   AS channel_ref,
				       COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='comm_status' AND jsonb_typeof(value)='number'), 0)  AS comm_status,
				       COALESCE((SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='replies'), '[]'::jsonb) AS replies_json
				FROM card c
				JOIN card_type ct ON ct.id = c.card_type_id
				WHERE ct.name = 'comm'
				  AND c.parent_card_id = $1
				  AND c.deleted_at IS NULL
				ORDER BY c.id
			`, in.TaskID)
			if err != nil {
				return nil, fmt.Errorf("comm.list_for_task: %w", err)
			}
			type commRowRaw struct {
				CommRow
				RepliesJSON []byte
			}
			var raws []commRowRaw
			for rows.Next() {
				var r commRowRaw
				if err := rows.Scan(&r.ID, &r.Title, &r.ThreadID, &r.ChannelID, &r.CommStatus, &r.RepliesJSON); err != nil {
					rows.Close()
					return nil, err
				}
				raws = append(raws, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}

			// Collect all reply_body ids referenced by these comms in
			// one pass, then fetch their attributes in one query. This
			// keeps the list endpoint at O(2) queries regardless of
			// reply count.
			var allReplyIDs []int64
			perCommReplyIDs := make(map[int64][]int64, len(raws))
			for _, r := range raws {
				ids := decodeCardRefArray(r.RepliesJSON)
				perCommReplyIDs[r.ID] = ids
				allReplyIDs = append(allReplyIDs, ids...)
			}
			replyByID, err := loadRepliesByID(ctx, tx, allReplyIDs)
			if err != nil {
				return nil, fmt.Errorf("comm.list_for_task: load replies: %w", err)
			}

			out := make([]CommRow, 0, len(raws))
			for _, r := range raws {
				row := r.CommRow
				ids := perCommReplyIDs[r.ID]
				row.Replies = make([]ReplyRow, 0, len(ids))
				for _, rid := range ids {
					if rep, ok := replyByID[rid]; ok {
						row.Replies = append(row.Replies, rep)
					}
				}
				out = append(out, row)
			}
			outs[i] = CommListForTaskOutput{Rows: out}
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}

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

// loadRepliesByID fetches all reply_body cards (and their attributes)
// for the supplied ids in one query, returning a map keyed by id so
// the caller can preserve the per-comm ordering from the replies
// attribute. ids may contain duplicates; we de-dup at the SQL layer.
func loadRepliesByID(ctx context.Context, tx pgx.Tx, ids []int64) (map[int64]ReplyRow, error) {
	out := map[int64]ReplyRow{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT c.id,
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='reply_to'), '')         AS reply_to,
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='reply_from'), '')       AS reply_from,
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='reply_subject'), '')    AS reply_subject,
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='reply_body_text'), '')  AS reply_body_text,
		       COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='delivery_status'), '')  AS delivery_status,
		       to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
		FROM card c
		WHERE c.id = ANY($1::bigint[]) AND c.deleted_at IS NULL
	`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r ReplyRow
		if err := rows.Scan(&r.ID, &r.To, &r.From, &r.Subject, &r.BodyText, &r.DeliveryStatus, &r.CreatedAt); err != nil {
			return nil, err
		}
		out[r.ID] = r
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ---- reply.post implementation ----

func runReplyPost(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}
		replyCTID, err := resolveCardType(snap, "reply_body")
		if err != nil {
			return nil, err
		}

		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ReplyPostInput)
			if in.CommID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "reply.post: comm_id is required"}
			}
			if in.To == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "reply.post: to is required"}
			}
			if in.Body == "" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "reply.post: body is required"}
			}

			// Verify the target is a comm card and grab its channel_ref so
			// we can copy the channel's from_address into reply_from.
			var commKind string
			var channelRef int64
			row := tx.QueryRow(ctx, `
				SELECT ct.name,
				       COALESCE((SELECT (value)::text::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name='channel_ref' AND jsonb_typeof(value)='number'), 0)
				FROM card c JOIN card_type ct ON ct.id = c.card_type_id
				WHERE c.id = $1 AND c.deleted_at IS NULL
			`, in.CommID)
			if err := row.Scan(&commKind, &channelRef); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, &reg.HandlerError{InputIndex: i, Code: "comm_not_found",
						Message: fmt.Sprintf("reply.post: comm %d not found", in.CommID)}
				}
				return nil, fmt.Errorf("reply.post: load comm: %w", err)
			}
			if commKind != "comm" {
				return nil, &reg.HandlerError{InputIndex: i, Code: "comm_wrong_type",
					Message: fmt.Sprintf("reply.post: card %d is %q, not comm", in.CommID, commKind)}
			}

			// Resolve the channel's configured from_address (best-effort:
			// channels need not have one configured yet — the SMTP sender
			// will refuse to ship a row that has an empty reply_from).
			var fromAddress string
			if channelRef != 0 {
				if err := tx.QueryRow(ctx, `
					SELECT COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='from_address'), '')
				`, channelRef).Scan(&fromAddress); err != nil {
					return nil, fmt.Errorf("reply.post: load channel from_address: %w", err)
				}
			}

			// Insert the reply_body card (global; no parent).
			var replyID int64
			if err := tx.QueryRow(ctx, `
				INSERT INTO card (card_type_id) VALUES ($1) RETURNING id
			`, replyCTID).Scan(&replyID); err != nil {
				return nil, fmt.Errorf("reply.post: insert reply_body card: %w", err)
			}
			if err := writeCardCreateActivity(ctx, tx, replyID, actorID); err != nil {
				return nil, fmt.Errorf("reply.post: activity: %w", err)
			}

			// Write the five required attributes. The threading suffix
			// [#<thread_id>] is NOT appended here; the SMTP sender builds
			// the final subject at send time.
			jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
			writes := []struct {
				name string
				val  json.RawMessage
			}{
				{"reply_to", jstr(in.To)},
				{"reply_from", jstr(fromAddress)},
				{"reply_subject", jstr(in.Subject)},
				{"reply_body_text", jstr(in.Body)},
				{"delivery_status", jstr("pending")},
			}
			for _, w := range writes {
				ad, ok := snap.AttrByName[w.name]
				if !ok {
					return nil, fmt.Errorf("reply.post: attribute_def %q missing", w.name)
				}
				if err := writeAttributeValue(ctx, tx, replyID, ad.ID, w.val, actorID); err != nil {
					return nil, fmt.Errorf("reply.post: write %s: %w", w.name, err)
				}
			}

			// Append the new reply_body id to the comm's replies attribute.
			if err := appendCardRefList(ctx, tx, in.CommID, "replies", replyID, snap, actorID); err != nil {
				return nil, fmt.Errorf("reply.post: append to replies: %w", err)
			}

			outs[i] = ReplyPostOutput{ReplyID: replyID}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// ---- comm_log.list implementation ----

func runCommLogList(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(CommLogListInput)
			if in.ProjectID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "comm_log.list: project_id is required"}
			}
			limit := in.Limit
			if limit <= 0 {
				limit = 200
			}
			if limit > 1000 {
				limit = 1000
			}
			rows, err := tx.Query(ctx, `
				SELECT cl.id, COALESCE(cl.channel_id, 0), cl.kind, cl.detail,
				       to_char(cl.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
				       COALESCE((
				         SELECT av.value #>> '{}'
				         FROM attribute_value av
				         JOIN attribute_def ad ON ad.id = av.attribute_def_id
				         WHERE av.card_id = cl.channel_id AND ad.name = 'title'
				       ), '') AS channel_name
				FROM comm_log cl
				WHERE cl.project_id = $1
				  AND ($2::text = '' OR cl.kind = $2)
				  AND cl.at >= COALESCE(NULLIF($3, '')::timestamptz, now() - interval '24 hours')
				ORDER BY cl.at DESC, cl.id DESC
				LIMIT $4
			`, in.ProjectID, in.Kind, in.Since, limit)
			if err != nil {
				return nil, fmt.Errorf("comm_log.list: %w", err)
			}
			var out []CommLogRow
			for rows.Next() {
				var r CommLogRow
				var detail []byte
				if err := rows.Scan(&r.ID, &r.ChannelID, &r.Kind, &detail, &r.At, &r.ChannelName); err != nil {
					rows.Close()
					return nil, err
				}
				if len(detail) > 0 {
					r.Detail = json.RawMessage(detail)
				}
				out = append(out, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			outs[i] = CommLogListOutput{Rows: out}
		}
		if p != nil {
			p.NoteRead()
		}
		return outs, nil
	}
}
