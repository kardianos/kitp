/// InboxScreen — per-user list of "open work assigned to me".
///
/// Dispatcher contract:
///   - On entry we issue ONE batch with these sub-requests:
///       1. inbox.select for the calling user's open tasks (server applies
///          assignee=:user_id AND status != "done", joins user_card_sort
///          for personal ordering, falls back to created_at DESC).
///       2. user.select for resolving assignee display names.
///       3. card.select_with_attributes for milestones+components+tags
///          (single call returning every non-task chip target).
///     The dispatcher coalesces them into ONE HTTP call (N-CLI-2).
///   - Drag-drop reorder: ONE batch with ONE `user_card_sort.set`. The
///     sort_order is computed from the dropped slot's neighbours (top:
///     `(first ?? 100) - 100`; between A and B: `(a + b) / 2`; bottom:
///     `(last ?? 0) + 100`). On `BatchAbortedError`/`SubRequestError` we
///     snap the row back and surface a Snackbar.
///   - Tapping a row routes to /task/:id.
///
/// Cards without a personal sort order get a lighter-coloured leading
/// indicator so users can see at a glance which rows they have actually
/// touched (the "personalised" badge in the description column). The
/// rest of the row chrome is identical to the kanban's TaskRow render.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app.dart';
import '../../dispatch/errors.dart';
import '../../reg/handlers.dart';
import '../filter/filter_bar.dart';
import '../filter/predicate.dart';
import '../widgets/task_row.dart';

/// **TEMPORARY** — the System User (id=1) is not assigned to any seeded
/// task, so until OIDC lands in Phase 20 we hard-wire the inbox to view
/// alice's queue (id=2) so the screen looks lived-in. This constant is
/// the single point of replacement when Phase 20 wires the real user
/// id from the OIDC subject claim.
const int kCurrentUserId = 2;

/// Sort-order spacing: the gap between two consecutive personal
/// sort_order values at the top or bottom of the list. Generous enough
/// that you can drop many cards before exhausting numerical precision.
/// Mirrors the kanban's `_kSortOrderStep`.
const double _kSortOrderStep = 100.0;

/// Carries the dragged row through the drop pipeline.
class _InboxDragPayload {
  final InboxRow row;
  const _InboxDragPayload(this.row);
}

