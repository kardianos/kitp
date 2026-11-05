package comm_test

// Review 2026-11-05 round 6 #5: threading never names a notification-shaped
// Message-ID, and In-Reply-To isn't a copy kitp sent on to someone else.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/mail"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/comm"
)

// latestThread is the newest comm and its first message.
func latestThread(t *testing.T, f *fixture) (commID, firstReply int64) {
	t.Helper()
	if err := f.sp.P.QueryRow(context.Background(), `
		SELECT c.id, (SELECT (e #>> '{}')::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id,
		                   jsonb_array_elements(av.value) e WHERE av.card_id = c.id AND ad.name = 'replies' LIMIT 1)
		FROM card c JOIN card_type ct ON ct.id = c.card_type_id WHERE ct.name = 'comm' ORDER BY c.id DESC LIMIT 1`).Scan(&commID, &firstReply); err != nil {
		t.Fatal(err)
	}
	return commID, firstReply
}

func TestNotificationShapedIDIsNotKept(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r8_notify_id")
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	first := inbound(10, "Question", "help please")
	first.MessageID = "<kitp-notify.trap@example.com>"
	pollOnce(t, f, ch, first)
	_, reply := latestThread(t, f)
	if got := storedMessageID(t, f, reply); got != "" {
		t.Errorf("stored %q: a notification-shaped id would turn the thread's relaying off", got)
	}
}

func TestInReplyToSkipsRelayCopies(t *testing.T) {
	f := setupAdmin(t, "kitp_test_r8_in_reply_to")
	ctx := context.Background()
	ch := seedChannelWith(t, f, `"intake_mode":"thread"`)
	first := inbound(10, "Question", "help please")
	first.MessageID = "in-r8@example.com"
	pollOnce(t, f, ch, first)
	commID, _ := latestThread(t, f)
	rt := &recordingTransport{}
	s := comm.NewSMTPSenderForTest(f.sp, ch, time.Second)
	s.SetTransport(rt.fn)
	send := func(body string) (int64, mail.Header) {
		t.Helper()
		var out comm.ReplyPostOutput
		dispatch(t, f, api.SubRequest{ID: "r", Endpoint: "reply", Action: "post", Data: json.RawMessage(
			fmt.Sprintf(`{"comm_id":"%d","body":%q}`, commID, body))}, &out)
		n := len(rt.calls)
		if err := s.RunOnce(ctx); err != nil {
			t.Fatalf("RunOnce: %v", err)
		}
		m, err := mail.ReadMessage(bytes.NewReader(rt.calls[n].msg))
		if err != nil {
			t.Fatal(err)
		}
		return out.ReplyID, m.Header
	}
	copyID, h1 := send("sent on to the others")
	// Make it a copy kitp sent on (relay.go sets relay_of on those).
	if _, err := f.sp.P.Exec(ctx, `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, id, to_jsonb($2::bigint) FROM attribute_def WHERE name = 'relay_of'`, copyID, commID); err != nil {
		t.Fatal(err)
	}
	_, h2 := send("an answer")
	if h2.Get("In-Reply-To") != "<in-r8@example.com>" {
		t.Errorf("In-Reply-To %q, want the incoming message, not the copy", h2.Get("In-Reply-To"))
	}
	if got := strings.Fields(h2.Get("References")); fmt.Sprint(got) != fmt.Sprint([]string{"<in-r8@example.com>", h1.Get("Message-ID")}) {
		t.Errorf("References %v, want both", got)
	}
}
