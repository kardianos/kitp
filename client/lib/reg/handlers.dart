/// Typed envelopes for every server handler the client knows about today.
///
/// We hand-write `fromJson`/`toJson` rather than spinning up
/// `freezed` + `json_serializable`; the volume is small enough that the
/// per-Phase build_runner cycle is more friction than it's worth here.
///
/// Convention:
///   - Field names match the server's JSON exactly (snake_case).
///   - Optional fields are nullable Dart fields. `toJson` omits nulls so
///     server-side `pointer-or-nil` decoders see the absent key.
library;

import 'handler_registry.dart';
import 'handlers_admin.dart';

// ============================================================================
// echo.ping
// ============================================================================

class EchoPingInput {
  final int x;
  final String message;
  const EchoPingInput({required this.x, required this.message});
  Map<String, dynamic> toJson() => {'x': x, 'message': message};
}

class EchoPingOutput {
  final int x;
  final String message;
  const EchoPingOutput({required this.x, required this.message});
  factory EchoPingOutput.fromJson(Map<String, dynamic> j) => EchoPingOutput(
    x: (j['x'] as num).toInt(),
    message: (j['message'] as String?) ?? '',
  );
}

// ============================================================================
// card_type.select   — empty input, list of rows out.
// ============================================================================

class CardTypeSelectInput {
  const CardTypeSelectInput();
  Map<String, dynamic> toJson() => const {};
}

class CardTypeRow {
  final int id;
  final String name;
  final int? parentCardTypeId;
  final bool allowSelfParent;
  final bool isBuiltIn;
  const CardTypeRow({
    required this.id,
    required this.name,
    this.parentCardTypeId,
    required this.allowSelfParent,
    required this.isBuiltIn,
  });
  factory CardTypeRow.fromJson(Map<String, dynamic> j) => CardTypeRow(
    id: (j['id'] as num).toInt(),
    name: j['name'] as String,
    parentCardTypeId: (j['parent_card_type_id'] as num?)?.toInt(),
    allowSelfParent: (j['allow_self_parent'] as bool?) ?? false,
    isBuiltIn: (j['is_built_in'] as bool?) ?? false,
  );
}

