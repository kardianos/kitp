/// TaskDetailScreen — full per-card lifecycle: title editor, description,
/// attribute panel, activity stream, comment composer.
///
/// Layout: two-column on wide viewports. The main column carries title,
/// description, activity, and the comment composer (in that order). The
/// right rail (~280px) carries the attribute side panel. Below ~700px we
/// collapse to a single column.
///
/// Dispatcher contract:
///   - Initial load: ONE batch with six sub-requests (task + activity +
///     milestones + components + tags + users). Coalesced into one HTTP
///     call (N-CLI-2).
///   - Editing the title or description issues ONE batch (attribute.update)
///     followed by a refresh batch.
///   - Setting status / assignee / milestone / component / sort_order — one
///     batch each.
///   - Posting a comment — one batch.
///   - Tag apply/remove — one batch each.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app.dart';
import '../../dispatch/errors.dart';
import '../../reg/handlers.dart';
import '../widgets/activity_row.dart';
import '../widgets/attribute_side_panel.dart';
import '../widgets/ctrl_enter.dart';
import '../widgets/tag_chip.dart';

const List<String> kTaskStatuses = ['todo', 'doing', 'review', 'done'];

/// Below this width we collapse the layout into a single column so the
/// side panel doesn't squeeze the description and activity stream.
const double _kSinglePaneBreakpoint = 700;

class TaskDetailScreen extends StatefulWidget {
  final int taskId;
  const TaskDetailScreen({super.key, required this.taskId});

  @override
  State<TaskDetailScreen> createState() => _TaskDetailScreenState();
}

class _TaskDetailScreenState extends State<TaskDetailScreen> {
  CardWithAttrs? _task;
  List<ActivityRow> _activity = [];
  List<CardWithAttrs> _milestones = [];
  List<CardWithAttrs> _components = [];
  List<CardWithAttrs> _tags = [];
  List<UserRow> _users = [];
  bool _loading = true;
  String? _error;

  // Title editor: drives a TextField; on blur or Enter we issue
  // attribute.update (only if changed). Keep the controller in sync with
  // `_task.title` on first load and post-save so live edits aren't lost.
  final _titleController = TextEditingController();
  final _titleFocus = FocusNode();
  String _lastSavedTitle = '';

  // Description editor: same pattern as title. Save on focus loss only;
  // typing N characters should not issue N batches.
  final _descController = TextEditingController();
  final _descFocus = FocusNode();
  String _lastSavedDescription = '';

  final _commentController = TextEditingController();
  final _commentFocus = FocusNode();
  bool _postingComment = false;

  // Activity section: collapsed by default per T6. Per-screen-instance,
  // not persisted across navigation.
  bool _activityExpanded = false;

  bool _bootstrapped = false;

