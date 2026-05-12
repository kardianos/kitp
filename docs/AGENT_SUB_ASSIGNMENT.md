# Agents-as-sub-assignments (MCP) — design options

Status: draft. Asks for a direction before implementation.

## Goal

A human user puts an MCP-driven agent on a timer. The agent
periodically pulls tasks assigned **to the agent** (not to the human
directly) and acts on them. From a project-management perspective the
agent reads as its own assignee: collaborators see "alice's research
agent" as the assignee, not "alice"; alice can see all her work in
one inbox or split human vs. agent work; the audit log preserves who
(human vs. agent) did what.

The existing model already separates login from assignment:

- `user_account` rows are logins (id, `oidc_sub`, `display_name`, `email`).
- `person` cards are assignable entities — `assignee` is a `card_ref → person`.
- `user_account_person` is the 1:1 link between a login and its
  default person card.
- Person cards can exist without a `user_account`. A `user_account` can
  exist briefly without a person card (first-sight provisioning).

That separation gives us room: an agent can be its own person card
without needing its own real login.

## Pre-existing related work

- `#41` — Remote MCP over HTTPS. Whatever identity model lands here
  becomes the wire claim the MCP session carries.
- BFF session model (`session` table, `kitp_session` cookie). Sessions
  are bound to a `user_id`; the cookie does not currently carry a
  "acting-as" agent identity.

## Options

### Option A — Agent = person card with `agent_of_person_card_id`

The cleanest extension of what we already have.

**Schema**
- Add `person` attribute `agent_of_person_card_id` (card_ref → person),
  nullable. Set when the person card is an agent under a parent person.
- Add `person` attribute `is_agent` (bool), or derive: `is_agent =
  (agent_of_person_card_id IS NOT NULL)`.
- `user_account_person` stays 1:1 with the parent person; agents do NOT
  get their own login row.

**Auth / MCP**
- BFF cookie keeps the parent login's identity (`user_id`). The MCP
  client opens a session as the human, then issues every call with an
  `acting_as_person_card_id` parameter (or HTTP header) the server
  validates against the parent's owned-agents list.
- Server's `auth.UserCtx` gains an `ActingAsPersonCardID *int64` field;
  every handler reads it (defaulting to the parent's person card when
  unset). `assignee` defaults to the acting-as person; audit
  `activity.actor_id` records the parent login (for accountability), and
  a new `activity.acting_as_person_card_id` column records the agent
  (for "what did the agent do" queries).

**Inbox / UX**
- Inbox defaults to "all of mine" = `assignee IN (parent_person ∪
  agents)`. A quick-filter pill `[Mine only] [Agents only] [All]`
  splits the view.
- Other users see the agent person card as a normal assignee; the
  picker can group "alice / alice's agents" under one heading.

**Pros**
- Reuses person cards + assignee plumbing wholesale. No new card type.
- Clear who did what in activity rows.
- Multiple agents per user trivially supported.
- An agent can move teams or be re-parented without touching tasks.

**Cons**
- "Acting as" is a per-request claim — fragile if the client forgets to
  set it. Mitigate by requiring it on the MCP session handshake and
  echoing back the resolved identity.
- Doesn't model "agent has its own credentials" — the agent inherits
  the parent's session. If the parent revokes, every agent goes dark
  (intended? probably yes, but worth confirming).

### Option B — Agent = `_is_agent` checkbox on the task itself

The "do almost nothing" option.

**Schema**
- New boolean attribute `agent_task` on tasks. No new person rows.
- Optional text attribute `agent_label` ("research", "triage", …).

**UX**
- Inbox shows a column / chip indicating agent work. A filter pill
  `[Hide agent tasks]` defaults on so humans don't see the noise.

**Pros**
- Smallest possible change. Ships in a day.
- No new authz model.

**Cons**
- Other users still see `assignee=alice`; they can't tell the agent
  did the work without inspecting the task.
- Audit log can't differentiate agent edits from alice edits.
- Multiple agents per user collapse into one bucket unless you split
  by `agent_label` (and even then the assignee is the human).
- Hard to retro-fit if we later want agents to have their own
  workloads / KPIs.

### Option C — Agent = `user_account` row owned by another user

The most "first-class" option.

**Schema**
- Add `user_account.parent_user_id` (nullable, self-FK).
- Agent `user_account` rows exist with `parent_user_id = <human>`,
  their own person card (via `user_account_person`), and an
  `oidc_sub`-free credential path (API tokens issued by the parent).
- Add a `user_token` table: opaque tokens scoped to a user, used by
  MCP clients. The parent user mints tokens for each agent.

**Auth / MCP**
- MCP authenticates with the agent's token. The session carries the
  agent's `user_id`. `parent_user_id` lets the UI show "agent under
  alice" and lets alice see/revoke every agent token from her account
  page.

**Pros**
- Strongest separation: agent is a real user, agent is a real person,
  every existing audit / authz / role path works without "acting as"
  trickery.
- Per-agent tokens can be rotated / revoked independently.
- An agent's session expiry is independent of the parent's.

