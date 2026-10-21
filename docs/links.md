# Task links

A **link** ties a URL to a task: a code change (a Gerrit CL, a pull request),
an issue, a design doc, or anything else worth keeping next to the work. Links
appear in the task's **Links** section, between the attachment previews and
Comms. They can be added by hand, by an agent over MCP, or by a code forge
through the forge hook.

## Model

A link is a `link` card parented under its task:

| attribute    | value                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| `title`      | display text; defaults to the URL                                      |
| `link_url`   | the URL, an absolute `http(s)` URL of at most 2048 characters; the link's identity on its task |
| `link_kind`  | short slug naming the source: `gerrit`, `github`, `gitlab`, `issue`, … (empty = a plain URL) |
| `link_state` | short slug the source reports: `open`, `reviewed`, `approved`, `merged`, `abandoned`, … (empty = no state) |

`kind` and `state` are open slugs (`^[a-z][a-z0-9_-]{0,31}$`, lower-cased), not
an enum. The kernel stores whatever a source sends. The web client maps the
slugs it knows to an icon, label and tone (`LINK_KINDS` / `LINK_STATES` in
`web/src/task-detail/link-specs.ts`). Unknown slugs still render, humanised and
in a neutral tone.

Because links are cards:

- every change writes activity rows on the link card, so the project Activity
  page shows them and the task's background poll counts them;
- visibility follows the task's project;
- `task.purge` removes a task's links with it, and `task.move` carries them
  along.

## Idempotency

`link.set` is an upsert keyed on **(task, url)**:

- the first call for a URL creates the link (`created: true`);
- every later call PATCHes that same link. `title`, `kind` and `state` are
  written when present and left alone when absent; an empty `kind` / `state`
  clears it;
- only values that actually change write activity rows. Re-sending an
  unchanged state returns `changed: false` and writes nothing;
- a transaction-scoped advisory lock on the (task, url) pair serialises
  concurrent callers, so two events arriving together can't create duplicate
  links.

Deleting a link isn't sticky. Linking the URL again adds a fresh link.

## Dispatcher endpoints (UI, API, MCP)

| endpoint      | input                                          | output                         |
| ------------- | ---------------------------------------------- | ------------------------------ |
| `link.set`    | `task_id`, `url`, `title?`, `kind?`, `state?`  | `link_id`, `created`, `changed` |
| `link.list`   | `task_id`                                      | `rows[]`: `id`, `task_id`, `url`, `title`, `kind`, `state`, `created_at`, `updated_at`, `created_by_id`, `created_by` |
| `link.delete` | `id`                                           | `deleted`                      |

`link.set` and `link.delete` require edit rights on the task: they're gated
on `card.update` of the parent task's project, the same gate attachments use.
`link.list` is open to any signed-in user and returns nothing for a task the
caller can't see. All three are on the curated MCP tool list (`link__set`,
`link__list`, `link__delete`).

## Forge hook

`POST /api/v1/links`. Bearer-token authenticated with a kitp API token, the
same kind MCP uses. It links **one URL to several tasks** in one call, which
is the shape a code change has:

```sh
curl -X POST https://kitp.example.com/api/v1/links \
  -H "Authorization: Bearer $KITP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"task_ids":["58","59"],"url":"https://gerrit.example.com/c/kitp/+/42",
       "title":"web: wire pickers into the grid","kind":"gerrit","state":"merged"}'
```

```json
{"results":[
  {"task_id":"58","ok":true,"link_id":"142","created":false,"changed":true},
  {"task_id":"59","ok":false,"created":false,"changed":false,
   "code":"task_not_found","message":"link.set: task 59 not found"}
]}
```

- Each task is linked in its own transaction through `link.set`, as the
  token's user. A mistyped task number fails only its own row.
- Repeated task ids are collapsed. At most 50 tasks per call.
- The response is `200` with per-task results. A malformed body is `400`, a
  missing or invalid token is `401`.

### Forge credentials

Give each forge a **workspace agent** and a **links-only token**:

- **Workspace agent:** Workspace → Agents → New, with Owner *Workspace*
  (`agent.create` with `owner: "system"`, global admins only). It's owned by
  the System account, not a person, so it keeps working through staff
  turnover. An agent can never do more than its owner, and System always
  holds every role, so it can do exactly what it's granted. Grant it
  **worker**. Its links show as added by its name.
- **Links-only token:** Access *Links only* (`user_token.create` with
  `scope: "links"`). The router admits it only on `POST /api/v1/links`. MCP
  and every other bearer route answer `403 token_scope`, and `kitpd mcp`
  refuses it. Full-access tokens (`scope` omitted) keep working everywhere,
  including the hook.

## Gerrit

`integrations/gerrit` is a Gerrit plugin that uses the hook. It links each
change to the tasks its commit message mentions (`task #123`, `kitp #123`,
`Task: 123`; a regex you can change) and keeps the
link state in step with the review: open, reviewed, approved, merged,
abandoned. A Gerrit commentlink makes those task numbers clickable in Gerrit.
See `integrations/gerrit/README.md`.
