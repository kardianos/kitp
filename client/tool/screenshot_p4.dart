/// Screenshot driver for Phases 16-18.
///
/// Captures the inbox, grid, and kanban screens against a real Chrome
/// driven by chromedriver. Mirrors the patterns established in
/// `tool/screenshot.dart` from Phases 13-15.
///
/// Usage:
///   dart run tool/screenshot_p4.dart \
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
          '--user-data-dir=/tmp/kitp-chrome-screenshots-p4',
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

void _settle(WebDriver driver,
    {Duration delay = const Duration(seconds: 2)}) {
  sleep(delay);
}

void main(List<String> argv) async {
  final args = _Args()..parse(argv);
  final http = HttpClient();
  final outDir = args.out;

  await _waitForServer(http, args.api);

  // -------------------------------------------------------------------
  // PHASE 16: inbox-empty (delete every alice task -> snap) and
  //           inbox-populated (restore them -> snap).
  // -------------------------------------------------------------------
  // Step 1: gather every task assigned to alice (id=2) so we know which
  // ids to soft-delete.
  final aliceQ = await _batch(http, args.api, [
    {
      'id': 'q',
      'type': 'data',
      'endpoint': 'card',
      'action': 'select_with_attributes',
      'data': {
        'card_type_name': 'task',
        'where': [
          {'attr': 'assignee', 'op': '=', 'value': 2},
        ],
      },
    }
  ]);
  final aliceRows = (((aliceQ['subresponses'] as List).first as Map)['data']
      as Map)['rows'] as List;
  final aliceIds = [for (final r in aliceRows) ((r as Map)['id'] as num).toInt()];

  // Soft-delete alice's tasks for the empty shot.
  if (aliceIds.isNotEmpty) {
    final dels = [
      for (final id in aliceIds)
        {
          'id': 'd$id',
          'type': 'data',
          'endpoint': 'card',
          'action': 'delete',
          'data': {'card_id': id},
        }
    ];
    await _batch(http, args.api, dels);
  }

  // 16a: inbox-empty.
  var driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/inbox');
    _settle(driver);
    await _save(driver, '$outDir/16/inbox-empty.png');
  } finally {
    driver.quit();
  }

  // Restore alice's tasks for the populated shot.
  if (aliceIds.isNotEmpty) {
    final ups = [
      for (final id in aliceIds)
        {
          'id': 'u$id',
          'type': 'data',
          'endpoint': 'card',
          'action': 'undelete',
          'data': {'card_id': id},
        }
    ];
    await _batch(http, args.api, ups);
  }

  driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/inbox');
    _settle(driver);
    await _save(driver, '$outDir/16/inbox-populated.png');
  } finally {
    driver.quit();
  }

  // -------------------------------------------------------------------
  // PHASE 17: grid views.
  // -------------------------------------------------------------------
  // 17a: grid-default — every task, default order, every status enabled.
  driver = _newDriver(args.chromedriver, width: 1600, height: 900);
  try {
    driver.get('${args.web}/#/grid?project=1');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/17/grid-default.png');
  } finally {
    driver.quit();
  }

  // 17b: grid-sorted — click the Status header to sort the rows
  // alphabetically (doing < done < review < todo). The screenshot
  // demonstrates the sort UI: the active column shows an up-arrow next
  // to its label.
  //
  // Flutter web on CanvasKit doesn't surface DOM nodes for individual
  // headers, so we click at the header's known x offset (computed from
  // the column widths in grid_screen.dart):
  //   left-rail(220) + body-padding(16) + id(60) + title(320)
  //                  + status-cell-midpoint(50) = 666.
  // Header row vertical centre ≈ 165 (under AppBar + filter wrap).
  driver = _newDriver(args.chromedriver, width: 1600, height: 900);
  try {
    driver.get('${args.web}/#/grid?project=1');
    _settle(driver, delay: const Duration(seconds: 3));
    driver.mouse.moveTo(xOffset: 16 + 220 + 60 + 320 + 50, yOffset: 165, absolute: true);
    driver.mouse.click();
    _settle(driver, delay: const Duration(seconds: 2));
    await _save(driver, '$outDir/17/grid-sorted.png');
  } finally {
    driver.quit();
  }

  // 17c: grid-filtered — deselect 'todo' and 'done' so only doing+review
  // remain. The filter chips sit in the wrap row immediately under the
  // AppBar; with the kitp AppBar height + Wrap padding, chip centres
  // land at y≈115. After the left rail (220) + body padding (16), the
  // 'Status:' label ends ~290, then chips spaced by 6px each ~72px wide:
  //   todo:   ~328
  //   doing:  ~404
  //   review: ~488
  //   done:   ~568
  driver = _newDriver(args.chromedriver, width: 1600, height: 900);
  try {
    driver.get('${args.web}/#/grid?project=1');
    _settle(driver, delay: const Duration(seconds: 3));
    driver.mouse.moveTo(xOffset: 328, yOffset: 115, absolute: true);
    driver.mouse.click();
    _settle(driver, delay: const Duration(seconds: 2));
    driver.mouse.moveTo(xOffset: 568, yOffset: 115, absolute: true);
    driver.mouse.click();
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/17/grid-filtered.png');
  } finally {
    driver.quit();
  }

  // -------------------------------------------------------------------
  // PHASE 18: kanban views.
  // -------------------------------------------------------------------
  // 18a: kanban-single-lane (default — columns by status, no swim lanes).
  driver = _newDriver(args.chromedriver, width: 1600, height: 900);
  try {
    driver.get('${args.web}/#/kanban?project=1');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/18/kanban-single-lane.png');
  } finally {
    driver.quit();
  }

  // 18b: kanban-with-lanes (columns by status, lanes by assignee).
  // The toolbar reads "Columns by: [Status v]   Swim lanes by: [(none) v]"
  // Centre of the swim-lanes dropdown control ≈ (620, 115). Material
  // pops the menu BELOW the control with one item per ~48 logical px;
  // entries in order: (none), Status, Assignee, Milestone, Component.
  // We want Assignee — index 2 → centre y ≈ 115 + (2*48) + 24 = 235.
  driver = _newDriver(args.chromedriver, width: 1600, height: 900);
  try {
    driver.get('${args.web}/#/kanban?project=1');
    _settle(driver, delay: const Duration(seconds: 3));
    driver.mouse.moveTo(xOffset: 620, yOffset: 115, absolute: true);
    driver.mouse.click();
    _settle(driver, delay: const Duration(seconds: 1));
    driver.mouse.moveTo(xOffset: 620, yOffset: 235, absolute: true);
    driver.mouse.click();
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/18/kanban-with-lanes.png');
  } finally {
    driver.quit();
  }

  // 18c: kanban-drag — show the post-drag state as a representative
  // "before/after" since mid-drag screenshots aren't practical without
  // a custom protocol. We move one card from 'doing' to 'review' on
  // the live board, take a fresh screenshot, then move it back so the
  // demo state is preserved for re-runs.
  // Pick a known doing-status task: id=26 'Activity feed pagination'
  // (assignee=alice). We do the move via the API rather than dragging
  // through the headless browser to keep the script reliable.
  await _batch(http, args.api, [
    {
      'id': 'm',
      'type': 'data',
      'endpoint': 'attribute',
      'action': 'update',
      'data': {
        'card_id': 26,
        'attribute_name': 'status',
        'value': 'review',
      }
    },
  ]);
  driver = _newDriver(args.chromedriver, width: 1600, height: 900);
  try {
    driver.get('${args.web}/#/kanban?project=1');
    _settle(driver, delay: const Duration(seconds: 3));
    await _save(driver, '$outDir/18/kanban-drag.png');
  } finally {
    driver.quit();
  }
  // Restore for idempotent re-runs.
  await _batch(http, args.api, [
    {
      'id': 'r',
      'type': 'data',
      'endpoint': 'attribute',
      'action': 'update',
      'data': {
        'card_id': 26,
        'attribute_name': 'status',
        'value': 'doing',
      }
    },
  ]);

  http.close();
  stdout.writeln('done.');
}
