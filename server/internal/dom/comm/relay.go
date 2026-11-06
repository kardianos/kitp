package comm

// Sending an emailed reply on to the rest of the thread
// (docs/MAIL_INTAKE_AND_CALENDARS.md, "Sending replies on").
//
// Ada, Bob and the account support@ are on a thread. Ada replies to
// support@ only; kitp files her message on the thread as always and, when
// the account's relay_replies is on, queues a copy to Bob:
//
//	From: "Ada Lovelace via Support" <support@…>
//	To:   the thread's people, minus Ada, minus anyone already on her
//	      To/Cc, minus the account itself, minus kitp users (they see
//	      it in kitp and get email through their notifications)
//
// Who gets a copy, and whose message is sent on (review 2026-11-03 #3 and
// round 2 #1): otherwise anyone could put addresses on a thread and have
// kitp mail them as the organisation. Only the thread's confirmed people
// take part, and only kitp confirms anyone — never something a received
// message says, since its From, To and Cc aren't authenticated: the people
// a person in kitp added to the thread (comm.create, comm.set_recipients)
// and the person who started it by mail (comm.comm_confirmed,
// comm_confirm). A staff reply confirms nobody (round 3 #5): it goes to
// everyone on the thread, whoever put them there.
// The sender must be confirmed and on the thread before this message; the
// copy goes to the confirmed people on it, at most maxRelayRecipients.
// Someone another person Cc'd joins the thread and gets staff replies, but
// no copies of other people's mail until staff add them (take them off and
// add them again). Someone staff took off stays off: their later mail is
// filed but doesn't put them back (comm_remove, round 3 #8).
// The thread's own mail account (its channel_ref) decides whether replies
// are sent on and sends the copy, whichever account the reply came in on
// (#10).
//
// The copy is a reply_body on the thread like any message kitp sends, so
// the SMTP sender ships it with a delivery status and Comm log rows; its
// relay_of names Ada's message, which the thread view shows it under. The
// copy carries the files stored with her message (linked, not copied) and
// Auto-Submitted: auto-forwarded, so out-of-office replies to it are not
// sent on again, and X-Loop naming the account. At most maxRelaysPerHour
// copies per thread in an hour. Never sent on: auto-replies, bounces,
// mail carrying X-Loop, mailing-list mail,
// replies to notification email, and mail from the account's own address.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/mail"
	"strings"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// automaticKind says why a message was written by a machine rather than a
// person ("" when it wasn't): RFC 3834 Auto-Submitted, a Precedence of
// bulk / junk / list / auto_reply, an X-Autoreply / X-Autorespond header,
// a mailing list (List-Id), a delivery or read report (multipart/report)
// or a bounce (an empty Return-Path, or From MAILER-DAEMON / postmaster).
// Such mail is filed as usual but never sent on.
func automaticKind(h mail.Header) string {
	if v := strings.ToLower(strings.TrimSpace(h.Get("Auto-Submitted"))); v != "" && v != "no" {
		return "auto_submitted"
	}
	switch strings.ToLower(strings.TrimSpace(h.Get("Precedence"))) {
	case "bulk", "junk", "list", "auto_reply":
		return "precedence"
	}
	if strings.TrimSpace(h.Get("X-Autoreply")) != "" || strings.TrimSpace(h.Get("X-Autorespond")) != "" {
		return "auto_reply"
	}
	if strings.TrimSpace(h.Get("List-Id")) != "" {
		return "mailing_list"
	}
	// X-Loop: kitp puts it on every copy it sends on (and mailing lists
	// on what they distribute); mail carrying one is never sent on, so
	// two relaying accounts can't bounce a message between them (review
	// 2026-11-03 round 4).
	if strings.TrimSpace(h.Get("X-Loop")) != "" {
		return "loop"
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(h.Get("Content-Type"))), "multipart/report") {
		return "report"
	}
	if rp, ok := h["Return-Path"]; ok && len(rp) > 0 && strings.TrimSpace(rp[0]) == "<>" {
		return "bounce"
	}
	if a, err := ParseAddress(h.Get("From")); err == nil {
		local, _, _ := strings.Cut(strings.ToLower(a.Address), "@")
		if local == "mailer-daemon" || local == "postmaster" {
			return "bounce"
		}
	}
	return ""
}

