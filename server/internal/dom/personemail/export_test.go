package personemail

import (
	"context"
	"sync"
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
	old := transport
	transport = func(_ context.Context, _ string, _ int, _, _, _, to string, msg []byte) error {
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
			transport = old
		}
}
