# MCP sign-in with OAuth (Claude connectors)

kitp's MCP endpoint, `/api/v1/mcp`, takes a bearer token that belongs to
an agent. People used to mint one by hand under **My Agents** and paste it
into their MCP client. That doesn't work for a Claude Team or Enterprise
organization. There, an Owner adds kitp once as a custom connector, and
Claude only offers OAuth sign-in or one request header that the whole
organization shares.

kitp is now an OAuth 2.1 authorization server, so each member connects as
**one of their own agents**:

1. The Owner adds kitp to Claude once.
2. Each member clicks **Connect** in Claude, signs in to kitp (SSO), and
   picks an agent on kitp's consent page.
3. Claude gets a token for that agent. Everything Claude does in kitp runs
   with the agent's roles and is recorded as the agent, on the member's
   behalf.

The code is in `server/internal/auth/oauth`. Trusted clients are managed
by `server/internal/dom/oauthclient` (the admin **MCP apps** screen).

## Turning it on (kitp operator)

| Setting | What it does |
| - | - |
| `KITP_PUBLIC_URL` | **Required.** The install's external base URL, `scheme://host[:port]` with no path, e.g. `https://kitp.example.com`. It is the OAuth issuer, and `<KITP_PUBLIC_URL>/api/v1/mcp` is the connector URL. When it is unset or has a path, OAuth is off (kitpd says which at startup) and the MCP endpoint takes only hand-minted tokens. A plain `http://` URL other than localhost logs a warning: tokens would travel unencrypted. |
| `KITP_TOKEN_MAX_DAYS` | Already caps API tokens; it also caps how long one connection lasts (default 365 days). After that, the member connects again. `0` means no cap. Separately, a connection that hasn't refreshed for 90 days ends. |

