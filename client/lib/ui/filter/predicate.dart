/// Predicate AST shared by the quick-filter bar and the advanced tree
/// editor. JSON-round-trippable so it can flow into URLs / saved views and
/// across the wire to `card.select_with_attributes` (`tree:` field).
///
/// A `Predicate` is either:
///   - `PredicateLeaf`: `<attr> <op> <value(s)>`
///   - `PredicateGroup`: `(child1) AND (child2)` (or OR / NOT)
///
/// NOT groups have exactly one child by construction; the constructor
/// asserts it. Empty AND groups are vacuously true; empty OR groups are
/// vacuously false (the server enforces the same).
library;

/// Operators understood by every layer (UI → wire → server SQL).
///
/// Names avoid Dart keywords (`in`, `is`) by adding a trailing underscore
/// where needed; the wire encoding uses the operator strings (`=`, `!=`,
/// `in`, `not in`, `exists`, `not exists`) returned by [predicateOpWire].
enum PredicateOp {
  eq,
  ne,
  in_,
  notIn,
  exists,
  notExists,
}

/// Returns the wire string for [op] (matches the server's `op` field).
String predicateOpWire(PredicateOp op) {
  switch (op) {
    case PredicateOp.eq:
      return '=';
    case PredicateOp.ne:
      return '!=';
    case PredicateOp.in_:
      return 'in';
    case PredicateOp.notIn:
      return 'not in';
    case PredicateOp.exists:
      return 'exists';
    case PredicateOp.notExists:
      return 'not exists';
  }
}

/// Parses a wire string into a [PredicateOp]. Throws [ArgumentError] on
/// unknown operators so server-issued JSON cannot silently smuggle in a
/// new operator the client cannot render.
PredicateOp predicateOpFromWire(String s) {
  switch (s) {
    case '=':
      return PredicateOp.eq;
    case '!=':
      return PredicateOp.ne;
    case 'in':
      return PredicateOp.in_;
    case 'not in':
      return PredicateOp.notIn;
    case 'exists':
      return PredicateOp.exists;
    case 'not exists':
      return PredicateOp.notExists;
    default:
      throw ArgumentError.value(s, 'op', 'unknown predicate operator');
  }
}

/// Whether [op] takes a single value (`eq`, `ne`), a list (`in`, `not in`),
/// or no value at all (`exists`, `not exists`). Drives the inline editor.
enum PredicateOpArity { none, single, multi }

PredicateOpArity predicateOpArity(PredicateOp op) {
  switch (op) {
    case PredicateOp.eq:
    case PredicateOp.ne:
      return PredicateOpArity.single;
    case PredicateOp.in_:
    case PredicateOp.notIn:
      return PredicateOpArity.multi;
    case PredicateOp.exists:
    case PredicateOp.notExists:
      return PredicateOpArity.none;
  }
}

/// Group connective.
enum GroupConnective { and, or, not }

String groupConnectiveWire(GroupConnective c) {
  switch (c) {
    case GroupConnective.and:
      return 'and';
    case GroupConnective.or:
      return 'or';
    case GroupConnective.not:
      return 'not';
  }
}

GroupConnective groupConnectiveFromWire(String s) {
  switch (s.toLowerCase()) {
    case 'and':
      return GroupConnective.and;
    case 'or':
      return GroupConnective.or;
    case 'not':
      return GroupConnective.not;
    default:
      throw ArgumentError.value(s, 'connective', 'unknown group connective');
  }
}

/// Sealed Predicate hierarchy. Use `switch (p)` to exhaustively dispatch
/// over the two subtypes.
sealed class Predicate {
  const Predicate();

  Map<String, dynamic> toJson();

  /// Decode a Predicate from its JSON shape. Accepts either:
  ///   - `{attr, op, values?}` → leaf
  ///   - `{connective, children}` → group
  factory Predicate.fromJson(Map<String, dynamic> j) {
    if (j.containsKey('connective')) {
      final children = (j['children'] as List?)?.cast<Map<String, dynamic>>()
              .map(Predicate.fromJson)
              .toList() ??
          const <Predicate>[];
      return PredicateGroup(
        connective: groupConnectiveFromWire(j['connective'] as String),
        children: children,
      );
    }
    final attr = (j['attr'] as String?) ?? '';
    final op = predicateOpFromWire((j['op'] as String?) ?? '');
    final values = (j['values'] as List?) ?? const <dynamic>[];
    return PredicateLeaf(attr: attr, op: op, values: List<dynamic>.from(values));
  }

