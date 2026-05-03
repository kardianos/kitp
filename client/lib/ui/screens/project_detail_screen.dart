/// ProjectDetailScreen — list child tasks of a project, plus a "+ New task"
/// affordance.
///
/// Dispatcher contract:
///   - On entry we issue a SINGLE batch with two sub-requests:
///     1. project itself (so we can render the title and 404 cleanly)
///     2. tasks under it (parent_card_id=project, card_type='task')
///     The Dispatcher's per-frame coalescing turns these into ONE HTTP call —
///     this is the central N-CLI-2 invariant.
///   - "New task" submits a card.insert with title only (no preset status or
///     assignee — defaults to unassigned). When the description field is
///     non-empty, an additional attribute.update follows, requiring the new
///     card id returned by the insert.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app.dart';
import '../../dispatch/dispatcher.dart';
import '../../dispatch/errors.dart';
import '../../reg/handlers.dart';
import '../widgets/attribute_chip.dart';
import '../widgets/ctrl_enter.dart';
import '../widgets/tag_chip.dart';

class ProjectDetailScreen extends StatefulWidget {
  final int projectId;
  const ProjectDetailScreen({super.key, required this.projectId});

  @override
  State<ProjectDetailScreen> createState() => _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends State<ProjectDetailScreen> {
  CardWithAttrs? _project;
  List<CardWithAttrs> _tasks = [];
  Map<int, String> _userNames = {};
  Map<int, String> _tagPaths = {};
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

  @override
  void didUpdateWidget(covariant ProjectDetailScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.projectId != widget.projectId) {
      _refresh();
    }
  }

  /// One batch with up to four parallel sub-requests:
  ///   1. the project (so we know it exists / can show its title)
  ///   2. tasks under the project (with attributes for chip rendering)
  ///   3. team members (assignee chip rendering)
  ///   4. tag cards in the Default Project (tag chip rendering)
  /// Dispatcher coalesces them into ONE HTTP call.
  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final dispatcher = KitpApp.dispatcherOf(context);

    final fProject = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: CardSelectWithAttributesInput(
        cardTypeName: 'project',
        where: [
          // Filter by id: there's no built-in id predicate, but we can
          // use the (rare) limit-to-this-card-type + parent fallback. The
          // simpler path is to just fetch everything and pick by id —
          // there are tens of projects in v1 at most.
        ],
      ),
    );
    final fTasks = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: CardSelectWithAttributesInput(
        parentCardId: widget.projectId,
        cardTypeName: 'task',
      ),
    );
    final fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>(
      endpoint: 'user',
      action: 'select',
      data: const UserSelectInput(),
    );
    final fTags = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: const CardSelectWithAttributesInput(cardTypeName: 'tag'),
    );

    try {
      final results = await Future.wait([fProject, fTasks, fUsers, fTags]);
      final pOut = results[0] as CardSelectWithAttributesOutput;
      final tOut = results[1] as CardSelectWithAttributesOutput;
      final uOut = results[2] as UserSelectOutput;
      final tagOut = results[3] as CardSelectWithAttributesOutput;
      if (!mounted) return;
      CardWithAttrs? proj;
      for (final p in pOut.rows) {
        if (p.id == widget.projectId) {
          proj = p;
          break;
        }
      }
      setState(() {
        _project = proj;
        _tasks = tOut.rows;
        _userNames = {for (final u in uOut.rows) u.id: u.displayName};
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

  Future<void> _openCreateDialog() async {
    final created = await showDialog<bool>(
      context: context,
      builder: (ctx) => _NewTaskDialog(
        dispatcher: KitpApp.dispatcherOf(context),
        projectId: widget.projectId,
      ),
    );
    if (created == true) {
      await _refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/projects'),
        ),
        title: Text(_project?.title ?? 'Project ${widget.projectId}'),
      ),
      body: _buildBody(context),
      floatingActionButton: _project == null
          ? null
          : FloatingActionButton.extended(
              key: const Key('project-new-task-fab'),
              onPressed: _openCreateDialog,
              icon: const Icon(Icons.add),
              label: const Text('New task'),
            ),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading && _project == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            'Failed to load project: ${_error!}',
            key: const Key('project-error'),
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      );
    }
    if (_project == null) {
      return const Center(
        child: Text('Project not found', key: Key('project-not-found')),
      );
    }
    if (_tasks.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'No tasks yet — create one',
            key: Key('project-tasks-empty'),
            style: TextStyle(fontSize: 16),
          ),
        ),
      );
    }
    return ListView.separated(
      key: const Key('project-tasks-list'),
      padding: const EdgeInsets.symmetric(vertical: 8),
      itemCount: _tasks.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final t = _tasks[i];
        return _TaskRow(
          task: t,
          userNames: _userNames,
          tagPaths: _tagPaths,
          onTap: () => context.go('/task/${t.id}'),
        );
      },
    );
  }
}

class _TaskRow extends StatelessWidget {
  final CardWithAttrs task;
  final Map<int, String> userNames;
  final Map<int, String> tagPaths;
  final VoidCallback onTap;

