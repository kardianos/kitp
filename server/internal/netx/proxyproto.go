package netx

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kitp/kitp/server/internal/job"
)

// PROXY protocol by sniffing (docs/MAIL_INTAKE_AND_CALENDARS.md §7). SMTP is
// server-speaks-first: a real client waits for the greeting. So before the
// server greets, a SniffListener waits briefly for bytes:
//
//   - nothing → a direct client; its TCP peer is its address;
//   - a PROXY header (v1 text "PROXY …\r\n" or the v2 binary signature) →
//     believed only from a trusted peer, and its source address becomes the
//     connection's RemoteAddr; from any other peer the connection is
//     dropped (it would let anyone claim any address);
//   - anything else → the client spoke before the greeting, a spam signal;
//     dropped.
//
// There is no switch to turn PROXY support on: a proxy that sends the
// header is recognised, one that doesn't isn't.

// v2Sig is the PROXY protocol v2 signature.
var v2Sig = []byte("\r\n\r\n\x00\r\nQUIT\n")

// Refusal reasons a SniffListener reports.
const (
	RefuseUntrustedProxy = "PROXY header from an untrusted peer"
	RefuseEarlyTalker    = "spoke before the greeting"
	RefuseBadProxyHeader = "malformed PROXY header"
)

// SniffListener wraps a listener; Accept returns connections whose
// RemoteAddr is already the real client.
type SniffListener struct {
	inner   net.Listener
	trusted *Trusted
	// Wait is how long to wait for a PROXY header before greeting (500 ms).
	Wait time.Duration
	// HeaderTimeout bounds reading a PROXY header once it has started (2 s).
	HeaderTimeout time.Duration
	// Admit, when set, runs on each sniffed connection with its real
	// address. A non-empty reply line ("421 …") is written and the
	// connection closed; otherwise release (when non-nil) runs once when
	// the connection closes. It is where the install allowlist and the
	// per-source connection limits go.
	Admit func(client netip.Addr) (reply string, release func())
	// OnRefuse records a dropped connection (for the Mail intake page).
	OnRefuse func(client netip.Addr, reason string)
	Logger   *slog.Logger

	conns     chan net.Conn
	errs      chan error
	closeOnce sync.Once
	done      chan struct{}
}

// NewSniffListener starts sniffing connections accepted from inner.
func NewSniffListener(inner net.Listener, trusted *Trusted) *SniffListener {
	l := &SniffListener{
		inner:         inner,
		trusted:       trusted,
		Wait:          500 * time.Millisecond,
		HeaderTimeout: 2 * time.Second,
		conns:         make(chan net.Conn),
		errs:          make(chan error, 1),
		done:          make(chan struct{}),
	}
	go l.acceptLoop()
	return l
}

func (l *SniffListener) logger() *slog.Logger {
	if l.Logger != nil {
		return l.Logger
	}
	return slog.Default()
}

// acceptLoop accepts until the listener closes. Any other Accept error —
// too many open files, a connection reset before accept — is logged and
// retried with a growing pause (5 ms up to 1 s, as net/http does), rather
// than ending the loop: that left the SMTP listener silently dead until a
// restart (review 2026-11-03 #22).
func (l *SniffListener) acceptLoop() {
	var pause time.Duration
	for {
		c, err := l.inner.Accept()
		if err != nil {
			select {
			case <-l.done:
				return
			default:
			}
			if errors.Is(err, net.ErrClosed) {
				select {
				case l.errs <- err:
				default:
				}
				return
			}
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			if pause == 0 {
				pause = 5 * time.Millisecond
			} else if pause *= 2; pause > time.Second {
				pause = time.Second
			}
			l.logger().Warn("smtp: accept failed; retrying", "err", err, "pause", pause)
			select {
			case <-time.After(pause):
			case <-l.done:
				return
			}
			continue
		}
		pause = 0
		go func() {
			// A panic sniffing one connection fails only that connection.
			if err := job.Protect(context.Background(), l.logger(), "smtp sniff", func() error {
				l.handle(c)
				return nil
			}); err != nil {
				_ = c.Close()
			}
		}()
	}
}

func (l *SniffListener) handle(c net.Conn) {
	peer := AddrOf(c.RemoteAddr())
	sc, reason, err := Sniff(c, l.trusted, l.Wait, l.HeaderTimeout)
	if err != nil {
		if reason != "" && l.OnRefuse != nil {
			l.OnRefuse(peer, reason)
		}
		_ = c.Close()
		return
	}
	client := AddrOf(sc.RemoteAddr())
	if l.Admit != nil {
		reply, release := l.Admit(client)
		if reply != "" {
			_ = sc.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_, _ = sc.Write([]byte(reply + "\r\n"))
			_ = sc.Close()
			if release != nil {
				release()
			}
			return
		}
		if release != nil {
			sc = &releasingConn{Conn: sc, release: release}
		}
	}
	select {
	case l.conns <- sc:
	case <-l.done:
		_ = sc.Close()
	}
}

// Accept returns the next sniffed connection.
func (l *SniffListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case err := <-l.errs:
		return nil, err
	case <-l.done:
		return nil, net.ErrClosed
	}
}

// Close stops accepting.
func (l *SniffListener) Close() error {
	var err error
	l.closeOnce.Do(func() {
		close(l.done)
		err = l.inner.Close()
	})
	return err
}

// Addr is the inner listener's address.
func (l *SniffListener) Addr() net.Addr { return l.inner.Addr() }

// sniffedConn is a connection whose first bytes were read by Sniff.
type sniffedConn struct {
	net.Conn
	r      *bufio.Reader
	remote net.Addr
}

