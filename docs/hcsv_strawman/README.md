# hcsv strawman — format trial for kitp schema/seed/demo

Status: exploratory. Files in this directory are sketches, not implementations.

Three files demonstrate the format end-to-end:
- `schema.hcsv` — DDL for ~12 tables (covers user_account, role, user_role, process, card_type, attribute_def, edge, role_grant, card, activity, attribute_value).
- `seed.hcsv` — install-level rows (users, roles, processes, card_types, attribute_defs, edges, role_grants).
- `demo.hcsv` — Default Project + 3 milestones + 2 components + 5 statuses + 5 tasks.

Together they cover roughly 60% of today's `db/schema/declarative.toml` semantics — enough to evaluate the format.

## Schema feature coverage

Verified against declarative.toml — every DDL construct in the live schema fits hcsv:

| feature | live use | hcsv encoding |
|---|---|---|
| bigserial PK | every table | `pk=true` on the id column |
| composite PK | attribute_value, role_grant, process_step, idempotency_response, user_card_sort, file_chunk | multiple columns with `pk=true` |
| column-level UNIQUE | role.name, process.name, oidc_sub | `unique=true` on the column |
| FK with `on_delete` | most FK columns | `references` + `on_delete` columns |
| self-FK | user_account.parent_user_id, card.parent_card_id | same as cross-table |
| nullable / default | pervasive | `nullable` + `default` columns |
| multi-column index | activity_card_created, attachment_card | quoted `"col1, col2"` in `columns` |
| unique index | many | `unique=true` in indexes |
| partial unique index (WHERE) | uniq_user_role_scoped, uniq_user_role_global | `where` column in indexes |
| GIN expression index | attribute_value_trgm, comment_body_trgm | `expressions` column + `using=gin` |
| table doc string | every table | `\| doc="..."` heading modifier |
| extensions | pg_trgm | `## prop` block |

NOT present in declarative.toml today (so not in this strawman either): CHECK constraints, triggers, stored functions, generated columns, ON UPDATE actions, INCLUDE columns on indexes. If kitp ever adds them, the format extends additively — add another optional column to the relevant section.

## What works

### Tables as ## sections, columns as a single CSV block

A table's DDL boils down to:
```
## table foo

### columns
name, type, pk, nullable, default, references, on_delete
id, bigserial, true, false, , ,
parent_id, bigint, false, true, , foo.id, cascade
```

One row per column. The header is constant across tables. PK is a column flag, which handles composite PKs (attribute_value: `card_id` and `attribute_def_id` both with `pk=true`) without any extra section. FK target is `<table>.<column>` in one cell; `on_delete` in another. Tested against partial unique indexes (see `user_account_oidc_sub_uniq` and the user_role composite unique).

Compared to declarative.toml's per-column TOML tables (~10 lines per column with `[[tables.columns]]` and `[tables.columns.references]` sub-tables), the hcsv form is 1 line per column. **Roughly 5–10× density gain for column declarations.**

### Schema metadata in a `### meta` block

```
### meta
name_column, id_column
display_name, id
```

Or for cards:
```
### meta
name_attribute, id_column
title, id
```

The runner consults this when resolving `$<table>.<name>` lookups. Per-table; cleanly attached to the table it describes. No global config file.

### `parent` for nested cards

```
# table card | alias=proj_default
### rows
card_type_id, title
$card_type.project, "Default Project"

## table card
### rows
card_type_id, parent_card_id, title, alias
$card_type.milestone, parent, "M1", m_m1
```

The depth-2 section's `parent` token resolves to the depth-1 row's id at toposort time. Captures the dominant pattern in the demo seed (cards parented to a project) without a single alias on the parent side.

### `attributes.x` expansion on card rows

A card row carrying columns that match `attribute_def.name` triggers the runner to emit, for each such column:
- one `activity` row of kind=`attr_update`
- one `attribute_value` row with `last_activity_id` pointing at the just-inserted activity
- plus one card-level `activity` of kind=`card_create` per card

For the demo's 5 tasks (6 attrs each: title, status, assignee, milestone_ref, component_ref, sort_order), that's ~14 generated rows per task. Total: ~80 rows generated from 14 lines of demo data. The current PL/pgSQL achieves the same with ~200 lines and explicit DECLARE/FOREACH.

### Aliases for sibling cross-references

`attribute_value.last_activity_id` is the canonical hard case — sibling row references sibling row. Two ways the format handles it:

1. **Implicit (handled by the runner inside `attributes.x` expansion):** the runner knows that when it expands `status = @s_todo` on a card row, it must emit the activity and then plug its returned id into the `last_activity_id` of the attribute_value. The author never names this dependency.

2. **Explicit (per-row `alias` column for cross-row references):** demo.hcsv uses `alias=m_m1` on each milestone row so subsequent task rows can write `milestone_ref = @m_m1`. The alias is a synthetic column the runner intercepts; not stored on the row itself.

### Global alias toposort

The runner walks every row, builds a graph of `references = (table, alias|$-lookup|parent)`, and topologically sorts insertions. Heading order is hints, not law — if you reference an alias defined later in the file, it still resolves. Only cycles fail.

