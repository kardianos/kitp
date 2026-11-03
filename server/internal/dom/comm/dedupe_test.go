package comm_test

// Message dedupe and the shared filing step (docs/MAIL_INTAKE_AND_CALENDARS.md
// §3–4): a message is filed at most once per project, however it arrives.

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

func rawMail(messageID, subject, body string) []byte {
	h := "From: Ada <ada@example.com>\r\nTo: support@example.com\r\nSubject: " + subject + "\r\nDate: Tue, 3 Nov 2026 10:00:00 +0000\r\n"
	if messageID != "" {
		h += "Message-ID: " + messageID + "\r\n"
	}
	return []byte(h + "\r\n" + body + "\r\n")
}

func tasksIn(t *testing.T, f *fixture) int {
	t.Helper()
	var n int
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'task' AND c.parent_card_id = $1 AND c.deleted_at IS NULL`, f.projectID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func logKinds(t *testing.T, f *fixture, channelID int64) map[string]int {
	t.Helper()
	rows, err := f.sp.P.Query(context.Background(), `SELECT kind, count(*) FROM comm_log WHERE channel_id = $1 GROUP BY kind`, channelID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			t.Fatal(err)
		}
		out[k] = n
	}
	return out
}

func TestDedupeFilesAMessageOncePerProject(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_dedupe")
	support := seedChannelForIMAP(t, f, "support@example.com", f.statusID)
	billing := seedChannelForIMAP(t, f, "billing@example.com", f.statusID)
	in := &comm.Intake{Pool: f.sp}
	ctx := context.Background()
	before := tasksIn(t, f)

	msg := rawMail("<one@example.com>", "Help", "Please help.")
	first, err := in.FileRaw(ctx, support, comm.TransportPOST, 0, msg)
	if err != nil || first.Outcome != comm.OutcomeTask || first.CardID == 0 {
		t.Fatalf("first copy: %+v, %v", first, err)
	}
	again, err := in.FileRaw(ctx, support, comm.TransportSMTP, 0, msg)
	if err != nil || !again.Duplicate || again.CardID != first.CardID {
		t.Errorf("second copy, same account: %+v, %v (want a duplicate of %d)", again, err, first.CardID)
	}
	other, err := in.FileRaw(ctx, billing, comm.TransportPOST, 0, msg)
	if err != nil || !other.Duplicate {
		t.Errorf("a copy to another account of the project: %+v, %v", other, err)
	}
	if got := tasksIn(t, f); got != before+1 {
		t.Errorf("tasks = %d, want %d: filed once", got, before+1)
	}
	if k := logKinds(t, f, support); k["received"] != 1 || k["duplicate"] != 1 {
		t.Errorf("support's log = %v, want one received and one duplicate", k)
	}

	// No Message-ID: the same text is the same message; other text isn't.
	plain := rawMail("", "No id", "Same words.")
	a, err := in.FileRaw(ctx, support, comm.TransportPOST, 0, plain)
	if err != nil || a.Duplicate {
		t.Fatalf("no Message-ID, first: %+v, %v", a, err)
	}
	if b, err := in.FileRaw(ctx, support, comm.TransportPOST, 0, plain); err != nil || !b.Duplicate {
		t.Errorf("no Message-ID, same message: %+v, %v", b, err)
	}
	if c, err := in.FileRaw(ctx, support, comm.TransportPOST, 0, rawMail("", "No id", "Other words.")); err != nil || c.Duplicate {
		t.Errorf("no Message-ID, different body: %+v, %v", c, err)
	}

	// Another project's copy doesn't count here.
	var otherProject int64
	if err := f.sp.P.QueryRow(ctx, `INSERT INTO card (card_type_id) SELECT id FROM card_type WHERE name = 'project' RETURNING id`).Scan(&otherProject); err != nil {
		t.Fatal(err)
	}
	if _, err := f.sp.P.Exec(ctx, `INSERT INTO comm_inbound_seen (project_id, message_key) VALUES ($1, 'mid:elsewhere@example.com')`, otherProject); err != nil {
		t.Fatal(err)
	}
	if r, err := in.FileRaw(ctx, support, comm.TransportPOST, 0, rawMail("<elsewhere@example.com>", "Elsewhere", "x")); err != nil || r.Duplicate {
		t.Errorf("a message another project saw: %+v, %v", r, err)
	}
}

// TestDedupeIMAPAfterPush: with IMAP polling and push both on for an account
// (switching over), the polled copy of a pushed message is marked seen and
// not filed again.
func TestDedupeIMAPAfterPush(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_dedupe_imap")
	channelID := seedChannelForIMAP(t, f, "support@example.com", f.statusID)
	in := &comm.Intake{Pool: f.sp}
	if _, err := in.FileRaw(context.Background(), channelID, comm.TransportPOST, 0, rawMail("<both@example.com>", "Both", "hi")); err != nil {
		t.Fatal(err)
	}
	before := tasksIn(t, f)
	stub := &stubIMAPClient{messages: []comm.InboundMessage{{UID: 7, MessageID: "<both@example.com>", From: "ada@example.com", Subject: "Both", Body: "hi"}}}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if got := tasksIn(t, f); got != before {
		t.Errorf("tasks = %d, want %d: the polled copy is a duplicate", got, before)
	}
	if marks := stub.marks(); len(marks) != 1 || marks[0] != 7 {
		t.Errorf("marked seen = %v, want [7]", marks)
	}
}

func TestIntakeRefusesPausedAndUnreadable(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_intake_errors")
	channelID := seedChannelForIMAP(t, f, "support@example.com", f.statusID)
	in := &comm.Intake{Pool: f.sp}
	ctx := context.Background()

	if _, err := in.FileRaw(ctx, channelID, comm.TransportPOST, 0, []byte("\x00\x01 not mail at all")); !errors.Is(err, comm.ErrUnparseable) {
		t.Errorf("garbage: %v, want ErrUnparseable", err)
	}
	if k := logKinds(t, f, channelID); k["parse_error"] != 1 {
		t.Errorf("log = %v, want a parse_error", k)
	}

	if err := comm.MarkChannelFault(ctx, f.sp, channelID, "test: paused"); err != nil {
		t.Fatal(err)
	}
	if _, err := in.FileRaw(ctx, channelID, comm.TransportPOST, 0, rawMail("<p@example.com>", "Paused", "x")); !errors.Is(err, comm.ErrChannelPaused) {
		t.Errorf("paused account: %v, want ErrChannelPaused", err)
	}
}

func TestDedupeRowsArePrunedByLastSeen(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_dedupe_prune")
	ctx := context.Background()
	for _, r := range []struct {
		key             string
		first, lastDays int
	}{{"mid:fresh", 30, 1}, {"mid:stale", 30, 20}} {
		if _, err := f.sp.P.Exec(ctx, `INSERT INTO comm_inbound_seen (project_id, message_key, first_seen_at, last_seen_at)
			VALUES ($1, $2, now() - make_interval(days => $3), now() - make_interval(days => $4))`, f.projectID, r.key, r.first, r.lastDays); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := comm.NewLogPruner(f.sp, 30*24*time.Hour).RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	var keys []string
	rows, err := f.sp.P.Query(ctx, `SELECT message_key FROM comm_inbound_seen WHERE project_id = $1 ORDER BY 1`, f.projectID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var k string
		_ = rows.Scan(&k)
		keys = append(keys, k)
	}
	rows.Close()
	if fmt.Sprint(keys) != "[mid:fresh]" {
		t.Errorf("kept %v, want [mid:fresh]: a row seen 1 day ago stays even though first seen 30 days ago", keys)
	}
}

// TestIMAPUnreadableMessageIsLoggedNotFiled: mail IMAP fetched but couldn't
// parse is logged as a parse_error and marked read — not filed as an empty
// thread (every empty message would share one dedupe key).
func TestIMAPUnreadableMessageIsLoggedNotFiled(t *testing.T) {
	f := setupAdmin(t, "kitp_test_comm_imap_unreadable")
	channelID := seedChannelForIMAP(t, f, "support@example.com", f.statusID)
	before := tasksIn(t, f)
	stub := &stubIMAPClient{messages: []comm.InboundMessage{
		{UID: 3, ParseError: "mail.ReadMessage: malformed header"},
		{UID: 4, ParseError: "mail.ReadMessage: malformed header"},
	}}
	p := comm.NewIMAPPollerForTest(f.sp, channelID, 5*time.Second)
	p.SetDialFunc(func(context.Context, comm.IMAPConfig) (comm.InboundClient, error) { return stub, nil })
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if got := tasksIn(t, f); got != before {
		t.Errorf("tasks = %d, want %d: nothing filed", got, before)
	}
	if marks := stub.marks(); len(marks) != 2 {
		t.Errorf("marked seen = %v, want both", marks)
	}
	if k := logKinds(t, f, channelID); k["parse_error"] != 2 || k["duplicate"] != 0 {
		t.Errorf("log = %v, want two parse_errors and no duplicates", k)
	}
}
