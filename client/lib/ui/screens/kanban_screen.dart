/// KanbanScreen — column + (optional) swim-lane board over tasks.
///
/// Dispatcher contract:
///   - Initial load: ONE batch with five sub-requests (tasks, users,
///     milestones, components, tags). Coalesced into one HTTP call.
///   - Drag-drop: optimistic local move; ONE batch posts the
///     `attribute.update`(s) for sort_order (always), the column attribute
///     (if the column changed) and the lane attribute (if a lane is active
///     and the lane changed). On `BatchAbortedError` / `SubRequestError`
///     we snap back to the pre-drop state and surface a Snackbar.
///
/// "Columns by:" defaults to `status`. Other options: `assignee`,
/// `milestone_ref`, `component_ref`. "Swim lanes by:" defaults to `(none)`.
///
/// Within-column ordering is `attributes.sort_order ASC`, with a fallback
/// to `id ASC` for cards whose sort_order is null. Drop targets sit
/// between every pair of cards plus the top and bottom edges of each
/// column. The drop computes a new sort_order halfway between neighbours
/// (or +/- 100 at the column edges) so a single drop never has to
/// re-sequence siblings.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app.dart';
import '../../dispatch/errors.dart';
import '../../reg/handlers.dart';
import '../filter/filter_bar.dart';
import '../filter/predicate.dart';
import '../widgets/attribute_chip.dart';
import '../widgets/tag_chip.dart';

/// Built-in attributes the kanban can group by.
const List<_GroupOption> _kGroupOptions = [
  _GroupOption('status', 'Status'),
  _GroupOption('assignee', 'Assignee'),
  _GroupOption('milestone_ref', 'Milestone'),
  _GroupOption('component_ref', 'Component'),
];

class _GroupOption {
  final String attr;
  final String label;
  const _GroupOption(this.attr, this.label);
}

/// Sentinel value standing in for the "(none)" swim lane option.
const String _kNoLane = '__none__';

/// Constant: the four status values displayed when grouping by status.
const List<String> _kStatuses = ['todo', 'doing', 'review', 'done'];

/// Sentinel column for tasks whose grouping attribute is unset.
const String _kUnsetKey = '__unset__';

/// Sort-order spacing: the gap between two consecutive sort_order values
/// at the top or bottom of a column. Generous enough that you can drop
/// many cards before exhausting numerical precision.
const double _kSortOrderStep = 100.0;

/// Carries the state of a drop: source card + destination cell + index.
class _DropPayload {
  final CardWithAttrs task;
  const _DropPayload(this.task);
}

class KanbanScreen extends StatefulWidget {
  /// Optional project scope. When null, every task in the system is loaded.
  final int? projectId;
  const KanbanScreen({super.key, this.projectId});

  @override
  State<KanbanScreen> createState() => _KanbanScreenState();
}

class _KanbanScreenState extends State<KanbanScreen> {
  String _columnAttr = 'status';
  String _laneAttr = _kNoLane;

  List<CardWithAttrs> _tasks = [];
  Map<int, String> _userNames = {};
  Map<int, String> _tagPaths = {};
  Map<int, String> _cardTitles = {};
  bool _loading = true;
  String? _error;

  /// Active FilterBar predicate. Null = no filtering — every task scoped
  /// to the current project (or board) is loaded. Sent on the wire as
  /// `card.select_with_attributes.tree`.
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
  /// the static set used by Grid; the assignee picker's options resolve
  /// against `_userNames` once the user lookup has loaded.
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

