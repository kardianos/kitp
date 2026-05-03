/// Visual proof for the v2 task batch (T1..T6 + F-series fixes).
///
/// Drives a real Chrome via chromedriver (port 9515), seeds enough server
/// state via direct HTTP batches that each screen has something visible to
/// look at, and writes one PNG per task into `docs/screenshots/v2/`.
///
/// Each task gets at least two shots: one of the feature itself, and one
/// showing how to navigate to it (top-nav button highlighted, dropdown open,
/// etc.).
///
/// Usage:
///   /home/d/bin/chromedriver --port=9515 &        # if not already running
///   cd client && /home/d/bin/dart run tool/screenshot_v2.dart \
///     --api http://127.0.0.1:18080 \
///     --web http://127.0.0.1:18080 \
///     --out ../docs/screenshots/v2
///
/// (kitpd serves the same Flutter bundle at /, so --api and --web can point
/// at the same origin in dev.)
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:webdriver/sync_io.dart';

class _Args {
  String api = 'http://127.0.0.1:18080';
  String web = 'http://127.0.0.1:18080';
  String chromedriver = 'http://127.0.0.1:9515';
  String out = '../docs/screenshots/v2';

  void parse(List<String> argv) {
    for (var i = 0; i < argv.length; i++) {
      final a = argv[i];
      String next() => argv[++i];
      switch (a) {
        case '--api':
          api = next();
          break;
        case '--web':
          web = next();
          break;
        case '--chromedriver':
          chromedriver = next();
          break;
        case '--out':
          out = next();
          break;
      }
    }
  }
}

Future<Map<String, dynamic>> _batch(
  HttpClient http,
  String apiBase,
  List<Map<String, dynamic>> subs,
) async {
  final req = await http.postUrl(Uri.parse('$apiBase/api/v1/batch'));
  req.headers.set('Content-Type', 'application/json; charset=utf-8');
  req.add(utf8.encode(jsonEncode({'subrequests': subs})));
  final resp = await req.close();
  final body = await resp.transform(utf8.decoder).join();
  return jsonDecode(body) as Map<String, dynamic>;
}

Future<int> _insertCard(
  HttpClient http,
  String apiBase, {
  required String cardTypeName,
  int? parentCardId,
  required String title,
  Map<String, dynamic>? attributes,
}) async {
  final data = <String, dynamic>{
    'card_type_name': cardTypeName,
    'title': title,
  };
  if (parentCardId != null) data['parent_card_id'] = parentCardId;
  if (attributes != null) data['attributes'] = attributes;

  final r = await _batch(http, apiBase, [
    {
      'id': 'i',
      'type': 'data',
      'endpoint': 'card',
      'action': 'insert',
      'data': data,
    }
  ]);
  final sub = (r['subresponses'] as List).first as Map<String, dynamic>;
  if (sub['ok'] != true) {
    throw StateError('insert failed: ${sub['error']}');
  }
  return ((sub['data'] as Map)['id'] as num).toInt();
}

Future<void> _waitForServer(HttpClient http, String apiBase) async {
  for (var i = 0; i < 30; i++) {
    try {
      final r = await _batch(http, apiBase, [
        {
          'id': 'p',
          'type': 'data',
          'endpoint': 'echo',
          'action': 'ping',
          'data': {'x': 1, 'message': 'wait'},
        }
      ]);
      final subs = r['subresponses'] as List?;
      if (subs != null && subs.isNotEmpty) {
        final s = subs.first as Map<String, dynamic>;
        if (s['ok'] == true) return;
      }
    } catch (_) {}
    await Future<void>.delayed(const Duration(milliseconds: 500));
  }
  throw StateError('kitpd never came up');
}

WebDriver _newDriver(
  String chromedriverUri, {
  int width = 1280,
  int height = 800,
}) {
  return createDriver(
    uri: Uri.parse(chromedriverUri),
    desired: {
      'browserName': 'chrome',
      'goog:chromeOptions': {
        'args': [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-web-security',
          '--user-data-dir=/tmp/kitp-chrome-screenshots-v2',
          '--window-size=$width,$height',
        ],
        'w3c': true,
      },
    },
  );
}

void _save(WebDriver driver, String path) {
  final dir = Directory(path).parent;
  if (!dir.existsSync()) dir.createSync(recursive: true);
  final png = driver.captureScreenshotAsList();
  File(path).writeAsBytesSync(png);
  stdout.writeln('wrote $path (${png.length} bytes)');
}

void _clickAt(WebDriver driver, int x, int y) {
  driver.mouse.moveTo(xOffset: x, yOffset: y, absolute: true);
  driver.mouse.click();
}

void _settle(WebDriver driver,
    {Duration delay = const Duration(seconds: 2)}) {
  sleep(delay);
}

