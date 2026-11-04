// Package mailin receives mail pushed to kitp — POST from a provider
// (Cloudflare, Mailgun, Postmark, anything that can send the raw message)
// and the SMTP listener — and files it through comm.Intake. Each way in is
// a route: a card_access row on the mail account holding a secret token,
// a provider and a policy of filters. See docs/MAIL_INTAKE_AND_CALENDARS.md
// §5–7.
package mailin

import (
	"encoding/json"
	"fmt"
	"net/mail"
	"net/netip"
	"sort"
	"strings"
)

// Route purposes and POST providers.
const (
	PurposePOST = "inbound_post"
	PurposeSMTP = "inbound_smtp"

	ProviderRaw      = "raw"
	ProviderMailgun  = "mailgun"
	ProviderPostmark = "postmark"
)

// DKIM modes and failure actions.
const (
	DKIMOff     = "off"
	DKIMRecord  = "record"
	DKIMRequire = "require"

	OnFailRefuse = "refuse"
	OnFailFile   = "file"
)

// Policy is a route's filters; every one is optional. Address lists take
// "a@b.com" (that address), "b.com" or "@b.com" (that domain exactly) and
// ".b.com" (any subdomain of b.com); host suffixes take ".b.com" or "b.com".
type Policy struct {
	// Sources: CIDRs the sender must come from (SMTP: the peer; POST: the
	// client IP through trusted proxies).
	Sources []string `json:"sources,omitempty"`
	// RequireTLS: SMTP only — refuse a recipient before STARTTLS.
	RequireTLS bool `json:"require_tls,omitempty"`
	// SenderHosts: SMTP only — the peer's forward-confirmed reverse DNS
	// name must end with one of these (".outbound.protection.outlook.com").
	SenderHosts []string `json:"sender_hosts,omitempty"`
	// EnvelopeFrom: SMTP only — allowed MAIL FROM addresses / domains. An
	// Exchange forward's envelope is bounces+SRS=…@<your domain>.
	EnvelopeFrom []string `json:"envelope_from,omitempty"`
	// HeaderFrom: allowed From: header addresses / domains.
	HeaderFrom []string `json:"header_from,omitempty"`
	DKIM       *DKIM    `json:"dkim,omitempty"`
}

// DKIM is the route's DKIM rule.
type DKIM struct {
	// Mode: off (the default), record (verify and log, never refuse) or
	// require (a valid signature from Domains — any domain when empty).
	Mode    string   `json:"mode"`
	Domains []string `json:"domains,omitempty"`
	// OnFail (require): refuse (the default) or file (filed, with a
	// dkim_failed log row).
	OnFail string `json:"on_fail,omitempty"`
}

// UnmarshalJSON validates and normalises a policy as it arrives, so a bad
// filter is refused when the route is saved rather than when mail comes.
func (p *Policy) UnmarshalJSON(b []byte) error {
	type plain Policy
	var v plain
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*p = Policy(v)
	return p.normalise()
}

func (p *Policy) normalise() error {
	var err error
	if p.Sources, err = normCIDRs(p.Sources); err != nil {
		return err
	}
	if p.SenderHosts, err = normDomains("sender_hosts", p.SenderHosts, false); err != nil {
		return err
	}
	if p.EnvelopeFrom, err = normAddressList("envelope_from", p.EnvelopeFrom); err != nil {
		return err
	}
	if p.HeaderFrom, err = normAddressList("header_from", p.HeaderFrom); err != nil {
		return err
	}
	if p.DKIM != nil {
		d := p.DKIM
		d.Mode = strings.ToLower(strings.TrimSpace(d.Mode))
		switch d.Mode {
		case "", DKIMOff:
			p.DKIM = nil
			return nil
		case DKIMRecord, DKIMRequire:
		default:
			return fmt.Errorf("dkim.mode %q: use off, record or require", d.Mode)
		}
		d.OnFail = strings.ToLower(strings.TrimSpace(d.OnFail))
		switch d.OnFail {
		case "":
			d.OnFail = OnFailRefuse
		case OnFailRefuse, OnFailFile:
		default:
			return fmt.Errorf("dkim.on_fail %q: use refuse or file", d.OnFail)
		}
		if d.Domains, err = normDomains("dkim.domains", d.Domains, true); err != nil {
			return err
		}
	}
	return nil
}

