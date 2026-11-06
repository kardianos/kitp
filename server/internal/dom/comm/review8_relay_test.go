package comm_test

import (
	"context"
	"testing"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

// TestMailFromAKitpUserIsntSentOn (review 2026-11-06 #8): mail whose From
// is a kitp user's — the primary, or a verified second address — is filed
// but never sent on: its From isn't authenticated, and the copy would go
// to the thread's people as "Carol via Support" from the organisation's own
// address. A correspondent's reply still is.
func TestMailFromAKitpUserIsntSentOn(t *testing.T) {
	r := newRelayFixture(t, "kitp_test_r8_relay_user", "")
	ctx := context.Background()
	var carol int64
	if err := r.f.sp.P.QueryRow(ctx, `
		SELECT av.card_id FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE ad.name = 'email' AND av.value #>> '{}' = 'carol@ourco.example'`).Scan(&carol); err != nil {
		t.Fatal(err)
	}
	if _, err := r.f.sp.P.Exec(ctx, `INSERT INTO person_email (person_card_id, email, source, verified_at) VALUES ($1, 'carol.home@gmail.example', 'added', now())`, carol); err != nil {
		t.Fatal(err)
	}
	for i, from := range []string{"Carol <carol@ourco.example>", "Carol <carol.home@gmail.example>"} {
		r.reply(t, uint32(10+i), func(m *comm.InboundMessage) {
			m.From = from
			m.MessageID = "<spoof-" + string(rune('a'+i)) + "@x.example>"
		})
		if got := relayCopies(t, r); len(got) != 0 {
			t.Fatalf("mail from %s was sent on: %v", from, got)
		}
		if d := logDetail(t, r.f, r.ch, "relay_skipped"); d["reason"] != "sender_is_user" {
			t.Errorf("mail from %s: relay_skipped %v, want sender_is_user", from, d)
		}
	}
	// Ada, a correspondent on the thread, is still sent on to Bob.
	r.reply(t, 20, func(m *comm.InboundMessage) { m.MessageID = "<ada-r8@x.example>" })
	if got := relayCopies(t, r); len(got) != 1 || got[0] != "bob@example.com" {
		t.Errorf("Ada's reply: copies %v, want one to bob@example.com", got)
	}
}
