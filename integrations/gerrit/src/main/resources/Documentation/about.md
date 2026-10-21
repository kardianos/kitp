Links Gerrit changes to [kitp](https://github.com/kitp/kitp) tasks.

When a change's commit message mentions a task (by default a `Task: 123`
line), the plugin links the change to that task in kitp. The link's state then
follows the review as it is reviewed, approved (+2 on the review label),
merged, abandoned or restored. Linking is idempotent: kitp keys each link on
(task, change URL), so each change appears once per task however many events
fire.

To make the task numbers clickable in Gerrit itself, configure a
`[commentlink "kitp"]` whose `link` points at kitp. The plugin reads task
numbers with that same `match` regex, so what reviewers see as links is
exactly what gets linked.

See [config](config.md) for setup.