// addressesIn returns the lowercased bare addresses in address-list
// headers — who a message reached. An odd entry is skipped and the rest
// kept (PeopleIn), so one odd Cc doesn't make everyone else on it look
// unreached (review 2026-11-03 round 4 #9). A header that doesn't parse
// adds nothing.
func addressesIn(headers ...string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, raw := range headers {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		for _, a := range PeopleIn(raw) {
			if addr := strings.ToLower(strings.TrimSpace(a.Address)); addr != "" {
				out[addr] = struct{}{}
			}
		}
	}
	return out
}

// senderOf is the one lowercased address a From header names, or ""
// when it names other than exactly one plain address. Strict, unlike
// addressesIn: a From with an odd address in it has no sender.
func senderOf(from string) string {
	from = strings.TrimSpace(from)
	if from == "" {
		return ""
	}
	if list, err := ParseAddressList(from); err == nil {
		if len(list) == 1 {
			return strings.ToLower(strings.TrimSpace(list[0].Address))
		}
		return ""
	}
	if a, err := ParseAddress(from); err == nil {
		return strings.ToLower(strings.TrimSpace(a.Address))
	}
	return ""
}

// relaySenderName is the name on a copy's From: the sender's display name,
// else their address, "via" the account's name (its address when unnamed).
func relaySenderName(from, accountName, accountAddr string) string {
	who := ""
	p := mail.AddressParser{WordDecoder: headerDecoder}
	if a, err := p.Parse(from); err == nil {
		who = strings.TrimSpace(a.Name)
		if who == "" {
			who = a.Address
		}
	} else {
		who = strings.TrimSpace(decodeHeaderText(from))
	}
	via := strings.TrimSpace(accountName)
	if via == "" {
		via = accountAddr
	}
	if who == "" {
		return via
	}
	return who + " via " + via
}

// maxRelayRecipients caps one relay copy's To.
const maxRelayRecipients = 20

// maxRelaysPerHour caps the copies one thread sends on in an hour.
const maxRelaysPerHour = 20

// recentRelays counts the copies kitp queued on a thread in the last hour.
func recentRelays(ctx context.Context, tx store.Querier, commID int64) (int, error) {
	row, err := namedRow(ctx, tx, `
		SELECT count(*)
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'replies'
		CROSS JOIN LATERAL jsonb_array_elements(
			CASE WHEN jsonb_typeof(av.value) = 'array' THEN av.value ELSE '[]'::jsonb END) AS e(v)
		JOIN card r ON r.id = CASE WHEN (e.v #>> '{}') ~ '^[0-9]{1,18}$' THEN (e.v #>> '{}')::bigint END
		           AND r.created_at > now() - interval '1 hour'
		JOIN attribute_value ro ON ro.card_id = r.id
		 AND ro.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'relay_of')
		WHERE av.card_id = :comm
	`, map[string]any{"comm": commID})
	if err != nil {
		return 0, fmt.Errorf("recent relays: %w", err)
	}
	var n int
	if err := row.Scan(&n); err != nil {
		return 0, fmt.Errorf("recent relays: %w", err)
	}
	return n, nil
}

// relayReply sends the message just filed on commID (replyID) on to the
// thread's other confirmed people when the thread's mail account does that.
// It writes a relay_queued Comm log row for a copy, relay_skipped when the
// message is one kitp never sends on, and nothing when there is nobody else
// to send to. A failure is logged and leaves the message filed, unsent on.
//
// before is the thread's people's addresses (lowercased) from before this
// message was filed (threadRecipientAddresses).
func (p *filer) relayReply(ctx context.Context, tx store.Querier, snap *schema.Snapshot, commID, replyID int64, m InboundMessage, in channelIntake, meta inboundMeta, actorID int64, before map[string]struct{}) error {
	err := withSavepoint(ctx, tx, "relay", func() error {
		return p.relayReplyTx(ctx, tx, snap, commID, replyID, m, in, meta, actorID, before)
	})
	if err != nil {
		p.logger.LogAttrs(ctx, slog.LevelWarn, "relay failed; the message is filed but not sent on",
			slog.Int64("channel_id", p.channelID),
			slog.Int64("comm_id", commID),
			slog.Int64("reply_id", replyID),
			slog.String("error", err.Error()))
	}
	return nil
}

