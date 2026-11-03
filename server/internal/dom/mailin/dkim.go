package mailin

import (
	"bytes"
	"context"
	"net"
	"net/mail"
	"strings"
	"time"

	"github.com/emersion/go-msgauth/dkim"
)

// dkimResult is what DKIM verification of one message found.
type dkimResult struct {
	Verified []string // signing domains (d=) whose signature checked out
	Failed   []string // "domain: why" for signatures that didn't
}

// lookupTXT is the DNS lookup DKIM uses; tests swap it.
var lookupTXT = func(domain string) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return net.DefaultResolver.LookupTXT(ctx, domain)
}

func verifyDKIM(raw []byte) dkimResult {
	var res dkimResult
	vs, err := dkim.VerifyWithOptions(bytes.NewReader(raw), &dkim.VerifyOptions{LookupTXT: lookupTXT, MaxVerifications: 10})
	if err != nil && len(vs) == 0 {
		res.Failed = append(res.Failed, "message: "+err.Error())
		return res
	}
	for _, v := range vs {
		if v.Err == nil {
			res.Verified = append(res.Verified, strings.ToLower(v.Domain))
		} else {
			res.Failed = append(res.Failed, strings.ToLower(v.Domain)+": "+v.Err.Error())
		}
	}
	return res
}

// passes reports whether the result satisfies a require rule: a valid
// signature from a listed domain, or any valid one when none is listed.
func (r dkimResult) passes(d *DKIM) bool {
	for _, v := range r.Verified {
		if len(d.Domains) == 0 {
			return true
		}
		for _, e := range d.Domains {
			if DomainMatches(v, e) {
				return true
			}
		}
	}
	return false
}

// headerFrom returns the From: header of a raw message ("" when none).
func headerFrom(raw []byte) string {
	m, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return ""
	}
	return m.Header.Get("From")
}

// checkMessage applies the filters that need the message itself — header
// From and DKIM. It returns the failed check ("" when it passes) and why,
// and the Comm log rows to write after filing (dkim_result / dkim_failed).
func checkMessage(p Policy, raw []byte) (check, reason string, after []logRow) {
	if len(p.HeaderFrom) > 0 {
		from := headerFrom(raw)
		if !AddressAllowed(p.HeaderFrom, from) {
			return "header_from", "From " + quoteOrNone(from) + " is not on the allow list", nil
		}
	}
	if p.DKIM == nil {
		return "", "", nil
	}
	res := verifyDKIM(raw)
	detail := map[string]any{"verified": nonNil(res.Verified), "failed": nonNil(res.Failed)}
	switch p.DKIM.Mode {
	case DKIMRecord:
		return "", "", []logRow{{kind: "dkim_result", detail: detail}}
	case DKIMRequire:
		if res.passes(p.DKIM) {
			return "", "", nil
		}
		why := "no valid DKIM signature"
		if len(p.DKIM.Domains) > 0 {
			why += " from " + strings.Join(p.DKIM.Domains, ", ")
		}
		if p.DKIM.OnFail == OnFailFile {
			detail["reason"] = why
			return "", "", []logRow{{kind: "dkim_failed", detail: detail}}
		}
		return "dkim", why, nil
	}
	return "", "", nil
}

type logRow struct {
	kind   string
	detail map[string]any
}

func quoteOrNone(s string) string {
	if strings.TrimSpace(s) == "" {
		return "(none)"
	}
	return "\"" + s + "\""
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