class CardTypeSelectOutput {
  final List<CardTypeRow> rows;
  const CardTypeSelectOutput({required this.rows});
  factory CardTypeSelectOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return CardTypeSelectOutput(
      rows: [for (final r in raw) CardTypeRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

// ============================================================================
// card.insert
// ============================================================================

/// `attributes` carries optional initial attribute writes — the server uses
/// them to emit one `attr_update` activity per entry as part of the same
/// insert. Values are JSON-encodable (string, num, bool, list, map). The
/// dispatcher forwards them as the raw `data.attributes` jsonb field.
class CardInsertInput {
  final String cardTypeName;
  final int? parentCardId;
  final String title;
  final Map<String, dynamic>? attributes;
  const CardInsertInput({
    required this.cardTypeName,
    this.parentCardId,
    required this.title,
    this.attributes,
  });
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{
      'card_type_name': cardTypeName,
      'title': title,
    };
    if (parentCardId != null) m['parent_card_id'] = parentCardId;
    if (attributes != null && attributes!.isNotEmpty) {
      m['attributes'] = attributes;
    }
    return m;
  }
}

class CardInsertOutput {
  final int id;
  const CardInsertOutput({required this.id});
  factory CardInsertOutput.fromJson(Map<String, dynamic> j) =>
      CardInsertOutput(id: (j['id'] as num).toInt());
}

// ============================================================================
// card.select  — list-only read; returns rows with title flattened
// ============================================================================

class CardSelectInput {
  final int? parentCardId;
  final String? cardTypeName;
  const CardSelectInput({this.parentCardId, this.cardTypeName});
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{};
    if (parentCardId != null) m['parent_card_id'] = parentCardId;
    if (cardTypeName != null) m['card_type_name'] = cardTypeName;
    return m;
  }
}

class CardRow {
  final int id;
  final int cardTypeId;
  final String cardTypeName;
  final int? parentCardId;
  final String? title;
  const CardRow({
    required this.id,
    required this.cardTypeId,
    required this.cardTypeName,
    this.parentCardId,
    this.title,
  });
  factory CardRow.fromJson(Map<String, dynamic> j) => CardRow(
    id: (j['id'] as num).toInt(),
    cardTypeId: (j['card_type_id'] as num).toInt(),
    cardTypeName: j['card_type_name'] as String,
    parentCardId: (j['parent_card_id'] as num?)?.toInt(),
    title: j['title'] as String?,
  );
}

class CardSelectOutput {
  final List<CardRow> rows;
  const CardSelectOutput({required this.rows});
  factory CardSelectOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return CardSelectOutput(
      rows: [for (final r in raw) CardRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

// ============================================================================
// card.select_with_attributes — LATERAL-join read; per-card attributes
// ============================================================================

/// Predicate for `where[]`. Matches the server's `Predicate` JSON shape.
///
/// The server supports two shapes; this class can produce either:
///   - Single condition: `{attr, op, value | values}` — `attr` and `op`
///     are required.
///   - Compound AND: `{and: [<pred>, ...]}` — all sub-predicates must
///     hold for a row to match. Construct via `CardWherePredicate.and(...)`.
class CardWherePredicate {
  final String attr;
  final String op;
  final dynamic value;
  final List<dynamic>? values;
  final List<CardWherePredicate>? and;

  const CardWherePredicate({
    required this.attr,
    required this.op,
    this.value,
    this.values,
  }) : and = null;

  /// Construct a compound AND predicate. The single-condition fields
  /// (attr/op/value/values) are unused for this shape.
  const CardWherePredicate.and(List<CardWherePredicate> predicates)
      : attr = '',
        op = '',
        value = null,
        values = null,
        and = predicates;

  Map<String, dynamic> toJson() {
    if (and != null) {
      return {'and': [for (final p in and!) p.toJson()]};
    }
    final m = <String, dynamic>{'attr': attr, 'op': op};
    if (value != null) m['value'] = value;
    if (values != null) m['values'] = values;
    return m;
  }
}

class CardOrderClause {
  final String field;
  final String? direction;
  const CardOrderClause({required this.field, this.direction});
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{'field': field};
    if (direction != null) m['direction'] = direction;
    return m;
  }
}

/// Recursive predicate-tree wire shape sent in the `tree` field of
/// `card.select_with_attributes`. Mirrors the server's `CardWhereGroup`:
///
///   { connective: 'and' | 'or' | 'not',
///     children: [ <leaf> | <group>, ... ] }
///
/// Each child is either another group (with `connective`) or a leaf map
/// `{attr, op, values?}` (the same shape as [CardWherePredicate]). The
/// dart-side editor in `client/lib/ui/filter/predicate.dart` produces this
/// shape via `Predicate.toJson()`; we accept any `Map<String,dynamic>`
/// here so the UI layer stays decoupled from the wire layer.
class CardWhereGroup {
  /// 'and' | 'or' | 'not'
  final String connective;

  /// Each child is either another [CardWhereGroup] (with `connective`) or
  /// a leaf map `{attr, op, values?}`.
  final List<Map<String, dynamic>> children;

  const CardWhereGroup({required this.connective, required this.children});

  Map<String, dynamic> toJson() => {
        'connective': connective,
        'children': children,
      };
}

class CardSelectWithAttributesInput {
  final int? parentCardId;
  final String? cardTypeName;
  final List<CardWherePredicate>? where;

  /// Recursive predicate tree — when set the server uses it instead of
  /// (and ignores) the flat `where` list. Either shape gives the same
  /// result for a single top-level AND of leaves; the tree is the only
  /// way to express OR / NOT / nesting.
  final Map<String, dynamic>? tree;

  final List<CardOrderClause>? order;
  final int? limit;
  final int? offset;
  final bool? includeDeleted;
  const CardSelectWithAttributesInput({
    this.parentCardId,
    this.cardTypeName,
    this.where,
    this.tree,
    this.order,
    this.limit,
    this.offset,
    this.includeDeleted,
  });
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{};
    if (parentCardId != null) m['parent_card_id'] = parentCardId;
    if (cardTypeName != null) m['card_type_name'] = cardTypeName;
    if (where != null && where!.isNotEmpty) {
      m['where'] = [for (final w in where!) w.toJson()];
    }
    if (tree != null) m['tree'] = tree;
    if (order != null && order!.isNotEmpty) {
      m['order'] = [for (final o in order!) o.toJson()];
    }
    if (limit != null) m['limit'] = limit;
    if (offset != null) m['offset'] = offset;
    if (includeDeleted != null) m['include_deleted'] = includeDeleted;
    return m;
  }
}

/// One row from `card.select_with_attributes`. `attributes` is a free-form
/// map keyed by attribute_def name; values are decoded JSON (strings, numbers,
/// lists, …). The screen layer is responsible for casting per attribute.
class CardWithAttrs {
  final int id;
  final int cardTypeId;
  final String cardTypeName;
  final int? parentCardId;
  final Map<String, dynamic> attributes;
  final String? deletedAt;
  const CardWithAttrs({
    required this.id,
    required this.cardTypeId,
    required this.cardTypeName,
    this.parentCardId,
    required this.attributes,
    this.deletedAt,
  });
  factory CardWithAttrs.fromJson(Map<String, dynamic> j) => CardWithAttrs(
    id: (j['id'] as num).toInt(),
    cardTypeId: (j['card_type_id'] as num).toInt(),
    cardTypeName: (j['card_type_name'] as String?) ?? '',
    parentCardId: (j['parent_card_id'] as num?)?.toInt(),
    attributes: ((j['attributes'] as Map?)?.cast<String, dynamic>()) ?? const {},
    deletedAt: j['deleted_at'] as String?,
  );

