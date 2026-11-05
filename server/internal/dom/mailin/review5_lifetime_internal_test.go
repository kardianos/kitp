package mailin

import (
	"io"
	"net"
	"testing"
	"time"
)

// TestConnectionLifetimeStartsAtAccept (review 2026-11-03 round 5 #8): a
// connection is closed its lifetime after accept, whether or not the peer
// ever says EHLO.
func TestConnectionLifetimeStartsAtAccept(t *testing.T) {
	inner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l := &lifetimeListener{Listener: inner, life: 200 * time.Millisecond}
	defer l.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := l.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	client, err := net.Dial("tcp", inner.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	defer server.Close()
	if err := client.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = client.Read(make([]byte, 1))
	if err != io.EOF {
		t.Fatalf("read: %v, want EOF when the lifetime ends", err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("closed after %v, want about 200ms", d)
	}
}
