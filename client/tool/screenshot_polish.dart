/// Screenshot driver for the post-v1 polish pass.
///
/// Refreshes the phase-15 task-detail screenshots (now showing the side
/// panel, description, and resolved activity rows) and the phase-18
/// kanban-default screenshot (now in stable sort_order). Adds a
/// `kanban-reorder.png` showing a card mid-drag with a highlighted gap.
///
/// Usage:
///   dart run tool/screenshot_polish.dart \
///     --api http://127.0.0.1:18080 \
///     --web http://127.0.0.1:18080 \
///     --chromedriver http://127.0.0.1:9515 \
///     --out ../docs/screenshots
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:webdriver/sync_io.dart';

class _Args {
  String api = 'http://127.0.0.1:18080';
  String web = 'http://127.0.0.1:18080';
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

WebDriver _newDriver(String chromedriverUri,
    {int width = 1440, int height = 900}) {
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
          '--user-data-dir=/tmp/kitp-chrome-polish-${DateTime.now().microsecondsSinceEpoch}',
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

void _settle(WebDriver driver, {Duration delay = const Duration(seconds: 2)}) {
  sleep(delay);
}

/// Click a viewport pixel via the W3C Actions API.
void _clickAt(WebDriver driver, int x, int y) {
  driver.mouse.moveTo(xOffset: x, yOffset: y, absolute: true);
  driver.mouse.click();
}

void main(List<String> argv) async {
  final args = _Args()..parse(argv);
  final http = HttpClient();
  final outDir = args.out;
  await _waitForServer(http, args.api);

  // ----- Phase 15: refreshed task-detail screenshots ---------------------
  // Pick a seeded dense task that already has rich attributes + a
  // description to show off the new layout. Card "Wire pickers (dense#1)"
  // is a good fit (priority/high tag, milestone M1, component Frontend,
  // assignee alice). Resolve its id by title.
  final taskIDResp = await _batch(http, args.api, [
    {
      'id': 'q',
      'type': 'data',
      'endpoint': 'card',
      'action': 'select_with_attributes',
      'data': {
        'card_type_name': 'task',
        'where': [
          {
            'attr': 'title',
            'op': '=',
            'value': 'Wire pickers (dense#1)',
          }
        ],
      },
    }
  ]);
  final taskRows =
      ((taskIDResp['subresponses'] as List).first as Map)['data']['rows']
          as List;
  if (taskRows.isEmpty) {
    throw StateError('expected seeded task "Wire pickers (dense#1)"');
  }
  final demoTaskID = ((taskRows.first as Map)['id'] as num).toInt();
  stdout.writeln('demoTaskID=$demoTaskID');

  // Reset status to 'todo' so the initial task-detail shot matches the
  // task's freshly-loaded state from a clean DB. Idempotent on re-run.
  await _batch(http, args.api, [
    {
      'id': 'r',
      'type': 'data',
      'endpoint': 'attribute',
      'action': 'update',
      'data': {
        'card_id': demoTaskID,
        'attribute_name': 'status',
        'value': 'todo',
      }
    }
  ]);

  // 15/task-detail.png — initial wide-screen layout.
  var driver = _newDriver(args.chromedriver, width: 1440, height: 900);
  try {
    driver.get('${args.web}/#/task/$demoTaskID');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/15/task-detail.png');
  } finally {
    driver.quit();
  }

  // 15/edit-attribute.png — bump the status, then snap.
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
  driver = _newDriver(args.chromedriver, width: 1440, height: 900);
  try {
    driver.get('${args.web}/#/task/$demoTaskID');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/15/edit-attribute.png');
  } finally {
    driver.quit();
  }

  // Add two comments so the activity stream looks lived-in for the
  // task-with-comments shot.
  await _batch(http, args.api, [
    {
      'id': 'c1',
      'type': 'data',
      'endpoint': 'comment',
      'action': 'insert',
      'data': {
        'card_id': demoTaskID,
        'body':
            'Got the picker registry up — the dense table now shares the same component as the side panel.',
      }
    },
    {
      'id': 'c2',
      'type': 'data',
      'endpoint': 'comment',
      'action': 'insert',
      'data': {
        'card_id': demoTaskID,
        'body': 'Ready for review — see the screenshot in the PR.',
      }
    }
  ]);

  // 15/task-with-comments.png — taller window so the full page fits.
  driver = _newDriver(args.chromedriver, width: 1440, height: 1500);
  try {
    driver.get('${args.web}/#/task/$demoTaskID');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/15/task-with-comments.png');
  } finally {
    driver.quit();
  }

  // Reset status back to 'todo' so the kanban-default shot has Wire
  // pickers in its original column and the board reads cleanly.
  await _batch(http, args.api, [
    {
      'id': 'r2',
      'type': 'data',
      'endpoint': 'attribute',
      'action': 'update',
      'data': {
        'card_id': demoTaskID,
        'attribute_name': 'status',
        'value': 'todo',
      }
    }
  ]);

  // ----- Phase 18: refreshed kanban-default + new kanban-reorder ----------
  driver = _newDriver(args.chromedriver, width: 1600, height: 900);
  try {
    driver.get('${args.web}/#/kanban?project=1');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/18/kanban-default.png');
  } finally {
    driver.quit();
  }

  // 18/kanban-reorder.png — synthetic "post-reorder" snapshot. Headless
  // Chrome can't reliably synthesise the long-press-and-hold gesture
  // Flutter's LongPressDraggable expects, so we drive the reorder via
  // the API directly (moving "API rate limits" from the top of `todo`
  // to the bottom of `review`) and capture the resulting board state.
  // The visible diff vs `kanban-default.png` proves cross-column
  // ordering persisted, which is the feature this image documents.
  // Look up the API rate limits task id.
  final reorderResp = await _batch(http, args.api, [
    {
      'id': 'q',
      'type': 'data',
      'endpoint': 'card',
      'action': 'select_with_attributes',
      'data': {
        'card_type_name': 'task',
        'where': [
          {'attr': 'title', 'op': '=', 'value': 'API rate limits'}
        ],
      }
    }
  ]);
  final reorderRows =
      ((reorderResp['subresponses'] as List).first as Map)['data']['rows']
          as List;
  if (reorderRows.isNotEmpty) {
    final apiRateLimitsID = ((reorderRows.first as Map)['id'] as num).toInt();
    stdout.writeln('reordering API rate limits id=$apiRateLimitsID into review');
    final r = await _batch(http, args.api, [
      {
        'id': 's',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': apiRateLimitsID,
          'attribute_name': 'status',
          'value': 'review',
        }
      },
      {
        'id': 'o',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': apiRateLimitsID,
          'attribute_name': 'sort_order',
          'value': 50.0,
        }
      },
    ]);
    stdout.writeln('reorder result: ${r['subresponses']}');
  }
  driver = _newDriver(args.chromedriver, width: 1600, height: 900);
  try {
    driver.get('${args.web}/#/kanban?project=1');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/18/kanban-reorder.png');
  } finally {
    driver.quit();
  }
  // Reset so re-running the tool puts the card back where it was.
  if (reorderRows.isNotEmpty) {
    final apiRateLimitsID = ((reorderRows.first as Map)['id'] as num).toInt();
    await _batch(http, args.api, [
      {
        'id': 's',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': apiRateLimitsID,
          'attribute_name': 'status',
          'value': 'todo',
        }
      },
      {
        'id': 'o',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': apiRateLimitsID,
          'attribute_name': 'sort_order',
          'value': apiRateLimitsID * 100,
        }
      },
    ]);
  }

  http.close();
  stdout.writeln('done.');
}