func (p *filer) relayReplyTx(ctx context.Context, tx store.Querier, snap *schema.Snapshot, commID, replyID int64, m InboundMessage, in channelIntake, meta inboundMeta, actorID int64, before map[string]struct{}) error {
	account, relayOn, err := threadAccount(ctx, tx, commID, p.channelID, in.relay)
	if err != nil {
		return err
	}
	if !relayOn {
		return nil
	}
	skip := func(reason string) error {
		return p.logInbound(ctx, tx, in.projectID, meta, "relay_skipped", map[string]any{
			"reply_id": replyID, "reason": reason,
			"message_id": m.MessageID, "from": m.From, "subject": m.Subject,
		})
	}
	if m.AutoKind != "" {
		return skip(m.AutoKind)
	}
	if IsNotificationReply(m) {
		return skip("notification_reply")
	}
	accountAddr, accountName, err := loadChannelSender(ctx, tx, account)
	if err != nil {
		return err
	}
	if accountAddr == "" {
		return skip("no_from_address")
	}
	own := strings.ToLower(accountAddr)
	sender := senderOf(m.From)
	if sender == "" {
		return skip("no_sender")
	}
	senders := map[string]struct{}{sender: {}}
	if _, fromSelf := senders[own]; fromSelf {
		return skip("own_address")
	}
	// A kitp user writes in kitp, as copies never go to them (R3). Mail
	// that says it is from one isn't sent on: its From isn't
	// authenticated, and the copy would go to the thread's people as
	// "Carol via Support" from the organisation's own address — passing
	// DMARC for whoever forged it (review 2026-11-06 #8). It is filed.
	if isUser, err := senderIsUser(ctx, tx, sender); err != nil {
		return err
	} else if isUser {
		return skip("sender_is_user")
	}
	// At most maxRelaysPerHour copies per thread in an hour: a sender who
	// may be sent on can otherwise make the account mail everyone on the
	// thread as fast as they write (review 2026-11-03 round 4).
	if n, err := recentRelays(ctx, tx, commID); err != nil {
		return err
	} else if n >= maxRelaysPerHour {
		return skip("rate_limited")
	}
	confirmed, err := threadConfirmed(ctx, tx, commID)
	if err != nil {
		return err
	}
	for sender := range senders {
		if _, was := before[sender]; !was {
			return skip("sender_not_on_thread")
		}
		if _, ok := confirmed[sender]; !ok {
			return skip("sender_unconfirmed")
		}
	}
	// Everyone the message already reached, and the account itself.
	reached := addressesIn(m.From, m.To, m.Cc)
	reached[own] = struct{}{}
	candidates, err := relayRecipients(ctx, tx, commID, reached)
	if err != nil {
		return err
	}
	var to []string
	for _, a := range candidates {
		key := strings.ToLower(a)
		_, was := before[key]
		_, ok := confirmed[key]
		if was && ok && !p.isRouteAddress(a) {
			to = append(to, a)
		}
	}
	if len(to) == 0 {
		return nil
	}
	if len(to) > maxRelayRecipients {
		return skip("too_many_recipients")
	}
	from := (&mail.Address{Name: relaySenderName(m.From, accountName, accountAddr), Address: accountAddr}).String()
	copyID, leftOff, err := queueRelayCopy(ctx, tx, snap, commID, replyID, from, strings.Join(to, ", "), m, actorID)
	if err != nil {
		return err
	}
	detail := map[string]any{
		"reply_id": replyID, "copy_id": copyID, "to": strings.Join(to, ", "),
		"message_id": m.MessageID, "from": m.From, "subject": m.Subject,
	}
	if leftOff > 0 {
		detail["attachments_left_off"] = leftOff
	}
	return p.logInbound(ctx, tx, in.projectID, meta, "relay_queued", detail)
}

// threadAccount is the mail account a thread belongs to (its channel_ref)
// and whether that account sends replies on. A thread without one (or
// whose account is gone) falls back to the account the reply came in on.
func threadAccount(ctx context.Context, tx store.Querier, commID, receivedOn int64, receivedRelay bool) (int64, bool, error) {
	row, err := namedRow(ctx, tx, `
		SELECT COALESCE((
			SELECT ch.id
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'channel_ref'
			JOIN card ch ON ch.id = CASE WHEN jsonb_typeof(av.value) = 'number' THEN (av.value)::text::bigint END
			            AND ch.deleted_at IS NULL
			WHERE av.card_id = :comm), 0)
	`, map[string]any{"comm": commID})
	if err != nil {
		return 0, false, fmt.Errorf("thread account: %w", err)
	}
	var account int64
	if err := row.Scan(&account); err != nil {
		return 0, false, fmt.Errorf("thread account: %w", err)
	}
	if account == 0 || account == receivedOn {
		return receivedOn, receivedRelay, nil
	}
	in, err := loadIntake(ctx, tx, account)
	if err != nil {
		return 0, false, fmt.Errorf("thread account %d: %w", account, err)
	}
	return account, in.relay, nil
}