Which apps may sign members in is not a setting: admins decide it on the
**MCP apps** screen ([Which clients kitp trusts](#which-clients-kitp-trusts)).

Anthropic's servers must be able to reach kitp, discovery and token
endpoints included. Their traffic comes from `160.79.104.0/21`, so check
that no firewall or WAF in front of kitp blocks it.

## Adding kitp to Claude (Team / Enterprise Owner)

1. Go to **Organization settings → Connectors → Add → Custom → Web**.
2. **Name:** kitp (or the workspace's name).
3. **URL:** `<KITP_PUBLIC_URL>/api/v1/mcp`, exactly, with no trailing
   slash. This must match the `resource` kitp publishes.
4. **Authentication:** *Sign in now* (or *Sign in when needed*). Claude
   should mark it *Detected*.
5. **OAuth client:** *Use Claude's published identity*. Don't use
   *Use your own OAuth client*: kitp has no registered clients, and that
   option is refused with a page saying so.
6. **Request headers:** none.

### The first connection from claude.ai

kitp trusts Claude Code's published client ID out of the box. The Claude
apps (web, desktop and mobile) don't publish theirs in advance. The first
member to connect from claude.ai therefore sees **This app isn't allowed
yet** and clicks **Ask an administrator**. A kitp admin then allows that
client ID once on **Admin → Workspace → MCP apps**, after checking it is an
address on `claude.ai`. That member and everyone after connect normally.

### Members

Before connecting, each member needs at least one agent with roles:
**My Agents** in kitp → create an agent → give it the roles Claude should
have. The consent page lists only the member's own live agents. It marks
any agent with no roles, and links to My Agents when there are none.

Then in Claude: **Customize → Connectors →** the kitp connector →
**Connect**. Claude opens kitp. The member signs in if needed, picks the
agent, and clicks **Allow**.

### Claude Code

`claude mcp add --transport http kitp <KITP_PUBLIC_URL>/api/v1/mcp`, then
`/mcp` to sign in. Claude Code identifies itself as
`https://claude.ai/oauth/claude-code-client-metadata` and uses a callback on
`localhost` at a random port. kitp accepts any port, and the consent page
warns that a program on this computer will get access.

## What a connection is

- **The access token is a `user_token` of the chosen agent, with scope
  `mcp`.** It works on `/api/v1/mcp` only, the resource it was issued for,
  not on kitp's other bearer routes. It shows in the agent's token list as
  `<client> (OAuth, connected YYYY-MM-DD, #<n>)` with access "MCP only (app
  sign-in)". Revoking it there ends the connection: the next call fails, and
  so does the next refresh. Deleting the agent, revoking the member's login,
  or an admin no longer trusting the client ends it too.
- An access token lasts **one hour**. Claude refreshes it before then. Each
  refresh replaces both tokens. The `user_token` row stays the same row:
  its `id` (the hash) changes, and the old access token stops working at
  once.
- **Refresh tokens form a chain** (`oauth_refresh_token`). At any time one
  is current and the rest are spent or orphaned:
  - Presenting the current token spends it and issues its successor.
  - A spent token can be presented again within **two minutes**, while its
    successor is still current and so was never presented. That is a client
    retrying after a lost reply: the successor is *orphaned* and new tokens
    go out.
  - Any other reuse means two parties hold the connection's tokens, so the
    connection is revoked (OAuth 2.1 §4.3.1). That covers a spent token
    presented later, a spent token whose successor was already used, and an
    orphaned token at any time.
  - The catch for a thief: someone who replays a just-spent token gets one
    refresh. Their refresh kills the real client's access token, so Claude
    refreshes at once, presents its orphaned token, and the connection ends
    for both. Two parallel refreshes with one token count as reuse too.
- **Codes** from the consent page last five minutes and work once. A code
  is checked against its client, redirect URI and PKCE verifier first, so a
  stray copy is just refused. A complete replay revokes the connection the
  code made (RFC 6749 §4.1.2).

Tables (declarative, `db/schema/schema.hcsv`):

- **`oauth_grant`:** one row per connection. It holds the agent, who
  approved it, the client, the token's label, the last refresh time and the
  expiry.
- **`oauth_refresh_token`:** each connection's chain of refresh tokens.
- **`oauth_code`:** pending and spent codes.
- **`oauth_client`:** trusted clients, and members' requests.

Only hashes of codes and tokens are stored. The **`oauth.reap`** job runs
hourly and deletes:

- codes an hour past their expiry;
- spent and orphaned refresh tokens after 30 days;
- connections a day after they were revoked, expired, went idle, or had
  their token revoked, together with that connection's `user_token` row, so
  an agent's token list doesn't fill up.

## Endpoints

| Path | What |
| - | - |
| `POST /api/v1/mcp` | Without a valid token: `401` with `WWW-Authenticate: Bearer realm="kitp", resource_metadata="…"`. With a refused token, the challenge also has `error="invalid_token"`. Takes full-access and `mcp`-scoped tokens. |
| `GET /.well-known/oauth-protected-resource/api/v1/mcp` | RFC 9728 metadata: `resource` is the MCP URL, `authorization_servers` is `[KITP_PUBLIC_URL]`. The same document is also served at `/.well-known/oauth-protected-resource`. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 metadata: the code and refresh grants, `S256` PKCE only, `token_endpoint_auth_methods_supported: ["none"]`, and `client_id_metadata_document_supported: true`. There is no `registration_endpoint`. |
| `GET /api/v1/oauth/authorize` | A visitor with no session is sent to SSO (`/api/v1/auth/oidc/start?redirect=…`) before anything else happens. Then kitp checks the client and redirect URI and shows the consent page, or the "isn't allowed yet" page for an untrusted client. Loading it changes nothing. |
| `POST /api/v1/oauth/authorize` | The consent form (`decision` allow / deny) and the untrusted-client page's **Ask an administrator** (`decision=request`). It is refused cross-site (the router's cross-origin check), and the session and the form's `consent_token` are checked before anything else. Allow sends a code to the redirect URI with `state` and `iss`. |
| `POST /api/v1/oauth/token` | Form-encoded `authorization_code` (PKCE) and `refresh_token` grants. Errors use the OAuth shape (`invalid_grant`, …). |

The consent page is rendered on the server (`assets/page.html`,
`assets/consent.css`) under the app's CSP. On that page, `form-action` is
widened to the redirect URI's origin, because browsers apply it to the
redirect that answers the form. A request whose values aren't valid UTF-8,
or contain NUL, is refused with a page. Pages name at most the client's
host, never an address that came from the link.

## Which clients kitp trusts

kitp keeps no registered clients and offers no dynamic client
registration. Clients identify themselves with a **Client ID Metadata
Document**: the `client_id` is an HTTPS URL that serves the client's name
and redirect URIs (MCP authorization spec, 2025-11-25).

kitp trusts a client only when an `oauth_client` row with
`allowed = true` matches its `client_id`. A row is either an exact client
ID, or a prefix ending in `/` that covers every client ID under it.
Matching works like this:

- The presented client ID is normalised first: https only, a DNS host name
  (no IP literal, `localhost` or single-label name) lower-cased with any
  port, a path without dot segments (encoded or not), and no user info,
  query or fragment.
- Rows are kept in the same form by `oauth_client.set`.
- The check runs on every authorize request, code exchange and refresh, so
  an admin's change applies at once.

Trusting by client ID rather than by host matters. Anyone who can publish a
file on a trusted host could otherwise post a client named "Claude" whose
redirect URI is their own site. A member who clicks Allow without reading
would then hand that site a token for their agent. Use a prefix only for an
address where nobody but that company can publish files.

When kitp trusts a client, it fetches the document without following
redirects. The response must be JSON and at most 64 KB. A document is
reused for ten minutes, and a failed fetch is remembered for one minute. kitp
then checks the document:

- The document's `client_id` must be the URL it was fetched from.
- The client is public: no secret, and `token_endpoint_auth_method` is
  `none`.
- The `redirect_uri` must be one of the document's `redirect_uris`.
  - HTTPS URIs, to a DNS host name, match exactly.
  - `http://localhost` and `http://127.0.0.1` URIs match on any port.

### The MCP apps screen and members' requests

When a signed-in member arrives with a client ID kitp doesn't trust, kitp
shows **This app isn't allowed yet**, naming the client's host, with an
**Ask an administrator** button. Loading that page records nothing. The
button posts the form with its `consent_token`. Only then does kitp record
the request on `oauth_client` with `allowed = false`: the member, the time,
the `redirect_uri` the app sent, and a count.

The recording has limits so a member can't flood the list:

- at most 10 open requests per member and 200 overall, counted under a lock
  (past the cap the member is told to ask an admin directly);
- kitpd logs `oauth: member asked to allow a client`.

Under **Admin → Workspace → MCP apps**, waiting requests come first. A row
counts as waiting when it isn't allowed and was asked for after the last
admin decision. Each shows who asked, with an **Allow** button, which
trusts that exact client ID. Allowed clients have **Stop allowing**.
**+ Allow a client** adds an exact ID or a `/` prefix before anyone asks,
and **Delete** removes a row. These are the admin-only handlers
`oauth_client.list / .set / .delete`.

Stopping a client refuses new sign-ins and ends its connections at their
next refresh, within the hour. Members then connect again once it is
allowed. The seed, and migration `0048_oauth_clients` for existing installs,
trust `https://claude.ai/oauth/claude-code-client-metadata`.

## When it doesn't work

| Symptom | Likely cause |
| - | - |
| Claude: "Couldn't reach the MCP server" | `KITP_PUBLIC_URL` is unset or has a path (so the 401 has no metadata pointer), or Anthropic's range can't reach kitp. `curl -i -X POST <url>` should show the `resource_metadata` challenge. |
| kitp page: "identifies an app by its published client ID" | The connector was added with *Use your own OAuth client*. Add it again with *Use Claude's published identity*. |
| kitp page: "This app isn't allowed yet" | The client ID isn't trusted. The member clicks **Ask an administrator**; an admin checks the request on **MCP apps** and clicks **Allow**; the member connects again. Expected once, the first time anyone connects from claude.ai. |
| kitp page: "You don't have any agents yet" | Create an agent under My Agents and give it roles. |
| Tools fail after connecting | The chosen agent lacks roles for that project. Grant them under My Agents. |
| Claude asks to reconnect | The connection was revoked in kitp, its client was no longer trusted, it idled 90 days or reached `KITP_TOKEN_MAX_DAYS`, or a refresh token was reused. |

## Limits

- Only agents can be connected; a person can't connect as themselves.
  Agents keep Claude's actions separate and limited to the roles granted.
- A connection has one access token at a time. A request already in flight
  with the old token while Claude refreshes gets a 401. Claude refreshes on
  a 401, so the call after it works.
- A client must not refresh with the same token twice at once. Each request
  gets a 200, but only the last reply's refresh token stays current. The
  others are orphaned, and if the client keeps one of those, its next
  refresh is taken as reuse and ends the connection. That is the price of
  catching a stolen refresh token.
- Client IDs (and admin-added prefixes) must have plain paths: no `;`, no
  empty or dot segments.
- Request-header authentication (Claude's `static_headers`, one token for
  the whole organization) still works with a hand-minted token. Every
  member then acts as that one agent.
