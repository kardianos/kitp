# Attributes

An **attribute definition** declares a field that cards can carry. It names the field (`status`, `priority`, `assignee`, …), pins its value type (string, number, boolean, card_ref, card_ref[]), and lists which card types are allowed to bind it.

This page is the canonical authoring surface for those defs plus the value cards that ref-typed attributes draw from (statuses, milestones, components, tags).

## Three panes

| Pane    | Role                                                                       |
| ------- | -------------------------------------------------------------------------- |
| **Left**   | List of every attribute_def, grouped by built-in vs custom. "+ New attribute" creates a draft. |
| **Center** | Edit form for the selected def — name, value_type, and the card_type a `card_ref` / `card_ref[]` points at. |
| **Right**  | "Bound to" matrix — one row per card_type. Toggle `[Bound]`, set `Ordering`, mark `[Required]`. Each toggle fires `edge.insert` / `edge.delete` immediately. |

## Value types

| Value type    | Stores                                                            |
| ------------- | ----------------------------------------------------------------- |
| `string`      | A single text value.                                              |
| `number`      | A 64-bit signed integer.                                          |
| `boolean`     | true / false.                                                     |
| `card_ref`    | One card id of a chosen target card_type (e.g. `assignee` → `person`). |
| `card_ref[]`  | A list of card ids (e.g. `tags` → many `tag` cards on one task).  |

The `target_card_type_name` field locks the type of card a `card_ref` / `card_ref[]` may reference. It is editable until any value of this attribute exists on a card; after that, the binding is frozen so existing rows do not point at a card_type the new target rejects.

## Built-in vs custom

`is_built_in` attributes are seeded by the platform (title, slug, layout, …). They cannot be renamed and they cannot be deleted. Custom attributes are everything you author here.

## Required edges

Marking a binding **required** means a card of the bound card_type must carry a value for this attribute. Card insert will reject any draft missing a required attribute. Use sparingly — once a binding is required, every existing card without a value becomes invalid until you backfill or relax the constraint.

## Ordering

The "Bound to" matrix carries an `ordering` integer per binding. This is the order attribute rows show up in card detail views and quick-entry forms, ascending. Two attributes with the same ordering tie-break on name.

## Deleting an attribute_def

A def can only be deleted when no attribute_value rows reference it. If they do, the delete is refused and the dialog lists how many rows are blocking; you must clear or migrate them first.

## Value-card management

For `card_ref` / `card_ref[]` defs whose target_card_type is `status`, `milestone`, `component`, or `tag`, the right pane shows the **value cards** that live under each project for that card_type. Inline editing creates / renames / archives them; flows on the **Flows** page reference the value cards by id.

## Related admin pages

- **Flows** — bind transitions to a value-card attribute (typically `status`).
- **Screens** — filters reference attributes by name; the Visual builder picks names from this list.
