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
// The copy is a reply_body on the thread like any message kitp sends, so
// the SMTP sender ships it with a delivery status and Comm log rows; its
// relay_of names Ada's message, which the thread view shows it under. The
// copy carries the files stored with her message (linked, not copied) and
// Auto-Submitted: auto-forwarded, so out-of-office replies to it are not
// sent on again. Never sent on: auto-replies, bounces, mailing-list mail,
// replies to notification email, and mail from the account's own address.

import (
	"context"
	"encoding/json"
	"fmt"
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
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(h.Get("Content-Type"))), "multipart/report") {
		return "report"
	}
	if rp, ok := h["Return-Path"]; ok && len(rp) > 0 && strings.TrimSpace(rp[0]) == "<>" {
		return "bounce"
	}
	if a, err := mail.ParseAddress(h.Get("From")); err == nil {
		local, _, _ := strings.Cut(strings.ToLower(a.Address), "@")
		if local == "mailer-daemon" || local == "postmaster" {
			return "bounce"
		}
	}
	return ""
}

// addressesIn returns the lowercased bare addresses in address-list
// headers. A header that doesn't parse adds nothing.
func addressesIn(headers ...string) map[string]struct{} {
	out := map[string]struct{}{}
	for _, raw := range headers {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		list, err := mail.ParseAddressList(raw)
		if err != nil {
			// One header that doesn't parse as a list may still be a
			// single address.
			if a, aerr := mail.ParseAddress(raw); aerr == nil {
				out[strings.ToLower(strings.TrimSpace(a.Address))] = struct{}{}
			}
			continue
		}
		for _, a := range list {
			if addr := strings.ToLower(strings.TrimSpace(a.Address)); addr != "" {
				out[addr] = struct{}{}
			}
		}
	}
	return out
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

// relayReply sends the message just filed on commID (replyID) on to the
// thread's other people when the account does that (in.relay). It writes a
// relay_queued Comm log row for a copy, relay_skipped when the message is
// one kitp never sends on, and nothing when there is nobody else to send to.
func (p *filer) relayReply(ctx context.Context, tx store.Querier, snap *schema.Snapshot, commID, replyID int64, m InboundMessage, in channelIntake, meta inboundMeta, actorID int64) error {
	if !in.relay {
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
	accountAddr, accountName, err := loadChannelSender(ctx, tx, p.channelID)
	if err != nil {
		return err
	}
	if accountAddr == "" {
		return skip("no_from_address")
	}
	own := strings.ToLower(accountAddr)
	if _, fromSelf := addressesIn(m.From)[own]; fromSelf {
		return skip("own_address")
	}
	// Everyone the message already reached, and the account itself.
	reached := addressesIn(m.From, m.To, m.Cc)
	reached[own] = struct{}{}
	to, err := relayRecipients(ctx, tx, commID, reached)
	if err != nil {
		return err
	}
	if len(to) == 0 {
		return nil
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
		if key == "" {
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
	`, map[string]any{"original": originalID})
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
		q, args, err := lb.Compile(`
			INSERT INTO reply_body_attachment (reply_body_id, attachment_id)
			SELECT :copy, rba.attachment_id
			FROM reply_body_attachment rba
			JOIN attachment a ON a.id = rba.attachment_id AND a.deleted_at IS NULL
			WHERE rba.reply_body_id = :original
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
