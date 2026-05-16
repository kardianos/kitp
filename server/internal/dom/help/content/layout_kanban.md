## Kanban layout

The kanban layout shows cards as tiles arranged into columns by one attribute and, optionally, into swim-lane rows by a second attribute. Dragging a card across columns invokes the matching flow transition.

**Best for:** work that moves through a small, fixed set of states (todo → doing → review → done).

**Affordances:**
- The filter's `column_attr` chooses the column axis; `lane_attr` chooses the row axis. Without `lane_attr` you get a single row of columns.
- Drag a card between columns to apply the transition. If the move is not a legal flow step, the drop is rejected and the card snaps back.
- Quick-entry at the foot of each column adds a card directly into that column's value.
