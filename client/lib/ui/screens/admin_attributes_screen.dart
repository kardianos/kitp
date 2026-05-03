/// AdminAttributesScreen — admin-only CRUD over attribute_def + edge rows
/// plus a population view for the ref-style value cards (milestone,
/// component, tag) where each card is itself a "value" of an attribute.
///
/// Layout: master / detail.
///   - Left: every attribute_def (built-in or custom). Tap to select.
///   - Right: bound card_types for the selected def (with an unbind
///     button) and — for ref-style defs — the value-card population with
///     an Active toggle and a Delete affordance.
///
/// Dispatcher contract:
///   - On entry: ONE batch carrying attribute_def.select + card_type.select
///     + (optionally) one card.select_with_attributes per ref-style
///     card_type discovered.
///   - User gestures (toggle Active, delete value, bind card_type, unbind
///     card_type, create attribute) each fire ONE batch with ONE
///     subrequest, then refresh.
///
/// Picker filtering against `is_active = false` is NOT done here — that
/// belongs to picker call sites. This screen only manages the data.
library;

import 'package:flutter/material.dart';

import '../../app.dart';
import '../../dispatch/dispatcher.dart';
import '../../reg/handlers.dart';

/// The three card_type names whose cards are themselves attribute values
/// (i.e. picker contents). Hard-coded today; a more general model would
/// derive this from `value_type` on the attribute_defs that target them
/// (e.g. `card_ref` of those types). Keeping it explicit is fine — the
/// set is closed and changing it is a deliberate schema change.
const List<String> _kRefCardTypeNames = ['milestone', 'component', 'tag'];

class AdminAttributesScreen extends StatefulWidget {
  const AdminAttributesScreen({super.key});

  @override
  State<AdminAttributesScreen> createState() => _AdminAttributesScreenState();
}

