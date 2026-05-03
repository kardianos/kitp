/// GridScreen — dense, sortable, status-filterable table over tasks.
///
/// Dispatcher contract:
///   - Initial load: ONE batch with sub-requests for tasks (with the
///     active filter predicate + active sort), users, milestones,
///     components, tags. The dispatcher coalesces them into ONE HTTP call.
///   - Sort change: rebuilds the predicate + order, issues ONE new batch
///     (re-fetches lookup tables too — a single HTTP call regardless).
///     The lookup tables rarely change, but resending them costs O(50)
///     rows and keeps the "one batch per gesture" invariant simple.
///   - Filter change: same as sort change — rebuild + ONE batch.
///
/// Columns: ID, Title, Status, Assignee, Priority, Milestone, Component,
/// Tags, Created.
///
/// Notes on density:
///   - We render via a `ListView.builder` over our own row widget rather
///     than Material's `DataTable`. Reason: `DataTable` materialises
///     every row at once; `ListView.builder` virtualises, so the
///     1,000-row scenario stays smooth.
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

const List<String> _kStatuses = ['todo', 'doing', 'review', 'done'];

/// Sortable column descriptor: which CardWithAttrs field to sort by, and
/// what to send in the server `order` parameter.
class _Column {
  final String label;
  /// Server-side `order.field`. Either `created_at` or
  /// `attributes.<name>`. Null means "not sortable on server" (we
  /// fall back to client-side sort, but only if the column is
  /// non-trivial; today every column is server-sortable).
  final String? orderField;
  final double width;
  const _Column(this.label, this.orderField, this.width);
}

class GridScreen extends StatefulWidget {
  /// Optional project scope. When null, the grid loads every task in
  /// the system (the inbox-like global view).
  final int? projectId;
  const GridScreen({super.key, this.projectId});

  @override
  State<GridScreen> createState() => _GridScreenState();
}

class _GridScreenState extends State<GridScreen> {
  final List<_Column> _columns = const [
    _Column('ID',        null,                 60),
    _Column('Title',     'attributes.title',   320),
    _Column('Status',    'attributes.status',  100),
    _Column('Assignee',  'attributes.assignee',120),
    _Column('Priority',  null,                 110),
    _Column('Milestone', 'attributes.milestone_ref', 100),
    _Column('Component', 'attributes.component_ref', 110),
    _Column('Tags',      null,                 220),
    _Column('Created',   'created_at',         170),
  ];

  /// Active sort column index in [_columns]; null = default order
  /// (server's `ORDER BY c.id`).
  int? _sortColumn;
  bool _sortAsc = true;

  /// Active filter tree. Initialised on first build to a default
  /// `status in (todo, doing, review, done)` predicate so the user sees
  /// the same chips today's bespoke status row gave them. Edit / remove
  /// freely from there.
  Predicate? _filter = PredicateLeaf(
    attr: 'status',
    op: PredicateOp.in_,
    values: List<dynamic>.from(_kStatuses),
  );

  List<CardWithAttrs> _tasks = [];
  Map<int, String> _userNames = {};
  Map<int, String> _tagPaths = {};
  Map<int, String> _cardTitles = {};
  bool _loading = true;
  String? _error;

