# kitp Gerrit plugin

Connects Gerrit code review to kitp tasks:

1. **Task numbers are clickable in Gerrit.** A mention like `task #123`,
   `kitp #123` or `Task: 123` in a commit message (or a review comment) links
   to `https://<kitp>/task/123` and opens in a new window. This is Gerrit's
   native *commentlink* mechanism.
2. **Changes link themselves to their tasks.** When a change is uploaded, the
   plugin reads the task numbers from its commit message and calls kitp to link
   the change URL to each task. Each link shows up in the task's **Links**
   section.
3. **Link state follows the review.** On every later event (new patch set,
   vote, merge, abandon, restore) the plugin re-reads the change and updates
   each link's state:

   | Gerrit change                                  | kitp link state |
   | ---------------------------------------------- | --------------- |
   | merged                                         | `merged`        |
   | abandoned                                      | `abandoned`     |
   | review label at its max vote (Code-Review +2)  | `approved`      |
   | any other vote on the review label             | `reviewed`      |
   | otherwise                                      | `open`          |

   The state comes from the change's *current* status and votes, not from the
   event that triggered the sync. So a duplicated, late or missed event can't
   leave a stale state behind. If a new patch set drops a +2, the link goes
   back to `open`, matching what Gerrit shows.

Linking is **idempotent**. kitp keys each link on (task, change URL), so the
same change linked again updates the one link instead of adding another, and a
sync that changes nothing writes nothing. Adding a `Task:` line in a later
patch set links the new task. Removing one leaves the existing link in place.

## Message format

Task numbers are found by **regex**, not by a parser. The primary regex is the
`match` of the `[commentlink "kitp"]` section, the same regex Gerrit uses to
linkify. So whatever reviewers see as a task link is exactly what gets linked.
The suggested (and default) pattern is:

```
\b(?:[Tt]ask|[Kk]itp)(?::\s*#?|\s+#)(\d+)\b
```

| text                                | linked? |
| ----------------------------------- | ------- |
| `task #634` / `Task #634`           | yes     |
| `kitp #505`, `(kitp #498): …`       | yes     |
| `Task: 123` / `task: #123`          | yes     |
| `task 5 minutes` (no `:` or `#`)    | no      |
| `Subtask: 12`, `CI job 364`         | no      |
| `#634` alone                        | no (see below) |

```
app/proc/imp: accept a quoted donor nickname #634

Break-fix. Read bare quotes as text and undo the doubling.

task #634

Change-Id: I8de4dbb09b21d6a8a20f11c215268dff9f40bcb8
```

To recognise other forms, edit the commentlink's `match`. The task number is
the first capture group that matched, so you can use alternation. Gerrit
evaluates commentlinks in both Java (server) and JavaScript (web UI), so keep
the regex in the syntax both share. In `gerrit.config`, the value must be
double-quoted: an unquoted `#` starts a comment.

**Extraction-only patterns.** Some forms should link a change without being
linkified everywhere in Gerrit, such as a bare `#634` at the end of the
subject line (`#634` alone is too common to linkify globally). Add them as
`plugin.kitp.taskPattern`. Repeat the key for several patterns; these use Java
regex syntax:

```ini
[plugin "kitp"]
  # a trailing "#634" on the subject line names a task
  taskPattern = "\\A[^\\n]*?\\s#(\\d+)[ \\t]*(?:\\r?\\n|\\z)"
```

## Build

The build is standalone Maven against the published Gerrit plugin API, so you
don't need a Gerrit source tree. It requires Java 21 (Gerrit 3.14).

```sh
cd integrations/gerrit
mvn package                      # → target/kitp.jar
```

Without a local JDK/Maven:

```sh
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD":/src -v "$HOME/.m2":/var/maven/.m2 \
  -e MAVEN_CONFIG=/var/maven/.m2 -w /src maven:3.9-eclipse-temurin-21 \
  mvn -Duser.home=/var/maven package
```

To target another Gerrit 3.x release, use `make gerrit-plugin GERRIT_API=<version>`
(or `-Dgerrit.api.version=<version>`). Match the server's version
(`/config/server/version`).

**Gerrit updates don't remove the plugin.** A version upgrade swaps
`bin/gerrit.war` and never touches `$site_path/plugins/`. What can break is the
plugin API across a minor version (3.14 → 3.15): the plugin then logs
`Cannot load plugin kitp` and needs a rebuild against the new version.

## Set up kitp

The plugin calls kitp as a **workspace agent** with a **links-only token**:

- A *workspace* agent belongs to the kitp workspace itself (the System
  account), not to a person. Staff turnover doesn't affect it: if the admin
  who set it up loses their roles or leaves, the forge keeps working. A
  personal agent would stop working, because an agent can never do more than
  its owner.
- A *links-only* token can call the forge link hook (`POST /api/v1/links`) and
  nothing else. MCP and every other API refuse it. If it leaks, the worst it
  can do is add or update links.

Setup, as a kitp admin:

1. Open **Workspace → Agents → + New**. Name it (for example "Gerrit") and pick
   **Owner: Workspace**. Links show as added by this name.
2. Give it the **worker** role, so it can link tasks in every project. Linking
   needs the same rights as editing the task.
3. Under **API tokens**, pick **Links only (forge hook)**, give it a label
   (for example `gerrit-prod`) and **Mint token**. Copy the token. It's shown
   only once. To rotate, mint a new token, update Gerrit's `secure.config`,
   then revoke the old one.

## Set up Gerrit

1. Copy `target/kitp.jar` into `$site_path/plugins/`.
2. In `$site_path/etc/gerrit.config`:

   ```ini
   [gerrit]
     canonicalWebUrl = https://gerrit.example.com/   # required: it's the URL that gets linked

   [plugin "kitp"]
     url = https://kitp.example.com

   [commentlink "kitp"]
     match = "\\b(?:[Tt]ask|[Kk]itp)(?::\\s*#?|\\s+#)(\\d+)\\b"
     link = https://kitp.example.com/task/$1
   ```

3. In `$site_path/etc/secure.config`:

   ```ini
   [plugin "kitp"]
     token = <the agent's kitp API token>
   ```

4. Restart Gerrit, or reload the plugin with `ssh -p 29418 admin@gerrit gerrit plugin reload kitp`.
   `error_log` shows `Loaded plugin kitp`.

All options are in [config.md](src/main/resources/Documentation/config.md),
which Gerrit also serves at `/plugins/kitp/Documentation/config.html`.

## Behaviour notes

- **Private changes** aren't linked unless `plugin.kitp.includePrivate = true`,
  because the change URL and subject would leave Gerrit.
- **Per-project opt-out:** set `[plugin "kitp"] enabled = false` in a project's
  `project.config`. It's inherited, so setting it on a parent project covers its
  children.
- **Failures:** an unknown task number, or a task the agent can't edit, is logged
  as a warning in `error_log` and isn't retried. A network error or kitp 5xx is
  retried with backoff (10s, 60s, 300s; `retries`, default 3).
- **Existing changes:** a change links on its next event. Changes that have no
  further activity after you install the plugin aren't backfilled.

## The kitp side

The plugin uses kitp's forge hook, which any forge or script can call:

```sh
curl -X POST https://kitp.example.com/api/v1/links \
  -H "Authorization: Bearer $KITP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"task_ids":["58","59"],"url":"https://gerrit.example.com/c/kitp/+/42",
       "title":"web: wire pickers into the grid","kind":"gerrit","state":"open"}'
```

See [docs/links.md](../../docs/links.md) for the API.
