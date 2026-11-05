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
// Authz: comm_channel.* and comm_log.list are admin-only configuration
// surface (handler-level AllowedRoles + authzAdmin), mirroring the
// install seed's admin-only role_grant on the comm_channel / reply_body
// card_types. comm.create + reply.post, by contrast, are per-row
// authorized: a worker / manager scoped to the parent task's project may
// start a comm (gated on the seeded (comm, card.create) grant) or author
// a reply (gated on the parent task's card.update) — so anyone who can
// open a task can communicate within it. comm.list_for_task /
// comm.unseen_count are readable by any authenticated user.
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
	"github.com/kitp/kitp/server/internal/named"
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
	// SignatureMode controls what (if anything) is auto-appended to the
	// body of outbound replies on this channel: 'none' | 'comm_name'
	// (the channel title) | 'user_name' (the reply author's display name).
	// Empty leaves the stored value unchanged (absent = 'comm_name').
	SignatureMode string `json:"signature_mode,omitempty" mcp:"desc=outbound reply signature; one of 'none' | 'comm_name' | 'user_name'; empty leaves the stored value unchanged"`
	// IntakeMode decides what a new (unmatched) inbound message becomes:
	// 'task' (a task and a thread), 'thread' (a thread on its own in the
	// project) or 'ignore' (only replies to existing threads come in).
	// Empty leaves the stored value unchanged; unset = 'task' when the
	// channel has an intake status, else 'ignore'. See docs/CONVERSATIONS.md.
	IntakeMode string `json:"intake_mode,omitempty" mcp:"desc=what new inbound mail becomes; one of 'task' | 'thread' | 'ignore'; empty leaves the stored value unchanged"`
	// ReplyQuote decides whether outbound replies quote the conversation:
	// 'off', 'last' (the message before) or 'all' (every earlier message).
	// Empty leaves the stored value unchanged; unset = 'last'.
	ReplyQuote string `json:"reply_quote,omitempty" mcp:"desc=quoting in outbound replies; one of 'off' | 'last' | 'all'; empty leaves the stored value unchanged"`
	// RelayReplies decides whether an emailed reply on a thread is sent on
	// to the thread's other people (not kitp users, not anyone already on
	// it): 'on' | 'off'. Empty leaves the stored value unchanged; a new
	// account defaults to 'on', an existing one without it reads as 'off'.
	RelayReplies string `json:"relay_replies,omitempty" mcp:"desc=send an emailed reply on to the thread's other people; one of 'on' | 'off'; empty leaves the stored value unchanged (a new account defaults to 'on')"`
	// EmailAttachments decides whether files on incoming mail are kept on
	// the thread: 'keep' | 'drop'. Empty leaves the stored value unchanged;
	// unset = 'keep'.
	EmailAttachments string `json:"email_attachments,omitempty" mcp:"desc=files on incoming mail; one of 'keep' | 'drop'; empty leaves the stored value unchanged (unset = 'keep')"`
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
	ID               int64  `json:"id,string" mcp:"desc=comm_channel card id"`
	Name             string `json:"name" mcp:"desc=display name (title attribute)"`
	ChannelType      string `json:"channel_type" mcp:"desc=channel type (email in v1)"`
	IMAPHost         string `json:"imap_host" mcp:"desc=IMAP server hostname"`
	IMAPPort         int    `json:"imap_port" mcp:"desc=IMAP server port"`
	IMAPUsername     string `json:"imap_username" mcp:"desc=IMAP login username"`
	SMTPHost         string `json:"smtp_host" mcp:"desc=SMTP server hostname"`
	SMTPPort         int    `json:"smtp_port" mcp:"desc=SMTP server port"`
	SMTPUsername     string `json:"smtp_username" mcp:"desc=SMTP login username"`
	FromAddress      string `json:"from_address" mcp:"desc=outbound From: envelope"`
	IntakeStatusID   int64  `json:"intake_status_id,string,omitempty" mcp:"desc=intake status card id; 0/omitted = use project flow default"`
	Status           string `json:"channel_status" mcp:"desc=tri-state status: 'enabled' | 'disabled-admin' | 'disabled-fault'"`
	SignatureMode    string `json:"signature_mode" mcp:"desc=outbound reply signature: 'none' | 'comm_name' | 'user_name' (empty = unset, treated as 'comm_name')"`
	IntakeMode       string `json:"intake_mode" mcp:"desc=what new inbound mail becomes: 'task' | 'thread' | 'ignore' (empty = unset: 'task' with an intake status, else 'ignore')"`
	ReplyQuote       string `json:"reply_quote" mcp:"desc=quoting in outbound replies: 'off' | 'last' | 'all' (empty = unset, treated as 'last')"`
	RelayReplies     string `json:"relay_replies" mcp:"desc=emailed replies sent on to the thread's other people: 'on' | 'off' (empty = unset, treated as 'off')"`
	EmailAttachments string `json:"email_attachments" mcp:"desc=files on incoming mail: 'keep' | 'drop' (empty = unset, treated as 'keep')"`
	FaultReason      string `json:"channel_fault_reason,omitempty" mcp:"desc=free-form reason set by the runtime when status='disabled-fault'; empty otherwise"`
	HasIMAPPassword  bool   `json:"has_imap_password" mcp:"desc=true if a non-null encrypted IMAP password is stored"`
	HasSMTPPassword  bool   `json:"has_smtp_password" mcp:"desc=true if a non-null encrypted SMTP password is stored"`
	CreatedAt        string `json:"created_at" mcp:"desc=RFC3339 creation timestamp of the channel card"`
}

