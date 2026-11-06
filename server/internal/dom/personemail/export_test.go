package personemail

import (
	"context"
	"sync"

	"github.com/kitp/kitp/server/internal/dom/comm"
)

// SentMail is one message the test transport took.
type SentMail struct {
	To  string
	Msg []byte
}

// CaptureMailForTest swaps the SMTP transport for one that records each
// message; the returned func lists them, and restore puts the real one back.
func CaptureMailForTest() (sent func() []SentMail, restore func()) {
	var mu sync.Mutex
	var got []SentMail
	old, oldAPI := transport, apiTransport
	transport = func(_ context.Context, _ string, _ int, _, _, _, to string, msg []byte) error {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, SentMail{To: to, Msg: append([]byte(nil), msg...)})
		return nil
	}
	apiTransport = func(_ context.Context, _ comm.Outbound, _, to string, msg []byte) error {
		mu.Lock()
		defer mu.Unlock()
		got = append(got, SentMail{To: to, Msg: append([]byte(nil), msg...)})
		return nil
	}
	return func() []SentMail {
			mu.Lock()
			defer mu.Unlock()
			return append([]SentMail(nil), got...)
		}, func() {
			transport, apiTransport = old, oldAPI
		}
}

// HoldingMailForTest swaps both transports for one that records each
// message, says on entered that it has one, then holds it until release
// is closed — so concurrent batches all reach their sends together.
func HoldingMailForTest(release <-chan struct{}, entered chan<- string) (sent func() []SentMail, restore func()) {
	var mu sync.Mutex
	var got []SentMail
	old, oldAPI := transport, apiTransport
	rec := func(to string, msg []byte) {
		mu.Lock()
		got = append(got, SentMail{To: to, Msg: append([]byte(nil), msg...)})
		mu.Unlock()
		entered <- to
		<-release
	}
	transport = func(_ context.Context, _ string, _ int, _, _, _, to string, msg []byte) error {
		rec(to, msg)
		return nil
	}
	apiTransport = func(_ context.Context, _ comm.Outbound, _, to string, msg []byte) error {
		rec(to, msg)
		return nil
	}
	return func() []SentMail {
			mu.Lock()
			defer mu.Unlock()
			return append([]SentMail(nil), got...)
		}, func() {
			transport, apiTransport = old, oldAPI
		}
}

// RefusingMailForTest records each message and refuses (550) those to
// refuse, as a mail server refusing that recipient would.
func RefusingMailForTest(refuse string) (sent func() []SentMail, restore func()) {
	var mu sync.Mutex
	var got []SentMail
	old, oldAPI := transport, apiTransport
	transport = func(_ context.Context, _ string, _ int, _, _, _, to string, msg []byte) error {
		if to == refuse {
			return &comm.SMTPBounceError{Code: 550, Msg: "no such user"}
		}
		mu.Lock()
		defer mu.Unlock()
		got = append(got, SentMail{To: to, Msg: append([]byte(nil), msg...)})
		return nil
	}
	return func() []SentMail {
			mu.Lock()
			defer mu.Unlock()
			return append([]SentMail(nil), got...)
		}, func() {
			transport, apiTransport = old, oldAPI
		}
}