### CSV-style values

Plain identifiers (`bigserial`, `cascade`, `now()`), numbers, and bare strings without commas pass through unquoted. Strings with commas or special chars wrap in `"..."` with `""` to escape an embedded quote. **Backtick-quoted cells** (`` `…` ``) carry their contents verbatim — no CSV escape gymnastics — and may span multiple lines; doubled `` `` `` inside escapes to a single backtick. Backticks are the right tool for embedded JSON values: `` `{"attr":"status","op":"has_phase","values":["active"]}` `` reads directly as that JSON string.

## What I had to invent while writing

These weren't in your spec; I chose what seemed least surprising. All are negotiable.

1. **`pk` as a column flag.** Cleaner than a separate primary_key section for composite PKs.
2. **Pipe-delimited heading modifiers.** `# table card | alias=proj_default | doc="..."`. Multiple modifiers separated by `|`. Order doesn't matter.
3. **`alias` as a synthetic row column.** Lets you alias per-row inside a multi-row section without writing one heading per row. The runner sees `alias` is not a real column on the table and treats it as a row-id label.
4. **Lookups with dots in the name use quoted form: `$process."card.update"`.** Process names are dotted (`card.update`, `comment.post`); the dot in `$<table>.<name>` would otherwise be ambiguous.
5. **Array-expansion in cells: `[a, b, c]`.** A cell whose value parses as a bracketed comma list expands the row into N rows, one per element. Multiple `[...]` cells in the same row produce a cross-product (Cartesian). This collapses today's role_grant CROSS JOIN SQL into 1 row per role.
6. **HTML-style comments `<!-- ... -->`.** Markdown's `#` already starts a heading, so a comment syntax must be different. HTML comments are familiar and unambiguous.
7. **The `doc=` heading modifier maps to the table/column DDL `COMMENT ON`.** Today declarative.toml uses a `doc` field on every entity; preserved here as a modifier on the heading line.

## Where it hurts

These came up while writing and aren't fully solved.

### JSON values in attribute_value (resolved)

Backtick-quoted cells carry their content verbatim and may span lines. A filter card's predicate becomes:

```
name, predicate
default, `{"attr":"status","op":"has_phase","values":["active"]}`
multiline, `{
  "attr": "status",
  "op": "has_phase",
  "values": ["active", "terminal"]
}`
```

The parser folds multi-line backtick cells into a single logical row before tokenizing. No heredoc syntax needed.

### Array values that are JSON arrays vs. expansion arrays

A cell `[1, 2, 3]` is ambiguous: array-expansion (3 rows, one per element) or a JSON array literal (one row, value is `[1,2,3]`)? declarative.toml's seeds today never have JSON array values on a column, but attribute_value.value could carry `[101, 102]` for a `card_ref[]` tags attribute.

**Mitigation**: array-expansion uses `[...]`; JSON arrays use the explicit string form `"[101, 102]"`. Convention; the runner picks based on quoting.

### Whitespace sensitivity

Markdown-style headings depend on the leading `#`. I lean on blank-line separation between header rows and data rows. Empty cells (trailing commas) need to be tolerated. Trailing whitespace on rows is fine, but the parser must be permissive. CSV parsers handle this; we'd want a real CSV library plus a heading preprocessor.

### Doc strings with commas

`doc="Worker + create/edit/delete on project/milestone/component/tag/screen/filter."` works because it's quoted, but the modifier-on-heading-line form needs unambiguous parsing. Could nest `doc` as a `### meta` row instead — but then table-level docs leave the heading less self-describing.

### Forward references go undetected at write time

While writing this strawman I referenced `$card_type.status` and `$card_type.person` in the `attribute_def` seed block before defining those rows in the `card_type` seed block. Caught it on review — the parser would catch it too (the toposort would fail at "unresolved lookup"), but the error would surface at apply time, not author time. A linter or schema-aware editor mode would help. Today's declarative.toml has the same issue (TOML lookups resolve at SQL-emit, not at TOML-parse), so this isn't a regression — just confirms the format inherits the same class of write-time-blind error.

### `attributes.x` expansion edge cases

