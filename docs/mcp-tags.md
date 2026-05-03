# kitp MCP Tag Schema (v1, locked)

This document describes the struct-tag schema kitp's MCP auto-publish
(`internal/mcp`) reads off handler input/output types to generate JSON
Schemas for MCP tools (Phase 19, REQUIREMENTS §3.5).

The schema is versioned. **v1 is locked**: tag keys, tag values, and the
JSON Schema mapping below are stable for v1. Adding new tag keys later
must keep the v1 keys interpreted unchanged.

## Locked tag keys (v1)

The tag namespace is `mcp` on struct fields:

```go
type InsertInput struct {
    CardTypeName string `json:"card_type_name" mcp:"desc=name of the card_type to create,required"`
    ParentCardID *int64 `json:"parent_card_id,omitempty" mcp:"desc=parent card id; nil for top-level cards"`
    Title        string `json:"title" mcp:"desc=value for the built-in title attribute,required"`
}
```

Recognised keys:

| Key        | Where               | Meaning |
| ---------- | ------------------- | ------- |
| `desc`     | input + output      | Human-readable description copied to JSON Schema `description`. **Greedy**: `desc=` consumes the entire remainder of the tag (so commas, parentheses, and slashes inside the description are fine). Always put `desc=` last. |
| `required` | input only          | Marks the field as required in the generated `required` array. Boolean flag (no value). |
| `enum`     | input only          | Pipe-separated list of allowed string values, e.g. `enum=ASC|DESC`. Mapped to JSON Schema `enum`. |

Tag-key ordering: `required` and `enum` come before `desc=`. The
canonical layout is `mcp:"required,enum=A|B,desc=human readable text"`.

Other keys are reserved and may be added in future tag schema versions.

The handler-level description is supplied via the registry, not a tag:

```go
reg.Register(reg.Handler{
    Endpoint:  "card",
    Action:    "insert",
    Doc:       "Insert a new card with the given card_type, optional parent, and initial title plus attributes.",
    ...
})
```

`Handler.Doc` becomes the MCP tool's `description`.

## Required-field detection

A field is reported in JSON Schema's `required` array iff:

* the `mcp` tag carries the `required` flag, **AND**
* the field's Go type is a non-pointer scalar or slice / map / struct (we
  treat presence as required when the value is not optional in Go).

Pointer-typed fields without `required` are emitted as optional and are
not added to the `required` list.

## Go-type to JSON Schema mapping

| Go type                            | JSON Schema |
| ---------------------------------- | ----------- |
| `string`                           | `{"type":"string"}` |
| `bool`                             | `{"type":"boolean"}` |
| `int`, `int32`, `int64`            | `{"type":"integer"}` |
| `*T`                               | same as `T`, but the field is omitted from `required` and the JSON tag honours `omitempty`. |
| `[]T`                              | `{"type":"array","items":<T>}` |
| `map[string]any`                   | `{"type":"object","additionalProperties":true}` |
| `map[string]json.RawMessage`       | `{"type":"object","additionalProperties":true}` |
| `json.RawMessage`                  | `{}` (any JSON value) |
| `time.Time`                        | `{"type":"string","format":"date-time"}` |
| struct                             | recursive `{"type":"object","properties":{…},"required":[…]}` |

Field names follow the JSON tag's first segment (e.g. `parent_card_id`
from `json:"parent_card_id,omitempty"`). If the JSON tag is missing or
`-`, the field is skipped.

The output schema uses the same mapping; `required` and `enum` are
ignored on output structs (only `desc` matters). All output fields are
reported as required for MCP introspection unless the JSON tag is
`omitempty`, mirroring the input rules.

## Tool naming

Tool names are `<endpoint>__<action>` (double underscore, so the
dot-separated handler key stays readable in domain code). Examples:

* `card.insert` -> `card__insert`
* `attribute.update` -> `attribute__update`
* `card_type.select` -> `card_type__select`

The auto-published `list_handlers` tool is reserved; no real handler
may register under `(endpoint=list, action=handlers)` if it would
collide on the MCP side.

## Versioning policy

* v1 tag keys (`desc`, `required`, `enum`) and the type mapping above
  are frozen for all of v1.
* Adding a new tag key in a v2 schema bump must keep v1-only readers
  parsing v1 tags unchanged.
* Removing a tag key is a backwards-incompatible change and requires a
  schema-version bump.
