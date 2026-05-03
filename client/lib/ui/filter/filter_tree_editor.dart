/// FilterTreeEditor — visual editor for an arbitrary [Predicate] AST.
///
/// Each node renders as a card; group nodes nest indented children. The
/// editor mutates by rebuilding the full tree on every change and handing
/// the new value to `onChanged` — the caller is the source of truth.
library;

import 'package:flutter/material.dart';

import 'filter_bar.dart';
import 'predicate.dart';

class FilterTreeEditor extends StatelessWidget {
  final Predicate? value;
  final void Function(Predicate?) onChanged;
  final List<FilterAttribute> attributes;
  final FilterValueLabel? labelForValue;

  const FilterTreeEditor({
    super.key,
    required this.value,
    required this.onChanged,
    required this.attributes,
    this.labelForValue,
  });

  @override
  Widget build(BuildContext context) {
    final root = value;
    if (root == null) {
      return Card(
        key: const Key('filter-tree-empty'),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              const Expanded(child: Text('No filter. Add a leaf or group.')),
              TextButton.icon(
                key: const Key('filter-tree-seed-leaf'),
                onPressed: () => onChanged(_seedLeaf()),
                icon: const Icon(Icons.add, size: 16),
                label: const Text('Leaf'),
              ),
              const SizedBox(width: 4),
              TextButton.icon(
                key: const Key('filter-tree-seed-group'),
                onPressed: () => onChanged(PredicateGroup(
                  connective: GroupConnective.and,
                  children: const [],
                )),
                icon: const Icon(Icons.account_tree, size: 16),
                label: const Text('Group'),
              ),
            ],
          ),
        ),
      );
    }
    return _PredicateNode(
      node: root,
      attributes: attributes,
      labelForValue: labelForValue,
      onChanged: (v) => onChanged(v),
      onDelete: () => onChanged(null),
      depth: 0,
    );
  }

  PredicateLeaf _seedLeaf() {
    final a = attributes.isNotEmpty ? attributes.first : null;
    return PredicateLeaf(
      attr: a?.name ?? '',
      op: PredicateOp.eq,
      values: const [],
    );
  }
}

/// Recursive widget rendering one [Predicate] node at depth [depth].
class _PredicateNode extends StatelessWidget {
  final Predicate node;
  final List<FilterAttribute> attributes;
  final FilterValueLabel? labelForValue;

  /// Replace this node with [next]; null deletes (caller decides what
  /// happens).
  final void Function(Predicate? next) onChanged;
  final VoidCallback onDelete;
  final int depth;

  const _PredicateNode({
    required this.node,
    required this.attributes,
    required this.labelForValue,
    required this.onChanged,
    required this.onDelete,
    required this.depth,
  });

  @override
  Widget build(BuildContext context) {
    final n = node;
    return Padding(
      padding: EdgeInsets.only(left: depth == 0 ? 0 : 16, top: 4, bottom: 4),
      child: switch (n) {
        PredicateLeaf l => _buildLeaf(context, l),
        PredicateGroup g => _buildGroup(context, g),
      },
    );
  }

  Widget _buildLeaf(BuildContext context, PredicateLeaf leaf) {
    final a =
        attributes.where((x) => x.name == leaf.attr).firstOrNull ??
            (attributes.isNotEmpty ? attributes.first : null);
    return Card(
      key: Key('filter-leaf-d$depth'),
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Row(
          children: [
            const Icon(Icons.label_outline, size: 16),
            const SizedBox(width: 8),
            Expanded(
              child: Wrap(
                spacing: 8,
                runSpacing: 4,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  // Attribute dropdown.
                  DropdownButton<String>(
                    key: Key('filter-leaf-attr-d$depth'),
                    value: a?.name,
                    items: [
                      for (final at in attributes)
                        DropdownMenuItem(
                          value: at.name,
                          child: Text(at.label),
                        ),
                    ],
                    onChanged: (v) {
                      if (v == null) return;
                      onChanged(leaf.copyWith(attr: v, values: const []));
                    },
                  ),
                  // Operator dropdown.
                  DropdownButton<PredicateOp>(
                    key: Key('filter-leaf-op-d$depth'),
                    value: leaf.op,
                    items: [
                      for (final op in (a?.ops ?? const <PredicateOp>[]))
                        DropdownMenuItem(
                          value: op,
                          child: Text(predicateOpWire(op)),
                        ),
                    ],
                    onChanged: (v) {
                      if (v == null) return;
                      onChanged(leaf.copyWith(op: v));
                    },
                  ),
                  // Value editor.
                  SizedBox(width: 240, child: _ValueField(
                    leaf: leaf,
                    attribute: a,
                    onChanged: (vs) =>
                        onChanged(leaf.copyWith(values: vs)),
                  )),
                ],
              ),
            ),
            IconButton(
              key: Key('filter-leaf-delete-d$depth'),
              icon: const Icon(Icons.close, size: 18),
              tooltip: 'Delete',
              onPressed: onDelete,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildGroup(BuildContext context, PredicateGroup group) {
    return Card(
      key: Key('filter-group-d$depth'),
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.account_tree, size: 16),
                const SizedBox(width: 8),
                DropdownButton<GroupConnective>(
                  key: Key('filter-group-connective-d$depth'),
                  value: group.connective,
                  items: const [
                    DropdownMenuItem(
                      value: GroupConnective.and,
                      child: Text('AND'),
                    ),
                    DropdownMenuItem(
                      value: GroupConnective.or,
                      child: Text('OR'),
                    ),
                    DropdownMenuItem(
                      value: GroupConnective.not,
                      child: Text('NOT'),
                    ),
                  ],
                  onChanged: (v) {
                    if (v == null) return;
                    if (v == GroupConnective.not) {
                      // NOT collapses to one child; keep the first or seed
                      // a leaf if empty.
                      final child = group.children.isNotEmpty
                          ? group.children.first
                          : _seedLeaf();
                      onChanged(PredicateGroup(
                        connective: v,
                        children: [child],
                      ));
                    } else {
                      onChanged(group.copyWith(connective: v));
                    }
                  },
                ),
                const Spacer(),
                if (group.connective != GroupConnective.not) ...[
                  IconButton(
                    key: Key('filter-group-add-leaf-d$depth'),
                    icon: const Icon(Icons.add, size: 18),
                    tooltip: 'Add leaf',
                    onPressed: () {
                      onChanged(group.copyWith(
                        children: [...group.children, _seedLeaf()],
                      ));
                    },
                  ),
                  IconButton(
                    key: Key('filter-group-add-group-d$depth'),
                    icon: const Icon(Icons.account_tree_outlined, size: 18),
                    tooltip: 'Add group',
                    onPressed: () {
                      onChanged(group.copyWith(
                        children: [
                          ...group.children,
                          PredicateGroup(
                            connective: GroupConnective.and,
                            children: const [],
                          ),
                        ],
                      ));
                    },
                  ),
                ],
                IconButton(
                  key: Key('filter-group-delete-d$depth'),
                  icon: const Icon(Icons.close, size: 18),
                  tooltip: 'Delete group',
                  onPressed: onDelete,
                ),
              ],
            ),
            // Capture the parent's onChanged so the child closures don't
            // collide with their own `onChanged` parameter name.
            for (var i = 0; i < group.children.length; i++)
              _buildChild(group, i),
            if (group.children.isEmpty)
              Padding(
                padding: const EdgeInsets.only(left: 16, top: 4),
                child: Text(
                  group.connective == GroupConnective.and
                      ? 'Empty AND (matches everything)'
                      : group.connective == GroupConnective.or
                          ? 'Empty OR (matches nothing)'
                          : 'NOT requires a child',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
          ],
        ),
      ),
    );
  }

