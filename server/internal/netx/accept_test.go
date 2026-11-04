package netx

import (
	"net"
	"os"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// flakyListener fails its first Accept with EMFILE, then hands out ch.
type flakyListener struct {
	calls atomic.Int32
	ch    chan net.Conn
}

func (l *flakyListener) Accept() (net.Conn, error) {
	if l.calls.Add(1) == 1 {
		return nil, &net.OpError{Op: "accept", Net: "tcp", Err: os.NewSyscallError("accept", syscall.EMFILE)}
	}
	c, ok := <-l.ch
	if !ok {
		return nil, net.ErrClosed
	}
	return c, nil
}
func (l *flakyListener) Close() error   { return nil }
func (l *flakyListener) Addr() net.Addr { return &net.TCPAddr{} }

// TestAcceptSurvivesTemporaryError (review 2026-11-03 #22): an Accept error
// other than "closed" doesn't end the accept loop — the next connection is
// still served.
func TestAcceptSurvivesTemporaryError(t *testing.T) {
	inner := &flakyListener{ch: make(chan net.Conn, 1)}
	tr, err := ParseTrusted("")
	if err != nil {
		t.Fatal(err)
	}
	sl := NewSniffListener(inner, tr)
	sl.Wait = 20 * time.Millisecond
	defer sl.Close()
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	inner.ch <- a
	got := make(chan error, 1)
	go func() {
		c, err := sl.Accept()
		if c != nil {
			_ = c.Close()
		}
		got <- err
	}()
	select {
	case err := <-got:
		if err != nil {
			t.Fatalf("Accept after a temporary error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("Accept blocked: the accept loop stopped after one error (inner Accept called %d times)", inner.calls.Load())
	}
}
