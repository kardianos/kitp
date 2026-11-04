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
