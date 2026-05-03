/// FilterBar — the chip-row "quick filter" UI plus a hand-off button to
/// the advanced tree editor.
///
/// The bar always edits a top-level AND of leaves (`PredicateGroup.and`);
/// each child leaf becomes a removable chip. Switching to the advanced
/// editor lets the user introduce OR / NOT groups and nested structure;
/// switching back is gated on `isFlatAndOfLeaves` so we never silently
/// drop OR/NOT structure.
///
/// Attribute palette (label, options, value type) is supplied by the host
/// screen — different screens (grid / inbox / kanban / projects) surface
/// different attribute sets.
library;

import 'package:flutter/material.dart';

import 'filter_tree_editor.dart';
import 'predicate.dart';

/// One attribute that can be filtered on. `options` are the suggested
/// values for eq / in pickers; null means "free-form text input".
class FilterAttribute {
  final String name;
  final String label;
  final List<FilterAttributeOption>? options;

  /// Set of operators that make sense for this attribute. Defaults to a
  /// reasonable working set when omitted.
  final List<PredicateOp> ops;

  const FilterAttribute({
    required this.name,
    required this.label,
    this.options,
    this.ops = const [
      PredicateOp.eq,
      PredicateOp.ne,
      PredicateOp.in_,
      PredicateOp.notIn,
      PredicateOp.exists,
      PredicateOp.notExists,
    ],
  });
}

/// One option for the eq / in picker on a [FilterAttribute].
class FilterAttributeOption {
  /// JSON-encodable value to send on the wire.
  final dynamic value;

  /// Human-readable label.
  final String label;
  const FilterAttributeOption({required this.value, required this.label});
}

/// Resolves human labels for opaque values (e.g. user_id 7 → "alice").
typedef FilterValueLabel = String Function(String attr, dynamic value);

class FilterBar extends StatefulWidget {
  final Predicate? value;
  final void Function(Predicate?) onChanged;

  /// Available attributes the user can pick to add a leaf for.
  final List<FilterAttribute> attributes;

  /// Optional override that turns a wire value into a display label. Falls
  /// back to the attribute's `options` when present, then `value.toString()`.
  final FilterValueLabel? labelForValue;

  const FilterBar({
    super.key,
    required this.value,
    required this.onChanged,
    required this.attributes,
    this.labelForValue,
  });

  @override
  State<FilterBar> createState() => _FilterBarState();
}

class _FilterBarState extends State<FilterBar> {
  bool _advanced = false;

  void _setLeaves(List<PredicateLeaf> leaves) {
    widget.onChanged(predicateFromLeaves(leaves));
  }

  String _renderValue(String attr, dynamic value) {
    if (widget.labelForValue != null) {
      return widget.labelForValue!(attr, value);
    }
    final a = widget.attributes.where((x) => x.name == attr).firstOrNull;
    if (a?.options != null) {
      for (final o in a!.options!) {
        if (o.value == value) return o.label;
      }
    }
    return value?.toString() ?? '';
  }

  String _renderLeaf(PredicateLeaf leaf) {
    final a =
        widget.attributes.where((x) => x.name == leaf.attr).firstOrNull;
    final attrLabel = a?.label ?? leaf.attr;
    final opTxt = predicateOpWire(leaf.op);
    switch (predicateOpArity(leaf.op)) {
      case PredicateOpArity.none:
        return '$attrLabel $opTxt';
      case PredicateOpArity.single:
        final v = leaf.values.isEmpty
            ? 'null'
            : _renderValue(leaf.attr, leaf.values.first);
        return '$attrLabel $opTxt $v';
      case PredicateOpArity.multi:
        final txt = leaf.values
            .map((v) => _renderValue(leaf.attr, v))
            .join(', ');
        return '$attrLabel $opTxt ($txt)';
    }
  }

  @override
  Widget build(BuildContext context) {
    final flat = isFlatAndOfLeaves(widget.value);
    if (_advanced || !flat) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Text(
                  'Advanced filter',
                  style: Theme.of(context).textTheme.titleSmall,
                ),
                const Spacer(),
                TextButton.icon(
                  key: const Key('filter-bar-switch-quick'),
                  onPressed: flat
                      ? () => setState(() => _advanced = false)
                      : null,
                  icon: const Icon(Icons.view_compact, size: 16),
                  label: const Text('Switch to quick'),
                ),
              ],
            ),
            const SizedBox(height: 4),
            FilterTreeEditor(
              value: widget.value,
              onChanged: widget.onChanged,
              attributes: widget.attributes,
              labelForValue: widget.labelForValue,
            ),
          ],
        ),
      );
    }

    final leaves = flattenLeaves(widget.value);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Wrap(
        key: const Key('filter-bar'),
        spacing: 6,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          for (var i = 0; i < leaves.length; i++)
            InputChip(
              key: Key('filter-chip-$i'),
              label: Text(_renderLeaf(leaves[i])),
              onDeleted: () {
                final next = [...leaves]..removeAt(i);
                _setLeaves(next);
              },
            ),
          ActionChip(
            key: const Key('filter-bar-add'),
            avatar: const Icon(Icons.add, size: 16),
            label: const Text('Filter'),
            onPressed: () async {
              final leaf = await _pickLeaf(context, widget.attributes,
                  labelForValue: _renderValue);
              if (leaf == null) return;
              _setLeaves([...leaves, leaf]);
            },
          ),
          TextButton.icon(
            key: const Key('filter-bar-switch-advanced'),
            onPressed: () => setState(() => _advanced = true),
            icon: const Icon(Icons.account_tree, size: 16),
            label: const Text('Advanced'),
          ),
        ],
      ),
    );
  }
}