- What if an attribute name collides with a structural column? (None today, but with new columns like `phase` it's a concern.) Rule: structural columns are listed in `### columns` of the schema; attribute_def names are looked up at runtime; if both match, the structural column wins (the runner ignores the column for attribute expansion).
- What about attributes that are required by edge but missing from the card row? Should the runner fail (matching the edge.is_required behaviour) or silently skip? Fail-loud — required attrs must be present on every card row whose card_type has them as required edges.
- Cards with no recognised attribute columns (e.g., the project card with just `title`): only the title attribute expansion fires, plus the card_create activity. Works fine.

### Where does the demo come from when stamping?

The previous design has `project.stamp` copying project-shaping children from a template. With hcsv seeding, the demo project IS just data. Two options:

- (a) Keep both — declarative.toml stamps the template at init; demo.hcsv inserts the demo project's rows directly (bypassing `project.stamp`). Risk: demo data diverges from what `project.stamp` would have produced.
- (b) demo.hcsv defines the template + a `_stamp` directive that triggers `project.stamp` post-row-insertion to produce the demo project. Format complication.

**Recommendation**: (a) for now. The demo is a test fixture; its drift from `project.stamp` output is a feature (lets us seed unusual states for tests).

## Lines saved (rough comparison)

Counting only the chunks I converted:

| Section | declarative.toml | hcsv | ratio |
|---|---|---|---|
| user_account columns + index (1 table) | 51 lines | 12 lines | 4.2× |
| 6 role rows | 18 lines | 8 lines | 2.3× |
| user_role seed (6 rows) | 4 lines of SQL | 10 lines | 0.4× (worse — small SQL CROSS JOIN beats explicit rows) |
| attribute_def + 8 rows | 80 lines | 12 lines | 6.7× |
| edge × 12 rows | 200 lines | 16 lines | 12× |
| role_grant cross-products | 50 lines of SQL | 8 lines with array expansion | 6× |
| [[demo]] PL/pgSQL block | ~200 lines | ~30 lines | 6.7× |

Aggregate: **about 5× density for tables-and-rows; 7× density for the demo block.** The savings come almost entirely from (a) per-column line vs. per-column TOML block, (b) FK-by-name lookup eliminating ID juggling, (c) `attributes.x` expansion eliminating activity/attribute_value boilerplate, and (d) array expansion eliminating CROSS JOIN SQL.

Where hcsv loses: small cross-products that PL/pgSQL CROSS JOIN expresses more compactly than explicit rows. But array expansion ([a, b, c] cells) closes most of that gap.

## What this would cost to implement

Conservative estimate, in Go:

1. Tokeniser + parser: ~600 LoC. Markdown heading detection, CSV row parsing, modifier-line parsing, comment stripping.
2. Schema interpreter (`schema.hcsv → CREATE TABLE / INDEX SQL`): ~300 LoC. Replaces declarative.toml's existing `GenerateSQL` half.
3. Seed/demo interpreter (`seed.hcsv → INSERT SQL` with row aliases + `parent` resolution + `$-lookups` + `@-aliases` + array expansion + attribute expansion): ~800 LoC. The bulk of the work.
4. Toposort of row references: ~150 LoC.
5. Tests: ~500 LoC.

**~2400 LoC vs. ~510 LoC for today's declarative loader.** ~5× the code, ~5× the density gain. Roughly break-even, except the new format catches more invariants statically (composite PKs, attribute-vs-column conflicts, FK references-by-name) than today's loader does.

## Open issues for a real spec

Things I'd want pinned down before treating this as more than a strawman:

1. **JSON-value escaping** (see Hurts). Heredoc, or accept CSV escaping?
2. **Comment syntax** — HTML `<!-- -->` works but is verbose. Consider `; ` at line start as a row-level comment.
3. **Multi-row parent disambiguation.** Per your decision, `parent` resolves to the *last* row of the parent section. Document this loud and clear; the surprising-on-first-encounter case is "I added a second row to a section and now my children point at the wrong one." A `parent_strict` mode (error if parent section has >1 row) might be a useful lint.
4. **m:n alias requirement.** You said m:n tables may require aliases — is this enforced (m:n table with no explicit alias on its rows is a parse error), or convention (you can omit aliases if you don't need cross-references)?
5. **Process names with dots.** `$process."card.update"` works but the quoting inside an already-quoted CSV cell is ugly. Alternative: rename processes to avoid dots (`card_update`, `comment_post`), at the cost of changing the running app.
6. **`### query` for Go codegen.** You said hold off; this strawman doesn't include any query blocks. Adding them later is purely additive to the format.
7. **Heading-only doc vs. `### meta` doc.** Currently I have `# table foo | doc="..."` on the heading and per-table comments in HTML form. A `doc` key in `### meta` is also workable. Pick one to be canonical.

## Recommendation

The format works. It's denser than declarative.toml by ~5× on typical content, dramatically denser on the demo block (the worst pain point today). The runtime cost is ~2400 LoC for the loader vs. ~510 LoC today — significant but bounded.

The JSON-escaping concern is resolved by backtick-quoted cells (see "Hurts" §"JSON values" above — the design accepts these as the third quoting form, alongside bare and double-quoted, and the parser handles them natively without a preprocess pass).

Three paths forward:

- **A. Commit to hcsv as the new format.** Build the loader. Migrate `declarative.toml` to `schema.hcsv` + `seed.hcsv` + `demo.hcsv`. Drop the existing TOML schema generator. ~2 weeks of focused work.
- **B. Hybrid: keep `declarative.toml` for schema and install seed, add `demo.hcsv` for just the demo.** The demo is where the pain is. Get most of the benefit with ~25% of the implementation cost.
- **C. Stay with declarative.toml + add row aliases.** Extend the existing format with the alias mechanism so we can drop the `[[demo]]` PL/pgSQL block without inventing a new file format. Smallest change, smallest gain.

Worth at least scoping (B) before committing to (A). If the demo is the only place that hurts, replacing only the demo gives 70% of the benefit. The schema and install seed are already declarative-data-tables in TOML.

What I'd want next: your read on (A) vs. (B) vs. (C), plus a decision on the JSON-escaping question.