  PredicateLeaf _seedLeaf() {
    final a = attributes.isNotEmpty ? attributes.first : null;
    return PredicateLeaf(
      attr: a?.name ?? '',
      op: PredicateOp.eq,
      values: const [],
    );
  }

  /// Builds the i-th child of [group] with closures that mutate the
  /// parent. Lifted out so the child closures don't shadow the parent
  /// node's `onChanged` field.
  Widget _buildChild(PredicateGroup group, int i) {
    final parentOnChanged = onChanged;
    void replaceAt(Predicate? next) {
      final children = [...group.children];
      if (next == null) {
        children.removeAt(i);
      } else {
        children[i] = next;
      }
      // NOT must keep exactly one child; deletion collapses the whole
      // group.
      if (group.connective == GroupConnective.not && children.isEmpty) {
        parentOnChanged(null);
        return;
      }
      parentOnChanged(group.copyWith(children: children));
    }

    return _PredicateNode(
      node: group.children[i],
      attributes: attributes,
      labelForValue: labelForValue,
      onChanged: replaceAt,
      onDelete: () => replaceAt(null),
      depth: depth + 1,
    );
  }
}

/// Inline value editor — picks a UI based on the operator's arity and
/// whether the attribute has a fixed `options` palette.
class _ValueField extends StatelessWidget {
  final PredicateLeaf leaf;
  final FilterAttribute? attribute;
  final void Function(List<dynamic>) onChanged;
  const _ValueField({
    required this.leaf,
    required this.attribute,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final arity = predicateOpArity(leaf.op);
    if (arity == PredicateOpArity.none) {
      return const SizedBox.shrink();
    }
    final opts = attribute?.options;
    if (arity == PredicateOpArity.single) {
      if (opts != null) {
        final cur = leaf.values.isEmpty ? null : leaf.values.first;
        return DropdownButton<dynamic>(
          isExpanded: true,
          value: opts.any((o) => o.value == cur) ? cur : null,
          hint: const Text('value'),
          items: [
            for (final o in opts)
              DropdownMenuItem(value: o.value, child: Text(o.label)),
          ],
          onChanged: (v) => onChanged([if (v != null) v]),
        );
      }
      return TextFormField(
        initialValue: leaf.values.isEmpty ? '' : leaf.values.first.toString(),
        decoration: const InputDecoration(isDense: true, hintText: 'value'),
        onChanged: (s) => onChanged([s]),
      );
    }
    // multi.
    if (opts != null) {
      final selected = leaf.values.toSet();
      return Wrap(
        spacing: 4,
        runSpacing: 4,
        children: [
          for (final o in opts)
            FilterChip(
              label: Text(o.label),
              selected: selected.contains(o.value),
              onSelected: (sel) {
                final next = [...leaf.values];
                if (sel) {
                  if (!next.contains(o.value)) next.add(o.value);
                } else {
                  next.remove(o.value);
                }
                onChanged(next);
              },
            ),
        ],
      );
    }
    return TextFormField(
      initialValue: leaf.values.join(', '),
      decoration: const InputDecoration(
        isDense: true,
        hintText: 'comma-separated values',
      ),
      onChanged: (s) => onChanged(
        s.split(',').map((x) => x.trim()).where((x) => x.isNotEmpty).toList(),
      ),
    );
  }
}