/// Inline picker dialog: choose attribute → operator → value(s). Returns
/// the assembled [PredicateLeaf] or null if cancelled.
Future<PredicateLeaf?> _pickLeaf(
  BuildContext context,
  List<FilterAttribute> attributes, {
  required String Function(String attr, dynamic value) labelForValue,
}) async {
  return showDialog<PredicateLeaf?>(
    context: context,
    builder: (ctx) => _LeafPickerDialog(
      attributes: attributes,
      labelForValue: labelForValue,
    ),
  );
}

class _LeafPickerDialog extends StatefulWidget {
  final List<FilterAttribute> attributes;
  final String Function(String attr, dynamic value) labelForValue;
  const _LeafPickerDialog({
    required this.attributes,
    required this.labelForValue,
  });

  @override
  State<_LeafPickerDialog> createState() => _LeafPickerDialogState();
}

class _LeafPickerDialogState extends State<_LeafPickerDialog> {
  FilterAttribute? _attr;
  PredicateOp _op = PredicateOp.eq;
  final TextEditingController _free = TextEditingController();
  final Set<dynamic> _multi = {};
  dynamic _single;

  @override
  void initState() {
    super.initState();
    if (widget.attributes.isNotEmpty) {
      _attr = widget.attributes.first;
      if (_attr!.ops.isNotEmpty) _op = _attr!.ops.first;
    }
  }

  @override
  void dispose() {
    _free.dispose();
    super.dispose();
  }

  void _setAttr(FilterAttribute a) {
    setState(() {
      _attr = a;
      if (!a.ops.contains(_op)) _op = a.ops.first;
      _single = null;
      _multi.clear();
      _free.clear();
    });
  }

  PredicateLeaf? _build() {
    final a = _attr;
    if (a == null) return null;
    switch (predicateOpArity(_op)) {
      case PredicateOpArity.none:
        return PredicateLeaf(attr: a.name, op: _op);
      case PredicateOpArity.single:
        final v = _single ?? (_free.text.isEmpty ? null : _free.text);
        if (v == null) return null;
        return PredicateLeaf.single(attr: a.name, op: _op, value: v);
      case PredicateOpArity.multi:
        if (_multi.isEmpty && _free.text.isEmpty) return null;
        final values = _multi.isNotEmpty
            ? _multi.toList()
            : _free.text.split(',').map((s) => s.trim()).toList();
        return PredicateLeaf(attr: a.name, op: _op, values: values);
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = _attr;
    return AlertDialog(
      title: const Text('Add filter'),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButtonFormField<FilterAttribute>(
              key: const Key('filter-pick-attr'),
              value: a,
              decoration: const InputDecoration(labelText: 'Attribute'),
              items: [
                for (final at in widget.attributes)
                  DropdownMenuItem(value: at, child: Text(at.label)),
              ],
              onChanged: (v) {
                if (v != null) _setAttr(v);
              },
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<PredicateOp>(
              key: const Key('filter-pick-op'),
              value: _op,
              decoration: const InputDecoration(labelText: 'Operator'),
              items: [
                for (final op in (a?.ops ?? const <PredicateOp>[]))
                  DropdownMenuItem(value: op, child: Text(predicateOpWire(op))),
              ],
              onChanged: (v) {
                if (v != null) setState(() => _op = v);
              },
            ),
            const SizedBox(height: 8),
            _valueEditor(a),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(null),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const Key('filter-pick-confirm'),
          onPressed: () {
            final p = _build();
            Navigator.of(context).pop(p);
          },
          child: const Text('Add'),
        ),
      ],
    );
  }

  Widget _valueEditor(FilterAttribute? a) {
    if (a == null) return const SizedBox.shrink();
    switch (predicateOpArity(_op)) {
      case PredicateOpArity.none:
        return const SizedBox.shrink();
      case PredicateOpArity.single:
        if (a.options != null) {
          return DropdownButtonFormField<dynamic>(
            key: const Key('filter-pick-value-single'),
            value: _single,
            decoration: const InputDecoration(labelText: 'Value'),
            items: [
              for (final o in a.options!)
                DropdownMenuItem(value: o.value, child: Text(o.label)),
            ],
            onChanged: (v) => setState(() => _single = v),
          );
        }
        return TextField(
          key: const Key('filter-pick-value-free'),
          controller: _free,
          decoration: const InputDecoration(labelText: 'Value'),
        );
      case PredicateOpArity.multi:
        if (a.options != null) {
          return Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              for (final o in a.options!)
                FilterChip(
                  key: Key('filter-pick-value-${o.value}'),
                  label: Text(o.label),
                  selected: _multi.contains(o.value),
                  onSelected: (sel) => setState(() {
                    if (sel) {
                      _multi.add(o.value);
                    } else {
                      _multi.remove(o.value);
                    }
                  }),
                ),
            ],
          );
        }
        return TextField(
          key: const Key('filter-pick-value-multi'),
          controller: _free,
          decoration: const InputDecoration(
            labelText: 'Values',
            hintText: 'comma-separated',
          ),
        );
    }
  }
}