class _AdminAttributesScreenState extends State<AdminAttributesScreen> {
  Future<_AdminAttrData>? _future;
  int? _selectedDefId;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _future ??= _load(KitpApp.dispatcherOf(context));
  }

  Future<_AdminAttrData> _load(Dispatcher d) async {
    final defsF = d.request<AttributeDefSelectInput, AttributeDefSelectOutput>(
      endpoint: 'attribute_def',
      action: 'select',
      data: const AttributeDefSelectInput(),
    );
    final typesF = d.request<CardTypeSelectInput, CardTypeSelectOutput>(
      endpoint: 'card_type',
      action: 'select',
      data: const CardTypeSelectInput(),
    );
    // Pull the population of every ref-style card type in one batch so the
    // detail panel renders without an extra round-trip.
    final valueCardFutures = <String, Future<CardSelectWithAttributesOutput>>{
      for (final n in _kRefCardTypeNames)
        n: d.request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
              endpoint: 'card',
              action: 'select_with_attributes',
              data: CardSelectWithAttributesInput(
                cardTypeName: n,
                includeDeleted: false,
                limit: 500,
              ),
            )
    };
    final defs = await defsF;
    final types = await typesF;
    final valueCards = <String, List<CardWithAttrs>>{};
    for (final entry in valueCardFutures.entries) {
      valueCards[entry.key] = (await entry.value).rows;
    }
    return _AdminAttrData(
      defs: defs.rows,
      cardTypes: types.rows,
      valueCardsByType: valueCards,
    );
  }

  void _refresh() {
    setState(() {
      _future = _load(KitpApp.dispatcherOf(context));
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Admin · Attributes'),
        actions: [
          IconButton(
            tooltip: 'New attribute',
            icon: const Icon(Icons.add),
            onPressed: () async {
              final data = await _future;
              if (data == null || !mounted) return;
              final created = await showDialog<bool>(
                context: context,
                builder: (_) => _NewAttributeDialog(cardTypes: data.cardTypes),
              );
              if (created == true) _refresh();
            },
            key: const ValueKey('new-attr-button'),
          ),
        ],
      ),
      body: FutureBuilder<_AdminAttrData>(
        future: _future,
        builder: (ctx, snap) {
          if (snap.hasError) {
            return Center(child: Text('Failed to load: ${snap.error}'));
          }
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }
          final data = snap.data!;
          AttributeDefRow? selected;
          if (_selectedDefId != null) {
            for (final r in data.defs) {
              if (r.id == _selectedDefId) {
                selected = r;
                break;
              }
            }
          }
          selected ??= data.defs.isEmpty ? null : data.defs.first;
          if (selected != null && _selectedDefId != selected.id) {
            // Stash the implicit selection so the detail builds against
            // the same object (no setState here — we are inside build).
            _selectedDefId = selected.id;
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(
                width: 280,
                child: _AttributeList(
                  defs: data.defs,
                  selectedId: _selectedDefId,
                  onSelect: (id) => setState(() => _selectedDefId = id),
                ),
              ),
              const VerticalDivider(width: 1),
              Expanded(
                child: selected == null
                    ? const Center(child: Text('No attribute selected'))
                    : _AttributeDetail(
                        def: selected,
                        cardTypes: data.cardTypes,
                        valueCardsByType: data.valueCardsByType,
                        onChanged: _refresh,
                      ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _AdminAttrData {
  final List<AttributeDefRow> defs;
  final List<CardTypeRow> cardTypes;
  final Map<String, List<CardWithAttrs>> valueCardsByType;
  _AdminAttrData({
    required this.defs,
    required this.cardTypes,
    required this.valueCardsByType,
  });
}

class _AttributeList extends StatelessWidget {
  final List<AttributeDefRow> defs;
  final int? selectedId;
  final void Function(int) onSelect;
  const _AttributeList({
    required this.defs,
    required this.selectedId,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      itemCount: defs.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (ctx, i) {
        final d = defs[i];
        final isSelected = d.id == selectedId;
        return ListTile(
          key: ValueKey('attr-row-${d.id}'),
          dense: true,
          selected: isSelected,
          title: Text(d.name),
          subtitle: Text(d.valueType),
          trailing: d.isBuiltIn
              ? Tooltip(
                  message: 'built-in',
                  child: Icon(Icons.lock_outline, size: 16, color: Theme.of(ctx).colorScheme.outline),
                )
              : null,
          onTap: () => onSelect(d.id),
        );
      },
    );
  }
}

class _AttributeDetail extends StatelessWidget {
  final AttributeDefRow def;
  final List<CardTypeRow> cardTypes;
  final Map<String, List<CardWithAttrs>> valueCardsByType;
  final VoidCallback onChanged;
  const _AttributeDetail({
    required this.def,
    required this.cardTypes,
    required this.valueCardsByType,
    required this.onChanged,
  });

  /// Card types this def is a "value of": i.e. milestone/component/tag
  /// when this def is `milestone_ref`/`component_ref`/`tags`. Hard-coded
  /// mapping today.
  List<String> _valueOfCardTypes() {
    switch (def.name) {
      case 'milestone_ref':
        return ['milestone'];
      case 'component_ref':
        return ['component'];
      case 'tags':
        return ['tag'];
      default:
        return const [];
    }
  }

  @override
  Widget build(BuildContext context) {
    final boundIds = {for (final b in def.boundTo) b.cardTypeId};
    final unbound = [
      for (final t in cardTypes)
        if (!boundIds.contains(t.id)) t,
    ];
    final valueOf = _valueOfCardTypes();
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Text(def.name,
                  style: Theme.of(context).textTheme.headlineSmall),
            ),
            Chip(label: Text(def.valueType)),
            if (def.isBuiltIn) ...[
              const SizedBox(width: 8),
              const Chip(label: Text('built-in')),
            ],
          ],
        ),
        const SizedBox(height: 16),
        Text('Bound to', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (def.boundTo.isEmpty)
          const Text('No bindings yet — pick a card type below to bind.'),
        for (final b in def.boundTo)
          _BoundRow(
            def: def,
            bound: b,
            onChanged: onChanged,
          ),
        const SizedBox(height: 12),
        if (unbound.isNotEmpty)
          _BindPicker(def: def, options: unbound, onChanged: onChanged),
        if (valueOf.isNotEmpty) ...[
          const Divider(height: 32),
          Text('Value cards (${valueOf.join(', ')})',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          for (final tname in valueOf)
            _ValueCardSection(
              cardTypeName: tname,
              cards: valueCardsByType[tname] ?? const [],
              onChanged: onChanged,
            ),
        ],
      ],
    );
  }
}

class _BoundRow extends StatelessWidget {
  final AttributeDefRow def;
  final AttributeDefBoundCardType bound;
  final VoidCallback onChanged;
  const _BoundRow({
    required this.def,
    required this.bound,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final dispatcher = KitpApp.dispatcherOf(context);
    // Refuse the unbind affordance entirely when the edge connects two
    // built-in entities (server will refuse it too — show the lock).
    final protected = def.isBuiltIn && bound.isBuiltIn;
    return ListTile(
      dense: true,
      key: ValueKey('bound-${def.id}-${bound.cardTypeId}'),
      title: Text(bound.cardTypeName),
      subtitle: bound.isRequired ? const Text('required') : null,
      trailing: protected
          ? const Tooltip(
              message: 'built-in edge — change the migration to remove',
              child: Icon(Icons.lock_outline, size: 18),
            )
          : IconButton(
              key: ValueKey('unbind-${def.id}-${bound.cardTypeId}'),
              tooltip: 'Unbind',
              icon: const Icon(Icons.link_off),
              onPressed: () async {
                final res = await dispatcher.request<EdgeDeleteInput, EdgeDeleteOutput>(
                  endpoint: 'edge',
                  action: 'delete',
                  data: EdgeDeleteInput(
                    attributeDefId: def.id,
                    cardTypeId: bound.cardTypeId,
                  ),
                );
                if (!context.mounted) return;
                if (!res.ok) {
                  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                    content: Text('In use by ${res.usageCount} card(s); clear them first.'),
                  ));
                  return;
                }
                onChanged();
              },
            ),
    );
  }
}

class _BindPicker extends StatefulWidget {
  final AttributeDefRow def;
  final List<CardTypeRow> options;
  final VoidCallback onChanged;
  const _BindPicker({
    required this.def,
    required this.options,
    required this.onChanged,
  });
  @override
  State<_BindPicker> createState() => _BindPickerState();
}

class _BindPickerState extends State<_BindPicker> {
  int? _picked;
  bool _required = false;

  @override
  Widget build(BuildContext context) {
    final dispatcher = KitpApp.dispatcherOf(context);
    return Wrap(
      spacing: 12,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        DropdownButton<int>(
          key: ValueKey('bind-picker-${widget.def.id}'),
          hint: const Text('Bind to card type'),
          value: _picked,
          items: [
            for (final t in widget.options)
              DropdownMenuItem(value: t.id, child: Text(t.name)),
          ],
          onChanged: (v) => setState(() => _picked = v),
        ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Checkbox(
              value: _required,
              onChanged: (v) => setState(() => _required = v ?? false),
            ),
            const Text('required'),
          ],
        ),
        FilledButton.tonal(
          key: ValueKey('bind-button-${widget.def.id}'),
          onPressed: _picked == null
              ? null
              : () async {
                  await dispatcher.request<EdgeInsertInput, EdgeInsertOutput>(
                    endpoint: 'edge',
                    action: 'insert',
                    data: EdgeInsertInput(
                      attributeDefId: widget.def.id,
                      cardTypeId: _picked!,
                      isRequired: _required,
                    ),
                  );
                  if (!mounted) return;
                  setState(() {
                    _picked = null;
                    _required = false;
                  });
                  widget.onChanged();
                },
          child: const Text('Bind'),
        ),
      ],
    );
  }
}