// threadConfirmed is the lowercased addresses of the people kitp has
// confirmed on a thread: those comm_confirmed names (added by a person in
// kitp, or who started the thread by mail — comm_confirm). Nothing a
// received message says counts — its From, To and Cc aren't authenticated
// (review 2026-11-03 round 2 #1) — and neither does a staff reply: reply.post
// writes to everyone on the thread, including whoever a received message
// put there, so "staff wrote to them" isn't a choice anyone made (round 3
// #5). Taking someone off the thread unconfirms them (comm_remove).
func threadConfirmed(ctx context.Context, tx store.Querier, commID int64) (map[string]struct{}, error) {
	b := named.New()
	b.Set("comm", commID)
	q, args, err := b.Compile(`
		SELECT lower(btrim(pav.value #>> '{}'))
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'comm_confirmed'
		CROSS JOIN LATERAL jsonb_array_elements(
			CASE WHEN jsonb_typeof(av.value) = 'array' THEN av.value ELSE '[]'::jsonb END) AS e(v)
		JOIN card pc ON pc.id = CASE WHEN (e.v #>> '{}') ~ '^[0-9]{1,18}$' THEN (e.v #>> '{}')::bigint END
		            AND pc.deleted_at IS NULL
		JOIN attribute_value pav ON pav.card_id = pc.id
		JOIN attribute_def pad ON pad.id = pav.attribute_def_id AND pad.name = 'email'
		WHERE av.card_id = :comm
	`)
	if err != nil {
		return nil, fmt.Errorf("thread confirmed: %w", err)
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("thread confirmed: %w", err)
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var person string
		if err := rows.Scan(&person); err != nil {
			return nil, fmt.Errorf("thread confirmed: scan: %w", err)
		}
		if person != "" {
			out[person] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("thread confirmed: %w", err)
	}
	return out, nil
}

// confirmStarter confirms the person who started a thread by writing to the
// account (comm_confirm): the thread is theirs, so their later messages are
// sent on to the people staff add. Their From isn't authenticated either,
// but it only ever reaches people a person in kitp chose.
func confirmStarter(ctx context.Context, tx store.Querier, commID int64, from string) error {
	addr := senderOf(from)
	if addr == "" {
		return nil
	}
	b := named.New()
	b.Set("comm", commID)
	b.Set("addr", addr)
	q, args, err := b.Compile(`
		SELECT comm_confirm(:comm, ARRAY(
			SELECT pc.id
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'comm_recipients'
			CROSS JOIN LATERAL jsonb_array_elements(
				CASE WHEN jsonb_typeof(av.value) = 'array' THEN av.value ELSE '[]'::jsonb END) AS e(v)
			JOIN card pc ON pc.id = CASE WHEN (e.v #>> '{}') ~ '^[0-9]{1,18}$' THEN (e.v #>> '{}')::bigint END
			            AND pc.deleted_at IS NULL
			JOIN attribute_value pav ON pav.card_id = pc.id
			JOIN attribute_def pad ON pad.id = pav.attribute_def_id AND pad.name = 'email'
			WHERE av.card_id = :comm AND lower(btrim(pav.value #>> '{}')) = :addr))
	`)
	if err != nil {
		return fmt.Errorf("confirm starter: %w", err)
	}
	if _, err := tx.Exec(ctx, q, args...); err != nil {
		return fmt.Errorf("confirm starter: %w", err)
	}
	return nil
}

// threadRecipientAddresses is the lowercased email of every person on a
// thread (comm_recipients), read before a message is filed so the relay
// can tell who was already there.
func threadRecipientAddresses(ctx context.Context, tx store.Querier, commID int64) (map[string]struct{}, error) {
	b := named.New()
	b.Set("comm", commID)
	q, args, err := b.Compile(`
		SELECT lower(btrim(pav.value #>> '{}'))
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'comm_recipients'
		CROSS JOIN LATERAL jsonb_array_elements(
			CASE WHEN jsonb_typeof(av.value) = 'array' THEN av.value ELSE '[]'::jsonb END) AS e(v)
		JOIN attribute_value pav ON pav.card_id = CASE WHEN (e.v #>> '{}') ~ '^[0-9]{1,18}$' THEN (e.v #>> '{}')::bigint END
		JOIN attribute_def pad ON pad.id = pav.attribute_def_id AND pad.name = 'email'
		WHERE av.card_id = :comm
	`)
	if err != nil {
		return nil, fmt.Errorf("thread recipients: %w", err)
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("thread recipients: %w", err)
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, fmt.Errorf("thread recipients: scan: %w", err)
		}
		if a != "" {
			out[a] = struct{}{}
		}
	}
	return out, rows.Err()
}

