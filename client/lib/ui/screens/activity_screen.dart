/// ActivityScreen — global cross-card activity stream.
///
/// Dispatcher contract:
///   - On entry we issue ONE batch with three sub-requests:
///       1. activity.select with no card_id (cross-card mode — the server
///          returns rows from every card the actor can see, newest-first).
///       2. user.select for actor name resolution.
///       3. card.select_with_attributes for tag cards (so tag-apply rows
///          render path strings rather than raw ids). Plus a parallel
///          fetch for milestones and components for similar reasons. The
///          per-screen Wave-1 task-detail screen does the same thing.
///     The dispatcher coalesces all of them into ONE HTTP call (N-CLI-2).
///   - Each row resolves the target card title via a separate fetch of
///     every card referenced by the activity rows; we issue this as a
///     follow-up batch to avoid blowing up the initial batch with one
///     `card.select_with_attributes` per id. Title fetch failures fall
///     back to "Card #id" so a single missing card doesn't break the row.
///   - Tapping a row routes to /task/:id.
library;

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app.dart';
import '../../dispatch/errors.dart';
import '../../reg/handlers.dart';
import '../widgets/activity_row.dart';

class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  List<ActivityRow> _rows = [];
  Map<int, String> _userNames = {};
  Map<int, String> _milestoneTitles = {};
  Map<int, String> _componentTitles = {};
  Map<int, String> _tagPaths = {};
  Map<int, String> _cardTitles = {};
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

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final dispatcher = KitpApp.dispatcherOf(context);

    final fActivity = dispatcher.request<ActivitySelectInput, ActivitySelectOutput>(
      endpoint: 'activity',
      action: 'select',
      data: const ActivitySelectInput(limit: 200),
    );
    final fUsers = dispatcher.request<UserSelectInput, UserSelectOutput>(
      endpoint: 'user',
      action: 'select',
      data: const UserSelectInput(),
    );
    final fMilestones = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: const CardSelectWithAttributesInput(cardTypeName: 'milestone'),
    );
    final fComponents = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: const CardSelectWithAttributesInput(cardTypeName: 'component'),
    );
    final fTags = dispatcher
        .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
      endpoint: 'card',
      action: 'select_with_attributes',
      data: const CardSelectWithAttributesInput(cardTypeName: 'tag'),
    );

    try {
      final results = await Future.wait([
        fActivity,
        fUsers,
        fMilestones,
        fComponents,
        fTags,
      ]);
      final actOut = results[0] as ActivitySelectOutput;
      final usersOut = results[1] as UserSelectOutput;
      final mOut = results[2] as CardSelectWithAttributesOutput;
      final cOut = results[3] as CardSelectWithAttributesOutput;
      final tOut = results[4] as CardSelectWithAttributesOutput;

      // Card titles: ask the server for every distinct card_id touched
      // by the activity rows, in one follow-up batch. We use card.select
      // (title-only) since attributes aren't needed for the row label.
      final cardIds = <int>{
        for (final r in actOut.rows)
          if (r.cardId != 0) r.cardId,
      };
      final titles = <int, String>{};
      if (cardIds.isNotEmpty) {
        // The server's card.select doesn't take an id list, so we settle
        // for fetching tasks + projects (the two card_types this screen
        // is most likely to link to) and harvesting titles. Anything not
        // in the result falls back to "Card #id" at render time.
        final fTaskRows = dispatcher
            .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
          endpoint: 'card',
          action: 'select_with_attributes',
          data: const CardSelectWithAttributesInput(cardTypeName: 'task'),
        );
        final fProjRows = dispatcher
            .request<CardSelectWithAttributesInput, CardSelectWithAttributesOutput>(
          endpoint: 'card',
          action: 'select_with_attributes',
          data: const CardSelectWithAttributesInput(cardTypeName: 'project'),
        );
        final cardResults = await Future.wait([fTaskRows, fProjRows]);
        for (final co in cardResults) {
          for (final row in co.rows) {
            final t = row.title;
            if (t != null) titles[row.id] = t;
          }
        }
        // Milestones / components / tags also surface as cards — pick up
        // their titles too so non-task activity has a useful label.
        for (final m in mOut.rows) {
          final t = m.title;
          if (t != null) titles[m.id] = t;
        }
        for (final c in cOut.rows) {
          final t = c.title;
          if (t != null) titles[c.id] = t;
        }
        for (final tag in tOut.rows) {
          final p = tag.attributes['path'];
          if (p is String) {
            titles[tag.id] = p;
          } else {
            final t = tag.title;
            if (t != null) titles[tag.id] = t;
          }
        }
      }

      if (!mounted) return;
      setState(() {
        _rows = actOut.rows;
        _userNames = {for (final u in usersOut.rows) u.id: u.displayName};
        _milestoneTitles = {
          for (final m in mOut.rows)
            if (m.title != null) m.id: m.title!,
        };
        _componentTitles = {
          for (final c in cOut.rows)
            if (c.title != null) c.id: c.title!,
        };
        _tagPaths = {
          for (final t in tOut.rows)
            if (t.attributes['path'] is String)
              t.id: t.attributes['path'] as String,
        };
        _cardTitles = titles;
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

  RefMaps get _refMaps => RefMaps(
        users: _userNames,
        milestones: _milestoneTitles,
        components: _componentTitles,
        tags: _tagPaths,
        cards: _cardTitles,
      );

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: _buildBody(context),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading && _rows.isEmpty) {
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
                'Failed to load activity: ${_error!}',
                key: const Key('activity-error'),
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
    if (_rows.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'No activity yet.',
            key: Key('activity-empty'),
            style: TextStyle(fontSize: 16),
          ),
        ),
      );
    }
    return ListView.separated(
      key: const Key('activity-list'),
      padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 16),
      itemCount: _rows.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final row = _rows[i];
        final cardLabel = _cardTitles[row.cardId] ?? 'Card #${row.cardId}';
        return InkWell(
          key: Key('activity-row-${row.id}'),
          onTap: row.cardId == 0
              ? null
              : () => context.go('/task/${row.cardId}'),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Per-row card link rendered as a header above the existing
                // ActivityRowView body. Blue + underline so it reads as a
                // clickable link even though the whole row is tappable.
                Text(
                  cardLabel,
                  key: Key('activity-card-link-${row.id}'),
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.primary,
                    fontWeight: FontWeight.w600,
                    decoration: TextDecoration.underline,
                  ),
                ),
                ActivityRowView(row: row, refs: _refMaps),
              ],
            ),
          ),
        );
      },
    );
  }
}