  /// Convenience accessor for the built-in title attribute. Returns null
  /// when the attribute is missing or non-string.
  String? get title {
    final v = attributes['title'];
    return v is String ? v : null;
  }
}

class CardSelectWithAttributesOutput {
  final List<CardWithAttrs> rows;
  const CardSelectWithAttributesOutput({required this.rows});
  factory CardSelectWithAttributesOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return CardSelectWithAttributesOutput(
      rows: [for (final r in raw) CardWithAttrs.fromJson(r as Map<String, dynamic>)],
    );
  }
}

// ============================================================================
// attribute.update
// ============================================================================

class AttributeUpdateInput {
  final int cardId;
  final String attributeName;
  /// JSON-encodable value (string / number / bool / null / list / map).
  final dynamic value;
  const AttributeUpdateInput({
    required this.cardId,
    required this.attributeName,
    required this.value,
  });
  Map<String, dynamic> toJson() => {
    'card_id': cardId,
    'attribute_name': attributeName,
    'value': value,
  };
}

class AttributeUpdateOutput {
  final bool ok;
  final int activityId;
  final dynamic prevValue;
  const AttributeUpdateOutput({
    required this.ok,
    required this.activityId,
    this.prevValue,
  });
  factory AttributeUpdateOutput.fromJson(Map<String, dynamic> j) =>
      AttributeUpdateOutput(
        ok: (j['ok'] as bool?) ?? false,
        activityId: (j['activity_id'] as num?)?.toInt() ?? 0,
        prevValue: j['prev_value'],
      );
}

// ============================================================================
// activity.select — paged, chronological activity for one card
// ============================================================================

/// `cardId` is optional: when null, the server returns activity across
/// every card the actor can see (cross-card mode used by the global
/// `/activity` view). When set, the per-card mode is unchanged.
class ActivitySelectInput {
  final int? cardId;
  final int? limit;
  final int? beforeActivityId;
  const ActivitySelectInput({
    this.cardId,
    this.limit,
    this.beforeActivityId,
  });
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{};
    if (cardId != null) m['card_id'] = cardId;
    if (limit != null) m['limit'] = limit;
    if (beforeActivityId != null) m['before_activity_id'] = beforeActivityId;
    return m;
  }
}

class ActivityRow {
  final int id;
  /// The card this activity row belongs to. Always populated by the server
  /// (added in T6 for the cross-card view); per-card responses also carry
  /// it so renderers can route per-row links uniformly.
  final int cardId;
  final String kind;
  final String? attributeName;
  final dynamic valueOld;
  final dynamic valueNew;
  final String? commentBody;
  final int actorId;
  final String createdAt;
  const ActivityRow({
    required this.id,
    this.cardId = 0,
    required this.kind,
    this.attributeName,
    this.valueOld,
    this.valueNew,
    this.commentBody,
    required this.actorId,
    required this.createdAt,
  });
  factory ActivityRow.fromJson(Map<String, dynamic> j) => ActivityRow(
    id: (j['id'] as num).toInt(),
    cardId: (j['card_id'] as num?)?.toInt() ?? 0,
    kind: j['kind'] as String,
    attributeName: j['attribute_name'] as String?,
    valueOld: j['value_old'],
    valueNew: j['value_new'],
    commentBody: j['comment_body'] as String?,
    actorId: (j['actor_id'] as num?)?.toInt() ?? 0,
    createdAt: (j['created_at'] as String?) ?? '',
  );
}