class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key});

  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends State<InboxScreen> {
  /// Inbox rows in display order — i.e. as the server returned them
  /// (personal_sort_order ASC NULLS LAST, created_at DESC). Drag-drop
  /// re-orders this list optimistically; a refresh re-renders from the
  /// server.
  List<InboxRow> _tasks = [];
  Map<int, String> _userNames = {};
  Map<int, String> _tagPaths = {};
  Map<int, String> _cardTitles = {};
  bool _loading = true;
  String? _error;

  /// Active FilterBar predicate. Null = no extra filtering (the inbox's
  /// built-in `assignee = me AND status != done` predicate still
  /// applies). Layered on the wire as the `tree` field of
  /// `inbox.select`.
  Predicate? _filter;

  bool _bootstrapped = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_bootstrapped) {
      _bootstrapped = true;
      _refresh();
    }
  }

  /// Available filterable attributes for the FilterBar's pickers. Mirrors
  /// the static set used by Grid; the assignee picker's options are
  /// resolved against `_userNames` once the user lookup has loaded.
  List<FilterAttribute> _filterAttributes() {
    return [
      const FilterAttribute(
        name: 'status',
        label: 'Status',
        options: [
          FilterAttributeOption(value: 'todo', label: 'todo'),
          FilterAttributeOption(value: 'doing', label: 'doing'),
          FilterAttributeOption(value: 'review', label: 'review'),
          FilterAttributeOption(value: 'done', label: 'done'),
        ],
      ),
      FilterAttribute(
        name: 'assignee',
        label: 'Assignee',
        options: [
          for (final e in _userNames.entries)
            FilterAttributeOption(value: e.key, label: e.value),
        ],
      ),
      const FilterAttribute(
        name: 'milestone_ref',
        label: 'Milestone',
      ),
      const FilterAttribute(
        name: 'component_ref',
        label: 'Component',
      ),
    ];
  }

  /// Build the wire `tree` field from the active filter predicate, or
  /// null when no filter is set. The server's CardWhereGroup expects a
  /// `connective` at the root; if the predicate is a bare leaf, wrap it
  /// in a single-child AND so the wire shape is always a group.
  Map<String, dynamic>? _buildTree() {
    final f = _filter;
    if (f == null) return null;
    if (f is PredicateGroup) return f.toJson();
    return PredicateGroup(
      connective: GroupConnective.and,
      children: [f],
    ).toJson();
  }

  void _onFilterChanged(Predicate? next) {
    setState(() => _filter = next);
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final dispatcher = KitpApp.dispatcherOf(context);

    // 1. Inbox tasks (personal-ordered). Until OIDC lands the client is
    //    pinned to alice (kCurrentUserId); the System User actor is
    //    permitted to impersonate any user_id in dev mode (see
    //    inbox.authzSelect).
    //    The optional `tree` carries the FilterBar's predicate so the
    //    server can layer extra constraints on top of its built-in
    //    `assignee = me AND status != done` predicate.
    final fInbox =
        dispatcher.request<InboxSelectInput, InboxSelectOutput>(
      endpoint: 'inbox',
      action: 'select',
      data: InboxSelectInput(
        userId: kCurrentUserId,
        tree: _buildTree(),
      ),
    );

    // 2. Users (for assignee chip).
    final fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>(
      endpoint: 'user',
      action: 'select',
      data: const UserSelectInput(),
    );

    // 3. Reference cards: milestones + components + tags. Three
    //    sub-requests but the dispatcher batches them with the inbox fetch
    //    above into ONE HTTP call.
    final fMilestones = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: const CardSelectWithAttributesInput(cardTypeName: 'milestone'),
    );
    final fComponents = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: const CardSelectWithAttributesInput(cardTypeName: 'component'),
    );
    final fTags = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: const CardSelectWithAttributesInput(cardTypeName: 'tag'),
    );

    try {
      final results = await Future.wait(
          [fInbox, fUsers, fMilestones, fComponents, fTags]);
      if (!mounted) return;
      final iOut = results[0] as InboxSelectOutput;
      final uOut = results[1] as UserSelectOutput;
      final mOut = results[2] as CardSelectWithAttributesOutput;
      final cOut = results[3] as CardSelectWithAttributesOutput;
      final tagOut = results[4] as CardSelectWithAttributesOutput;
      setState(() {
        _tasks = iOut.rows;
        _userNames = {for (final u in uOut.rows) u.id: u.displayName};
        _cardTitles = {
          for (final m in mOut.rows)
            if (m.title != null) m.id: m.title!,
          for (final c in cOut.rows)
            if (c.title != null) c.id: c.title!,
        };
        _tagPaths = {
          for (final t in tagOut.rows)
            if (t.attributes['path'] is String)
              t.id: t.attributes['path'] as String,
        };
        _loading = false;
      });
    } on SubRequestError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    } on BatchAbortedError catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.reason;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  /// Compute the new personal sort_order for a card dropped at slot
  /// `slot` (0..N) in the current list. Mirrors the kanban math but
  /// against `personalSort` rather than the global `sort_order`.
  double _newSortOrderAt(List<InboxRow> visible, int slot) {
    if (visible.isEmpty) return 0.0;
    if (slot <= 0) {
      final first = visible.first.personalSort ?? _kSortOrderStep;
      return first - _kSortOrderStep;
    }
    if (slot >= visible.length) {
      final last = visible.last.personalSort ?? 0.0;
      return last + _kSortOrderStep;
    }
    final a = visible[slot - 1].personalSort;
    final b = visible[slot].personalSort;
    if (a != null && b != null) return (a + b) / 2.0;
    if (a != null) return a + _kSortOrderStep;
    if (b != null) return b - _kSortOrderStep;
    return slot * _kSortOrderStep.toDouble();
  }

  /// Drag-drop handler: move [row] to slot [slot]. Issues ONE batch with
  /// ONE user_card_sort.set. Optimistic UI; rollback on error.
  Future<void> _handleDrop(InboxRow row, int slot) async {
    final dispatcher = KitpApp.dispatcherOf(context);

    // Compute the destination list as it WOULD look post-move so the
    // sort_order math doesn't include the dragged row itself.
    final without = [for (final r in _tasks) if (r.id != row.id) r];
    var insertAt = slot;
    final origIdx = _tasks.indexWhere((r) => r.id == row.id);
    if (origIdx >= 0 && origIdx < slot) insertAt -= 1;
    if (insertAt < 0) insertAt = 0;
    if (insertAt > without.length) insertAt = without.length;

    final newSort = _newSortOrderAt(without, insertAt);

    // Optimistic move: local list mutation first.
    final original = List<InboxRow>.from(_tasks);
    final moved = InboxRow(
      id: row.id,
      cardTypeId: row.cardTypeId,
      parentCardId: row.parentCardId,
      attributes: row.attributes,
      personalSort: newSort,
    );
    setState(() {
      _tasks = [...without];
      _tasks.insert(insertAt, moved);
    });

    try {
      await dispatcher
          .request<UserCardSortSetInput, UserCardSortSetOutput>(
        endpoint: 'user_card_sort',
        action: 'set',
        data: UserCardSortSetInput(cardId: row.id, sortOrder: newSort),
      );
    } on SubRequestError catch (e) {
      if (!mounted) return;
      setState(() => _tasks = original);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Reorder failed: ${e.message}')),
      );
    } on BatchAbortedError catch (e) {
      if (!mounted) return;
      setState(() => _tasks = original);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Reorder aborted: ${e.reason}')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _tasks = original);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Reorder failed: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _buildBody(context),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading && _tasks.isEmpty && _filter == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.error_outline,
                  size: 48, color: Theme.of(context).colorScheme.error),
              const SizedBox(height: 12),
              Text(
                'Failed to load inbox: ${_error!}',
                key: const Key('inbox-error'),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              const SizedBox(height: 12),
              FilledButton(onPressed: _refresh, child: const Text('Retry')),
            ],
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Text(
            'Inbox — ${_tasks.length} open task${_tasks.length == 1 ? '' : 's'}',
            key: const Key('inbox-header'),
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ),
        Container(
          key: const Key('inbox-filter-bar'),
          child: FilterBar(
            value: _filter,
            onChanged: _onFilterChanged,
            attributes: _filterAttributes(),
          ),
        ),
        const Divider(height: 1),
        if (_tasks.isEmpty)
          const Expanded(
            child: Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'Your inbox is clear.',
                  key: Key('inbox-empty'),
                  style: TextStyle(fontSize: 16),
                ),
              ),
            ),
          )
        else
          Expanded(
            child: ListView(
              key: const Key('inbox-list'),
              padding: const EdgeInsets.symmetric(vertical: 8),
              children: _buildListChildren(context),
            ),
          ),
      ],
    );
  }

  /// Build alternating drop slots and draggable rows. Slot N sits BEFORE
  /// row N; the trailing slot at index `_tasks.length` is "drop at
  /// bottom". Pattern mirrors the kanban's `_buildColumnChildren`.
  List<Widget> _buildListChildren(BuildContext context) {
    final out = <Widget>[];
    for (var i = 0; i < _tasks.length; i++) {
      out.add(_InboxDropSlot(
        key: Key('inbox-slot-$i'),
        onAccept: (payload) => _handleDrop(payload.row, i),
      ));
      out.add(_DraggableInboxRow(
        row: _tasks[i],
        userNames: _userNames,
        tagPaths: _tagPaths,
        cardTitles: _cardTitles,
        onTap: () => context.go('/task/${_tasks[i].id}'),
      ));
    }
    out.add(_InboxDropSlot(
      key: Key('inbox-slot-${_tasks.length}'),
      onAccept: (payload) => _handleDrop(payload.row, _tasks.length),
      tail: true,
    ));
    return out;
  }
}

