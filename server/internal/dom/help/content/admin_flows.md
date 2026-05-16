# Flows

A **flow** binds one attribute (typically `status`) to a project and enumerates the legal transitions between its values. The runtime transition bar (the buttons that move a card from `todo` to `doing`, etc.) reads the same flow rows you author here.

## When to add a flow

Add a flow whenever you need a closed graph of states for a card type — for example a bug lifecycle, a review pipeline, or a publishing workflow. If you just need an unconstrained dropdown, an attribute on its own is enough; flows exist for the cases where the *order* of transitions matters.

## Authoring layout

The screen is three panes:

1. **Left** — project picker plus the list of flows in the selected project. "+ New flow" opens a small dialog that asks for the bound attribute and a name.
2. **Center** — header for the selected flow (name, doc, default create status). The bound attribute is fixed once the flow exists.
3. **Right** — step editor. Each step is a `(from → to)` transition with an optional label, a `requires_role`, and a `sort_order`.

## Steps and transitions

A step is the edge from one value-card to another. `from` is omitted on the very first step (the *create* step) — that is the transition that produces the card in its starting state. Subsequent steps must name both endpoints.

`requires_role` gates a transition behind a role. When set, only users who hold that role see the transition button at runtime.

## Deleting a flow

Delete opens a preview that lists the value-cards and tasks that reference the flow. The destructive call only runs after you confirm.

## Related admin pages

- **Screens** (in the sidebar under *Admin*) — a screen can bind to a flow via its `flow_ref` attribute, which is what surfaces the transition buttons on tasks shown by that screen.