  @override
  void initState() {
    super.initState();
    _descFocus.addListener(_onDescFocusChange);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_bootstrapped) {
      _bootstrapped = true;
      _refresh(initial: true);
    }
  }

  @override
  void dispose() {
    _titleController.dispose();
    _titleFocus.dispose();
    _descController.dispose();
    _descFocus.removeListener(_onDescFocusChange);
    _descFocus.dispose();
    _commentController.dispose();
    _commentFocus.dispose();
    super.dispose();
  }

  Map<int, String> get _tagPaths => {
        for (final t in _tags)
          if (t.attributes['path'] is String)
            t.id: t.attributes['path'] as String,
      };

  RefMaps get _refMaps => RefMaps(
        users: {for (final u in _users) u.id: u.displayName},
        milestones: {
          for (final m in _milestones)
            if (m.title != null) m.id: m.title!,
        },
        components: {
          for (final c in _components)
            if (c.title != null) c.id: c.title!,
        },
        tags: _tagPaths,
      );

  /// Initial load + refresh. On `initial=true` we also seed the editors;
  /// subsequent refreshes preserve any in-flight edit (i.e. text in the
  /// description field while the user is typing).
  Future<void> _refresh({bool initial = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final dispatcher = KitpApp.dispatcherOf(context);

    final fTask = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: CardSelectWithAttributesInput(cardTypeName: 'task'),
    );
    final fActivity = dispatcher.request<ActivitySelectInput, ActivitySelectOutput>(
      endpoint: 'activity',
      action: 'select',
      data: ActivitySelectInput(cardId: widget.taskId, limit: 50),
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
    final fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>(
      endpoint: 'user',
      action: 'select',
      data: const UserSelectInput(),
    );

    try {
      final results = await Future.wait([
        fTask,
        fActivity,
        fMilestones,
        fComponents,
        fTags,
        fUsers,
      ]);
      final taskOut = results[0] as CardSelectWithAttributesOutput;
      final actOut = results[1] as ActivitySelectOutput;
      final mOut = results[2] as CardSelectWithAttributesOutput;
      final cOut = results[3] as CardSelectWithAttributesOutput;
      final tOut = results[4] as CardSelectWithAttributesOutput;
      final uOut = results[5] as UserSelectOutput;

      CardWithAttrs? task;
      for (final r in taskOut.rows) {
        if (r.id == widget.taskId) {
          task = r;
          break;
        }
      }
      if (!mounted) return;
      setState(() {
        _task = task;
        _activity = actOut.rows;
        _milestones = mOut.rows;
        _components = cOut.rows;
        _tags = tOut.rows;
        _users = uOut.rows;
        if (initial && task != null) {
          _titleController.text = task.title ?? '';
          _lastSavedTitle = task.title ?? '';
          final desc = task.attributes['description'];
          final descStr = desc is String ? desc : '';
          _descController.text = descStr;
          _lastSavedDescription = descStr;
        }
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

  // ----------------------------------------------------------------- title --

  Future<void> _saveTitleIfChanged() async {
    final next = _titleController.text.trim();
    if (next.isEmpty || next == _lastSavedTitle) return;
    final prev = _lastSavedTitle;
    _lastSavedTitle = next;
    try {
      await KitpApp.dispatcherOf(context)
          .request<AttributeUpdateInput, AttributeUpdateOutput>(
        endpoint: 'attribute',
        action: 'update',
        data: AttributeUpdateInput(
          cardId: widget.taskId,
          attributeName: 'title',
          value: next,
        ),
      );
      await _refresh();
    } catch (e) {
      _lastSavedTitle = prev;
      _titleController.text = prev;
      _showError('Failed to save title: $e');
    }
  }

  // ------------------------------------------------------------ description --

  void _onDescFocusChange() {
    if (!_descFocus.hasFocus) {
      _saveDescriptionIfChanged();
    }
  }

  Future<void> _saveDescriptionIfChanged() async {
    final next = _descController.text;
    if (next == _lastSavedDescription) return;
    final prev = _lastSavedDescription;
    _lastSavedDescription = next;
    if (_task != null) {
      setState(() {
        _task = _withAttribute(_task!, 'description', next.isEmpty ? null : next);
      });
    }
    try {
      await KitpApp.dispatcherOf(context)
          .request<AttributeUpdateInput, AttributeUpdateOutput>(
        endpoint: 'attribute',
        action: 'update',
        data: AttributeUpdateInput(
          cardId: widget.taskId,
          attributeName: 'description',
          value: next.isEmpty ? null : next,
        ),
      );
      await _refresh();
    } on BatchAbortedError catch (e) {
      _rollbackDescription(prev);
      _showError('Failed to save description: ${e.reason}');
    } on SubRequestError catch (e) {
      _rollbackDescription(prev);
      _showError('Failed to save description: ${e.message}');
    } catch (e) {
      _rollbackDescription(prev);
      _showError('Failed to save description: $e');
    }
  }

  void _rollbackDescription(String prev) {
    _lastSavedDescription = prev;
    if (mounted) {
      setState(() {
        _descController.text = prev;
        if (_task != null) {
          _task = _withAttribute(_task!, 'description', prev.isEmpty ? null : prev);
        }
      });
    }
  }

  // -------------------------------------------------------------- attrs --

  Future<void> _setAttribute(String name, dynamic value) async {
    if (_task == null) return;
    final prev = _task!;
    setState(() {
      _task = _withAttribute(prev, name, value);
    });
    try {
      await KitpApp.dispatcherOf(context)
          .request<AttributeUpdateInput, AttributeUpdateOutput>(
        endpoint: 'attribute',
        action: 'update',
        data: AttributeUpdateInput(
          cardId: widget.taskId,
          attributeName: name,
          value: value,
        ),
      );
      await _refresh();
    } catch (e) {
      if (!mounted) return;
      setState(() => _task = prev);
      _showError('Failed to set $name: $e');
    }
  }

  Future<void> _toggleTag(int tagCardId, bool currentlyApplied) async {
    final dispatcher = KitpApp.dispatcherOf(context);
    try {
      if (currentlyApplied) {
        await dispatcher.request<TagRemoveInput, TagRemoveOutput>(
          endpoint: 'tag',
          action: 'remove',
          data: TagRemoveInput(targetCardId: widget.taskId, tagCardId: tagCardId),
        );
      } else {
        await dispatcher.request<TagApplyInput, TagApplyOutput>(
          endpoint: 'tag',
          action: 'apply',
          data: TagApplyInput(targetCardId: widget.taskId, tagCardId: tagCardId),
        );
      }
      await _refresh();
    } catch (e) {
      _showError('Failed to update tags: $e');
    }
  }

  Future<void> _openTagPicker() async {
    if (_task == null) return;
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => _TagPickerDialog(
        allTags: _tags,
        appliedIds: _appliedTagIds(_task!),
        onToggle: _toggleTag,
      ),
    );
    if (result == true && mounted) {
      await _refresh();
    }
  }

  // ------------------------------------------------------------ comment --

  Future<void> _postComment() async {
    final body = _commentController.text.trim();
    if (body.isEmpty) return;
    setState(() => _postingComment = true);
    try {
      await KitpApp.dispatcherOf(context)
          .request<CommentInsertInput, CommentInsertOutput>(
        endpoint: 'comment',
        action: 'insert',
        data: CommentInsertInput(cardId: widget.taskId, body: body),
      );
      _commentController.clear();
      if (!mounted) return;
      await _refresh();
    } catch (e) {
      _showError('Failed to post comment: $e');
    } finally {
      if (mounted) setState(() => _postingComment = false);
    }
  }

  // ------------------------------------------------------------ helpers --

  CardWithAttrs _withAttribute(CardWithAttrs c, String key, dynamic value) {
    final next = Map<String, dynamic>.from(c.attributes);
    if (value == null) {
      next.remove(key);
    } else {
      next[key] = value;
    }
    return CardWithAttrs(
      id: c.id,
      cardTypeId: c.cardTypeId,
      cardTypeName: c.cardTypeName,
      parentCardId: c.parentCardId,
      attributes: next,
      deletedAt: c.deletedAt,
    );
  }

  List<int> _appliedTagIds(CardWithAttrs t) {
    final raw = t.attributes['tags'];
    if (raw is List) {
      return [for (final r in raw) if (r is num) r.toInt()];
    }
    return const [];
  }

  void _showError(String msg) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    messenger?.showSnackBar(SnackBar(content: Text(msg)));
  }

  // -------------------------------------------------------------- build --

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () {
            if (_task?.parentCardId != null) {
              context.go('/project/${_task!.parentCardId}');
            } else {
              context.go('/projects');
            }
          },
        ),
        title: Text(_task?.title ?? 'Task ${widget.taskId}'),
      ),
      body: _buildBody(context),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading && _task == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'Failed to load task: ${_error!}',
            key: const Key('task-error'),
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      );
    }
    if (_task == null) {
      return const Center(
        child: Text('Task not found', key: Key('task-not-found')),
      );
    }

    return LayoutBuilder(
      builder: (ctx, constraints) {
        final wide = constraints.maxWidth >= _kSinglePaneBreakpoint;
        final main = _buildMainColumn(context);
        final side = _buildSidePanel(context);
        if (!wide) {
          return ListView(
            key: const Key('task-detail-scroll'),
            padding: const EdgeInsets.all(16),
            children: [
              side,
              const SizedBox(height: 16),
              ...main,
            ],
          );
        }
        return ListView(
          key: const Key('task-detail-scroll'),
          padding: const EdgeInsets.all(16),
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: main,
                  ),
                ),
                const SizedBox(width: 16),
                SizedBox(width: 280, child: side),
              ],
            ),
          ],
        );
      },
    );
  }

  List<Widget> _buildMainColumn(BuildContext context) {
    return [
      _buildHeader(context),
      const SizedBox(height: 16),
      _buildDescription(context),
      const SizedBox(height: 24),
      _buildActivitySection(context),
      const SizedBox(height: 16),
      _buildCommentComposer(context),
    ];
  }

  Widget _buildSidePanel(BuildContext context) {
    return AttributeSidePanel(
      task: _task!,
      statuses: kTaskStatuses,
      users: _users,
      milestones: _milestones,
      components: _components,
      tagPaths: _tagPaths,
      onStatusChanged: (v) => _setAttribute('status', v),
      onAssigneeChanged: (v) => _setAttribute('assignee', v),
      onMilestoneChanged: (v) => _setAttribute('milestone_ref', v),
      onComponentChanged: (v) => _setAttribute('component_ref', v),
      onEditTags: _openTagPicker,
      onRemoveTag: (id) => _toggleTag(id, true),
    );
  }

  Widget _buildHeader(BuildContext context) {
    return CtrlEnterSubmit(
      onSubmit: _saveTitleAndBlur,
      child: TextField(
        key: const Key('task-title-field'),
        controller: _titleController,
        focusNode: _titleFocus,
        style: Theme.of(context).textTheme.headlineSmall,
        decoration: const InputDecoration(
          labelText: 'Title',
          border: OutlineInputBorder(),
        ),
        onSubmitted: (_) => _saveTitleIfChanged(),
        onEditingComplete: _saveTitleIfChanged,
      ),
    );
  }

  Widget _buildDescription(BuildContext context) {
    return CtrlEnterSubmit(
      onSubmit: _saveDescriptionAndBlur,
      child: TextField(
        key: const Key('task-description-field'),
        controller: _descController,
        focusNode: _descFocus,
        minLines: 4,
        maxLines: 12,
        decoration: const InputDecoration(
          labelText: 'Description',
          hintText: 'Write a description…',
          border: OutlineInputBorder(),
          alignLabelWithHint: true,
        ),
      ),
    );
  }

  Widget _buildActivitySection(BuildContext context) {
    // Strip the default ExpansionTile dividers/padding so the Activity
    // section visually matches the surrounding plain Columns.
    final theme = Theme.of(context);
    return Theme(
      data: theme.copyWith(
        dividerColor: Colors.transparent,
        listTileTheme: theme.listTileTheme.copyWith(
          contentPadding: EdgeInsets.zero,
          minVerticalPadding: 0,
        ),
      ),
      child: ExpansionTile(
        key: const Key('task-activity-expansion'),
        initiallyExpanded: _activityExpanded,
        onExpansionChanged: (v) => setState(() => _activityExpanded = v),
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(top: 8),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        title: Text(
          'Activity (${_activity.length})',
          style: theme.textTheme.titleMedium,
        ),
        children: [
          if (_activity.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text('No activity yet.'),
            )
          else
            Column(
              key: const Key('task-activity-list'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final r in _activity)
                  ActivityRowView(row: r, refs: _refMaps),
              ],
            ),
        ],
      ),
    );
  }

  Widget _buildCommentComposer(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Comment', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            CtrlEnterSubmit(
              onSubmit: _postCommentFromShortcut,
              child: TextField(
                key: const Key('task-comment-input'),
                controller: _commentController,
                focusNode: _commentFocus,
                minLines: 2,
                maxLines: 6,
                decoration: const InputDecoration(
                  hintText: 'Add a comment…',
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                key: const Key('task-comment-post'),
                onPressed: _postingComment ? null : _postComment,
                child: _postingComment
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('Post'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ---------------------------------------------------------- shortcuts --

  /// Ctrl+Enter on the title: persist (if changed) and drop focus so the
  /// editor visually settles. Mirrors the blur-save path but is also OK
  /// when the title hasn't changed (the save is a no-op).
  void _saveTitleAndBlur() {
    _titleFocus.unfocus();
    _saveTitleIfChanged();
  }

  /// Ctrl+Enter on the description: persist (if changed) and drop focus.
  /// We unfocus first so the existing focus-loss listener doesn't race
  /// with the explicit save call (the listener invokes the same save and
  /// short-circuits on no diff).
  void _saveDescriptionAndBlur() {
    _descFocus.unfocus();
  }

  /// Ctrl+Enter in the comment composer: post the comment if non-empty.
  /// We do not clear focus — the composer clears its own text and we want
  /// it ready for another comment.
  void _postCommentFromShortcut() {
    if (_postingComment) return;
    _postComment();
  }
}

class _TagPickerDialog extends StatefulWidget {
  final List<CardWithAttrs> allTags;
  final List<int> appliedIds;
  final Future<void> Function(int tagCardId, bool currentlyApplied) onToggle;

  const _TagPickerDialog({
    required this.allTags,
    required this.appliedIds,
    required this.onToggle,
  });

  @override
  State<_TagPickerDialog> createState() => _TagPickerDialogState();
}

class _TagPickerDialogState extends State<_TagPickerDialog> {
  late Set<int> _applied;

  @override
  void initState() {
    super.initState();
    _applied = widget.appliedIds.toSet();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Edit tags'),
      content: SizedBox(
        width: 360,
        child: SingleChildScrollView(
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final tag in widget.allTags)
                TagChip(
                  path: tag.attributes['path'] is String
                      ? tag.attributes['path'] as String
                      : (tag.title ?? '#${tag.id}'),
                  selected: _applied.contains(tag.id),
                  onTap: () async {
                    final wasApplied = _applied.contains(tag.id);
                    setState(() {
                      if (wasApplied) {
                        _applied.remove(tag.id);
                      } else {
                        _applied.add(tag.id);
                      }
                    });
                    await widget.onToggle(tag.id, wasApplied);
                  },
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Done'),
        ),
      ],
    );
  }
}