**Cons**
- Most code to land: new column + new table + token issue/revoke
  endpoints + UI to manage agents + agent-only login path.
- A `user_account` with no `oidc_sub` is conceptually unusual; need to
  make sure it doesn't show up in human user lists, role pickers, etc.
- Need to decide whether agents have their own roles (admin? worker?)
  or inherit the parent's.

## Recommendation

**Option A** ("agent = person card with parent person ref") is the
right baseline — it reuses every existing assignee/inbox/filter path
unchanged and adds one nullable attribute on `person` plus one
nullable activity column. The "acting as" claim on the MCP session is
the only genuinely new auth concept, and it pairs naturally with the
remote-MCP work (#41): the MCP handshake names the agent the session
will act as, the server validates it against the parent's owned-agents
list, and from then on every handler treats the agent as the actor.

If/when we need rotating credentials per agent (e.g. give an agent a
narrower role than the parent, or share an agent with a teammate),
**Option C** can be layered on top: the agent's person card stays;
we add an optional `user_account` row that maps to that same person.
That migration is cheap because Option A doesn't create alternate
identity rows we'd need to reconcile.

**Option B** is tempting for speed but doesn't model what the user
asked for ("a way to see all your issues in your inbox, or separate
out into agents") cleanly. Skip unless we abandon the agent-as-actor
direction entirely.

## Open questions for the user

1. Should agents share the parent's authorization (always inherit
   parent role) or have their own role rows (parent grants a subset)?
2. Does revoking the parent's session revoke every agent's session
   too, or do agents survive independently?
3. UI: do agents appear in the assignee picker for *other* users
   inside the parent's projects, or are they only visible to the
   parent?
4. Audit: when alice's agent edits a task, what name should appear in
   the activity stream — "alice's research agent" alone, or
   "alice (as research agent)"? Both have legibility tradeoffs.
5. Should an agent's `is_agent` boolean gate it OUT of the default
   "Mine" filter (so humans see only their human assignments by
   default) or IN (so humans see everything they're parent of)?


---

# User direction (2026-05-12) + finalised plan

> It is important to be able to give an agent read-only permissions, or
> read-only or comment only, or comment set turn. So to use an MCP, you
> would first login, create an agent user. Then when the mcp logs in,
> during authentication (right after) you would choose which agent it
> is logging in as (as part of the auth, or part of a auth token you
> provide, out of band of mcp), and the agent would never be able to
> admin itself or other agents or roles. So I think this would be
> enabled through option C.
>
> As far as assignment rollup, this gets tricky. I suspect we should
> put agent assignments where we put inbox ordering: per user, per
> issue. So we might (permission allowing) either allow the agent to
> see everything and work on everything, or just see what is in the
> parent user inbox, assigned to that agent. I like that best.

**Decision: Option C — first-class `user_account` hierarchy.**

Folding in the constraints:

## Resolved questions

1. **Authorization.** Agents do NOT inherit the parent's role set;
   the parent grants each agent a *subset* of roles. The role surface
   adds explicit "viewer / commenter / commenter-on-its-own-turn"
   tiers below `worker` so the parent can scope an agent narrowly.
2. **Session lifetime.** Agent tokens are independent of the parent's
   BFF session — revoking the parent's session does NOT revoke agent
   tokens. The parent revokes agents explicitly (or via cascade-delete
   when the parent account itself is deleted).
3. **Assignee picker visibility.** Agents are not in the assignee
   picker for *other* users. Other people in the project see the
   parent as the assignee; agent routing is private to the parent.
4. **Audit.** `activity.actor_id` becomes the agent's own
   `user_account.id`. The agent's display name in activity rows reads
   "alice's research agent" (compose from `user_account.display_name`
   + `parent_user_id`). No "acting as" claim — the agent simply IS
   the actor.
5. **Inbox default.** The agent's identity is its own. Its inbox shows
   tasks the parent has explicitly routed to it (see `user_card_agent`
   below); the human's Inbox stays unchanged. Optional toggle: "see
   parent's whole inbox" for agents granted that permission.

## Schema additions

```toml
# user_account gains
parent_user_id bigint NULL REFERENCES user_account(id) ON DELETE CASCADE
is_agent       boolean NOT NULL DEFAULT false
```

`parent_user_id` self-FK + cascade so deleting a human deletes all
agent rows owned by them. `is_agent` is the structural flag the UI
keys on (admin screen splits "Users" from "Agents"; assignee picker
hides agents from non-parents).

```toml
# user_token: opaque tokens used by MCP clients to authenticate AS an agent
[[tables]]
name = "user_token"
columns:
  id            text PRIMARY KEY           # opaque, 256-bit base64url, same shape as session.id
  user_id       bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE
  label         text                        # human description "research agent"
  created_at    timestamptz NOT NULL DEFAULT now()
  last_used_at  timestamptz NOT NULL DEFAULT now()
  revoked_at    timestamptz
  expires_at    timestamptz                 # optional hard expiry
indexes: (user_id), (last_used_at)
```

`user_token.user_id` is the *agent's* user id (or, optionally, a
human for "personal access token" use). Touch + revoke semantics
mirror `session` (batched in-memory touch flush; opaque value).

```toml
# user_card_agent: parent user routes a card to one of their agents
[[tables]]
name = "user_card_agent"
columns:
  user_id        bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE  # parent
  card_id        bigint NOT NULL REFERENCES card(id)         ON DELETE CASCADE
  agent_user_id  bigint NOT NULL REFERENCES user_account(id) ON DELETE CASCADE
  created_at     timestamptz NOT NULL DEFAULT now()
primary_key: (user_id, card_id)
indexes: (agent_user_id)
```

Each (parent, card) routes to at most one agent — same shape as
`user_card_sort`. The agent inbox query becomes:

```sql
SELECT card.*
  FROM card
  JOIN user_card_agent uca ON uca.card_id = card.id
 WHERE uca.agent_user_id = $me   -- the agent
   AND uca.user_id       = $parent;
```

## Auth flow

1. **Parent creates an agent** (BFF UI / `POST /api/v1/agent.create`):
   - inserts `user_account` row with `parent_user_id = parent_id`,
     `is_agent = true`, `oidc_sub = NULL`, `display_name` from form.
   - inserts a 1:1 `user_account_person` row so the agent has its own
     person card (so it can be assigned via the normal flow).
2. **Parent grants roles**
   (`POST /api/v1/agent.role.grant {agent_user_id, role_id}`):
   - rejects roles the parent doesn't hold themselves;
   - rejects `admin` regardless (parent can't make an agent their own
     equal — explicit guardrail).
3. **Parent mints a token**
   (`POST /api/v1/agent.token.create {agent_user_id, label}`):
   - generates a 256-bit base64url string, inserts `user_token`;
   - returns the token ONCE in the response body — never re-readable.
4. **MCP client authenticates** (`kitpd mcp --token <…>` or `KITP_TOKEN=…`):
   - `runMCP` reads the env / flag, looks up `user_token` (validate
     revoked / expired), resolves to `user_account` row, builds a
     `UserCtx{ID, DisplayName}`, calls `auth.WithUser(ctx, &uc)`;
   - same dispatcher run-loop as today, except now the actor is the
     agent's user_account.

The parent's BFF cookie path is untouched. Token auth only fires on
the MCP stdio entry (and on the future remote-MCP transport in #41).

## Self-admin prevention

- `user_role.grant` / `user_role.revoke` endpoints add an explicit
  check: if the actor is an agent, reject. Agents can never edit
  role assignments — not their own, not anyone else's.
- `agent.create` and `agent.token.*` endpoints reject when the actor
  is itself an agent. Agents can't bootstrap new agents.
- The `admin` role is never granted to agents (enforced at `agent.role.grant`).

## Inbox / UX impact

- **Parent's inbox** unchanged.
- **Parent's task detail** gains a small "Route to agent ▾" affordance
  (when the parent owns ≥1 agent). Picking an agent writes a
  `user_card_agent` row; "Unroute" deletes it.
- **Agent's inbox** (separate route or filter, TBD when the BFF agent
  login UI lands): SQL above. Default columns: title, status,
  routed-at, parent-assignee (= parent).
- **Assignee picker** for *other* users: filter out `is_agent=true`
  rows unless `parent_user_id = me`.
- **Activity display**: `actor_label = display_name + " (agent of " +
  parent.display_name + ")"` when `is_agent`.

## Rollout order

1. Schema: declarative.toml — `user_account` columns,
   `user_token`, `user_card_agent`. Apply via `make db-reset`. ← start here.
2. Server: `session` package gets a token branch (or new
   `user_token` package); `runMCP` learns `--token` / `KITP_TOKEN`.
3. Server: `agent.create`, `agent.role.grant`, `agent.role.revoke`,
   `agent.token.create`, `agent.token.revoke` handlers (registered
   like any other endpoint; admin-only).
4. Server: `user_card_agent.set`, `user_card_agent.clear` handlers;
   agent-inbox query helper.
5. Client: Admin → Agents screen (list + create + grant roles + mint
   tokens). Token shown once with copy-to-clipboard.
6. Client: Task detail "Route to agent" affordance for owners.
7. Client: Agent inbox view (when the agent itself logs in to the UI;
   though the typical use is MCP-only, so this can come later).
8. Tests + docs.

## Open follow-ups

- Token rotation UX: how do we surface "your agent's token expires
  in 7 days" warnings? Probably a status badge on the Admin → Agents
  list once `expires_at` is set.
- "Commenter-on-its-own-turn" tier: needs a new gate in the
  `comment.post` process_step that checks whether the agent is the
  most-recent commenter; defer the gate to follow-up. The role itself
  can land alongside `viewer` and `commenter`.
- Remote MCP (#41) authenticates with the same token. Likely
  `Authorization: Bearer <token>` over HTTPS or a `?token=…` URL
  param on the SSE endpoint — picked when #41 designs the transport.