class _ValueCardSection extends StatelessWidget {
  final String cardTypeName;
  final List<CardWithAttrs> cards;
  final VoidCallback onChanged;
  const _ValueCardSection({
    required this.cardTypeName,
    required this.cards,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 8),
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      cardTypeName,
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                  TextButton.icon(
                    key: ValueKey('add-value-$cardTypeName'),
                    icon: const Icon(Icons.add, size: 18),
                    label: Text('New $cardTypeName'),
                    onPressed: () async {
                      final created = await showDialog<bool>(
                        context: context,
                        builder: (_) => _AddValueDialog(
                          cardTypeName: cardTypeName,
                          existing: cards,
                        ),
                      );
                      if (created == true) onChanged();
                    },
                  ),
                ],
              ),
            ),
            if (cards.isEmpty)
              const Padding(
                padding: EdgeInsets.all(8),
                child: Text('No value cards.'),
              ),
            for (final c in cards)
              _ValueCardRow(
                cardTypeName: cardTypeName,
                card: c,
                onChanged: onChanged,
              ),
          ],
        ),
      ),
    );
  }
}

/// Inline dialog for creating a new milestone / component / tag value
/// card. Tags optionally accept a `path` (slash-separated) so they can be
/// nested (e.g. `priority/p1`); milestones / components just take a title.
class _AddValueDialog extends StatefulWidget {
  final String cardTypeName;
  final List<CardWithAttrs> existing;
  const _AddValueDialog({
    required this.cardTypeName,
    required this.existing,
  });
  @override
  State<_AddValueDialog> createState() => _AddValueDialogState();
}