// ChannelListOutput wraps the rows in a stable envelope.
type ChannelListOutput struct {
	Rows []ChannelRow `json:"rows" mcp:"desc=comm_channel cards under the project"`
}

// ---- comm.unseen_count ----

// UnseenCountInput is the cheap "how many new received comms?" probe behind the
// header notification bell. SinceActivityID is the create-activity id baseline
// the client already saw; the count is of received reply_body cards created
// after it, across every project the caller can see.
type UnseenCountInput struct {
	SinceActivityID int64 `json:"since_activity_id,string,omitempty" mcp:"desc=create-activity id baseline; unseen_count counts received comms created after it (0/omitted counts all visible)"`
}

// UnseenCountOutput reports the newest received-comm create-activity id the
// caller can see plus how many are newer than SinceActivityID.
type UnseenCountOutput struct {
	LatestActivityID int64 `json:"latest_activity_id,string" mcp:"desc=max create-activity id across received comms the caller can see (0 when none)"`
	UnseenCount      int   `json:"unseen_count" mcp:"desc=count of received comms created after since_activity_id"`
}

// ---- comm.create ----

// CommCreateInput is the wire shape for comm.create.
type CommCreateInput struct {
	TaskID             int64   `json:"task_id,string" mcp:"required,desc=task card id this comm attaches to"`
	ChannelID          int64   `json:"channel_id,string" mcp:"required,desc=comm_channel card id this comm uses"`
	Subject            string  `json:"subject,omitempty" mcp:"desc=display title on the comm card; defaults to the task's title when empty (outbound replies always use {thread_id} + task.title for the email Subject header at send time, regardless of this value)"`
	InitialMessage     string  `json:"initial_message,omitempty" mcp:"desc=optional first message to SEND to the recipients; when set, a reply_body row with delivery_status='pending' (authored by the actor, queued for SMTP) is created and appended to the comm's replies attribute. Requires recipient_person_ids"`
	RecipientPersonIDs reg.IDs `json:"recipient_person_ids,omitempty" mcp:"desc=initial participants; each id must reference a person card. Stored in the comm_recipients attribute and used as the To: list when an operator authors a reply"`
}

// CommCreateOutput carries the new comm card id and the generated
// thread_id so callers can render the appended-to-task immediately.
type CommCreateOutput struct {
	CommID   int64  `json:"comm_id,string" mcp:"desc=id of the new comm card"`
	ThreadID string `json:"thread_id" mcp:"desc=10-char base62 thread id used for inbound threading"`
}

