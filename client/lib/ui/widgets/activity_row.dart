/// One rendered row in the task detail activity stream.
///
/// Knows how to format every kind we currently emit: `card_create`,
/// `attr_update`, `comment`, `card_delete`, `card_undelete`, `card_move`,
/// `tag_apply`, `tag_remove`. Unknown kinds fall through to a generic
/// `kind` rendering.
///
/// All numeric ids are resolved to display names via [RefMaps] so the user
/// reads "alice" rather than "2" in an `assignee` change.
library;

import 'package:flutter/material.dart';

import '../../reg/handlers.dart';

/// Lookup tables fed to [ActivityRowView] (and to TaskDetail's renderer)
/// so attribute values that are foreign keys can be displayed as names.
class RefMaps {
  /// user_account.id -> display_name.
  final Map<int, String> users;

  /// milestone card.id -> title.
  final Map<int, String> milestones;

  /// component card.id -> title.
  final Map<int, String> components;

  /// tag card.id -> path (e.g. "priority/high").
  final Map<int, String> tags;

  /// Optional fall-back map of any card id -> title for unknown refs.
  final Map<int, String> cards;

  const RefMaps({
    this.users = const {},
    this.milestones = const {},
    this.components = const {},
    this.tags = const {},
    this.cards = const {},
  });

  static const RefMaps empty = RefMaps();
}

/// Humanise an attribute_def name for display: drops the `_ref` suffix and
/// replaces underscores with spaces.
String humaniseAttribute(String name) {
  var n = name;
  if (n.endsWith('_ref')) n = n.substring(0, n.length - 4);
  return n.replaceAll('_', ' ');
}

class ActivityRowView extends StatelessWidget {
  final ActivityRow row;
  final RefMaps refs;

  const ActivityRowView({
    super.key,
    required this.row,
    required this.refs,
  });

  String _actor() {
    final n = refs.users[row.actorId];
    return n ?? 'user#${row.actorId}';
  }

  String _formatAttrValue(String? attrName, dynamic v) {
    if (v == null) return '∅';
    switch (attrName) {
      case 'assignee':
        if (v is num) return refs.users[v.toInt()] ?? '#${v.toInt()}';
        return v.toString();
      case 'milestone_ref':
        if (v is num) return refs.milestones[v.toInt()] ?? '#${v.toInt()}';
        return v.toString();
      case 'component_ref':
        if (v is num) return refs.components[v.toInt()] ?? '#${v.toInt()}';
        return v.toString();
      case 'tags':
        if (v is List) return _formatTagList(v);
        return v.toString();
    }
    if (v is String) return v;
    if (v is num) return v.toString();
    if (v is bool) return v.toString();
    return v.toString();
  }

  String _formatTagList(List<dynamic> ids) {
    final parts = <String>[];
    for (final id in ids) {
      if (id is num) {
        parts.add(refs.tags[id.toInt()] ?? '#${id.toInt()}');
      } else {
        parts.add(id.toString());
      }
    }
    if (parts.isEmpty) return '∅';
    return parts.join(', ');
  }

  /// For tag activity rows, compute the diff between value_old and value_new
  /// and return ([added], [removed]) display strings.
  (List<String>, List<String>) _tagDiff() {
    final oldIds = _idSet(row.valueOld);
    final newIds = _idSet(row.valueNew);
    final added = newIds.difference(oldIds);
    final removed = oldIds.difference(newIds);
    String resolve(int id) => refs.tags[id] ?? '#$id';
    return (
      [for (final id in added) resolve(id)],
      [for (final id in removed) resolve(id)],
    );
  }

  Set<int> _idSet(dynamic v) {
    if (v is List) {
      return {for (final e in v) if (e is num) e.toInt()};
    }
    return const {};
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final actor = _actor();
    final ts = row.createdAt.length >= 19 ? row.createdAt.substring(0, 19).replaceFirst('T', ' ') : row.createdAt;

    Widget body;
    switch (row.kind) {
      case 'card_create':
        body = _line(context, '$actor created the card.');
        break;
      case 'attr_update':
        final name = row.attributeName ?? 'attribute';
        if (name == 'description') {
          body = _line(context, '$actor edited the description.');
        } else if (name == 'sort_order') {
          body = _line(context, '$actor reordered the card.');
        } else {
          final label = humaniseAttribute(name);
          final oldS = _formatAttrValue(name, row.valueOld);
          final newS = _formatAttrValue(name, row.valueNew);
          body = _line(context, '$actor changed $label: $oldS → $newS');
        }
        break;
      case 'comment':
        final text = row.commentBody ?? '';
        body = _comment(context, actor, text);
        break;
      case 'card_delete':
        body = _line(context, '$actor deleted the card.');
        break;
      case 'card_undelete':
        body = _line(context, '$actor restored the card.');
        break;
      case 'card_move':
        body = _line(context, '$actor moved the card.');
        break;
      case 'tag_apply':
      case 'tag_remove':
        final (added, removed) = _tagDiff();
        if (added.isEmpty && removed.isEmpty) {
          body = _line(context, '$actor changed tags.');
        } else if (removed.isEmpty) {
          body = _line(context, '$actor applied ${added.join(', ')}');
        } else if (added.isEmpty) {
          body = _line(context, '$actor removed ${removed.join(', ')}');
        } else {
          body = _line(context,
              '$actor applied ${added.join(', ')} and removed ${removed.join(', ')}');
        }
        break;
      default:
        body = _line(context, '$actor: ${row.kind}');
    }

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(ts, style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
          const SizedBox(height: 2),
          body,
        ],
      ),
    );
  }

  Widget _line(BuildContext context, String text) {
    return Text(text, style: Theme.of(context).textTheme.bodyMedium);
  }

  Widget _comment(BuildContext context, String actor, String body) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: cs.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(actor, style: TextStyle(fontWeight: FontWeight.w600, color: cs.onSurface)),
          const SizedBox(height: 4),
          Text(body, style: Theme.of(context).textTheme.bodyMedium),
        ],
      ),
    );
  }
}