// loadChannelSender returns the account's from_address and name.
func loadChannelSender(ctx context.Context, tx store.Querier, channelID int64) (addr, name string, err error) {
	row, err := namedRow(ctx, tx, `
		SELECT
			COALESCE((SELECT btrim(value #>> '{}') FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel AND ad.name = 'from_address'), ''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = :channel AND ad.name = 'title'), '')
	`, map[string]any{"channel": channelID})
	if err != nil {
		return "", "", fmt.Errorf("load account sender: %w", err)
	}
	if err := row.Scan(&addr, &name); err != nil {
		return "", "", fmt.Errorf("load account sender: %w", err)
	}
	return addr, name, nil
}

// relayRecipients returns the email addresses of the thread's people (its
// comm_recipients, in order, each address once) who are not kitp users and
// not in reached (lowercased addresses the message already went to).
// senderIsUser: addr is a kitp user's — a login's email, or the primary or
// a verified address of a person linked to a login.
func senderIsUser(ctx context.Context, tx store.Querier, addr string) (bool, error) {
	row, err := namedRow(ctx, tx, `
		SELECT EXISTS (
			SELECT 1 FROM user_account ua
			WHERE lower(ua.email) = :addr AND ua.deleted_at IS NULL
			UNION ALL
			SELECT 1 FROM user_account_person uap
			JOIN attribute_value av ON av.card_id = uap.person_card_id
			JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'email'
			WHERE lower(btrim(av.value #>> '{}')) = :addr
			UNION ALL
			SELECT 1 FROM person_email pe
			JOIN user_account_person uap ON uap.person_card_id = pe.person_card_id
			WHERE pe.email = :addr AND pe.verified_at IS NOT NULL)
	`, map[string]any{"addr": strings.ToLower(addr)})
	if err != nil {
		return false, fmt.Errorf("relay: is the sender a user: %w", err)
	}
	var is bool
	if err := row.Scan(&is); err != nil {
		return false, fmt.Errorf("relay: is the sender a user: %w", err)
	}
	return is, nil
}

func relayRecipients(ctx context.Context, tx store.Querier, commID int64, reached map[string]struct{}) ([]string, error) {
	b := named.New()
	b.Set("comm", commID)
	q, args, err := b.Compile(`
		SELECT btrim(pav.value #>> '{}')
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'comm_recipients'
		CROSS JOIN LATERAL jsonb_array_elements(
			CASE WHEN jsonb_typeof(av.value) = 'array' THEN av.value ELSE '[]'::jsonb END
		) WITH ORDINALITY AS e(v, ord)
		JOIN card pc ON pc.id = CASE WHEN (e.v #>> '{}') ~ '^[0-9]+$' THEN (e.v #>> '{}')::bigint END
		            AND pc.deleted_at IS NULL
		JOIN attribute_value pav ON pav.card_id = pc.id
		JOIN attribute_def pad ON pad.id = pav.attribute_def_id AND pad.name = 'email'
		WHERE av.card_id = :comm
		  -- kitp users see the thread in kitp; their notifications cover email.
		  AND NOT EXISTS (SELECT 1 FROM user_account_person uap WHERE uap.person_card_id = pc.id)
		ORDER BY e.ord
	`)
	if err != nil {
		return nil, fmt.Errorf("relay recipients: %w", err)
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("relay recipients: %w", err)
	}
	defer rows.Close()
	var out []string
	seen := map[string]struct{}{}
	for rows.Next() {
		var addr string
		if err := rows.Scan(&addr); err != nil {
			return nil, fmt.Errorf("relay recipients: scan: %w", err)
		}
		key := strings.ToLower(addr)
		if key == "" || !PlainAddress(key) {
			continue
		}
		if _, ok := reached[key]; ok {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, addr)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("relay recipients: %w", err)
	}
	return out, nil
}

// rawEmailNamePattern matches the .eml kitp keeps of a message it received
// (KITP_COMM_SAVE_RAW_EMAIL, rawEmailName). An operator's debugging copy: it
// holds the whole message, files an account drops included, and its trace
// headers, so a relay copy never carries it (review 2026-11-03 #27).
const rawEmailNamePattern = `^inbound-uid-[0-9]+\.eml$`