// ---- comm.list_for_task ----

// CommListForTaskInput identifies the task whose comms we want, or one
// thread (a thread on its own has no task; its page loads it by id).
type CommListForTaskInput struct {
	TaskID int64 `json:"task_id,string,omitempty" mcp:"desc=task card id whose comms to list; required unless comm_id is given"`
	CommID int64 `json:"comm_id,string,omitempty" mcp:"desc=list just this comm (wherever it sits: under a task or directly in its project); overrides task_id"`
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
	// Acked is the per-thread "handled" flag. Defaults true (no acked row yet ⇒
	// nothing to handle); a received inbound reply clears it to false. Must be a
	// real field on this struct — otherwise the SQL row's `acked` key is dropped
	// on decode and the client defaults it true, disagreeing with the comms list
	// (which reads the attribute_value directly).
	Acked bool `json:"acked" mcp:"desc=true when the thread has been acknowledged/handled; false when a received message awaits an ACK"`
	// Approval is the vote request that started the thread (approval.set
	// with email), nil for any other thread.
	Approval *CommApproval `json:"approval,omitempty" mcp:"desc=the approval request that started this thread, when one did; vote on the task, not by replying"`
}

// CommApproval names the vote request a thread was started for.
type CommApproval struct {
	ID     int64  `json:"id,string" mcp:"desc=approval request id"`
	Action string `json:"action" mcp:"desc=the status action's name, e.g. 'Approve'"`
	From   string `json:"from" mcp:"desc=status the step starts from"`
	To     string `json:"to" mcp:"desc=status the step leads to"`
}

// ReplyRow is one reply_body card materialised for the comms screen.
type ReplyRow struct {
	ID             int64  `json:"id,string" mcp:"desc=reply_body card id"`
	To             string `json:"to" mcp:"desc=To: envelope"`
	From           string `json:"from" mcp:"desc=From: envelope (for outbound mail, the channel's from_address)"`
	FromName       string `json:"from_name" mcp:"desc=who the message is from: the kitp author for messages written here (an agent is named with its owner), else the person whose email matches the sender, else the From: header's display name; empty when unknown"`
	FromAddress    string `json:"from_address" mcp:"desc=bare sender email address from the From: envelope"`
	AuthorID       int64  `json:"author_id,string" mcp:"desc=user_account that wrote the message in kitp; 0 for received mail"`
	Subject        string `json:"subject" mcp:"desc=subject line"`
	BodyText       string `json:"body_text" mcp:"desc=plain-text body"`
	DeliveryStatus string `json:"delivery_status" mcp:"desc=pending / sent / bounced / failed / received"`
	CreatedAt      string `json:"created_at" mcp:"desc=RFC3339 creation timestamp"`
	// Attachments are the message's files. A received file lives on the
	// thread (OnThread) until someone moves it onto the task
	// (comm.attachment_to_task); the message keeps it either way.
	Attachments []ReplyAttachment `json:"attachments" mcp:"desc=the message's files"`
	// AttachmentsLeftOff counts the files a mail account that drops them
	// didn't keep (email_attachments = 'drop').
	AttachmentsLeftOff int `json:"attachments_left_off" mcp:"desc=files on the incoming message that were not kept (the account drops them)"`
	// Relay is the copy kitp sent on to the rest of the thread, for an
	// emailed reply on an account that does that (relay_replies = 'on').
	Relay *ReplyRelay `json:"relay,omitempty" mcp:"desc=the copy sent on to the thread's other people, when one was"`
}

// ReplyAttachment is one file on a message.
type ReplyAttachment struct {
	ID        int64  `json:"id,string" mcp:"desc=attachment id (download with attachment.download_url)"`
	Filename  string `json:"filename" mcp:"desc=file name"`
	MimeType  string `json:"mime_type" mcp:"desc=MIME type"`
	SizeBytes int64  `json:"size_bytes" mcp:"desc=size in bytes"`
	Kind      string `json:"kind" mcp:"desc=image | pdf | markdown | other — what the viewer can show"`
	OnThread  bool   `json:"on_thread" mcp:"desc=true while the file belongs to the thread (not yet moved onto its task)"`
}

