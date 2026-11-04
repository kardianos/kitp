package comm

import (
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
func ParseAddressList(s string) ([]*mail.Address, error) {
	p := mail.AddressParser{WordDecoder: headerDecoder}
	return p.ParseList(s)
}

// ParseAddress is ParseAddressList for a header that holds one address.
func ParseAddress(s string) (*mail.Address, error) {
	p := mail.AddressParser{WordDecoder: headerDecoder}
	return p.Parse(s)
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