    final fTasks = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: CardSelectWithAttributesInput(
        cardTypeName: 'task',
        parentCardId: widget.projectId,
        tree: _buildTree(),
        order: const [
          CardOrderClause(field: 'attributes.sort_order', direction: 'ASC'),
        ],
        limit: 5000,
      ),
    );
    final fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>(
      endpoint: 'user',
      action: 'select',
      data: const UserSelectInput(),
    );
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
          [fTasks, fUsers, fMilestones, fComponents, fTags]);
      if (!mounted) return;
      final tOut = results[0] as CardSelectWithAttributesOutput;
      final uOut = results[1] as UserSelectOutput;
      final mOut = results[2] as CardSelectWithAttributesOutput;
      final cOut = results[3] as CardSelectWithAttributesOutput;
      final tagOut = results[4] as CardSelectWithAttributesOutput;
      setState(() {
        _tasks = tOut.rows;
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

  /// Build the ordered list of column keys for `_columnAttr`. For status
  /// we use the canonical four-step order; for ref attributes we walk
  /// every task to enumerate distinct values, plus a trailing sentinel
  /// for "unset" tasks.
  List<String> _columnKeysForAttr(String attr) {
    if (attr == 'status') {
      return [..._kStatuses, _kUnsetKey];
    }
    final keys = <String>[];
    final seen = <String>{};
    for (final t in _tasks) {
      final v = t.attributes[attr];
      final k = _keyOf(v);
      if (!seen.contains(k)) {
        seen.add(k);
        keys.add(k);
      }
    }
    if (!seen.contains(_kUnsetKey)) {
      keys.add(_kUnsetKey);
    }
    return keys;
  }

  /// Build the ordered list of lane keys for the active lane attribute.
  List<String> _laneKeys() {
    if (_laneAttr == _kNoLane) return const [_kNoLane];
    return _columnKeysForAttr(_laneAttr);
  }

  String _keyOf(dynamic v) {
    if (v == null) return _kUnsetKey;
    if (v is String) return v;
    if (v is num) return v.toString();
    if (v is bool) return v.toString();
    return v.toString();
  }

  String _labelFor(String attr, String key) {
    if (key == _kUnsetKey) return '(unset)';
    if (attr == 'status') return key;
    if (attr == 'assignee') {
      final id = int.tryParse(key);
      if (id != null) {
        return _userNames[id] ?? 'user#$id';
      }
      return key;
    }
    final id = int.tryParse(key);
    if (id != null) {
      return _cardTitles[id] ?? 'card#$id';
    }
    return key;
  }

  /// Move task `t` so its [attr] equals the value implied by `key`.
  dynamic _valueForKey(String attr, String key) {
    if (key == _kUnsetKey) return null;
    if (attr == 'status') return key;
    return int.tryParse(key);
  }

  /// Pull the sort_order out of a card. Cards with a missing or non-numeric
  /// sort_order return null; the caller then falls back to id-ordering.
  double? _sortOrderOf(CardWithAttrs c) {
    final v = c.attributes['sort_order'];
    if (v is num) return v.toDouble();
    return null;
  }

  /// Compute the new sort_order for a card dropped at slot `slot` (0..N)
  /// in column `colCards`. The list is already sorted by sort_order ASC
  /// (with id as the tie-breaker baked in by the caller).
  double _newSortOrderAt(List<CardWithAttrs> colCards, int slot) {
    if (colCards.isEmpty) return 0.0;
    if (slot <= 0) {
      final first = _sortOrderOf(colCards.first) ?? _kSortOrderStep;
      return first - _kSortOrderStep;
    }
    if (slot >= colCards.length) {
      final last = _sortOrderOf(colCards.last) ?? 0.0;
      return last + _kSortOrderStep;
    }
    final a = _sortOrderOf(colCards[slot - 1]);
    final b = _sortOrderOf(colCards[slot]);
    if (a != null && b != null) return (a + b) / 2.0;
    if (a != null) return a + _kSortOrderStep;
    if (b != null) return b - _kSortOrderStep;
    return slot * _kSortOrderStep.toDouble();
  }

  /// Drag-drop handler: moves [task] into the (column, lane) cell whose
  /// children are [colCards] (already in display order) at [slot]. ONE
  /// batch with up to three `attribute.update` sub-requests:
  ///   - sort_order (always)
  ///   - column attr (only if changed)
  ///   - lane attr (only if active and changed)
  Future<void> _handleDrop(
    CardWithAttrs task, {
    required String colKey,
    required String laneKey,
    required List<CardWithAttrs> destCards,
    required int slot,
  }) async {
    final dispatcher = KitpApp.dispatcherOf(context);
    final updates = <Future<AttributeUpdateOutput>>[];
    final updatedAttrs = <String, dynamic>{...task.attributes};

    // Compute the destination card list as it WOULD look post-move so the
    // sort_order math doesn't include the dragged card itself. If the
    // card is already in the destination cell, drop it from the list at
    // its current index first.
    final destWithoutSelf = [
      for (final c in destCards) if (c.id != task.id) c,
    ];
    var insertAt = slot;
    if (destCards.length != destWithoutSelf.length && slot > 0) {
      // The dragged card was in destCards at some index < slot — adjust
      // insertAt so the slot still refers to the same visual gap.
      final origIdx = destCards.indexWhere((c) => c.id == task.id);
      if (origIdx >= 0 && origIdx < slot) insertAt -= 1;
    }
    if (insertAt < 0) insertAt = 0;
    if (insertAt > destWithoutSelf.length) insertAt = destWithoutSelf.length;

    final newSortOrder = _newSortOrderAt(destWithoutSelf, insertAt);

    // Always emit sort_order; otherwise refreshes after a "same cell, new
    // position" drop wouldn't show the move.
    updates.add(dispatcher
        .request<AttributeUpdateInput, AttributeUpdateOutput>(
      endpoint: 'attribute',
      action: 'update',
      data: AttributeUpdateInput(
        cardId: task.id,
        attributeName: 'sort_order',
        value: newSortOrder,
      ),
    ));
    updatedAttrs['sort_order'] = newSortOrder;

    final newColVal = _valueForKey(_columnAttr, colKey);
    final currentColKey = _keyOf(task.attributes[_columnAttr]);
    if (currentColKey != colKey) {
      updates.add(dispatcher
          .request<AttributeUpdateInput, AttributeUpdateOutput>(
        endpoint: 'attribute',
        action: 'update',
        data: AttributeUpdateInput(
          cardId: task.id,
          attributeName: _columnAttr,
          value: newColVal,
        ),
      ));
      if (newColVal == null) {
        updatedAttrs.remove(_columnAttr);
      } else {
        updatedAttrs[_columnAttr] = newColVal;
      }
    }

    if (_laneAttr != _kNoLane) {
      final newLaneVal = _valueForKey(_laneAttr, laneKey);
      final currentLaneKey = _keyOf(task.attributes[_laneAttr]);
      if (currentLaneKey != laneKey) {
        updates.add(dispatcher
            .request<AttributeUpdateInput, AttributeUpdateOutput>(
          endpoint: 'attribute',
          action: 'update',
          data: AttributeUpdateInput(
            cardId: task.id,
            attributeName: _laneAttr,
            value: newLaneVal,
          ),
        ));
        if (newLaneVal == null) {
          updatedAttrs.remove(_laneAttr);
        } else {
          updatedAttrs[_laneAttr] = newLaneVal;
        }
      }
    }

    // Optimistic update.
    final originalTasks = List<CardWithAttrs>.from(_tasks);
    setState(() {
      final idx = _tasks.indexWhere((x) => x.id == task.id);
      if (idx >= 0) {
        _tasks[idx] = CardWithAttrs(
          id: task.id,
          cardTypeId: task.cardTypeId,
          cardTypeName: task.cardTypeName,
          parentCardId: task.parentCardId,
          attributes: updatedAttrs,
          deletedAt: task.deletedAt,
        );
      }
    });

    try {
      await Future.wait(updates);
    } on SubRequestError catch (e) {
      if (!mounted) return;
      setState(() => _tasks = originalTasks);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Move failed: ${e.message}')),
      );
    } on BatchAbortedError catch (e) {
      if (!mounted) return;
      setState(() => _tasks = originalTasks);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Move aborted: ${e.reason}')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _tasks = originalTasks);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Move failed: $e')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.projectId == null
            ? 'Kanban'
            : 'Kanban — project ${widget.projectId}'),
        toolbarHeight: 48,
      ),
      body: _buildBody(context),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading && _tasks.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'Failed to load kanban: ${_error!}',
            key: const Key('kanban-error'),
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _buildToolbar(context),
        const Divider(height: 1),
        Expanded(child: _buildBoard(context)),
      ],
    );
  }

  Widget _buildToolbar(BuildContext context) {
    // Two rows: the first holds the "Columns by"/"Swim lanes by" pickers
    // and the task count. The second row hosts the FilterBar (chips +
    // add-button + advanced toggle). Two rows keeps both controls
    // touchable on narrow viewports without truncating either.
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: [
              const Text('Columns by: '),
              const SizedBox(width: 8),
              DropdownButton<String>(
                key: const Key('kanban-columns-by'),
                value: _columnAttr,
                items: [
                  for (final o in _kGroupOptions)
                    DropdownMenuItem(value: o.attr, child: Text(o.label)),
                ],
                onChanged: (v) {
                  if (v == null) return;
                  setState(() => _columnAttr = v);
                },
              ),
              const SizedBox(width: 24),
              const Text('Swim lanes by: '),
              const SizedBox(width: 8),
              DropdownButton<String>(
                key: const Key('kanban-lanes-by'),
                value: _laneAttr,
                items: [
                  const DropdownMenuItem(value: _kNoLane, child: Text('(none)')),
                  for (final o in _kGroupOptions)
                    DropdownMenuItem(value: o.attr, child: Text(o.label)),
                ],
                onChanged: (v) {
                  if (v == null) return;
                  setState(() => _laneAttr = v);
                },
              ),
              const Spacer(),
              Text('${_tasks.length} task${_tasks.length == 1 ? '' : 's'}'),
            ],
          ),
        ),
        Container(
          key: const Key('kanban-filter-bar'),
          child: FilterBar(
            value: _filter,
            onChanged: _onFilterChanged,
            attributes: _filterAttributes(),
          ),
        ),
      ],
    );
  }

  Widget _buildBoard(BuildContext context) {
    final columnKeys = _columnKeysForAttr(_columnAttr);
    final laneKeys = _laneKeys();

    // Group tasks into a map keyed by (lane, column). Within a cell, sort
    // by sort_order ASC (nulls last) with id as tie-breaker.
    final cells = <String, Map<String, List<CardWithAttrs>>>{};
    for (final lk in laneKeys) {
      cells[lk] = {for (final ck in columnKeys) ck: []};
    }
    for (final t in _tasks) {
      final ck = _keyOf(t.attributes[_columnAttr]);
      final lk = _laneAttr == _kNoLane ? _kNoLane : _keyOf(t.attributes[_laneAttr]);
      final laneMap = cells.putIfAbsent(lk, () => {});
      final colList = laneMap.putIfAbsent(ck, () => []);
      colList.add(t);
    }
    for (final laneMap in cells.values) {
      for (final colList in laneMap.values) {
        colList.sort((a, b) {
          final sa = _sortOrderOf(a);
          final sb = _sortOrderOf(b);
          if (sa != null && sb != null) {
            final c = sa.compareTo(sb);
            if (c != 0) return c;
            return a.id.compareTo(b.id);
          }
          if (sa == null && sb == null) return a.id.compareTo(b.id);
          return sa == null ? 1 : -1; // nulls last
        });
      }
    }

    // Single lane (no swim-lanes): the board fills the entire viewport
    // height. Multiple lanes: each lane gets a fixed slice tall enough to
    // be useful; the lane stack scrolls vertically when it overflows.
    if (_laneAttr == _kNoLane) {
      final lk = laneKeys.first;
      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minWidth: MediaQuery.of(context).size.width,
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final ck in columnKeys)
                _buildColumn(
                  context,
                  columnKey: ck,
                  laneKey: lk,
                  cells: cells[lk]?[ck] ?? const [],
                ),
            ],
          ),
        ),
      );
    }

    final laneRows = <Widget>[];
    for (final lk in laneKeys) {
      laneRows.add(_buildLaneHeader(context, lk));
      laneRows.add(
        SizedBox(
          height: 480,
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final ck in columnKeys)
                  _buildColumn(
                    context,
                    columnKey: ck,
                    laneKey: lk,
                    cells: cells[lk]?[ck] ?? const [],
                  ),
              ],
            ),
          ),
        ),
      );
      laneRows.add(const Divider(height: 12));
    }

    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: laneRows,
      ),
    );
  }

  Widget _buildLaneHeader(BuildContext context, String laneKey) {
    return Container(
      key: Key('kanban-lane-$laneKey'),
      width: double.infinity,
      color: Theme.of(context).colorScheme.surfaceContainerHigh,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Text(
        '${_optionLabel(_laneAttr)}: ${_labelFor(_laneAttr, laneKey)}',
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
    );
  }

  String _optionLabel(String attr) {
    for (final o in _kGroupOptions) {
      if (o.attr == attr) return o.label;
    }
    return attr;
  }

  Widget _buildColumn(
    BuildContext context, {
    required String columnKey,
    required String laneKey,
    required List<CardWithAttrs> cells,
  }) {
    final cs = Theme.of(context).colorScheme;

    // The column itself is just a visual container. Drop-zone DragTargets
    // live inside the ListView below (one between each pair of cards plus
    // a tail slot for "drop at bottom"). A wrapping column-level DragTarget
    // would race the inner slot targets in headless tests and would also
    // suppress the visual hover feedback per gap.
    return Container(
      key: Key('kanban-col-$laneKey-$columnKey'),
      width: 260,
      margin: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLow,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(
                horizontal: 12, vertical: 8),
            child: Row(
              children: [
                Text(
                  _labelFor(_columnAttr, columnKey),
                  key: Key('kanban-col-$laneKey-$columnKey-header'),
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                const Spacer(),
                Text('${cells.length}',
                    style: TextStyle(color: cs.onSurfaceVariant)),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.all(6),
              children: _buildColumnChildren(
                context,
                columnKey: columnKey,
                laneKey: laneKey,
                cells: cells,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Build the children of one column's ListView: alternating drop slots
  /// and draggable cards. Slot N sits BEFORE card N; slot length = card
  /// count + 1 (the trailing slot is "drop at bottom").
  List<Widget> _buildColumnChildren(
    BuildContext context, {
    required String columnKey,
    required String laneKey,
    required List<CardWithAttrs> cells,
  }) {
    final out = <Widget>[];
    for (var i = 0; i < cells.length; i++) {
      out.add(_DropSlotZone(
        key: Key('kanban-slot-$laneKey-$columnKey-$i'),
        onAccept: (payload) => _handleDrop(
          payload.task,
          colKey: columnKey,
          laneKey: laneKey,
          destCards: cells,
          slot: i,
        ),
      ));
      out.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: _DraggableCard(
          task: cells[i],
          userNames: _userNames,
          tagPaths: _tagPaths,
          cardTitles: _cardTitles,
          onTap: () => context.go('/task/${cells[i].id}'),
        ),
      ));
    }
    out.add(_DropSlotZone(
      key: Key('kanban-slot-$laneKey-$columnKey-${cells.length}'),
      onAccept: (payload) => _handleDrop(
        payload.task,
        colKey: columnKey,
        laneKey: laneKey,
        destCards: cells,
        slot: cells.length,
      ),
      tail: true,
    ));
    return out;
  }
}

/// A 1D drop target that sits between two cards (or above the first /
/// below the last). On hover, it visibly expands and highlights the gap
/// so the user can see where the card will land.
class _DropSlotZone extends StatelessWidget {
  final void Function(_DropPayload payload) onAccept;

  /// `tail=true` slots are the "below the last card" zone; they get a
  /// taller hit box so dropping into mostly-empty columns is easier.
  final bool tail;

  const _DropSlotZone({
    super.key,
    required this.onAccept,
    this.tail = false,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    // Fixed height per slot; the gap doesn't grow on hover (a hover-grow
    // animation triggers a relayout that, in headless tests, can drop the
    // up() event between hit-tests). Visual highlighting alone is enough
    // to communicate the drop landing site.
    final height = tail ? 28.0 : 18.0;
    return SizedBox(
      height: height,
      child: DragTarget<_DropPayload>(
        onWillAcceptWithDetails: (_) => true,
        onAcceptWithDetails: (details) => onAccept(details.data),
        builder: (context, candidate, rejected) {
          // The fixed-height SizedBox above keeps the slot at a stable
          // hit-test region; we paint hover state via a child decoration
          // here without changing the DragTarget's render box.
          final highlighted = candidate.isNotEmpty;
          return Container(
            margin: const EdgeInsets.symmetric(vertical: 1, horizontal: 2),
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

/// One kanban card. The card body is wrapped in a `LongPressDraggable`
/// so touch users can pick it up with a press-and-hold; for mouse / pen
/// users an explicit `Icons.drag_indicator` handle is rendered in the
/// header. The handle uses an immediate `Draggable` (no long press) and
/// shows a grab cursor on hover so the gesture is discoverable.
class _DraggableCard extends StatelessWidget {
  final CardWithAttrs task;
  final Map<int, String> userNames;
  final Map<int, String> tagPaths;
  final Map<int, String> cardTitles;
  final VoidCallback onTap;
  const _DraggableCard({
    required this.task,
    required this.userNames,
    required this.tagPaths,
    required this.cardTitles,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final card = _buildCard(context, dragging: false);
    final feedback = Material(
      elevation: 6,
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(width: 240, child: _buildCard(context, dragging: true)),
    );
    return LongPressDraggable<_DropPayload>(
      data: _DropPayload(task),
      feedback: feedback,
      childWhenDragging: Opacity(opacity: 0.4, child: card),
      child: card,
    );
  }

  Widget _buildCard(BuildContext context, {required bool dragging}) {
    final cs = Theme.of(context).colorScheme;
    final title = task.title ?? '(untitled)';
    final assigneeId = task.attributes['assignee'];
    final assigneeName = assigneeId is num ? userNames[assigneeId.toInt()] : null;

    String? priorityPath;
    final otherTagPaths = <String>[];
    final ids = task.attributes['tags'];
    if (ids is List) {
      for (final id in ids) {
        if (id is num) {
          final p = tagPaths[id.toInt()];
          if (p == null) continue;
          if (p.startsWith('priority/')) {
            priorityPath = p;
          } else {
            otherTagPaths.add(p);
          }
        }
      }
    }

    return InkWell(
      key: Key('kanban-card-${task.id}'),
      onTap: dragging ? null : onTap,
      child: Container(
        decoration: BoxDecoration(
          color: cs.surface,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: cs.outlineVariant, width: 0.5),
        ),
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w500),
                  ),
                ),
                // Only render the handle on the live card. The drag
                // feedback re-enters `_buildCard` with `dragging: true`,
                // which must skip the handle to avoid infinite recursion
                // on the Draggable's own feedback subtree.
                if (!dragging) _buildHandle(context),
              ],
            ),
            const SizedBox(height: 6),
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                if (priorityPath != null) TagChip(path: priorityPath),
                AttributeChip(
                  label: 'assignee',
                  value: assigneeName,
                  muted: assigneeName == null,
                ),
                for (final p in otherTagPaths) TagChip(path: p),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Build the explicit drag handle (only used on the live card, not in
  /// the drag feedback). Wrapped in `MouseRegion(grab)` so pointer users
  /// see a grab cursor, and in an immediate `Draggable` so dragging the
  /// icon starts without the long-press delay required by the body.
  Widget _buildHandle(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final icon = Icon(
      Icons.drag_indicator,
      key: Key('kanban-drag-handle-${task.id}'),
      size: 18,
      color: cs.onSurfaceVariant,
    );
    final feedback = Material(
      elevation: 6,
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(width: 240, child: _buildCard(context, dragging: true)),
    );
    return MouseRegion(
      cursor: SystemMouseCursors.grab,
      child: Draggable<_DropPayload>(
        data: _DropPayload(task),
        feedback: feedback,
        childWhenDragging: Opacity(opacity: 0.4, child: icon),
        child: icon,
      ),
    );
  }
}