// ReplyRelay is the copy of an emailed reply kitp sent on.
type ReplyRelay struct {
	ID                 int64  `json:"id,string" mcp:"desc=the copy's reply_body id"`
	To                 string `json:"to" mcp:"desc=who it went to (comma-separated)"`
	DeliveryStatus     string `json:"delivery_status" mcp:"desc=pending / sent / bounced / failed"`
	AttachmentsLeftOff int    `json:"attachments_left_off" mcp:"desc=files too large to send on with it"`
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
	AttachmentIDs reg.IDs `json:"attachment_ids,omitempty" mcp:"desc=existing attachment ids to send with the reply: the task's files or the thread's own (linked, not copied)"`
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
	Kind      string `json:"kind,omitempty" mcp:"desc=optional kind filter (poll / received / duplicate / inbound_refused / dkim_result / dkim_failed / send_ok / send_retry / send_bounce / send_fail / imap_auth_fail / parse_error / file_retry / file_error / unmatched_thread / attachment_too_large / attachments_dropped / relay_queued / relay_skipped / notification_reply / notify_ok / notify_bounce / notify_fail)"`
	Since     string `json:"since,omitempty" mcp:"desc=RFC 3339 timestamp (e.g. 2026-11-03T00:00:00Z); rows older than this are excluded; empty defaults to 24h ago"`
	ChannelID int64  `json:"channel_id,string,omitempty" mcp:"desc=optional: only this mail account's rows"`
	RouteID   int64  `json:"route_id,string,omitempty" mcp:"desc=optional: only rows for this inbound route (a POST URL or SMTP address from comm_route.list)"`
	Limit     int    `json:"limit,omitempty" mcp:"desc=max rows to return; default 200, max 1000"`
}

