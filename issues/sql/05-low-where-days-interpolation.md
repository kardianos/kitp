# S5 — `where.go` interpolates an integer `days` directly into SQL via `%d`

- **Severity:** LOW (informational, defense-in-depth flag)
- **Status:** ✅ RESOLVED 2026-05-22
- **Agent:** sql
- **Location:** `server/internal/dom/card/where.go:215` (and the `compileLeaf` `within_days` case at 197-216)

## Resolution

`days` now flows through `addArg` (the named-parameter
`Builder.Bind` in practice — `where.go` accepts an arbitrary
`addArg func(any) string`). The `interval '%d days'` formatting
became `%s * interval '1 day'` where `%s` is the bound
placeholder. Multiplying a bound int by a literal interval is
the standard Postgres pattern and keeps the user value out of
the SQL string entirely.

`where.go`'s contract — "every user value is a pgx parameter, no
exceptions" — now holds with no carve-outs.

## What

`withinDaysValue` returns a Go `int` clamped to `[0, 3650]`, then
the `within_days` op formats it into ``interval '%d days'``. Every
*other* value in `where.go` rides through `addArg` (pgx
parameter); this is the only int that doesn't.

## Risk

None today — the value is validated. But it's the one place in the
predicate compiler that doesn't follow the "never concat into SQL"
rule, so a future refactor that loosens `withinDaysValue` would
silently widen the surface.

## Suggested fix

Bind `days` via `addArg` and write:

```sql
... <= to_char((now() + (CONCAT($N, ' days'))::interval)::date, 'YYYY-MM-DD')
```

…or pass days as a numeric and multiply. Cosmetic but normalises
the file's contract: the compiler's invariant is "every user
value is a pgx parameter, no exceptions".

---

DT: Yes, use named parameters and use parameters. I understand in this case it is harmless enough.