func (c *sniffedConn) Read(p []byte) (int, error) { return c.r.Read(p) }
func (c *sniffedConn) RemoteAddr() net.Addr      { return c.remote }

// releasingConn runs release once when closed.
type releasingConn struct {
	net.Conn
	once    sync.Once
	release func()
}

func (c *releasingConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}

// Sniff inspects a fresh connection (see the package comment above). It
// returns the connection to use, or an error with the refusal reason.
func Sniff(c net.Conn, trusted *Trusted, wait, headerTimeout time.Duration) (net.Conn, string, error) {
	peer := AddrOf(c.RemoteAddr())
	r := bufio.NewReaderSize(c, 512)
	_ = c.SetReadDeadline(time.Now().Add(wait))
	first, err := r.Peek(1)
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			// Nothing sent: a direct client.
			_ = c.SetReadDeadline(time.Time{})
			return &sniffedConn{Conn: c, r: r, remote: c.RemoteAddr()}, "", nil
		}
		return nil, "", err
	}
	isV1 := first[0] == 'P'
	isV2 := first[0] == '\r'
	if !isV1 && !isV2 {
		return nil, RefuseEarlyTalker, errors.New(RefuseEarlyTalker)
	}
	_ = c.SetReadDeadline(time.Now().Add(headerTimeout))
	var src netip.AddrPort
	if isV1 {
		src, err = readV1(r)
	} else {
		src, err = readV2(r)
	}
	if err != nil {
		if errors.Is(err, errNotProxy) {
			return nil, RefuseEarlyTalker, errors.New(RefuseEarlyTalker)
		}
		return nil, RefuseBadProxyHeader, fmt.Errorf("%s: %w", RefuseBadProxyHeader, err)
	}
	if !trusted.Contains(peer) {
		return nil, RefuseUntrustedProxy, errors.New(RefuseUntrustedProxy)
	}
	if r.Buffered() > 0 {
		// Data right behind the header, before the greeting.
		return nil, RefuseEarlyTalker, errors.New(RefuseEarlyTalker)
	}
	_ = c.SetReadDeadline(time.Time{})
	remote := c.RemoteAddr()
	if src.IsValid() {
		remote = net.TCPAddrFromAddrPort(src)
	}
	return &sniffedConn{Conn: c, r: r, remote: remote}, "", nil
}

var errNotProxy = errors.New("not a PROXY header")

// readV1 reads "PROXY TCP4|TCP6|UNKNOWN src dst sport dport\r\n" (≤ 107
// bytes). UNKNOWN (a proxy's own health check) keeps the TCP peer.
func readV1(r *bufio.Reader) (netip.AddrPort, error) {
	head, err := r.Peek(6)
	if err != nil {
		return netip.AddrPort{}, err
	}
	if string(head) != "PROXY " {
		return netip.AddrPort{}, errNotProxy
	}
	var line []byte
	for len(line) < 107 {
		b, err := r.ReadByte()
		if err != nil {
			return netip.AddrPort{}, err
		}
		line = append(line, b)
		if b == '\n' {
			break
		}
	}
	if !bytes.HasSuffix(line, []byte("\r\n")) {
		return netip.AddrPort{}, errors.New("v1 header not terminated")
	}
	f := strings.Fields(strings.TrimSpace(string(line)))
	if len(f) >= 2 && f[1] == "UNKNOWN" {
		return netip.AddrPort{}, nil
	}
	if len(f) != 6 || (f[1] != "TCP4" && f[1] != "TCP6") {
		return netip.AddrPort{}, fmt.Errorf("v1 header %q", strings.TrimSpace(string(line)))
	}
	a, err := netip.ParseAddr(f[2])
	if err != nil {
		return netip.AddrPort{}, err
	}
	port, err := strconv.ParseUint(f[4], 10, 16)
	if err != nil {
		return netip.AddrPort{}, err
	}
	return netip.AddrPortFrom(a.Unmap(), uint16(port)), nil
}

// readV2 reads a binary v2 header. LOCAL (the proxy's own connection)
// keeps the TCP peer.
func readV2(r *bufio.Reader) (netip.AddrPort, error) {
	head, err := r.Peek(16)
	if err != nil {
		return netip.AddrPort{}, err
	}
	if !bytes.Equal(head[:12], v2Sig) {
		return netip.AddrPort{}, errNotProxy
	}
	verCmd, fam := head[12], head[13]
	n := int(binary.BigEndian.Uint16(head[14:16]))
	if verCmd>>4 != 2 || n > 216 {
		return netip.AddrPort{}, errors.New("v2 header version or length")
	}
	buf := make([]byte, 16+n)
	if _, err := ioReadFull(r, buf); err != nil {
		return netip.AddrPort{}, err
	}
	body := buf[16:]
	if verCmd&0x0f == 0 { // LOCAL
		return netip.AddrPort{}, nil
	}
	switch fam {
	case 0x11, 0x12: // TCP / UDP over IPv4
		if len(body) < 12 {
			return netip.AddrPort{}, errors.New("v2 IPv4 addresses")
		}
		a := netip.AddrFrom4([4]byte(body[0:4]))
		return netip.AddrPortFrom(a, binary.BigEndian.Uint16(body[8:10])), nil
	case 0x21, 0x22: // over IPv6
		if len(body) < 36 {
			return netip.AddrPort{}, errors.New("v2 IPv6 addresses")
		}
		a := netip.AddrFrom16([16]byte(body[0:16])).Unmap()
		return netip.AddrPortFrom(a, binary.BigEndian.Uint16(body[32:34])), nil
	}
	return netip.AddrPort{}, nil // UNSPEC / unix: keep the TCP peer
}

func ioReadFull(r *bufio.Reader, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := r.Read(buf[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}
