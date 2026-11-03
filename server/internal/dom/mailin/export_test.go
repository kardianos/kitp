package mailin

import "context"

// SetLookupTXTForTest swaps the DNS lookup DKIM uses; call the returned
// function to restore it.
func SetLookupTXTForTest(f func(string) ([]string, error)) func() {
	old := lookupTXT
	lookupTXT = f
	return func() { lookupTXT = old }
}

// SetSenderDNSForTest swaps the sender_hosts DNS lookups.
func SetSenderDNSForTest(addr func(context.Context, string) ([]string, error), host func(context.Context, string) ([]string, error)) func() {
	oa, oh := lookupAddr, lookupHost
	lookupAddr, lookupHost = addr, host
	return func() { lookupAddr, lookupHost = oa, oh }
}