// CommLogRow is one comm_log row.
type CommLogRow struct {
	ID          int64           `json:"id,string" mcp:"desc=comm_log row id"`
	ChannelID   int64           `json:"channel_id,string,omitempty" mcp:"desc=channel card id; 0 / omitted for pre-identification rows (e.g. IMAP auth failures)"`
	ChannelName string          `json:"channel_name,omitempty" mcp:"desc=channel display name (title attribute on the channel card); empty when channel_id is 0 or the channel has been deleted"`
	RouteID     int64           `json:"route_id,string,omitempty" mcp:"desc=inbound route (card_access row) a POST / SMTP event came through; 0 for IMAP and outbound rows"`
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
		Endpoint:   "comm",
		Action:     "create",
		Doc:        "Create a comm card under a task (worker / manager / admin, scoped to the task's project). Generates a 10-char alphanumeric thread_id, sets channel_ref + comm_status (the project's comm flow default_create_status_id), appends the new comm to the task's comms attribute, and (when initial_message is provided) creates an outbound reply_body row (delivery_status='pending', queued for SMTP) — which requires recipient_person_ids.",
		InputType:  reflect.TypeFor[CommCreateInput](),
		OutputType: reflect.TypeFor[CommCreateOutput](),
		// Anyone who can open a task can start a comm within it: the per-row
		// scope pass gates on the seeded (comm, card.create) grant that
		// worker / manager hold (db/schema/seed.hcsv), scoped to the parent
		// task's project. comm.create's input names the parent task_id (not
		// card_id), so an explicit ScopeCardID resolver supplies the walk
		// start (task → project) — without it a project-scoped worker /
		// manager is denied (BE-H3 / A2).
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.create",
		CardTypeID:   commCardTypeID,
		ScopeCardID:  scopeCardFromCommCreateInput,
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
		Doc:          "Return every comm card under the task, hydrated with its replies (reply_body cards listed in the comm's replies attribute) — or, with comm_id, that one comm (a thread on its own sits directly in its project). Read-side affordance for the task detail and thread screens; any authenticated user may call.",
		InputType:    reflect.TypeFor[CommListForTaskInput](),
		OutputType:   reflect.TypeFor[CommListForTaskOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		// Unified handler — body lives in
		// db/schema/functions/comm_list_for_task_batch.sql.
		SQLFunc: "comm_list_for_task_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "comm",
		Action:       "unseen_count",
		Doc:          "Cheap count of newly received comms (inbound reply_body cards) across every project the caller can see, with create-activity id > since_activity_id. Drives the header notification bell; any authenticated user may call.",
		InputType:    reflect.TypeFor[UnseenCountInput](),
		OutputType:   reflect.TypeFor[UnseenCountOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		IsRead:       true,
		// Unified handler — body lives in
		// db/schema/functions/comm_unseen_count_batch.sql.
		SQLFunc: "comm_unseen_count_batch",
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
	registerPersonGrantAccount(p)
	registerPersonMerge(p)
	registerCommSetRecipients(p)
	registerCommSetAck(p)
	registerCommAttach(p)
}

// cardTypeFromReplyPostInput walks comm → parent task and returns the
// task's card_type so the dispatcher can scope-check against the
// actor's task-level grant (commAuthzCardType).
func cardTypeFromReplyPostInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return commAuthzCardType(ctx, pool, raw.(ReplyPostInput).CommID)
}

// commAuthzCardType is the card type a comm write (reply.post,
// comm.set_ack, comm.set_recipients) is authorized against: the comm's
// task's, so a worker's task grant covers the task's threads; or, for a
// thread on its own (directly in its project, docs/CONVERSATIONS.md),
// the comm's own, which worker / manager hold card.update on
// (db/schema/seed.hcsv). Returns 0 (skip authz) on a missing comm — the
// handler's validation surfaces the proper not-found error.
func commAuthzCardType(ctx context.Context, pool reg.ValidationPool, commID int64) (int64, error) {
	b := named.New()
	b.Set("comm_id", commID)
	q, args, err := b.Compile(`
		SELECT CASE WHEN pct.name = 'task' THEN p.card_type_id ELSE c.card_type_id END
		FROM card c
		LEFT JOIN card p ON p.id = c.parent_card_id
		LEFT JOIN card_type pct ON pct.id = p.card_type_id
		WHERE c.id = :comm_id
	`)
	if err != nil {
		return 0, fmt.Errorf("comm authz card type: compile: %w", err)
	}
	var cardTypeID int64
	if err := pool.QueryRow(ctx, q, args...).Scan(&cardTypeID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return cardTypeID, nil
}

// scopeCardFromReplyPostInput returns the comm card id the per-row
// scope pass walks up from (comm → task → project). Used as
// reg.Handler.ScopeCardID for reply.post (BE-H3 / A2).
func scopeCardFromReplyPostInput(_ context.Context, _ reg.ValidationPool, raw any) (int64, error) {
	return raw.(ReplyPostInput).CommID, nil
}

// commCardTypeID returns the comm card_type_id so the dispatcher can
// scope-check comm.create against the actor's (comm, card.create) grant —
// the grant worker / manager already hold per db/schema/seed.hcsv. The
// result is input-independent (comm.create always authors a comm card).
// Returns 0 (skip authz) only if the comm card_type is somehow absent,
// matching cardTypeFromName's "let the handler surface the failure" rule.
func commCardTypeID(ctx context.Context, pool reg.ValidationPool, _ any) (int64, error) {
	var id int64
	if err := pool.QueryRow(ctx, `SELECT id FROM card_type WHERE name = 'comm'`).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return id, nil
}

// scopeCardFromCommCreateInput returns the parent task id the per-row
// scope pass walks up from (task → project). comm.create's input names it
// task_id (not card_id), so the reflection fallback can't find it — this
// resolver supplies the walk start. Used as reg.Handler.ScopeCardID.
func scopeCardFromCommCreateInput(_ context.Context, _ reg.ValidationPool, raw any) (int64, error) {
	return raw.(CommCreateInput).TaskID, nil
}

// authzAdmin requires the actor to hold the admin or system role
// globally. Mirrors flow.authzAdmin / rolemapping.authzAdmin.
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)
	admin, err := auth.IsGlobalAdmin(ctx, authzPool.P, userID)
	if err != nil {
		return fmt.Errorf("comm.authz: %w", err)
	}
	if !admin {
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
func writeCardCreateActivity(ctx context.Context, tx store.Querier, cardID, actorID int64) error {
	return namedExec(ctx, tx, `
		INSERT INTO activity (card_id, kind, actor_id) VALUES (:card, 'card_create', :actor)
	`, map[string]any{"card": cardID, "actor": actorID})
}

// writeAttributeValue emits one attr_update activity + one
// attribute_value upsert, linked through last_activity_id. Same shape
// as projectstamp.writeAttributeValue — duplicated here so the comm
// package doesn't depend on projectstamp.
func writeAttributeValue(
	ctx context.Context,
	tx store.Querier,
	cardID, attributeDefID int64,
	value json.RawMessage,
	actorID int64,
) error {
	var activityID int64
	row, err := namedRow(ctx, tx, `
		INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
		VALUES (:card, 'attr_update', :def, NULL, :value::jsonb, :actor)
		RETURNING id
	`, map[string]any{"card": cardID, "def": attributeDefID, "value": value, "actor": actorID})
	if err != nil {
		return fmt.Errorf("comm: write activity: %w", err)
	}
	if err := row.Scan(&activityID); err != nil {
		return fmt.Errorf("comm: write activity: %w", err)
	}
	if err := namedExec(ctx, tx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
		VALUES (:card, :def, :value::jsonb, :activity)
		ON CONFLICT (card_id, attribute_def_id) DO UPDATE
			SET value = EXCLUDED.value,
			    last_activity_id = EXCLUDED.last_activity_id
	`, map[string]any{"card": cardID, "def": attributeDefID, "value": value, "activity": activityID}); err != nil {
		return fmt.Errorf("comm: upsert attribute_value: %w", err)
	}
	return nil
}

// readAttributeValueRaw fetches the current jsonb value of (cardID,
// attrName) or returns ("null", false) when no row exists.
func readAttributeValueRaw(ctx context.Context, tx store.Querier, cardID int64, attrName string) (json.RawMessage, bool, error) {
	var raw []byte
	row, err := namedRow(ctx, tx, `
		SELECT av.value
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = :card AND ad.name = :attr
	`, map[string]any{"card": cardID, "attr": attrName})
	if err != nil {
		return nil, false, err
	}
	err = row.Scan(&raw)
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
func commFlowDefaultStatus(ctx context.Context, tx store.Querier, projectID, commStatusAttrID int64) (int64, error) {
	var defaultID int64
	row, err := namedRow(ctx, tx, `
		SELECT COALESCE(default_create_status_id, 0)
		FROM flow
		WHERE scope_card_id = :project AND attribute_def_id = :def
		LIMIT 1
	`, map[string]any{"project": projectID, "def": commStatusAttrID})
	if err != nil {
		return 0, err
	}
	err = row.Scan(&defaultID)
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
func uniqueThreadID(ctx context.Context, tx store.Querier) (string, error) {
	for attempt := 0; attempt < 5; attempt++ {
		candidate, err := generateThreadID()
		if err != nil {
			return "", err
		}
		var n int
		row, err := namedRow(ctx, tx, `
			SELECT count(*)
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE ad.name = 'thread_id' AND av.value = to_jsonb(:candidate::text)
		`, map[string]any{"candidate": candidate})
		if err != nil {
			return "", fmt.Errorf("comm.create: thread uniqueness: %w", err)
		}
		err = row.Scan(&n)
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
func appendCardRefList(ctx context.Context, tx store.Querier, cardID int64, attrName string, appendID int64, snap *schema.Snapshot, actorID int64) error {
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
