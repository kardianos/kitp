kitp plugin configuration
=========================

Settings are read when the plugin loads. Reload the plugin after you change
them.

gerrit.config
-------------

```ini
[gerrit]
  canonicalWebUrl = https://gerrit.example.com/

[plugin "kitp"]
  url = https://kitp.example.com
  commentlink = kitp
  taskPattern = "\\A[^\\n]*?\\s#(\\d+)[ \\t]*(?:\\r?\\n|\\z)"
  kind = gerrit
  reviewLabel = Code-Review
  includePrivate = false
  timeout = 10s
  retries = 3

[commentlink "kitp"]
  match = "\\b(?:[Tt]ask|[Kk]itp)(?::\\s*#?|\\s+#)(\\d+)\\b"
  link = https://kitp.example.com/task/$1
```

plugin.kitp.url
:   Base URL of kitp. Required. Links are POSTed to `<url>/api/v1/links`.

plugin.kitp.commentlink
:   Name of the commentlink whose `match` finds task numbers in commit
    messages. The task number is the first capture group that matched.
    Default: `kitp`. If that commentlink isn't configured, the plugin uses
    `\b(?:[Tt]ask|[Kk]itp)(?::\s*#?|\s+#)(\d+)\b` (`task #12`, `kitp #12`,
    `Task: 12`), but Gerrit then won't linkify the numbers in its UI. The value
    must be double-quoted, because an unquoted `#` starts a comment.

plugin.kitp.taskPattern
:   Extra regexes (Java syntax, repeatable) that also find task numbers but
    aren't linkified in Gerrit. Example: the pattern above treats a trailing
    `#634` on the subject line as a task. Default: none.

plugin.kitp.kind
:   The link `kind` sent to kitp, which picks the icon kitp shows. Default:
    `gerrit`.

plugin.kitp.reviewLabel
:   The label that drives the `reviewed` and `approved` states. Its maximum vote
    means `approved`, and any other non-zero vote means `reviewed`. Default:
    `Code-Review`.

plugin.kitp.includePrivate
:   Also link private changes. Default: `false`.

plugin.kitp.timeout
:   Connect and request timeout for calls to kitp. Default: `10s`.

plugin.kitp.retries
:   How many times a failed call is retried after network errors or kitp 5xx
    / 429 responses, with 10s, 60s and 300s backoff. Default: `3`.

gerrit.canonicalWebUrl
:   Required. The change URL that gets linked is built from it.

secure.config
-------------

```ini
[plugin "kitp"]
  token = <kitp API token>
```

plugin.kitp.token
:   A kitp **links-only** API token for the workspace agent the plugin acts
    as. In kitp, go to Workspace → Agents, create an agent with Owner
    *Workspace*, give it the worker role, and mint a token with Access *Links
    only*. That token works only on the link hook, and the agent doesn't
    depend on any person's account. Required.

project.config
--------------

```ini
[plugin "kitp"]
  enabled = false
```

plugin.kitp.enabled
:   Set to `false` to stop linking changes of this project and, by inheritance,
    its child projects. Default: `true`.

Events
------

The plugin re-syncs a change after a new patch set, a comment or vote, a
deleted vote, a merge, an abandon, or a restore. Events for one change that
arrive within about 1.5s are coalesced into one call. Each call sends the
change's current state, so kitp's per-(task, URL) idempotency makes repeats
no-ops.