/// One row, wrapped in a `LongPressDraggable<_InboxDragPayload>` so
/// long-pressing starts a drag (touch-friendly fallback). For pointer
/// users an explicit `Icons.drag_indicator` handle is prepended to the
/// leading edge; the handle uses an immediate `Draggable` (no long
/// press) and shows a grab cursor on hover so the gesture is
/// discoverable. The undragged child is the original `TaskRow`; the
/// feedback is a Material-elevated copy with a fixed width so it
/// tracks the cursor cleanly across the column.
class _DraggableInboxRow extends StatelessWidget {
  final InboxRow row;
  final Map<int, String> userNames;
  final Map<int, String> tagPaths;
  final Map<int, String> cardTitles;
  final VoidCallback onTap;

  const _DraggableInboxRow({
    required this.row,
    required this.userNames,
    required this.tagPaths,
    required this.cardTitles,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final hasPersonalSort = row.personalSort != null;
    // A subtle leading indicator highlights rows the user has actively
    // ordered vs. the server's fallback ordering. We use a thin coloured
    // border to keep the styling unobtrusive.
    final body = TaskRow(
      task: row.toCardWithAttrs(),
      userNames: userNames,
      tagPaths: tagPaths,
      cardTitles: cardTitles,
      onTap: onTap,
    );
    final handleIcon = Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Icon(
        Icons.drag_indicator,
        key: Key('inbox-drag-handle-${row.id}'),
        color: cs.onSurfaceVariant,
      ),
    );
    final handle = MouseRegion(
      cursor: SystemMouseCursors.grab,
      child: Draggable<_InboxDragPayload>(
        data: _InboxDragPayload(row),
        feedback: _buildFeedback(),
        childWhenDragging: Opacity(opacity: 0.4, child: handleIcon),
        child: handleIcon,
      ),
    );
    final card = Container(
      decoration: BoxDecoration(
        border: Border(
          left: BorderSide(
            color: hasPersonalSort
                ? cs.primary.withValues(alpha: 0.7)
                : cs.outlineVariant.withValues(alpha: 0.4),
            width: 3,
          ),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          handle,
          Expanded(child: body),
        ],
      ),
    );
    return LongPressDraggable<_InboxDragPayload>(
      data: _InboxDragPayload(row),
      feedback: _buildFeedback(),
      childWhenDragging: Opacity(opacity: 0.4, child: card),
      child: card,
    );
  }

