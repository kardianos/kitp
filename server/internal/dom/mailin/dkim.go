package mailin

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/mail"
	"strings"
	"time"

	"github.com/emersion/go-msgauth/dkim"

	"github.com/kitp/kitp/server/internal/dom/comm"
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

// singleHeaders are the headers a message may carry at most once (RFC 5322
// §3.6). A second copy is how a forged From rides on a genuinely signed
// message: kitp reads the first, DKIM verifies the last (review 2026-11-03
// #9), so a message with two is refused.
var singleHeaders = []string{"From", "Sender", "Reply-To", "To", "Cc", "Subject", "Message-Id", "Date", "In-Reply-To", "References"}

// headerFrom returns the From: header of a raw message ("" when none), and
// a reason when the header block itself is unacceptable: a header that may
// appear once appears more than once.
func headerFrom(raw []byte) (from, bad string) {
	m, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return "", ""
	}
	for _, h := range singleHeaders {
		if n := len(m.Header[h]); n > 1 {
			return "", fmt.Sprintf("the message has %d %s headers", n, h)
		}
	}
	return m.Header.Get("From"), ""
}

// fromDomain is the domain of a From header with exactly one address, or "".
func fromDomain(from string) string {
	list, err := comm.ParseAddressList(from)
	if err != nil || len(list) != 1 {
		return ""
	}
	a := strings.ToLower(list[0].Address)
	at := strings.LastIndexByte(a, '@')
	if at < 0 {
		return ""
	}
	return a[at+1:]
}

// aligned reports whether a From domain and a DKIM signing domain belong
// together (DMARC's relaxed alignment, without the public-suffix list): the
// same domain, or one a subdomain of the other.
func aligned(from, signer string) bool {
	from, signer = strings.ToLower(from), strings.ToLower(signer)
	return from != "" && signer != "" &&
		(from == signer || strings.HasSuffix(from, "."+signer) || strings.HasSuffix(signer, "."+from))
}

// checkMessage applies the filters that need the message itself — header
// From and DKIM. It returns the failed check ("" when it passes) and why,
// and the Comm log rows to write after filing (dkim_result / dkim_failed).
//
// A message with a repeated From, Subject, Message-ID (… singleHeaders) is
// refused whenever either filter is set. With both set and the DKIM rule
// accepting any signer (no domains listed), the signature must also come
// from the From address's own domain: otherwise anyone could sign with
// their own domain and claim an allowed From. A listed signer (say, the
// organisation's own mail server forwarding customer mail) vouches for
// the From itself, so it needn't match.
func checkMessage(p Policy, raw []byte) (check, reason string, after []logRow) {
	from := ""
	if len(p.HeaderFrom) > 0 || p.DKIM != nil {
		var bad string
		from, bad = headerFrom(raw)
		if bad != "" {
			return "header_from", bad, nil
		}
	}
	if len(p.HeaderFrom) > 0 {
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
		if res.passes(p.DKIM) && len(p.HeaderFrom) > 0 && len(p.DKIM.Domains) == 0 {
			fd := fromDomain(from)
			ok := false
			for _, v := range res.Verified {
				if aligned(fd, v) {
					ok = true
					break
				}
			}
			if !ok {
				why := "no valid DKIM signature from the From address's domain " + quoteOrNone(fd)
				if p.DKIM.OnFail == OnFailFile {
					detail["reason"] = why
					return "", "", []logRow{{kind: "dkim_failed", detail: detail}}
				}
				return "dkim", why, nil
			}
		}
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
