package comm

import (
	"errors"
	"io"
	"mime"
	"net/mail"
	"strings"
	"unicode"

	"golang.org/x/text/encoding/htmlindex"

	"github.com/kitp/kitp/server/internal/textnorm"
)

// headerDecoder decodes RFC 2047 encoded words ("=?UTF-8?B?…?=") in any
// charset golang.org/x/text knows, not just the UTF-8 / Latin-1 the
// standard library handles itself.
var headerDecoder = &mime.WordDecoder{
	CharsetReader: func(charset string, input io.Reader) (io.Reader, error) {
		enc, err := htmlindex.Get(charset)
		if err != nil {
			return nil, err
		}
		return enc.NewDecoder().Reader(input), nil
	},
}

// ParseAddressList parses an address-list header (From, To, Cc) whose
// display names may be encoded words in any charset headerDecoder knows.
// The standard parser refuses a name in windows-1252, ISO-2022-JP, GB2312
// and the like, and the whole header with it — an allow list then refuses
// the sender, DKIM alignment fails, and the people on it are lost (review
// 2026-11-03 round 2 #17).
//
// Every address must be plain (PlainAddress), or the whole header is
// refused with ErrOddAddress.
func ParseAddressList(s string) ([]*mail.Address, error) {
	p := mail.AddressParser{WordDecoder: headerDecoder}
	list, err := p.ParseList(s)
	if err != nil {
		return nil, err
	}
	for _, a := range list {
		if !PlainAddress(a.Address) {
			return nil, ErrOddAddress
		}
	}
	return list, nil
}

// ParseAddress is ParseAddressList for a header that holds one address.
func ParseAddress(s string) (*mail.Address, error) {
	p := mail.AddressParser{WordDecoder: headerDecoder}
	a, err := p.Parse(s)
	if err != nil {
		return nil, err
	}
	if !PlainAddress(a.Address) {
		return nil, ErrOddAddress
	}
	return a, nil
}

// ErrOddAddress is a header address kitp won't store or send to: see
// PlainAddress.
var ErrOddAddress = errors.New("mail: address with a quoted or unusual local part")

// PlainAddress reports whether addr is an addr-spec kitp stores, checks and
// sends to: one "@" between a non-empty local part and domain, and none of
// the characters only a quoted local part or a domain literal can hold —
// comma, semicolon, colon, double quote, angle and square brackets, parentheses,
// backslash, whitespace or control characters. net/mail hands back
// `"eve@evil.example, x"@ourco.example` unquoted, as
// `eve@evil.example, x@ourco.example`: an allow list read ourco.example
// after the last "@", and a reply to the stored address went to
// eve@evil.example as well (review 2026-11-03 round 3 #9). Real mail
// doesn't use such addresses (an apostrophe, as in o'brien@, is fine).
func PlainAddress(addr string) bool {
	at := strings.IndexByte(addr, '@')
	if at <= 0 || at == len(addr)-1 || strings.IndexByte(addr[at+1:], '@') >= 0 {
		return false
	}
	for _, r := range addr {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
		switch r {
		case ',', ';', ':', '"', '<', '>', '[', ']', '(', ')', '\\':
			return false
		}
	}
	return true
}

// decodeHeaderText decodes a header value's encoded words (a Subject),
// or returns it as it came when it can't be decoded.
// The result is storable (textnorm.Storable): an encoded word can decode
// to a NUL.
func decodeHeaderText(s string) string {
	d, err := headerDecoder.DecodeHeader(s)
	if err != nil {
		return textnorm.Storable(s)
	}
	return textnorm.Storable(d)
}

// displayAddress renders a From header for people — the thread view and
// the "On …, Name <addr> wrote:" quote header: the name decoded, then
// the address in angle brackets (review A27). A header that doesn't parse
// as one address comes back with its encoded words decoded.
func displayAddress(raw string) string {
	p := mail.AddressParser{WordDecoder: headerDecoder}
	a, err := p.Parse(raw)
	if err != nil {
		return decodeHeaderText(raw)
	}
	name := strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, textnorm.Storable(a.Name)))
	addr := textnorm.Storable(a.Address)
	if name == "" {
		return addr
	}
	return name + " <" + addr + ">"
}