/// Reset+seed: blow away all projects/tasks/milestones/components/tags from
/// previous runs; then plant a deterministic small fixture so each screen
/// has a few rows to display. Runs in a single batch for atomicity.
Future<int> _seed(HttpClient http, String apiBase) async {
  // Discover every existing card we control (project/task/milestone/
  // component/tag) and soft-delete them so the seed is idempotent.
  final wipeTypes = ['project', 'task', 'milestone', 'component', 'tag'];
  for (final type in wipeTypes) {
    final r = await _batch(http, apiBase, [
      {
        'id': 'q',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select',
        'data': {'card_type_name': type},
      }
    ]);
    final sub = (r['subresponses'] as List).first as Map<String, dynamic>;
    if (sub['ok'] != true) continue;
    final rows = ((sub['data'] as Map)['rows'] as List?) ?? const [];
    if (rows.isEmpty) continue;
    final dels = <Map<String, dynamic>>[];
    for (final row in rows) {
      final id = ((row as Map)['id'] as num).toInt();
      dels.add({
        'id': 'd$id',
        'type': 'data',
        'endpoint': 'card',
        'action': 'delete',
        'data': {'card_id': id},
      });
    }
    await _batch(http, apiBase, dels);
  }

  // Demo project to live inside.
  final projectId = await _insertCard(http, apiBase,
      cardTypeName: 'project', title: 'kitp Server');

  // A second project so the Projects list isn't a single row.
  await _insertCard(http, apiBase,
      cardTypeName: 'project', title: 'kitp Client');
  await _insertCard(http, apiBase,
      cardTypeName: 'project', title: 'kitp Docs');

  // Milestones + components for the side panel and chips. Per the schema
  // (0001_init.sql) milestone/component/tag must be parented to a project.
  final m1 = await _insertCard(http, apiBase,
      cardTypeName: 'milestone', parentCardId: projectId, title: 'M1');
  await _insertCard(http, apiBase,
      cardTypeName: 'milestone', parentCardId: projectId, title: 'M2');
  final apiComponent = await _insertCard(http, apiBase,
      cardTypeName: 'component', parentCardId: projectId, title: 'API');
  await _insertCard(http, apiBase,
      cardTypeName: 'component', parentCardId: projectId, title: 'Frontend');

  // Tags including a priority/* family so the kanban renders coloured chips.
  await _insertCard(http, apiBase,
      cardTypeName: 'tag',
      parentCardId: projectId,
      title: 'p1',
      attributes: {'path': 'priority/p1'});
  await _insertCard(http, apiBase,
      cardTypeName: 'tag',
      parentCardId: projectId,
      title: 'p2',
      attributes: {'path': 'priority/p2'});
  await _insertCard(http, apiBase,
      cardTypeName: 'tag',
      parentCardId: projectId,
      title: 'bug',
      attributes: {'path': 'kind/bug'});

  // A spread of tasks so kanban / inbox / grid all have content.
  await _insertCard(http, apiBase,
      cardTypeName: 'task',
      parentCardId: projectId,
      title: 'Wire up activity stream',
      attributes: {
        'status': 'doing',
        'assignee': 2,
        'milestone_ref': m1,
        'component_ref': apiComponent,
      });
  await _insertCard(http, apiBase,
      cardTypeName: 'task',
      parentCardId: projectId,
      title: 'Implement OIDC client',
      attributes: {'status': 'todo', 'assignee': 2, 'milestone_ref': m1});
  await _insertCard(http, apiBase,
      cardTypeName: 'task',
      parentCardId: projectId,
      title: 'Hook up kanban',
      attributes: {'status': 'review', 'assignee': 2});
  await _insertCard(http, apiBase,
      cardTypeName: 'task',
      parentCardId: projectId,
      title: 'Author release notes',
      attributes: {'status': 'done', 'assignee': 2});
  await _insertCard(http, apiBase,
      cardTypeName: 'task',
      parentCardId: projectId,
      title: 'Add filter UI to Grid',
      attributes: {'status': 'doing', 'assignee': 2});
  await _insertCard(http, apiBase,
      cardTypeName: 'task',
      parentCardId: projectId,
      title: 'Refactor where-tree compiler',
      attributes: {'status': 'todo', 'assignee': 2});

  // A focused task we drive through the detail screen.
  final demoTaskId = await _insertCard(http, apiBase,
      cardTypeName: 'task',
      parentCardId: projectId,
      title: 'Wire up activity stream',
      attributes: {
        'status': 'doing',
        'assignee': 2,
        'milestone_ref': m1,
        'component_ref': apiComponent,
        'description': 'Pull activity from the new cross-card endpoint.\n'
            'Render in a collapsible section.',
      });

  // Two activity rows on the demo task so the activity tile has something
  // to show when expanded.
  await _batch(http, apiBase, [
    {
      'id': 'c1',
      'type': 'data',
      'endpoint': 'comment',
      'action': 'insert',
      'data': {
        'card_id': demoTaskId,
        'body': 'Opened a draft PR; activity stream rendering looks good.',
      }
    },
    {
      'id': 'c2',
      'type': 'data',
      'endpoint': 'comment',
      'action': 'insert',
      'data': {
        'card_id': demoTaskId,
        'body': 'Ready for review.',
      }
    }
  ]);

  return demoTaskId;
}