class ActivitySelectOutput {
  final List<ActivityRow> rows;
  const ActivitySelectOutput({required this.rows});
  factory ActivitySelectOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return ActivitySelectOutput(
      rows: [for (final r in raw) ActivityRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

// ============================================================================
// comment.insert
// ============================================================================

class CommentInsertInput {
  final int cardId;
  final String body;
  const CommentInsertInput({required this.cardId, required this.body});
  Map<String, dynamic> toJson() => {'card_id': cardId, 'body': body};
}

class CommentInsertOutput {
  final bool ok;
  final int activityId;
  final int commentBodyId;
  const CommentInsertOutput({
    required this.ok,
    required this.activityId,
    required this.commentBodyId,
  });
  factory CommentInsertOutput.fromJson(Map<String, dynamic> j) =>
      CommentInsertOutput(
        ok: (j['ok'] as bool?) ?? false,
        activityId: (j['activity_id'] as num?)?.toInt() ?? 0,
        commentBodyId: (j['comment_body_id'] as num?)?.toInt() ?? 0,
      );
}

// ============================================================================
// user.select — empty input, list of users out (for assignee dropdowns).
// ============================================================================

class UserSelectInput {
  const UserSelectInput();
  Map<String, dynamic> toJson() => const {};
}

class UserRow {
  final int id;
  final String displayName;
  const UserRow({required this.id, required this.displayName});
  factory UserRow.fromJson(Map<String, dynamic> j) => UserRow(
    id: (j['id'] as num).toInt(),
    displayName: j['display_name'] as String,
  );
}

class UserSelectOutput {
  final List<UserRow> rows;
  const UserSelectOutput({required this.rows});
  factory UserSelectOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return UserSelectOutput(
      rows: [for (final r in raw) UserRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

// ============================================================================
// tag.apply / tag.remove
// ============================================================================

class TagApplyInput {
  final int targetCardId;
  final int tagCardId;
  const TagApplyInput({required this.targetCardId, required this.tagCardId});
  Map<String, dynamic> toJson() => {
    'target_card_id': targetCardId,
    'tag_card_id': tagCardId,
  };
}

class TagApplyOutput {
  final bool ok;
  final int activityId;
  final List<int> removedTagIds;
  const TagApplyOutput({
    required this.ok,
    required this.activityId,
    required this.removedTagIds,
  });
  factory TagApplyOutput.fromJson(Map<String, dynamic> j) {
    final removed = (j['removed_tag_ids'] as List?) ?? const [];
    return TagApplyOutput(
      ok: (j['ok'] as bool?) ?? false,
      activityId: (j['activity_id'] as num?)?.toInt() ?? 0,
      removedTagIds: [for (final r in removed) (r as num).toInt()],
    );
  }
}

class TagRemoveInput {
  final int targetCardId;
  final int tagCardId;
  const TagRemoveInput({required this.targetCardId, required this.tagCardId});
  Map<String, dynamic> toJson() => {
    'target_card_id': targetCardId,
    'tag_card_id': tagCardId,
  };
}

class TagRemoveOutput {
  final bool ok;
  final int activityId;
  const TagRemoveOutput({required this.ok, required this.activityId});
  factory TagRemoveOutput.fromJson(Map<String, dynamic> j) => TagRemoveOutput(
    ok: (j['ok'] as bool?) ?? false,
    activityId: (j['activity_id'] as num?)?.toInt() ?? 0,
  );
}

// ============================================================================
// inbox.select — per-user "open work assigned to me" read with personal
// ordering. Mirrors `card.select_with_attributes` rows but adds
// `personal_sort_order` so the inbox screen can drive its drag-drop
// reorder.
// ============================================================================

class InboxSelectInput {
  /// Optional override; in dev mode the server refuses any value other
  /// than the calling actor's own user_id.
  final int? userId;

  /// Optional v2 predicate-tree (same shape as
  /// `card.select_with_attributes.tree`) — layers extra constraints on
  /// top of the inbox's built-in `assignee = me AND status != done`
  /// predicate. The compiled SQL is AND-joined into the WHERE clause.
  final Map<String, dynamic>? tree;

  final int? limit;
  final int? offset;
  const InboxSelectInput({this.userId, this.tree, this.limit, this.offset});
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{};
    if (userId != null) m['user_id'] = userId;
    if (tree != null) m['tree'] = tree;
    if (limit != null) m['limit'] = limit;
    if (offset != null) m['offset'] = offset;
    return m;
  }
}

/// One row of `inbox.select`. The shape mirrors `CardWithAttrs` (so the
/// existing TaskRow renderer can be reused) but the server intentionally
/// omits `card_type_name` and `deleted_at` (every row is a non-deleted
/// task). `personalSort` is null when the row has never been reordered.
class InboxRow {
  final int id;
  final int cardTypeId;
  final int? parentCardId;
  final Map<String, dynamic> attributes;
  final double? personalSort;
  const InboxRow({
    required this.id,
    required this.cardTypeId,
    this.parentCardId,
    required this.attributes,
    this.personalSort,
  });
  factory InboxRow.fromJson(Map<String, dynamic> j) => InboxRow(
    id: (j['id'] as num).toInt(),
    cardTypeId: (j['card_type_id'] as num).toInt(),
    parentCardId: (j['parent_card_id'] as num?)?.toInt(),
    attributes:
        ((j['attributes'] as Map?)?.cast<String, dynamic>()) ?? const {},
    personalSort: (j['personal_sort_order'] as num?)?.toDouble(),
  );

  /// Adapter to the existing `CardWithAttrs` shape so widgets that already
  /// render an inbox-style row (e.g. `TaskRow`) need not change.
  CardWithAttrs toCardWithAttrs() => CardWithAttrs(
        id: id,
        cardTypeId: cardTypeId,
        cardTypeName: 'task',
        parentCardId: parentCardId,
        attributes: attributes,
      );

  /// Convenience: title attribute as a String.
  String? get title {
    final v = attributes['title'];
    return v is String ? v : null;
  }
}

class InboxSelectOutput {
  final List<InboxRow> rows;
  const InboxSelectOutput({required this.rows});
  factory InboxSelectOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return InboxSelectOutput(
      rows: [for (final r in raw) InboxRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

// ============================================================================
// user_card_sort.set — write the calling user's personal sort_order for
// one card. Single-shot per drop; the dispatcher batches many adjacent
// sets within one frame into one HTTP call (and the server coalesces them
// into one SQL statement).
// ============================================================================

class UserCardSortSetInput {
  final int cardId;
  final double sortOrder;
  const UserCardSortSetInput({required this.cardId, required this.sortOrder});
  Map<String, dynamic> toJson() => {
    'card_id': cardId,
    'sort_order': sortOrder,
  };
}

class UserCardSortSetOutput {
  final bool ok;
  const UserCardSortSetOutput({required this.ok});
  factory UserCardSortSetOutput.fromJson(Map<String, dynamic> j) =>
      UserCardSortSetOutput(ok: (j['ok'] as bool?) ?? false);
}

// ============================================================================
// card.delete — soft-delete (used by the attribute admin to retire value
// cards once their references are clear).
// ============================================================================

class CardDeleteInput {
  final int cardId;
  const CardDeleteInput({required this.cardId});
  Map<String, dynamic> toJson() => {'card_id': cardId};
}

class CardDeleteOutput {
  final bool ok;
  final int activityId;
  const CardDeleteOutput({required this.ok, required this.activityId});
  factory CardDeleteOutput.fromJson(Map<String, dynamic> j) => CardDeleteOutput(
        ok: (j['ok'] as bool?) ?? false,
        activityId: (j['activity_id'] as num?)?.toInt() ?? 0,
      );
}

// ============================================================================
// attribute_def.select / attribute_def.insert
// edge.insert / edge.delete    (T5 — attribute admin screen)
// ============================================================================

class AttributeDefSelectInput {
  const AttributeDefSelectInput();
  Map<String, dynamic> toJson() => const {};
}

class AttributeDefBoundCardType {
  final int cardTypeId;
  final String cardTypeName;
  final bool isRequired;
  final bool isBuiltIn;
  final int ordering;
  const AttributeDefBoundCardType({
    required this.cardTypeId,
    required this.cardTypeName,
    required this.isRequired,
    required this.isBuiltIn,
    required this.ordering,
  });
  factory AttributeDefBoundCardType.fromJson(Map<String, dynamic> j) =>
      AttributeDefBoundCardType(
        cardTypeId: (j['card_type_id'] as num).toInt(),
        cardTypeName: (j['card_type_name'] as String?) ?? '',
        isRequired: (j['is_required'] as bool?) ?? false,
        isBuiltIn: (j['is_built_in'] as bool?) ?? false,
        ordering: (j['ordering'] as num?)?.toInt() ?? 0,
      );
}

class AttributeDefRow {
  final int id;
  final String name;
  final String valueType;
  final bool isBuiltIn;
  final List<AttributeDefBoundCardType> boundTo;
  const AttributeDefRow({
    required this.id,
    required this.name,
    required this.valueType,
    required this.isBuiltIn,
    required this.boundTo,
  });
  factory AttributeDefRow.fromJson(Map<String, dynamic> j) {
    final raw = (j['bound_to'] as List?) ?? const [];
    return AttributeDefRow(
      id: (j['id'] as num).toInt(),
      name: j['name'] as String,
      valueType: (j['value_type'] as String?) ?? '',
      isBuiltIn: (j['is_built_in'] as bool?) ?? false,
      boundTo: [
        for (final r in raw) AttributeDefBoundCardType.fromJson(r as Map<String, dynamic>),
      ],
    );
  }
}

class AttributeDefSelectOutput {
  final List<AttributeDefRow> rows;
  const AttributeDefSelectOutput({required this.rows});
  factory AttributeDefSelectOutput.fromJson(Map<String, dynamic> j) {
    final raw = (j['rows'] as List?) ?? const [];
    return AttributeDefSelectOutput(
      rows: [for (final r in raw) AttributeDefRow.fromJson(r as Map<String, dynamic>)],
    );
  }
}

/// One initial edge to seed alongside an `attribute_def.insert`.
class AttributeDefBindEntry {
  final int cardTypeId;
  final bool isRequired;
  final int ordering;
  const AttributeDefBindEntry({
    required this.cardTypeId,
    this.isRequired = false,
    this.ordering = 0,
  });
  Map<String, dynamic> toJson() => {
        'card_type_id': cardTypeId,
        if (isRequired) 'is_required': isRequired,
        if (ordering != 0) 'ordering': ordering,
      };
}

class AttributeDefInsertInput {
  final String name;
  final String valueType;
  final List<AttributeDefBindEntry> bindTo;
  const AttributeDefInsertInput({
    required this.name,
    required this.valueType,
    this.bindTo = const [],
  });
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{'name': name, 'value_type': valueType};
    if (bindTo.isNotEmpty) {
      m['bind_to'] = [for (final b in bindTo) b.toJson()];
    }
    return m;
  }
}

class AttributeDefInsertOutput {
  final int id;
  const AttributeDefInsertOutput({required this.id});
  factory AttributeDefInsertOutput.fromJson(Map<String, dynamic> j) =>
      AttributeDefInsertOutput(id: (j['id'] as num).toInt());
}

class EdgeInsertInput {
  final int attributeDefId;
  final int cardTypeId;
  final bool isRequired;
  final int ordering;
  const EdgeInsertInput({
    required this.attributeDefId,
    required this.cardTypeId,
    this.isRequired = false,
    this.ordering = 0,
  });
  Map<String, dynamic> toJson() {
    final m = <String, dynamic>{
      'attribute_def_id': attributeDefId,
      'card_type_id': cardTypeId,
    };
    if (isRequired) m['is_required'] = isRequired;
    if (ordering != 0) m['ordering'] = ordering;
    return m;
  }
}

class EdgeInsertOutput {
  final bool ok;
  const EdgeInsertOutput({required this.ok});
  factory EdgeInsertOutput.fromJson(Map<String, dynamic> j) =>
      EdgeInsertOutput(ok: (j['ok'] as bool?) ?? false);
}

class EdgeDeleteInput {
  final int attributeDefId;
  final int cardTypeId;
  const EdgeDeleteInput({required this.attributeDefId, required this.cardTypeId});
  Map<String, dynamic> toJson() => {
        'attribute_def_id': attributeDefId,
        'card_type_id': cardTypeId,
      };
}

class EdgeDeleteOutput {
  final bool ok;
  final int usageCount;
  const EdgeDeleteOutput({required this.ok, required this.usageCount});
  factory EdgeDeleteOutput.fromJson(Map<String, dynamic> j) => EdgeDeleteOutput(
        ok: (j['ok'] as bool?) ?? false,
        usageCount: (j['usage_count'] as num?)?.toInt() ?? 0,
      );
}

// ============================================================================
// Registration helpers
// ============================================================================

/// Registers every handler this client currently understands. Invoked once
/// at startup from `KitpApp` and once per test setup.
void registerBuiltInHandlers(HandlerRegistry r) {
  r.register<EchoPingInput, EchoPingOutput>(HandlerSpec(
    endpoint: 'echo',
    action: 'ping',
    encode: (i) => i.toJson(),
    decode: (raw) => EchoPingOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<CardTypeSelectInput, CardTypeSelectOutput>(HandlerSpec(
    endpoint: 'card_type',
    action: 'select',
    encode: (i) => i.toJson(),
    decode: (raw) => CardTypeSelectOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<CardInsertInput, CardInsertOutput>(HandlerSpec(
    endpoint: 'card',
    action: 'insert',
    encode: (i) => i.toJson(),
    decode: (raw) => CardInsertOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<CardSelectInput, CardSelectOutput>(HandlerSpec(
    endpoint: 'card',
    action: 'select',
    encode: (i) => i.toJson(),
    decode: (raw) => CardSelectOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
    HandlerSpec(
      endpoint: 'card',
      action: 'select_with_attributes',
      encode: (i) => i.toJson(),
      decode: (raw) =>
          CardSelectWithAttributesOutput.fromJson(raw as Map<String, dynamic>),
    ),
  );
  r.register<AttributeUpdateInput, AttributeUpdateOutput>(HandlerSpec(
    endpoint: 'attribute',
    action: 'update',
    encode: (i) => i.toJson(),
    decode: (raw) =>
        AttributeUpdateOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<ActivitySelectInput, ActivitySelectOutput>(HandlerSpec(
    endpoint: 'activity',
    action: 'select',
    encode: (i) => i.toJson(),
    decode: (raw) =>
        ActivitySelectOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<CommentInsertInput, CommentInsertOutput>(HandlerSpec(
    endpoint: 'comment',
    action: 'insert',
    encode: (i) => i.toJson(),
    decode: (raw) =>
        CommentInsertOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<UserSelectInput, UserSelectOutput>(HandlerSpec(
    endpoint: 'user',
    action: 'select',
    encode: (i) => i.toJson(),
    decode: (raw) => UserSelectOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<TagApplyInput, TagApplyOutput>(HandlerSpec(
    endpoint: 'tag',
    action: 'apply',
    encode: (i) => i.toJson(),
    decode: (raw) => TagApplyOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<TagRemoveInput, TagRemoveOutput>(HandlerSpec(
    endpoint: 'tag',
    action: 'remove',
    encode: (i) => i.toJson(),
    decode: (raw) => TagRemoveOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<InboxSelectInput, InboxSelectOutput>(HandlerSpec(
    endpoint: 'inbox',
    action: 'select',
    encode: (i) => i.toJson(),
    decode: (raw) => InboxSelectOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<UserCardSortSetInput, UserCardSortSetOutput>(HandlerSpec(
    endpoint: 'user_card_sort',
    action: 'set',
    encode: (i) => i.toJson(),
    decode: (raw) =>
        UserCardSortSetOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<CardDeleteInput, CardDeleteOutput>(HandlerSpec(
    endpoint: 'card',
    action: 'delete',
    encode: (i) => i.toJson(),
    decode: (raw) => CardDeleteOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<AttributeDefSelectInput, AttributeDefSelectOutput>(HandlerSpec(
    endpoint: 'attribute_def',
    action: 'select',
    encode: (i) => i.toJson(),
    decode: (raw) =>
        AttributeDefSelectOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<AttributeDefInsertInput, AttributeDefInsertOutput>(HandlerSpec(
    endpoint: 'attribute_def',
    action: 'insert',
    encode: (i) => i.toJson(),
    decode: (raw) =>
        AttributeDefInsertOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<EdgeInsertInput, EdgeInsertOutput>(HandlerSpec(
    endpoint: 'edge',
    action: 'insert',
    encode: (i) => i.toJson(),
    decode: (raw) => EdgeInsertOutput.fromJson(raw as Map<String, dynamic>),
  ));
  r.register<EdgeDeleteInput, EdgeDeleteOutput>(HandlerSpec(
    endpoint: 'edge',
    action: 'delete',
    encode: (i) => i.toJson(),
    decode: (raw) => EdgeDeleteOutput.fromJson(raw as Map<String, dynamic>),
  ));
  registerAdminHandlers(r);
}
