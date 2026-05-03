/// Compact list-style row that renders one task with chips for status,
/// assignee, milestone, component, and any tags. Used by the Inbox and
/// the project-detail list. The grid view renders its own table-style
/// row; the kanban renders a vertical card.
library;

import 'package:flutter/material.dart';

import '../../reg/handlers.dart';
import 'attribute_chip.dart';
import 'tag_chip.dart';

/// A reusable task row with rich chip metadata.
///
/// Caller-provided lookup tables let the chip resolve human-readable
/// names: `userNames` for assignees, `tagPaths` for tag chips, and
/// `cardTitles` for milestone/component refs (which point at other
/// cards). Anything missing falls through to a muted "—" rendering.
class TaskRow extends StatelessWidget {
  final CardWithAttrs task;
  final Map<int, String> userNames;
  final Map<int, String> tagPaths;
  final Map<int, String> cardTitles;
  final VoidCallback onTap;

  /// `true` to render an explicit Open button to the right.
  final bool showOpenButton;

  /// Optional row key. Defaults to `task-row-<id>`.
  final Key? rowKey;

  const TaskRow({
    super.key,
    required this.task,
    required this.userNames,
    required this.tagPaths,
    required this.cardTitles,
    required this.onTap,
    this.showOpenButton = false,
    this.rowKey,
  });

  @override
  Widget build(BuildContext context) {
    final title = task.title ?? '(untitled)';
    final children = <Widget>[];

    // Status chip.
    final status = task.attributes['status'];
    children.add(AttributeChip(
      label: 'status',
      value: status is String ? status : null,
      muted: status is! String,
    ));

    // Assignee chip.
    final assigneeId = task.attributes['assignee'];
    final assigneeName = assigneeId is num ? userNames[assigneeId.toInt()] : null;
    children.add(AttributeChip(
      label: 'assignee',
      value: assigneeName,
      muted: assigneeName == null,
    ));

    // Priority tag (split out of `tags` so it always renders first when
    // present — kanban + inbox skim it for at-a-glance scanning).
    final tagIds = task.attributes['tags'];
    int? priorityTagId;
    final otherTagIds = <int>[];
    if (tagIds is List) {
      for (final t in tagIds) {
        if (t is num) {
          final p = tagPaths[t.toInt()];
          if (p != null && p.startsWith('priority/')) {
            priorityTagId = t.toInt();
          } else {
            otherTagIds.add(t.toInt());
          }
        }
      }
    }
    if (priorityTagId != null) {
      final p = tagPaths[priorityTagId];
      if (p != null) children.add(TagChip(path: p));
    }

    // Milestone chip.
    final milestoneId = task.attributes['milestone_ref'];
    if (milestoneId is num) {
      final t = cardTitles[milestoneId.toInt()];
      children.add(AttributeChip(
        label: 'milestone',
        value: t,
        muted: t == null,
      ));
    }

    // Component chip.
    final componentId = task.attributes['component_ref'];
    if (componentId is num) {
      final t = cardTitles[componentId.toInt()];
      children.add(AttributeChip(
        label: 'component',
        value: t,
        muted: t == null,
      ));
    }

    // Other (non-priority) tags.
    for (final id in otherTagIds) {
      final p = tagPaths[id];
      if (p != null) children.add(TagChip(path: p));
    }

    return ListTile(
      key: rowKey ?? Key('task-row-${task.id}'),
      title: Text(title),
      subtitle: Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Wrap(spacing: 6, runSpacing: 4, children: children),
      ),
      trailing: showOpenButton
          ? TextButton(
              key: Key('task-open-${task.id}'),
              onPressed: onTap,
              child: const Text('Open'),
            )
          : null,
      onTap: onTap,
    );
  }
}
