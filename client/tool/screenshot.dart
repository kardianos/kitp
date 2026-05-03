/// Screenshot driver for Phases 13-15.
///
/// Drives a real Chrome via chromedriver (port 9515 by default) and the
/// `package:webdriver/sync_io.dart` API. Each phase block in `main()` resets
/// server state via direct HTTP POST batches, navigates the Flutter app to
/// the relevant URL, and writes a PNG out to `docs/screenshots/<phase>/`.
///
/// Usage:
///   dart run tool/screenshot.dart \
///     --api http://127.0.0.1:18080 \
///     --web http://127.0.0.1:18091 \
///     --chromedriver http://127.0.0.1:9515 \
///     --out ../docs/screenshots
///
/// chromedriver must already be running. Start it with:
///   /home/d/bin/chromedriver --port=9515
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:webdriver/sync_io.dart';

class _Args {
  String api = 'http://127.0.0.1:18080';
  String web = 'http://127.0.0.1:18091';
  String chromedriver = 'http://127.0.0.1:9515';
  String out = '../docs/screenshots';

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

/// Submit one batch via raw HTTP and return the parsed JSON. We encode the
/// body explicitly as UTF-8 so non-ASCII characters (em-dashes in comment
/// bodies, etc.) survive the trip without IOSink choking on Latin-1.
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

/// Convenience: insert a card and return its new id.
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

/// Wait until kitpd is reachable. We poll /api/v1/batch with echo.ping.
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
    } catch (_) {
      // not yet ready
    }
    await Future<void>.delayed(const Duration(milliseconds: 500));
  }
  throw StateError('kitpd never came up');
}

WebDriver _newDriver(String chromedriverUri, {int width = 1280, int height = 800}) {
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
          '--user-data-dir=/tmp/kitp-chrome-screenshots',
          '--window-size=$width,$height',
        ],
        'w3c': true,
      },
    },
  );
}

Future<void> _save(WebDriver driver, String path) async {
  final dir = Directory(path).parent;
  if (!dir.existsSync()) dir.createSync(recursive: true);
  final png = driver.captureScreenshotAsList();
  File(path).writeAsBytesSync(png);
  stdout.writeln('wrote $path (${png.length} bytes)');
}

/// Click the viewport at (x, y). Flutter web's CanvasKit renderer doesn't
/// publish DOM semantics nodes by default, so we drive interaction through
/// the W3C Actions API at known pixel coordinates.
void _clickAt(WebDriver driver, int x, int y) {
  driver.mouse.moveTo(xOffset: x, yOffset: y, absolute: true);
  driver.mouse.click();
}

void _settle(WebDriver driver, {Duration delay = const Duration(seconds: 2)}) {
  // Flutter has no DOMContentLoaded equivalent we can hook from outside, so
  // we just sleep for `delay` after every navigation. Two seconds is plenty
  // for the dispatcher to fire and the build to settle on a local DB.
  sleep(delay);
}