class _AddValueDialogState extends State<_AddValueDialog> {
  final _title = TextEditingController();
  final _path = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _title.dispose();
    _path.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dispatcher = KitpApp.dispatcherOf(context);
    final isTag = widget.cardTypeName == 'tag';
    return AlertDialog(
      title: Text('New ${widget.cardTypeName}'),
      content: SizedBox(
        width: 420,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              key: const ValueKey('add-value-title'),
              controller: _title,
              autofocus: true,
              decoration: const InputDecoration(labelText: 'Title'),
            ),
            if (isTag) ...[
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('add-value-path'),
                controller: _path,
                decoration: const InputDecoration(
                  labelText: 'Path (optional)',
                  hintText: 'e.g. priority/p1',
                ),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('add-value-create'),
          onPressed: _busy
              ? null
              : () async {
                  final t = _title.text.trim();
                  if (t.isEmpty) {
                    setState(() => _error = 'Title is required');
                    return;
                  }
                  setState(() {
                    _busy = true;
                    _error = null;
                  });
                  try {
                    final attrs = <String, dynamic>{};
                    if (isTag && _path.text.trim().isNotEmpty) {
                      attrs['path'] = _path.text.trim();
                    }
                    await dispatcher
                        .request<CardInsertInput, CardInsertOutput>(
                      endpoint: 'card',
                      action: 'insert',
                      data: CardInsertInput(
                        cardTypeName: widget.cardTypeName,
                        title: t,
                        attributes: attrs.isEmpty ? null : attrs,
                      ),
                    );
                    if (!mounted) return;
                    Navigator.of(context).pop(true);
                  } catch (e) {
                    if (!mounted) return;
                    setState(() {
                      _busy = false;
                      _error = '$e';
                    });
                  }
                },
          child: const Text('Create'),
        ),
      ],
    );
  }
}

class _ValueCardRow extends StatefulWidget {
  final String cardTypeName;
  final CardWithAttrs card;
  final VoidCallback onChanged;
  const _ValueCardRow({
    required this.cardTypeName,
    required this.card,
    required this.onChanged,
  });
  @override
  State<_ValueCardRow> createState() => _ValueCardRowState();
}

class _ValueCardRowState extends State<_ValueCardRow> {
  bool _busy = false;
  int? _usageCount; // null until checked

  /// Pre-check usage. The picker filter is "include this value when listing
  /// choices for `<cardTypeName>_ref` (or `tags`)" — we count cards that
  /// reference this value via the ref attribute (`milestone_ref`,
  /// `component_ref`) or the `tags` array (the server's `=` op against a
  /// jsonb scalar handles both shapes since the value side is always
  /// stored as the card id JSON literal).
  Future<int> _countUsage() async {
    final dispatcher = KitpApp.dispatcherOf(context);
    final id = widget.card.id;
    String attr;
    switch (widget.cardTypeName) {
      case 'milestone':
        attr = 'milestone_ref';
        break;
      case 'component':
        attr = 'component_ref';
        break;
      case 'tag':
        attr = 'tags';
        break;
      default:
        return 0;
    }
    final out = await dispatcher.request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: CardSelectWithAttributesInput(
        where: [CardWherePredicate(attr: attr, op: '=', value: id)],
        includeDeleted: false,
        limit: 1000,
      ),
    );
    return out.rows.length;
  }

  bool get _isActive {
    final v = widget.card.attributes['is_active'];
    if (v == null) return true; // absent == active (default)
    if (v is bool) return v;
    return v != false;
  }

  Future<void> _toggleActive() async {
    setState(() => _busy = true);
    try {
      final dispatcher = KitpApp.dispatcherOf(context);
      await dispatcher.request<AttributeUpdateInput, AttributeUpdateOutput>(
        endpoint: 'attribute',
        action: 'update',
        data: AttributeUpdateInput(
          cardId: widget.card.id,
          attributeName: 'is_active',
          value: !_isActive,
        ),
      );
      if (!mounted) return;
      widget.onChanged();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    setState(() => _busy = true);
    try {
      final dispatcher = KitpApp.dispatcherOf(context);
      // Pre-check usage; refuse if any.
      final n = await _countUsage();
      if (!mounted) return;
      if (n > 0) {
        setState(() => _usageCount = n);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('In use by $n card(s); clear references first.'),
        ));
        return;
      }
      // Confirm.
      final ok = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
          title: Text('Delete ${widget.card.title ?? '#${widget.card.id}'}?'),
          content: const Text('This permanently removes the value card.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Delete'),
            ),
          ],
        ),
      );
      if (ok != true) return;
      // Soft-delete via the existing card.delete handler. (We avoid
      // reaching into card_delete details here — the existing endpoint
      // already stamps deleted_at.)
      final res = await dispatcher.request<CardDeleteInput, CardDeleteOutput>(
        endpoint: 'card',
        action: 'delete',
        data: CardDeleteInput(cardId: widget.card.id),
      );
      if (!mounted) return;
      if (!res.ok) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Delete failed.'),
        ));
        return;
      }
      widget.onChanged();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.card;
    final usage = _usageCount;
    return ListTile(
      key: ValueKey('value-card-${c.id}'),
      dense: true,
      title: Text(c.title ?? '#${c.id}'),
      subtitle: usage == null ? null : Text('referenced by $usage card(s)'),
      trailing: Wrap(
        spacing: 4,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text('Active'),
              Switch(
                key: ValueKey('active-toggle-${c.id}'),
                value: _isActive,
                onChanged: _busy ? null : (_) => _toggleActive(),
              ),
            ],
          ),
          IconButton(
            key: ValueKey('delete-value-${c.id}'),
            tooltip: usage != null && usage > 0
                ? 'In use by $usage card(s)'
                : 'Delete value card',
            icon: const Icon(Icons.delete_outline),
            onPressed: _busy ? null : _delete,
          ),
        ],
      ),
    );
  }
}