  bool _bootstrapped = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_bootstrapped) {
      _bootstrapped = true;
      _refresh();
    }
  }

  /// Available attributes for the FilterBar's pickers. Static at the
  /// moment — we'll fold in milestone / component populations once the
  /// lookup tables become available before the bar is rendered.
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

  List<CardOrderClause> _buildOrder() {
    final i = _sortColumn;
    if (i == null) return const [];
    final f = _columns[i].orderField;
    if (f == null) return const [];
    return [CardOrderClause(field: f, direction: _sortAsc ? 'ASC' : 'DESC')];
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
        order: _buildOrder(),
        limit: 5000, // generous; grid view is meant to be fast on a few thousand rows
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

  void _toggleSort(int columnIndex) {
    final col = _columns[columnIndex];
    if (col.orderField == null) return;
    setState(() {
      if (_sortColumn == columnIndex) {
        _sortAsc = !_sortAsc;
      } else {
        _sortColumn = columnIndex;
        _sortAsc = true;
      }
    });
    _refresh();
  }

  void _onFilterChanged(Predicate? next) {
    setState(() => _filter = next);
    _refresh();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.projectId == null
            ? 'Grid'
            : 'Grid — project ${widget.projectId}'),
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
            'Failed to load grid: ${_error!}',
            key: const Key('grid-error'),
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _buildFilterBar(context),
        const Divider(height: 1),
        Expanded(child: _buildTable(context)),
      ],
    );
  }

  Widget _buildFilterBar(BuildContext context) {
    return Container(
      key: const Key('grid-filter-bar'),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: FilterBar(
              value: _filter,
              onChanged: _onFilterChanged,
              attributes: _filterAttributes(),
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(right: 16, top: 12),
            child: Text(
              '${_tasks.length} row${_tasks.length == 1 ? '' : 's'}',
              key: const Key('grid-row-count'),
            ),
          ),
        ],
      ),
    );
  }

  /// Total width of the rendered table, in logical pixels. Header rows
  /// and body rows must agree on this width so vertical alignment is
  /// preserved even when the body scrolls horizontally with the header.
  double get _totalWidth =>
      _columns.fold<double>(0, (sum, c) => sum + c.width);

  Widget _buildHeader(BuildContext context) {
    return Container(
      color: Theme.of(context).colorScheme.surfaceContainerHigh,
      width: _totalWidth,
      child: Row(
        children: [
          for (var i = 0; i < _columns.length; i++)
            SizedBox(
              width: _columns[i].width,
              child: InkWell(
                key: Key('grid-header-${_columns[i].label.toLowerCase()}'),
                onTap: _columns[i].orderField == null
                    ? null
                    : () => _toggleSort(i),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                      horizontal: 8, vertical: 8),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Flexible(
                        child: Text(
                          _columns[i].label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ),
                      if (_sortColumn == i) ...[
                        const SizedBox(width: 4),
                        Icon(
                          _sortAsc ? Icons.arrow_upward : Icons.arrow_downward,
                          size: 14,
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildTable(BuildContext context) {
    if (_tasks.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('No matching rows.', key: Key('grid-empty')),
        ),
      );
    }
    // The header and the rows share `_totalWidth` so the columns stay
    // aligned. We scroll horizontally as a single unit (header + body).
    // Vertical scrolling is delegated to a virtualised ListView.builder
    // so 1,000-row grids stay smooth (N-PERF-2).
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SizedBox(
        width: _totalWidth,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _buildHeader(context),
            const Divider(height: 1),
            Expanded(
              child: Scrollbar(
                child: ListView.builder(
                  key: const Key('grid-list'),
                  itemCount: _tasks.length,
                  itemBuilder: (context, i) => _GridRow(
                    task: _tasks[i],
                    columns: _columns,
                    userNames: _userNames,
                    tagPaths: _tagPaths,
                    cardTitles: _cardTitles,
                    width: _totalWidth,
                    onTap: () => context.go('/task/${_tasks[i].id}'),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _GridRow extends StatelessWidget {
  final CardWithAttrs task;
  final List<_Column> columns;
  final Map<int, String> userNames;
  final Map<int, String> tagPaths;
  final Map<int, String> cardTitles;
  final double width;
  final VoidCallback onTap;

  const _GridRow({
    required this.task,
    required this.columns,
    required this.userNames,
    required this.tagPaths,
    required this.cardTitles,
    required this.width,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return InkWell(
      key: Key('grid-row-${task.id}'),
      onTap: onTap,
      child: Container(
        width: width,
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: cs.outlineVariant, width: 0.5)),
        ),
        height: 38,
        child: Row(
          children: [
            for (final c in columns)
              SizedBox(
                width: c.width,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: _cell(context, c.label),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _cell(BuildContext context, String label) {
    switch (label) {
      case 'ID':
        return Text('${task.id}', maxLines: 1, overflow: TextOverflow.ellipsis);
      case 'Title':
        return Text(task.title ?? '(untitled)',
            maxLines: 1, overflow: TextOverflow.ellipsis);
      case 'Status':
        final s = task.attributes['status'];
        return Align(
          alignment: Alignment.centerLeft,
          child: AttributeChip(
            label: 'status',
            value: s is String ? s : null,
            muted: s is! String,
          ),
        );
      case 'Assignee':
        final id = task.attributes['assignee'];
        final n = id is num ? userNames[id.toInt()] : null;
        return Align(
          alignment: Alignment.centerLeft,
          child: AttributeChip(label: 'assignee', value: n, muted: n == null),
        );
      case 'Priority':
        return Align(
          alignment: Alignment.centerLeft,
          child: _priorityCell(),
        );
      case 'Milestone':
        final id = task.attributes['milestone_ref'];
        final n = id is num ? cardTitles[id.toInt()] : null;
        return Align(
          alignment: Alignment.centerLeft,
          child: AttributeChip(label: 'milestone', value: n, muted: n == null),
        );
      case 'Component':
        final id = task.attributes['component_ref'];
        final n = id is num ? cardTitles[id.toInt()] : null;
        return Align(
          alignment: Alignment.centerLeft,
          child: AttributeChip(label: 'component', value: n, muted: n == null),
        );
      case 'Tags':
        final ids = task.attributes['tags'];
        final chips = <Widget>[];
        if (ids is List) {
          for (final id in ids) {
            if (id is num) {
              final p = tagPaths[id.toInt()];
              if (p != null && !p.startsWith('priority/')) {
                chips.add(TagChip(path: p));
              }
            }
          }
        }
        return ClipRect(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final c in chips)
                Padding(padding: const EdgeInsets.only(right: 4), child: c),
            ],
          ),
        );
      case 'Created':
        // No created_at in the wire shape today (we track activity timestamps);
        // the LATERAL read returns deleted_at only. We surface a placeholder
        // so the column is still present and sortable.
        return const Text('—');
      default:
        return const SizedBox.shrink();
    }
  }

  Widget _priorityCell() {
    final ids = task.attributes['tags'];
    if (ids is List) {
      for (final id in ids) {
        if (id is num) {
          final p = tagPaths[id.toInt()];
          if (p != null && p.startsWith('priority/')) {
            return TagChip(path: p);
          }
        }
      }
    }
    return const Text('—');
  }
}