// rawEmailName is the name of the raw .eml kept for a received message.
func rawEmailName(uid uint32) string { return fmt.Sprintf("inbound-uid-%d.eml", uid) }

// queueRelayCopy writes the copy: a pending reply_body on the thread whose
// relay_of is the original message, carrying the original's files. Files
// over the per-message send limit (MaxReplyAttachmentBytes, together) are
// left off the copy, which then says so; leftOff counts them.
func queueRelayCopy(ctx context.Context, tx store.Querier, snap *schema.Snapshot, commID, originalID int64, from, to string, m InboundMessage, actorID int64) (copyID int64, leftOff int, err error) {
	replyCTID, err := resolveCardType(snap, "reply_body")
	if err != nil {
		return 0, 0, err
	}
	row, err := namedRow(ctx, tx, `INSERT INTO card (card_type_id) VALUES (:type) RETURNING id`,
		map[string]any{"type": replyCTID})
	if err != nil {
		return 0, 0, err
	}
	if err := row.Scan(&copyID); err != nil {
		return 0, 0, fmt.Errorf("insert relay copy: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, copyID, actorID); err != nil {
		return 0, 0, err
	}

	var count int
	var total int64
	row, err = namedRow(ctx, tx, `
		SELECT count(*), COALESCE(sum(f.size_bytes), 0)
		FROM reply_body_attachment rba
		JOIN attachment a ON a.id = rba.attachment_id AND a.deleted_at IS NULL
		JOIN file f ON f.id = a.file_id
		WHERE rba.reply_body_id = :original
		  AND NOT (f.mime_type = 'message/rfc822' AND f.filename ~ :raw_eml)
	`, map[string]any{"original": originalID, "raw_eml": rawEmailNamePattern})
	if err != nil {
		return 0, 0, err
	}
	if err := row.Scan(&count, &total); err != nil {
		return 0, 0, fmt.Errorf("relay copy files: %w", err)
	}
	body := m.Body
	if count > 0 && total > MaxReplyAttachmentBytes {
		leftOff = count
		noun := "attachments were"
		if count == 1 {
			noun = "attachment was"
		}
		body = strings.TrimRight(body, "\r\n") + fmt.Sprintf("\n\n[%d %s too large to send on; open the conversation to get them.]", count, noun)
	} else if count > 0 {
		lb := named.New()
		lb.Set("copy", copyID)
		lb.Set("original", originalID)
		lb.Set("raw_eml", rawEmailNamePattern)
		q, args, err := lb.Compile(`
			INSERT INTO reply_body_attachment (reply_body_id, attachment_id)
			SELECT :copy, rba.attachment_id
			FROM reply_body_attachment rba
			JOIN attachment a ON a.id = rba.attachment_id AND a.deleted_at IS NULL
			JOIN file f ON f.id = a.file_id
			WHERE rba.reply_body_id = :original
			  AND NOT (f.mime_type = 'message/rfc822' AND f.filename ~ :raw_eml)
			ON CONFLICT DO NOTHING
		`)
		if err != nil {
			return 0, 0, fmt.Errorf("relay copy files: %w", err)
		}
		if _, err := tx.Exec(ctx, q, args...); err != nil {
			return 0, 0, fmt.Errorf("relay copy files: %w", err)
		}
	}

	jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
	jnum := func(n int64) json.RawMessage { b, _ := json.Marshal(n); return b }
	writes := []struct {
		name string
		val  json.RawMessage
	}{
		{"reply_to", jstr(to)},
		{"reply_from", jstr(from)},
		{"reply_subject", jstr(m.Subject)},
		{"reply_body_text", jstr(body)},
		{"delivery_status", jstr("pending")},
		{"relay_of", jnum(originalID)},
	}
	if leftOff > 0 {
		writes = append(writes, struct {
			name string
			val  json.RawMessage
		}{"attachments_left_off", jnum(int64(leftOff))})
	}
	for _, w := range writes {
		ad, ok := snap.AttrByName[w.name]
		if !ok {
			return 0, 0, fmt.Errorf("queueRelayCopy: missing attribute_def %q", w.name)
		}
		if err := writeAttributeValue(ctx, tx, copyID, ad.ID, w.val, actorID); err != nil {
			return 0, 0, err
		}
	}
	if err := appendCardRefList(ctx, tx, commID, "replies", copyID, snap, actorID); err != nil {
		return 0, 0, err
	}
	return copyID, leftOff, nil
}