class _NewAttributeDialog extends StatefulWidget {
  final List<CardTypeRow> cardTypes;
  const _NewAttributeDialog({required this.cardTypes});
  @override
  State<_NewAttributeDialog> createState() => _NewAttributeDialogState();
}

class _NewAttributeDialogState extends State<_NewAttributeDialog> {
  final TextEditingController _name = TextEditingController();
  String _valueType = 'text';
  final Set<int> _bindTo = {};
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dispatcher = KitpApp.dispatcherOf(context);
    return AlertDialog(
      title: const Text('New attribute'),
      content: SizedBox(
        width: 480,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              key: const ValueKey('new-attr-name'),
              controller: _name,
              decoration: const InputDecoration(labelText: 'Name'),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              key: const ValueKey('new-attr-type'),
              value: _valueType,
              decoration: const InputDecoration(labelText: 'Value type'),
              items: const [
                DropdownMenuItem(value: 'text', child: Text('text')),
                DropdownMenuItem(value: 'bool', child: Text('bool')),
                DropdownMenuItem(value: 'int', child: Text('int')),
                DropdownMenuItem(value: 'card_ref', child: Text('card_ref')),
                DropdownMenuItem(value: 'card_ref[]', child: Text('card_ref[]')),
                DropdownMenuItem(value: 'user_ref', child: Text('user_ref')),
              ],
              onChanged: (v) => setState(() => _valueType = v ?? 'text'),
            ),
            const SizedBox(height: 12),
            const Text('Bind to card types:'),
            const SizedBox(height: 4),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                for (final t in widget.cardTypes)
                  FilterChip(
                    key: ValueKey('bind-chip-${t.id}'),
                    label: Text(t.name),
                    selected: _bindTo.contains(t.id),
                    onSelected: (s) => setState(() {
                      if (s) {
                        _bindTo.add(t.id);
                      } else {
                        _bindTo.remove(t.id);
                      }
                    }),
                  ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          key: const ValueKey('new-attr-create'),
          onPressed: _busy
              ? null
              : () async {
                  if (_name.text.trim().isEmpty) {
                    setState(() => _error = 'Name is required');
                    return;
                  }
                  setState(() {
                    _busy = true;
                    _error = null;
                  });
                  try {
                    await dispatcher.request<AttributeDefInsertInput, AttributeDefInsertOutput>(
                      endpoint: 'attribute_def',
                      action: 'insert',
                      data: AttributeDefInsertInput(
                        name: _name.text.trim(),
                        valueType: _valueType,
                        bindTo: [
                          for (final id in _bindTo) AttributeDefBindEntry(cardTypeId: id),
                        ],
                      ),
                    );
                    if (!mounted) return;
                    Navigator.of(context).pop(true);
                  } catch (e) {
                    if (!mounted) return;
                    setState(() {
                      _busy = false;
                      _error = '$e';
                    });
                  }
                },
          child: const Text('Create'),
        ),
      ],
    );
  }
}
