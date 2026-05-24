// comm_secret_refusal_test.go: SEC-8 / A7 — production must refuse to
// start when KITP_COMM_SECRET_KEY is unset (or left at the dev default),
// so real comm-channel credentials are never encrypted under a published
// key. Dev/test keeps booting with the fallback + one-shot warning.
package store_test

import (
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

func TestRefuseStartIfNoCommSecretKey(t *testing.T) {
	t.Run("production unset → refuse", func(t *testing.T) {
		t.Setenv("KITP_COMM_SECRET_KEY", "")
		if err := store.RefuseStartIfNoCommSecretKey("production"); err == nil {
			t.Fatal("expected production with unset key to refuse, got nil")
		}
	})
	t.Run("production dev-default → refuse", func(t *testing.T) {
		t.Setenv("KITP_COMM_SECRET_KEY", store.DevCommSecretKey)
		if err := store.RefuseStartIfNoCommSecretKey("production"); err == nil {
			t.Fatal("expected production with the dev default to refuse, got nil")
		}
	})
	t.Run("production real key → boot", func(t *testing.T) {
		t.Setenv("KITP_COMM_SECRET_KEY", "a-real-operator-supplied-key")
		if err := store.RefuseStartIfNoCommSecretKey("production"); err != nil {
			t.Fatalf("production with a real key should boot: %v", err)
		}
	})
	t.Run("dev unset → boot with fallback", func(t *testing.T) {
		t.Setenv("KITP_COMM_SECRET_KEY", "")
		if err := store.RefuseStartIfNoCommSecretKey("dev"); err != nil {
			t.Fatalf("dev with unset key should boot: %v", err)
		}
	})
}
