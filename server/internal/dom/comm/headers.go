package comm

import (
	"io"
	"mime"
	"net/mail"

	"golang.org/x/text/encoding/htmlindex"
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

// decodeHeaderText decodes a header value's encoded words (a Subject),
// or returns it as it came when it can't be decoded.
func decodeHeaderText(s string) string {
	d, err := headerDecoder.DecodeHeader(s)
	if err != nil {
		return s
	}
	return d
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
	if a.Name == "" {
		return a.Address
	}
	return a.Name + " <" + a.Address + ">"
}