void main(List<String> argv) async {
  final args = _Args()..parse(argv);
  final http = HttpClient();
  final outDir = args.out;

  // ---------------------------------------------------------------------
  // PHASE 13: empty list -> populated list -> create dialog open.
  // ---------------------------------------------------------------------
  await _waitForServer(http, args.api);

  // Empty list: soft-delete every project (we only have the seeded Default
  // Project at this point) so the screen renders the empty state.
  final existing = await _batch(http, args.api, [
    {
      'id': 'q',
      'type': 'data',
      'endpoint': 'card',
      'action': 'select',
      'data': {'card_type_name': 'project'},
    }
  ]);
  final qSub = (existing['subresponses'] as List).first as Map<String, dynamic>;
  if (qSub['ok'] == true) {
    final rows = ((qSub['data'] as Map)['rows'] as List?) ?? const [];
    final dels = <Map<String, dynamic>>[];
    for (final r in rows) {
      final id = ((r as Map)['id'] as num).toInt();
      dels.add({
        'id': 'd$id',
        'type': 'data',
        'endpoint': 'card',
        'action': 'delete',
        'data': {'card_id': id},
      });
    }
    if (dels.isNotEmpty) await _batch(http, args.api, dels);
  }

  // Open Chrome and snap the empty list.
  var driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/projects');
    _settle(driver);
    await _save(driver, '$outDir/13/list-empty.png');

    // Create-project dialog. The FAB is rendered by Flutter onto the
    // canvas, so we can't query a DOM element — instead we click the
    // viewport at the FAB's known position (bottom-right corner).
    _clickAt(driver, 1192, 617);
    _settle(driver, delay: const Duration(milliseconds: 1500));
    await _save(driver, '$outDir/13/create-dialog.png');

    // Close the dialog by clicking outside it.
    _clickAt(driver, 50, 100);
    _settle(driver);
  } finally {
    driver.quit();
  }

  // Populate: undelete every soft-deleted project + create three more so
  // the list looks lived-in.
  if (qSub['ok'] == true) {
    final rows = ((qSub['data'] as Map)['rows'] as List?) ?? const [];
    final ups = <Map<String, dynamic>>[];
    for (final r in rows) {
      final id = ((r as Map)['id'] as num).toInt();
      ups.add({
        'id': 'u$id',
        'type': 'data',
        'endpoint': 'card',
        'action': 'undelete',
        'data': {'card_id': id},
      });
    }
    if (ups.isNotEmpty) await _batch(http, args.api, ups);
  }
  await _insertCard(http, args.api,
      cardTypeName: 'project', title: 'kitp Server');
  await _insertCard(http, args.api,
      cardTypeName: 'project', title: 'kitp Client');
  await _insertCard(http, args.api,
      cardTypeName: 'project', title: 'kitp Docs');

  driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/projects');
    _settle(driver);
    await _save(driver, '$outDir/13/list-with-projects.png');
  } finally {
    driver.quit();
  }

  // ---------------------------------------------------------------------
  // PHASE 14: project detail empty -> populated -> new task dialog.
  // ---------------------------------------------------------------------
  // Use the seeded Default Project (id=1) for the empty-state shot.
  driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/project/1');
    _settle(driver);
    await _save(driver, '$outDir/14/project-empty.png');
  } finally {
    driver.quit();
  }

  // Insert a few tasks into the Default Project (id=1).
  await _insertCard(http, args.api,
      cardTypeName: 'task',
      parentCardId: 1,
      title: 'Implement OIDC client',
      attributes: {'status': 'doing', 'assignee': 2});
  await _insertCard(http, args.api,
      cardTypeName: 'task',
      parentCardId: 1,
      title: 'Migrate to webdriver tests',
      attributes: {'status': 'todo', 'assignee': 3});
  await _insertCard(http, args.api,
      cardTypeName: 'task',
      parentCardId: 1,
      title: 'Hook up kanban',
      attributes: {'status': 'review', 'assignee': 4});
  await _insertCard(http, args.api,
      cardTypeName: 'task',
      parentCardId: 1,
      title: 'Author release notes',
      attributes: {'status': 'done', 'assignee': 5});

  driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/project/1');
    _settle(driver);
    await _save(driver, '$outDir/14/project-with-tasks.png');

    // Open the New Task dialog by clicking the FAB.
    _clickAt(driver, 1192, 617);
    _settle(driver, delay: const Duration(milliseconds: 1500));
    await _save(driver, '$outDir/14/new-task.png');
  } finally {
    driver.quit();
  }

  // ---------------------------------------------------------------------
  // PHASE 15: task detail with rich data -> after edit -> with comments.
  // ---------------------------------------------------------------------
  // Create one richly-populated task we can drive through the lifecycle.
  // milestone_ref / component_ref point at seeded cards (M1 -> id 2,
  // Backend -> id 6 in our seeded order).
  final demoTaskID = await _insertCard(
    http,
    args.api,
    cardTypeName: 'task',
    parentCardId: 1,
    title: 'Wire up activity stream',
    attributes: {
      'status': 'doing',
      'assignee': 2,
      'milestone_ref': 2,
      'component_ref': 6,
    },
  );

  // Apply a couple of tags so the detail screen has chips to render.
  await _batch(http, args.api, [
    {
      'id': 'a1',
      'type': 'data',
      'endpoint': 'tag',
      'action': 'apply',
      'data': {'target_card_id': demoTaskID, 'tag_card_id': 10},
    },
    {
      'id': 'a2',
      'type': 'data',
      'endpoint': 'tag',
      'action': 'apply',
      'data': {'target_card_id': demoTaskID, 'tag_card_id': 13},
    }
  ]);

  driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/task/$demoTaskID');
    _settle(driver);
    await _save(driver, '$outDir/15/task-detail.png');

  } finally {
    driver.quit();
  }

  // Edit attribute: bump status to 'review', then re-mount Chrome so the
  // hash-routed Flutter app actually re-bootstraps and pulls the new state.
  await _batch(http, args.api, [
    {
      'id': 'u',
      'type': 'data',
      'endpoint': 'attribute',
      'action': 'update',
      'data': {
        'card_id': demoTaskID,
        'attribute_name': 'status',
        'value': 'review',
      }
    }
  ]);
  driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/task/$demoTaskID');
    _settle(driver);
    await _save(driver, '$outDir/15/edit-attribute.png');
  } finally {
    driver.quit();
  }

  // Add a couple of comments, then re-mount Chrome and capture the comment
  // stream.
  await _batch(http, args.api, [
    {
      'id': 'c1',
      'type': 'data',
      'endpoint': 'comment',
      'action': 'insert',
      'data': {
        'card_id': demoTaskID,
        'body': 'PR opened. Activity stream rendering looks promising.',
      }
    },
    {
      'id': 'c2',
      'type': 'data',
      'endpoint': 'comment',
      'action': 'insert',
      'data': {
        'card_id': demoTaskID,
        'body': 'Ready for review.',
      }
    }
  ]);
  // Use a taller viewport so the activity stream + comments fit on a
  // single PNG. Flutter's canvas-based scrolling doesn't honour the host
  // browser's scrollbar, so the simplest path is just to make the window
  // taller for this one shot.
  driver = _newDriver(args.chromedriver, width: 1280, height: 1500);
  try {
    driver.get('${args.web}/#/task/$demoTaskID');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/15/task-with-comments.png');
  } finally {
    driver.quit();
  }

  http.close();
  stdout.writeln('done.');
}