  const _TaskRow({
    required this.task,
    required this.userNames,
    required this.tagPaths,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final title = task.title ?? '(untitled)';
    final status = task.attributes['status'];
    final assignee = task.attributes['assignee'];
    final tags = task.attributes['tags'];
    final description = task.attributes['description'];

    final chips = <Widget>[];
    chips.add(AttributeChip(
      label: 'status',
      value: status is String ? status : null,
      muted: status is! String,
    ));
    final assigneeName = _assigneeLabel(assignee);
    chips.add(AttributeChip(
      label: 'assignee',
      value: assigneeName,
      muted: assigneeName == null,
    ));
    if (tags is List) {
      for (final t in tags) {
        if (t is num) {
          final p = tagPaths[t.toInt()];
          if (p != null) chips.add(TagChip(path: p));
        }
      }
    }

    // Description preview: first line, truncated. Skipped when missing
    // or empty so the row is unchanged for tasks without a description.
    String? descPreview;
    if (description is String && description.trim().isNotEmpty) {
      descPreview = description.split('\n').first.trim();
    }

    return ListTile(
      key: Key('task-row-${task.id}'),
      isThreeLine: descPreview != null,
      title: Text(title),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (descPreview != null) ...[
            const SizedBox(height: 2),
            Text(
              descPreview,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
          ],
          const SizedBox(height: 6),
          Wrap(spacing: 6, runSpacing: 4, children: chips),
        ],
      ),
      trailing: TextButton(
        key: Key('task-open-${task.id}'),
        onPressed: onTap,
        child: const Text('Open'),
      ),
      onTap: onTap,
    );
  }

  String? _assigneeLabel(dynamic raw) {
    if (raw == null) return null;
    if (raw is num) {
      return userNames[raw.toInt()];
    }
    if (raw is String) return raw;
    return raw.toString();
  }
}

class _NewTaskDialog extends StatefulWidget {
  final Dispatcher dispatcher;
  final int projectId;
  const _NewTaskDialog({
    required this.dispatcher,
    required this.projectId,
  });

  @override
  State<_NewTaskDialog> createState() => _NewTaskDialogState();
}

class _NewTaskDialogState extends State<_NewTaskDialog> {
  final _titleController = TextEditingController();
  final _descController = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _titleController.dispose();
    _descController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final title = _titleController.text.trim();
    if (title.isEmpty) {
      setState(() => _error = 'Title is required');
      return;
    }
    final description = _descController.text;
    final hasDescription = description.trim().isNotEmpty;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      // 1) Insert the card (no assignee, no preset status — those are set
      // on the detail screen). The dispatcher coalesces per frame.
      final insertFuture =
          widget.dispatcher.request<CardInsertInput, CardInsertOutput>(
        endpoint: 'card',
        action: 'insert',
        data: CardInsertInput(
          cardTypeName: 'task',
          parentCardId: widget.projectId,
          title: title,
        ),
      );
      // 2) attribute.update for description needs the new card id, so it
      // must follow the await. Each batch is one HTTP call.
      final inserted = await insertFuture;
      if (hasDescription) {
        await widget.dispatcher
            .request<AttributeUpdateInput, AttributeUpdateOutput>(
          endpoint: 'attribute',
          action: 'update',
          data: AttributeUpdateInput(
            cardId: inserted.id,
            attributeName: 'description',
            value: description,
          ),
        );
      }
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on SubRequestError catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = e.message;
      });
    } on BatchAbortedError catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = e.reason;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context).size;
    final width = media.width * 0.8 < 560.0 ? media.width * 0.8 : 560.0;
    final maxHeight = media.height * 0.8;
    return Dialog(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          minWidth: 560,
          maxWidth: width,
          minHeight: 360,
          maxHeight: maxHeight,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'New task',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 16),
              CtrlEnterSubmit(
                onSubmit: _submit,
                child: TextField(
                  key: const Key('new-task-title'),
                  controller: _titleController,
                  autofocus: true,
                  enabled: !_submitting,
                  onSubmitted: (_) => _submit(),
                  decoration: const InputDecoration(
                    labelText: 'Title',
                    hintText: 'Implement feature X',
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Flexible(
                child: CtrlEnterSubmit(
                  onSubmit: _submit,
                  child: TextField(
                    key: const Key('new-task-description'),
                    controller: _descController,
                    enabled: !_submitting,
                    minLines: 4,
                    maxLines: 10,
                    keyboardType: TextInputType.multiline,
                    textInputAction: TextInputAction.newline,
                    decoration: const InputDecoration(
                      labelText: 'Description',
                      hintText: 'Optional — what needs to be done?',
                      alignLabelWithHint: true,
                      border: OutlineInputBorder(),
                    ),
                  ),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(
                  _error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _submitting
                        ? null
                        : () => Navigator.of(context).pop(false),
                    child: const Text('Cancel'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    key: const Key('new-task-submit'),
                    onPressed: _submitting ? null : _submit,
                    child: _submitting
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Create'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