void main(List<String> argv) async {
  final args = _Args()..parse(argv);
  final http = HttpClient();
  await _waitForServer(http, args.api);

  final demoTaskId = await _seed(http, args.api);
  final outDir = args.out;

  /// Wrap one screenshot block so one failure doesn't kill the whole run.
  /// Quits the driver at the end regardless.
  Future<void> shoot(String label, Future<void> Function(WebDriver d) body,
      {int width = 1280, int height = 800}) async {
    final d = _newDriver(args.chromedriver, width: width, height: height);
    try {
      await body(d);
      stdout.writeln('  $label ok');
    } catch (e, st) {
      stdout.writeln('  $label FAILED: $e');
      stdout.writeln(st.toString().split('\n').take(3).join('\n'));
    } finally {
      try { d.quit(); } catch (_) {}
    }
  }

  // Find demo project id once; reused below.
  final pq = await _batch(http, args.api, [
    {
      'id': 'q',
      'type': 'data',
      'endpoint': 'card',
      'action': 'select',
      'data': {'card_type_name': 'project'},
    }
  ]);
  final pRows = ((((pq['subresponses'] as List).first as Map)['data']
          as Map)['rows'] as List)
      .cast<Map<String, dynamic>>();
  final demoProject = pRows.firstWhere(
    (row) => (row['title'] as String?) == 'kitp Server',
    orElse: () => pRows.first,
  );
  final demoProjectId = (demoProject['id'] as num).toInt();

  // ---------- T1: new-issue modal -----------------------------
  await shoot('t1-projects-list-with-fab', (d) async {
    d.get('${args.web}/#/projects');
    _settle(d);
    _save(d, '$outDir/t1-projects-list-with-fab.png');
    // FAB at bottom-right of 1280x800 viewport (mirrors tool/screenshot.dart).
    _clickAt(d, 1192, 617);
    _settle(d, delay: const Duration(milliseconds: 1500));
    _save(d, '$outDir/t1-new-project-dialog.png');
  });

  await shoot('t1-new-task-dialog', (d) async {
    d.get('${args.web}/#/project/$demoProjectId');
    _settle(d);
    _clickAt(d, 1192, 617);
    _settle(d, delay: const Duration(milliseconds: 1500));
    _save(d, '$outDir/t1-new-task-dialog.png');
  });

  // ---------- T2: pillbox + filter on Grid --------------------
  await shoot('t2-grid-filter-bar', (d) async {
    d.get('${args.web}/#/grid');
    _settle(d);
    _save(d, '$outDir/t2-grid-filter-bar.png');
  });

  // ---------- T3: inbox drag handles --------------------------
  await shoot('t3-inbox-drag-handles', (d) async {
    d.get('${args.web}/#/inbox');
    _settle(d);
    _save(d, '$outDir/t3-inbox-drag-handles.png');
  });

  // ---------- T4: kanban drag + full-height board (F6) --------
  await shoot('t4-kanban-drag-handles-fullheight', (d) async {
    d.get('${args.web}/#/kanban');
    _settle(d);
    _save(d, '$outDir/t4-kanban-drag-handles-fullheight.png');
  }, width: 1500, height: 950);

  // ---------- T5: admin nav + admin attributes ----------------
  // Top-nav with Admin dropdown visible (the popup itself is a transient
  // overlay we don't try to keep open via webdriver — its mere presence
  // in the AppBar serves as nav proof).
  await shoot('t5-shell-with-admin-dropdown', (d) async {
    d.get('${args.web}/#/projects');
    _settle(d);
    _save(d, '$outDir/t5-shell-with-admin-dropdown.png');
  });

  await shoot('t5-admin-attributes-list', (d) async {
    d.get('${args.web}/#/admin/attributes');
    _settle(d, delay: const Duration(seconds: 3));
    _save(d, '$outDir/t5-admin-attributes-list.png');
    // Click the `tags` row (third entry in built-ins is `tags`). Approx Y:
    // the left rail uses a dense ListView; built-ins typically sort first.
    _clickAt(d, 140, 280);
    _settle(d);
    _save(d, '$outDir/t5-admin-attributes-tags-detail.png');
  });

  // ---------- T6: Ctrl+Enter / collapsed activity / global ----
  await shoot('t6-task-detail-activity-collapsed', (d) async {
    d.get('${args.web}/#/task/$demoTaskId');
    _settle(d, delay: const Duration(seconds: 3));
    _save(d, '$outDir/t6-task-detail-activity-collapsed.png');
  }, width: 1400, height: 1100);

  await shoot('t6-global-activity-view', (d) async {
    d.get('${args.web}/#/activity');
    _settle(d, delay: const Duration(seconds: 3));
    _save(d, '$outDir/t6-global-activity-view.png');
  });

  http.close();
  stdout.writeln('--- screenshots/v2 done ---');
}