  /// Human-readable, share-friendly textual rendering — read-only; we do
  /// NOT round-trip text back into the AST. Use [toJson]/[fromJson] for
  /// that. Examples:
  ///   `status != done`
  ///   `milestone in (M1, M2)`
  ///   `(status = doing) AND (NOT (assignee = alice))`
  String toText();
}

class PredicateLeaf extends Predicate {
  final String attr;
  final PredicateOp op;
  final List<dynamic> values;

  const PredicateLeaf({
    required this.attr,
    required this.op,
    this.values = const [],
  });

  /// Convenience: a single-value leaf (eq/ne).
  PredicateLeaf.single({
    required String attr,
    required PredicateOp op,
    required dynamic value,
  }) : this(attr: attr, op: op, values: [value]);

  PredicateLeaf copyWith({
    String? attr,
    PredicateOp? op,
    List<dynamic>? values,
  }) =>
      PredicateLeaf(
        attr: attr ?? this.attr,
        op: op ?? this.op,
        values: values ?? this.values,
      );

  @override
  Map<String, dynamic> toJson() => {
        'attr': attr,
        'op': predicateOpWire(op),
        if (values.isNotEmpty) 'values': values,
      };

  @override
  String toText() {
    final opTxt = predicateOpWire(op);
    switch (predicateOpArity(op)) {
      case PredicateOpArity.none:
        return '$attr $opTxt';
      case PredicateOpArity.single:
        final v = values.isEmpty ? 'null' : _renderValue(values.first);
        return '$attr $opTxt $v';
      case PredicateOpArity.multi:
        return '$attr $opTxt (${values.map(_renderValue).join(', ')})';
    }
  }
}

class PredicateGroup extends Predicate {
  final GroupConnective connective;
  final List<Predicate> children;

  PredicateGroup({
    required this.connective,
    required this.children,
  }) {
    if (connective == GroupConnective.not && children.length != 1) {
      throw ArgumentError(
        'NOT group must have exactly one child (got ${children.length})',
      );
    }
  }

  PredicateGroup copyWith({
    GroupConnective? connective,
    List<Predicate>? children,
  }) =>
      PredicateGroup(
        connective: connective ?? this.connective,
        children: children ?? this.children,
      );

  @override
  Map<String, dynamic> toJson() => {
        'connective': groupConnectiveWire(connective),
        'children': [for (final c in children) c.toJson()],
      };

  @override
  String toText() {
    if (connective == GroupConnective.not) {
      return 'NOT (${children.first.toText()})';
    }
    if (children.isEmpty) {
      // Empty AND is true; empty OR is false. Render the textual constant
      // so the rendering is unambiguous when the editor is in this state.
      return connective == GroupConnective.and ? 'true' : 'false';
    }
    final joiner = connective == GroupConnective.and ? ' AND ' : ' OR ';
    return children.map((c) => '(${c.toText()})').join(joiner);
  }
}

String _renderValue(dynamic v) {
  if (v == null) return 'null';
  if (v is String) return v;
  return '$v';
}

/// `true` when [p] is a flat top-level AND of leaves — the shape the
/// quick-filter bar can edit. Used by the advanced editor to decide
/// whether the "switch to quick" button should be enabled.
bool isFlatAndOfLeaves(Predicate? p) {
  if (p == null) return true;
  if (p is PredicateLeaf) return true;
  if (p is PredicateGroup) {
    if (p.connective != GroupConnective.and) return false;
    for (final c in p.children) {
      if (c is! PredicateLeaf) return false;
    }
    return true;
  }
  return false;
}

/// Returns the leaves of [p] when [p] is a flat AND of leaves (or a single
/// leaf); empty list when [p] is null. Throws [StateError] otherwise.
List<PredicateLeaf> flattenLeaves(Predicate? p) {
  if (p == null) return const [];
  if (p is PredicateLeaf) return [p];
  if (p is PredicateGroup && p.connective == GroupConnective.and) {
    return [
      for (final c in p.children)
        if (c is PredicateLeaf) c else throw StateError('not flat'),
    ];
  }
  throw StateError('predicate is not a flat AND of leaves');
}

/// Wrap [leaves] in a top-level AND group; returns null when [leaves] is
/// empty so callers can drop the `where` field altogether.
Predicate? predicateFromLeaves(List<PredicateLeaf> leaves) {
  if (leaves.isEmpty) return null;
  if (leaves.length == 1) return leaves.first;
  return PredicateGroup(connective: GroupConnective.and, children: leaves);
}