  Widget _buildFeedback() {
    return Material(
      elevation: 6,
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(
        width: 480,
        child: TaskRow(
          task: row.toCardWithAttrs(),
          userNames: userNames,
          tagPaths: tagPaths,
          cardTitles: cardTitles,
          onTap: () {},
        ),
      ),
    );
  }
}

/// A 1D drop target sitting between two rows (or above the first / below
/// the last). Fixed-height like the kanban's `_DropSlotZone` so it
/// doesn't relayout on hover, which would race the up event in headless
/// tests.
class _InboxDropSlot extends StatelessWidget {
  final void Function(_InboxDragPayload payload) onAccept;
  final bool tail;
  const _InboxDropSlot({super.key, required this.onAccept, this.tail = false});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final height = tail ? 32.0 : 12.0;
    return SizedBox(
      height: height,
      child: DragTarget<_InboxDragPayload>(
        onWillAcceptWithDetails: (_) => true,
        onAcceptWithDetails: (details) => onAccept(details.data),
        builder: (context, candidate, rejected) {
          final highlighted = candidate.isNotEmpty;
          return Container(
            margin: const EdgeInsets.symmetric(vertical: 1, horizontal: 4),
            decoration: BoxDecoration(
              color: highlighted
                  ? cs.primaryContainer.withValues(alpha: 0.55)
                  : cs.surfaceContainer.withValues(alpha: 0.001),
              border: highlighted
                  ? Border.all(color: cs.primary, width: 2)
                  : null,
              borderRadius: BorderRadius.circular(4),
            ),
          );
        },
      ),
    );
  }
}
