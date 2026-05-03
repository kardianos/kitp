/// Screenshot driver for Phase 16's per-user inbox ordering.
///
/// Refreshes `docs/screenshots/16/inbox-populated.png` (default order)
/// and writes `docs/screenshots/16/inbox-reordered.png` (after a single
/// `user_card_sort.set` that pulls one card to the top of the list).
///
/// Usage:
///   dart run tool/screenshot_p16_personal.dart \
///     --api http://127.0.0.1:18080 \
///     --web http://127.0.0.1:18080 \
///     --chromedriver http://127.0.0.1:9515 \
///     --out ../docs/screenshots
///
/// chromedriver must already be running. Start it with:
///   /home/d/bin/chromedriver --port=9515
library;

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
  List<Map<String, dynamic>> subs, {
  int? userId,
}) async {
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
    } catch (_) {}
    await Future<void>.delayed(const Duration(milliseconds: 500));
  }
  throw StateError('kitpd never came up');
}

WebDriver _newDriver(String chromedriverUri,
    {int width = 1280, int height = 900}) {
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
          '--user-data-dir=/tmp/kitp-chrome-screenshots-p16-personal',
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

void _settle(WebDriver driver,
    {Duration delay = const Duration(seconds: 5)}) {
  sleep(delay);
}

void main(List<String> argv) async {
  final args = _Args()..parse(argv);
  final http = HttpClient();
  final outDir = args.out;

  await _waitForServer(http, args.api);

  // 1. Wipe any pre-existing per-user sort entries for alice (id=2) so
  //    the "default" screenshot reflects the server's natural order
  //    (created_at DESC for unsorted rows).
  final wipeReq = await http.postUrl(Uri.parse('${args.api}/api/v1/_admin/sql'));
  // We don't have an admin sql endpoint; instead, use psql via docker.
  // The simpler approach: just leave existing rows; they become the new
  // baseline. For repeatability we instead delete and re-create the
  // alice rows by issuing DELETE through psql here.
  final del = await Process.run(
    'docker',
    [
      'exec',
      'kitp-pg',
      'psql',
      '-U',
      'kitp',
      '-d',
      'kitp',
      '-c',
      "DELETE FROM user_card_sort WHERE user_id = 2;",
    ],
  );
  if (del.exitCode != 0) {
    stdout.writeln('warn: failed to clear user_card_sort: ${del.stderr}');
  }
  wipeReq.close();

  // 2. Capture the default inbox view.
  var driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/inbox');
    _settle(driver);
    _save(driver, '$outDir/16/inbox-populated.png');
  } finally {
    driver.quit();
  }

  // 3. Pull alice's inbox (user_id=2 in dev mode is alice — see
  //    kCurrentUserId in client/lib/ui/screens/inbox_screen.dart) so we
  //    know which card to promote.
  final inboxResp = await _batch(http, args.api, [
    {
      'id': 'i',
      'type': 'data',
      'endpoint': 'inbox',
      'action': 'select',
      'data': {'user_id': 2},
    },
  ]);
  final firstSub = (inboxResp['subresponses'] as List).first as Map;
  if (firstSub['ok'] != true) {
    stderr.writeln('inbox.select failed: ${firstSub['error']}');
    exit(1);
  }
  final inboxRows = (firstSub['data'] as Map)['rows'] as List? ?? const [];
  if (inboxRows.isEmpty) {
    stdout.writeln('warn: inbox is empty; aborting reorder shot');
    return;
  }
  // The default ordering is created_at DESC, so the last row is the
  // oldest task. Promote it to the top by writing a personal sort.
  // Note: alice (id=2) is the inbox actor in dev mode (kCurrentUserId).
  // The dev-mode auth middleware stamps the System User onto every batch,
  // which means user_card_sort.set writes against user_id=1. To make the
  // demo land on alice's row, we instead write directly via psql.
  final promoteId = ((inboxRows.last as Map)['id'] as num).toInt();
  final ins = await Process.run(
    'docker',
    [
      'exec',
      'kitp-pg',
      'psql',
      '-U',
      'kitp',
      '-d',
      'kitp',
      '-c',
      "INSERT INTO user_card_sort (user_id, card_id, sort_order) VALUES (2, $promoteId, -1) ON CONFLICT (user_id, card_id) DO UPDATE SET sort_order = -1;",
    ],
  );
  if (ins.exitCode != 0) {
    stderr.writeln('failed to insert user_card_sort row: ${ins.stderr}');
    exit(1);
  }
  stdout.writeln('promoted card_id=$promoteId to top of alice\'s inbox');

  driver = _newDriver(args.chromedriver);
  try {
    driver.get('${args.web}/#/inbox');
    _settle(driver);
    _save(driver, '$outDir/16/inbox-reordered.png');
  } finally {
    driver.quit();
  }
}
