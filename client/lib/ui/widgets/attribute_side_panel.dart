/// Right-rail "Attributes" panel for the task detail screen.
///
/// Renders the four built-in dropdowns (status / assignee / milestone /
/// component) plus a tag chip-list with an "Edit tags" button. Receives
/// callbacks for every interaction; this widget owns no fetch state of
/// its own — its parent feeds the lookup tables.
library;

import 'package:flutter/material.dart';

import '../../reg/handlers.dart';
import 'tag_chip.dart';

class AttributeSidePanel extends StatelessWidget {
  final CardWithAttrs task;
  final List<String> statuses;
  final List<UserRow> users;
  final List<CardWithAttrs> milestones;
  final List<CardWithAttrs> components;
  final Map<int, String> tagPaths;

  final ValueChanged<String> onStatusChanged;
  final ValueChanged<int?> onAssigneeChanged;
  final ValueChanged<int?> onMilestoneChanged;
  final ValueChanged<int?> onComponentChanged;
  final VoidCallback onEditTags;
  final void Function(int tagId) onRemoveTag;

  const AttributeSidePanel({
    super.key,
    required this.task,
    required this.statuses,
    required this.users,
    required this.milestones,
    required this.components,
    required this.tagPaths,
    required this.onStatusChanged,
    required this.onAssigneeChanged,
    required this.onMilestoneChanged,
    required this.onComponentChanged,
    required this.onEditTags,
    required this.onRemoveTag,
  });

  List<int> _appliedTagIds() {
    final raw = task.attributes['tags'];
    if (raw is List) {
      return [for (final r in raw) if (r is num) r.toInt()];
    }
    return const [];
  }

  @override
  Widget build(BuildContext context) {
    final status = task.attributes['status'];
    final assignee = task.attributes['assignee'];
    final milestoneRef = task.attributes['milestone_ref'];
    final componentRef = task.attributes['component_ref'];
    final applied = _appliedTagIds().toSet();

    return Card(
      key: const Key('task-side-panel'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Attributes', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              key: const Key('task-status-dropdown'),
              value: status is String ? status : null,
              decoration: const InputDecoration(labelText: 'Status'),
              items: [
                const DropdownMenuItem(value: null, child: Text('— unset —')),
                for (final s in statuses)
                  DropdownMenuItem(value: s, child: Text(s)),
              ],
              onChanged: (v) => v == null ? null : onStatusChanged(v),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int?>(
              key: const Key('task-assignee-dropdown'),
              value: assignee is num ? assignee.toInt() : null,
              decoration: const InputDecoration(labelText: 'Assignee'),
              items: [
                const DropdownMenuItem(value: null, child: Text('Unassigned')),
                for (final u in users)
                  DropdownMenuItem(value: u.id, child: Text(u.displayName)),
              ],
              onChanged: onAssigneeChanged,
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int?>(
              key: const Key('task-milestone-dropdown'),
              value: milestoneRef is num ? milestoneRef.toInt() : null,
              decoration: const InputDecoration(labelText: 'Milestone'),
              items: [
                const DropdownMenuItem(value: null, child: Text('— none —')),
                for (final m in milestones)
                  DropdownMenuItem(value: m.id, child: Text(m.title ?? '#${m.id}')),
              ],
              onChanged: onMilestoneChanged,
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int?>(
              key: const Key('task-component-dropdown'),
              value: componentRef is num ? componentRef.toInt() : null,
              decoration: const InputDecoration(labelText: 'Component'),
              items: [
                const DropdownMenuItem(value: null, child: Text('— none —')),
                for (final c in components)
                  DropdownMenuItem(value: c.id, child: Text(c.title ?? '#${c.id}')),
              ],
              onChanged: onComponentChanged,
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Text('Tags', style: Theme.of(context).textTheme.labelLarge),
                const Spacer(),
                TextButton.icon(
                  key: const Key('task-edit-tags-button'),
                  onPressed: onEditTags,
                  icon: const Icon(Icons.edit, size: 14),
                  label: const Text('Edit'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            if (applied.isEmpty)
              Text('No tags applied.',
                  style: Theme.of(context).textTheme.bodySmall)
            else
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final id in applied)
                    if (tagPaths[id] != null)
                      TagChip(
                        path: tagPaths[id]!,
                        selected: true,
                        onRemove: () => onRemoveTag(id),
                      ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
