/// ProjectsScreen — top-level list of every project, with a "+ New project"
/// affordance that opens a Material dialog and submits a single
/// `card.insert` batch.
///
/// Dispatcher contract:
///   - On entry we issue ONE `card.select_with_attributes` request
///     (parent_card_id=null, card_type_name='project') so titles are returned
///     inline. This fits inside the per-frame batch as a single sub-request.
///   - Submitting the dialog issues `card.insert` and, when the description
///     field is non-empty, a follow-up `attribute.update` carrying the new
///     card id (one batch each), then refetches the projects list.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app.dart';
import '../../dispatch/dispatcher.dart';
import '../../dispatch/errors.dart';
import '../../reg/handlers.dart';
import '../filter/filter_bar.dart';
import '../filter/predicate.dart';
import '../widgets/ctrl_enter.dart';

class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({super.key});

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  /// The currently displayed list. Empty until the first fetch resolves.
  List<CardWithAttrs> _projects = [];

  /// Loading flag flips true around any fetch.
  bool _loading = true;

  /// Sticky error message — set on a fetch failure, cleared on success.
  String? _error;

  /// Active FilterBar predicate. Null = no filter — every project loads.
  /// Sent to the server as `card.select_with_attributes.tree`.
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

  /// Filterable attributes for the FilterBar's quick-pick UI. Project
  /// cards in the seed schema only carry `title` + `description`; we
  /// deliberately leave the palette empty so the user can still
  /// hand-author predicates via the advanced editor without us inventing
  /// attributes that don't exist in the data.
  List<FilterAttribute> _filterAttributes() => const [];

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
    try {
      // We use card.select_with_attributes (instead of the lighter
      // card.select) because it already supports the v2 `tree` predicate
      // the FilterBar emits. Projects are cards too; the LATERAL fold of
      // attributes adds at most ~2 small fields per row.
      final out = await dispatcher
          .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
        endpoint: 'card',
        action: 'select_with_attributes',
        data: CardSelectWithAttributesInput(
          cardTypeName: 'project',
          // parent_card_id is null → top-level projects only.
          tree: _buildTree(),
        ),
      );
      if (!mounted) return;
      setState(() {
        _projects = out.rows;
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
      builder: (ctx) => _NewProjectDialog(
        dispatcher: KitpApp.dispatcherOf(context),
      ),
    );
    if (created == true) {
      await _refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _buildBody(context),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('projects-new-fab'),
        onPressed: _openCreateDialog,
        icon: const Icon(Icons.add),
        label: const Text('New project'),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    // The initial bootstrapping spinner only renders before the first
    // fetch completes AND no filter is active — once the user has typed
    // a filter we keep the FilterBar visible during refreshes so they
    // can edit it.
    if (_loading && _projects.isEmpty && _filter == null) {
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
                'Failed to load projects: ${_error!}',
                key: const Key('projects-error'),
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
        Container(
          key: const Key('projects-filter-bar'),
          child: FilterBar(
            value: _filter,
            onChanged: _onFilterChanged,
            attributes: _filterAttributes(),
          ),
        ),
        const Divider(height: 1),
        if (_projects.isEmpty)
          const Expanded(
            child: Center(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text(
                  'No projects yet — create one',
                  key: Key('projects-empty'),
                  style: TextStyle(fontSize: 16),
                ),
              ),
            ),
          )
        else
          Expanded(
            child: ListView.separated(
              key: const Key('projects-list'),
              padding: const EdgeInsets.symmetric(vertical: 8),
              itemCount: _projects.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final p = _projects[i];
                final title = p.title ?? '(untitled)';
                return ListTile(
                  key: Key('project-row-${p.id}'),
                  leading: const Icon(Icons.folder_open),
                  title: Text(title),
                  subtitle: Text('id ${p.id}'),
                  trailing: TextButton(
                    key: Key('project-open-${p.id}'),
                    onPressed: () => context.go('/project/${p.id}'),
                    child: const Text('Open'),
                  ),
                  onTap: () => context.go('/project/${p.id}'),
                );
              },
            ),
          ),
      ],
    );
  }
}

class _NewProjectDialog extends StatefulWidget {
  final Dispatcher dispatcher;
  const _NewProjectDialog({required this.dispatcher});

  @override
  State<_NewProjectDialog> createState() => _NewProjectDialogState();
}

class _NewProjectDialogState extends State<_NewProjectDialog> {
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
      // 1) Insert the card.
      final insertFuture =
          widget.dispatcher.request<CardInsertInput, CardInsertOutput>(
        endpoint: 'card',
        action: 'insert',
        data: CardInsertInput(cardTypeName: 'project', title: title),
      );
      // The dispatcher coalesces requests issued in the same frame. Because
      // `attribute.update` requires the new card id, we fire it *after*
      // awaiting the insert. The two land in separate batches, but each
      // batch is one HTTP call.
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
                'New project',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: 16),
              CtrlEnterSubmit(
                onSubmit: _submit,
                child: TextField(
                  key: const Key('new-project-title'),
                  controller: _titleController,
                  autofocus: true,
                  enabled: !_submitting,
                  onSubmitted: (_) => _submit(),
                  decoration: const InputDecoration(
                    labelText: 'Title',
                    hintText: 'My Project',
                  ),
                ),
              ),
              const SizedBox(height: 12),
              Flexible(
                child: CtrlEnterSubmit(
                  onSubmit: _submit,
                  child: TextField(
                    key: const Key('new-project-description'),
                    controller: _descController,
                    enabled: !_submitting,
                    minLines: 4,
                    maxLines: 10,
                    keyboardType: TextInputType.multiline,
                    textInputAction: TextInputAction.newline,
                    decoration: const InputDecoration(
                      labelText: 'Description',
                      hintText: 'Optional — what is this project about?',
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
                    key: const Key('new-project-submit'),
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
