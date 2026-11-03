# Mail intake

How mail reaches kitp from outside, besides polling an IMAP mailbox. A mail account (Comm Channels) can have **routes**:

- a **POST route** — a URL a mail provider sends each message to (Cloudflare, Mailgun, Postmark, SES, a script);
- an **SMTP route** — an address for kitp's own SMTP listener, which a mailbox forwards to.

This page shows the install-wide side: the listener, its certificate, which proxies are trusted, the rate limits, and what was turned away before reaching any account. Everything here is set by environment variables on the kitp server; the counts are kept in memory and reset when kitp restarts.

## The SMTP listener

| Setting | |
| ------- | - |
| `KITP_SMTP_ADDR` | Where it listens, e.g. `:2525`. Off when unset. |
| `KITP_SMTP_DOMAIN` | The domain of route addresses: `<token>@<domain>`. Required. Mail for any other domain is refused, so kitp never relays. |
| `KITP_SMTP_HOSTNAME` | The name it greets with; defaults to the domain. |
| `KITP_SMTP_TLS_CERT`, `KITP_SMTP_TLS_KEY` | PEM files for STARTTLS. Re-read when they change, so a cert-manager renewal needs no restart. Without them, senders deliver unencrypted. |
| `KITP_SMTP_MAX_BYTES` | Largest message; default 40 MB. |
| `KITP_SMTP_ALLOW` | Optional CIDRs: only these may connect at all. |

### Making it reachable

1. Pick a domain for route addresses, e.g. `in.example.com` — a subdomain, because an MX record covers a whole domain.
2. Add an MX record for it pointing at the host kitp's listener is reached on.
3. Open **TCP port 25** to that host and pass it to `KITP_SMTP_ADDR` (senders always deliver to port 25). Many home and some cloud networks block inbound 25.
4. Get a certificate for the MX host name (e.g. with cert-manager) and set the two TLS variables.
5. On Comm Channels, add an **SMTP address** to the account and point a forward at it.

### Behind a proxy

STARTTLS happens inside kitp, so a proxy in front must pass the TCP connection through rather than terminate TLS. To keep the sender's real address (for Sources, Sender hosts and rate limits), have the proxy send a PROXY protocol header — kitp recognises one by itself, there is no switch:

| Proxy | Setting |
| ----- | ------- |
| Traefik | on the TCP service: `proxyProtocol: {version: 2}` |
| HAProxy | `send-proxy-v2` on the server line |
| nginx (stream) | `proxy_protocol on;` |
| AWS NLB | the target group's *proxy protocol v2* attribute |

A PROXY header is believed only from a **trusted proxy** (below); from anyone else the connection is dropped, since it would let a sender claim any address. A client that sends anything before kitp's greeting is dropped too — real mail servers wait.

## Trusted proxies

`KITP_TRUSTED_PROXIES` — whose word about the client's address kitp believes: the PROXY header on SMTP, `X-Forwarded-For` on POST routes. Unset, it is any private or loopback address (10/8, 172.16/12, 192.168/16, 100.64/10, 127/8, ::1, fc00::/7) — where a proxy in front of kitp normally sits. Set it to narrow that to your proxy's own range; a public range is refused at startup.

## Rate limits

Generous, in memory, per source address (IPv6 grouped by /64) and per route. A *miss* — an unknown address or token, a refused filter — counts ten times, so a source guessing addresses is slowed first. A throttled SMTP sender gets a temporary error (it retries later); a POST client gets 429. *Throttled now* lists who is held back.

## Recent refusals

Connections and requests turned away before they reached a mail account, so they can't be in any account's Comm log: an unknown route, a PROXY header from an untrusted peer, a client that spoke early, a source outside `KITP_SMTP_ALLOW`, a rate limit. Refusals by a route's own filters are in the Comm log, on the route.