func normCIDRs(in []string) ([]string, error) {
	var out []string
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		pfx, err := netip.ParsePrefix(s)
		if err != nil {
			a, aerr := netip.ParseAddr(s)
			if aerr != nil {
				return nil, fmt.Errorf("sources: %q is not a CIDR or an address", s)
			}
			pfx = netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen())
		}
		out = append(out, pfx.Masked().String())
	}
	return dedupe(out), nil
}

// normDomains: "b.com", "@b.com" (exact) or ".b.com" (subdomains). allowAt
// keeps a leading @ as exact.
func normDomains(field string, in []string, allowAt bool) ([]string, error) {
	var out []string
	for _, s := range in {
		s = strings.ToLower(strings.TrimSpace(s))
		if allowAt {
			s = strings.TrimPrefix(s, "@")
		}
		if s == "" {
			continue
		}
		if !validDomain(strings.TrimPrefix(s, ".")) {
			return nil, fmt.Errorf("%s: %q is not a domain", field, s)
		}
		out = append(out, s)
	}
	return dedupe(out), nil
}

// normAddressList: addresses stay addresses; "@b.com" becomes "b.com".
func normAddressList(field string, in []string) ([]string, error) {
	var out []string
	for _, s := range in {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" {
			continue
		}
		if at := strings.LastIndexByte(s, '@'); at > 0 {
			if _, err := mail.ParseAddress(s); err != nil || !validDomain(s[at+1:]) {
				return nil, fmt.Errorf("%s: %q is not an address", field, s)
			}
			out = append(out, s)
			continue
		}
		s = strings.TrimPrefix(s, "@")
		if !validDomain(strings.TrimPrefix(s, ".")) {
			return nil, fmt.Errorf("%s: %q is not an address or a domain", field, s)
		}
		out = append(out, s)
	}
	return dedupe(out), nil
}

func validDomain(d string) bool {
	if d == "" || len(d) > 253 || strings.HasPrefix(d, ".") || strings.HasSuffix(d, ".") || !strings.Contains(d, ".") {
		return false
	}
	for _, label := range strings.Split(d, ".") {
		if label == "" || len(label) > 63 {
			return false
		}
		for _, r := range label {
			if !(r == '-' || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')) {
				return false
			}
		}
	}
	return true
}

func dedupe(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	sort.Strings(in)
	out := in[:1]
	for _, s := range in[1:] {
		if s != out[len(out)-1] {
			out = append(out, s)
		}
	}
	return out
}

// DomainMatches reports whether a domain matches a list entry: "b.com"
// exactly, ".b.com" any subdomain.
func DomainMatches(domain, entry string) bool {
	domain = strings.ToLower(strings.TrimSuffix(domain, "."))
	if strings.HasPrefix(entry, ".") {
		return strings.HasSuffix(domain, entry)
	}
	return domain == entry
}

// AddressAllowed reports whether an address matches an allow list (empty =
// anything). addr may carry a display name ("Ada <ada@b.com>"), but must be
// exactly one address: a list ("Eve <eve@evil>, x@staff") or anything that
// doesn't parse is refused, rather than judged by the domain after its last
// "@" (review 2026-11-03 #21). An SMTP envelope address ("ada@b.com", no
// brackets) parses the same way.
func AddressAllowed(list []string, addr string) bool {
	if len(list) == 0 {
		return true
	}
	parsed, err := mail.ParseAddressList(addr)
	if err != nil || len(parsed) != 1 {
		return false
	}
	a := strings.ToLower(parsed[0].Address)
	at := strings.LastIndexByte(a, '@')
	if at < 0 {
		return false
	}
	domain := a[at+1:]
	for _, e := range list {
		if strings.Contains(e, "@") {
			if a == e {
				return true
			}
			continue
		}
		if DomainMatches(domain, e) {
			return true
		}
	}
	return false
}

// HostAllowed reports whether a host name ends with one of the suffixes
// (".b.com" any subdomain; "b.com" that host or any subdomain).
func HostAllowed(suffixes []string, host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, s := range suffixes {
		bare := strings.TrimPrefix(s, ".")
		if host == bare && !strings.HasPrefix(s, ".") {
			return true
		}
		if strings.HasSuffix(host, "."+bare) {
			return true
		}
	}
	return false
}
