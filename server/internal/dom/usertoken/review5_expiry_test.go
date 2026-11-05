package usertoken_test

// New tokens last at most KITP_TOKEN_MAX_DAYS (review 2026-11-03 round 4).

import (
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/usertoken"
)

func TestTokenLifetimeIsCapped(t *testing.T) {
	usertoken.SetMaxDays(30)
	defer usertoken.SetMaxDays(usertoken.DefaultMaxDays)
	ins, err := usertoken.PreRunCreateForTest([]any{usertoken.CreateInput{UserID: 1, Label: "a"}})
	if err != nil {
		t.Fatal(err)
	}
	at, err := time.Parse(time.RFC3339, ins[0].(usertoken.CreateInput).ExpiresAt)
	if err != nil {
		t.Fatalf("no default expiry: %v", err)
	}
	if d := time.Until(at); d < 29*24*time.Hour || d > 31*24*time.Hour {
		t.Errorf("default expiry in %v, want about 30 days", d)
	}
	far := time.Now().Add(400 * 24 * time.Hour).UTC().Format(time.RFC3339)
	if _, err := usertoken.PreRunCreateForTest([]any{usertoken.CreateInput{UserID: 1, Label: "b", ExpiresAt: far}}); err == nil {
		t.Error("a token past the cap was accepted")
	}
}

// TestTokenCapReadsEveryTimestampForm (round 5 #10): an expiry written with
// a lower-case t or z, which the SQL takes, is held to the cap too; one
// that doesn't parse is refused before the SQL.
func TestTokenCapReadsEveryTimestampForm(t *testing.T) {
	usertoken.SetMaxDays(30)
	defer usertoken.SetMaxDays(usertoken.DefaultMaxDays)
	for _, c := range []struct {
		at string
		ok bool
	}{
		{"2099-01-01t00:00:00z", false},
		{"2099-01-01T00:00:00z", false},
		{time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02t15:04:05z"), true},
		{"tomorrow", false},
	} {
		ins, err := usertoken.PreRunCreateForTest([]any{usertoken.CreateInput{UserID: 1, Label: "x", ExpiresAt: c.at}})
		if (err == nil) != c.ok {
			t.Errorf("expires_at %q: err %v, want ok=%v", c.at, err, c.ok)
			continue
		}
		if c.ok {
			if _, err := time.Parse(time.RFC3339Nano, ins[0].(usertoken.CreateInput).ExpiresAt); err != nil {
				t.Errorf("expires_at %q passed on as %q", c.at, ins[0].(usertoken.CreateInput).ExpiresAt)
			}
		}
	}
	for _, n := range []int64{-1, usertoken.MaxMaxDays + 1} {
		if usertoken.CheckMaxDays(n) == nil {
			t.Errorf("KITP_TOKEN_MAX_DAYS=%d accepted", n)
		}
	}
	if usertoken.CheckMaxDays(0) != nil || usertoken.CheckMaxDays(365) != nil {
		t.Error("a valid KITP_TOKEN_MAX_DAYS refused")
	}
}
