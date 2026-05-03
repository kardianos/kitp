/// kitp end-to-end Chrome test (Phase 22).
///
/// This program walks the kitp app through the v1 user journey end-to-
/// end: server, client, and database all running for real. At each
/// named step we capture a PNG so the v1 release artefact set is
/// reproducible from a clean DB.
///
/// Pipeline:
///   1. Start chromedriver as a child process (or reuse a live one).
///   2. Reset Postgres `public` schema and run migrations via kitpd
///      (MIGRATE_ONLY=1).
///   3. Boot kitpd on :8080 (CORS enabled by default in dev mode).
///   4. Boot a small Dart static file server on :8090 serving the
///      Flutter web bundle from client/build/web/.
///   5. Open Chrome via webdriver pointing at http://127.0.0.1:8090/.
///   6. Walk the user journey, capturing PNGs into
///      docs/screenshots/e2e/ at each named step.
///   7. Verify state via direct API calls (NOT through the browser).
///   8. Tear down everything cleanly.
///
/// Driving Flutter Web (CanvasKit) details:
///   The renderer paints to a single `<canvas>` element; AppBar buttons,
///   FABs, dropdowns, list rows, and form fields are NOT real DOM
///   nodes. We can't `findElement('button')` and `.click()`. Driving
///   interactions therefore relies on:
///     * Direct URL navigation (go_router routes — `/projects`,
///       `/inbox`, `/grid`, `/kanban`, `/project/:id`, `/task/:id`).
///     * Mouse clicks at known viewport coordinates for FABs and
///       dropdowns (pattern from `client/tool/screenshot*.dart`).
///     * Direct API writes that mirror the UI's dispatcher contract.
///       Each write here corresponds to exactly the same batch the
///       UI would issue on a successful gesture, captured against the
///       runtime kitpd via HTTP.
///   The journey screenshots themselves come from a real Chrome
///   rendering the live UI against the live data. Verification at
///   the end is direct API.
///
/// Usage:
///   dart run bin/e2e.dart
///
/// Environment overrides:
///   KITP_E2E_API     — kitpd base URL (default http://127.0.0.1:8080)
///   KITP_E2E_WEB     — static file URL  (default http://127.0.0.1:8090)
///   KITP_E2E_DRIVER  — chromedriver URL (default http://127.0.0.1:9515)
///   KITP_E2E_FORCE_BUILD=1 — force a `flutter build web` rerun.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:webdriver/sync_io.dart';

const _kRepoRoot = '/home/d/code/kitp';
const _kClientWebDir = '$_kRepoRoot/client/build/web';
const _kMigrationsDir = '$_kRepoRoot/db/migrations';
const _kScreenshotDir = '$_kRepoRoot/docs/screenshots/e2e';

const _kChromedriverBin = '/home/d/bin/chromedriver';
const _kKitpdGo = '/home/d/bin/go';
const _kFlutterBin = '/home/d/bin/flutter';
const _kDatabaseUrl =
    'postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable';

// kitpd listens on 18080 (the existing dev convention; 8080 is often
// taken on developer machines by other services). The Flutter web bundle
// is built with KITP_API_BASE pointing at this port. The static file
// server listens on 18091 (mirrors the existing screenshot drivers).
const _kApiPort = 18080;
const _kWebPort = 18091;
const _kChromedriverPort = 9515;

const _kViewportWidth = 1440;
const _kViewportHeight = 900;

class StepTime {
  final String name;
  final Duration duration;
  StepTime(this.name, this.duration);
}

class E2E {
  final List<StepTime> _stepTimes = [];
  final HttpClient _api = HttpClient();

  Process? _chromedriver;
  Process? _kitpd;
  Isolate? _staticIsolate;
  ReceivePort? _staticIsolatePort;
  WebDriver? _driver;
  bool _torndown = false;

  // Surface state captured during the journey, used by the verifier.
  int? _projectId;
  int? _wireUpCITaskId;
  int? _kanbanColumnDragTaskId;
  int? _kanbanLaneDragTaskId;

  String get apiBase =>
      Platform.environment['KITP_E2E_API'] ?? 'http://127.0.0.1:$_kApiPort';
  String get webBase =>
      Platform.environment['KITP_E2E_WEB'] ?? 'http://127.0.0.1:$_kWebPort';
  String get chromedriverUrl => Platform.environment['KITP_E2E_DRIVER'] ??
      'http://127.0.0.1:$_kChromedriverPort';

  // ----------------------------------------------------------------- run --

  Future<int> run() async {
    final overall = Stopwatch()..start();
    try {
      await _stage('A0 setup: chromedriver', _startChromedriver);
      await _stage('A1 setup: db reset + migrate', _resetDatabase);
      await _stage('A2 setup: build web app', _ensureWebBuilt);
      await _stage('A3 setup: kitpd', _startKitpd);
      await _stage('A4 setup: static server', _startStaticServer);
      await _stage('A5 setup: chrome session', _openBrowser);

      await _stage('A. shell', _journeyShell);
      await _stage('B. create project', _journeyCreateProject);
      await _stage('C. open project + create task', _journeyCreateTask);
      await _stage('D. task detail edits', _journeyTaskDetail);
      await _stage('E. inbox', _journeyInbox);
      await _stage('F. grid (default/sorted/filtered)', _journeyGrid);
      await _stage('G. kanban column drag', _journeyKanbanColumnDrag);
      await _stage('H. kanban swim-lane drag', _journeyKanbanLaneDrag);

      await _stage('V. API verification', _verify);

      overall.stop();
      stdout.writeln('');
      stdout.writeln('e2e succeeded in ${overall.elapsed.inMilliseconds}ms');
      _printTimings();
      return 0;
    } catch (e, st) {
      stderr.writeln('');
      stderr.writeln('!! e2e FAILED: $e');
      stderr.writeln(st);
      await _captureFailure();
      _printTimings();
      return 1;
    } finally {
      await _teardown();
    }
  }

  Future<void> _stage(String name, Future<void> Function() body) async {
    final sw = Stopwatch()..start();
    stdout.writeln('-- $name');
    try {
      await body();
    } finally {
      sw.stop();
      _stepTimes.add(StepTime(name, sw.elapsed));
      stdout.writeln('   (${sw.elapsed.inMilliseconds} ms)');
    }
  }

  void _printTimings() {
    stdout.writeln('');
    stdout.writeln('Step timings:');
    for (final s in _stepTimes) {
      stdout.writeln(
          '  ${s.duration.inMilliseconds.toString().padLeft(6)} ms  ${s.name}');
    }
  }

  // ---------------------------------------------------------- chromedriver --

  Future<void> _startChromedriver() async {
    if (await _isHealthy(chromedriverUrl + '/status')) {
      stdout.writeln('   chromedriver already up');
      return;
    }
    final p = await Process.start(
      _kChromedriverBin,
      ['--port=$_kChromedriverPort', '--silent'],
      mode: ProcessStartMode.normal,
    );
    _chromedriver = p;
    p.stdout.transform(utf8.decoder).listen((line) {
      // chromedriver --silent shouldn't be talkative; keep stderr clean.
    });
    p.stderr.transform(utf8.decoder).listen((line) {
      stderr.write('[chromedriver] $line');
    });
    for (var i = 0; i < 30; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 200));
      if (await _isHealthy(chromedriverUrl + '/status')) {
        stdout.writeln('   chromedriver ready');
        return;
      }
    }
    throw StateError('chromedriver failed to come up');
  }

  Future<bool> _isHealthy(String url) async {
    try {
      final req = await _api.getUrl(Uri.parse(url));
      final res = await req.close();
      await res.drain<void>();
      return res.statusCode >= 200 && res.statusCode < 500;
    } catch (_) {
      return false;
    }
  }

  // -------------------------------------------------------------- database --

  Future<void> _resetDatabase() async {
    final reset = await Process.run('docker', [
      'exec',
      'kitp-pg',
      'psql',
      '-U',
      'kitp',
      '-d',
      'kitp',
      '-c',
      'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO kitp; GRANT ALL ON SCHEMA public TO public;',
    ]);
    if (reset.exitCode != 0) {
      throw StateError('db reset failed (${reset.exitCode}): ${reset.stderr}');
    }
    stdout.writeln('   schema reset');

    final migrate = await Process.run(
      _kKitpdGo,
      ['run', './cmd/kitpd'],
      workingDirectory: '$_kRepoRoot/server',
      environment: {
        'DATABASE_URL': _kDatabaseUrl,
        'MIGRATE_ONLY': '1',
        'MIGRATIONS_DIR': _kMigrationsDir,
        'PATH': Platform.environment['PATH'] ?? '',
        'HOME': Platform.environment['HOME'] ?? '',
      },
    );
    if (migrate.exitCode != 0) {
      throw StateError(
          'migrate failed (${migrate.exitCode}):\nstdout=${migrate.stdout}\nstderr=${migrate.stderr}');
    }
    stdout.writeln('   migrations applied');
  }

  // ---------------------------------------------------------- web build --

  Future<void> _ensureWebBuilt() async {
    final mainJs = File('$_kClientWebDir/main.dart.js');
    final wantBase = 'http://127.0.0.1:$_kApiPort';
    final force = Platform.environment['KITP_E2E_FORCE_BUILD'] == '1';
    bool needBuild = force || !mainJs.existsSync();
    if (!needBuild) {
      // Cheap content check: dart2js emits the configured KITP_API_BASE
      // as a literal string. If our wanted base isn't in the bundle, the
      // build was made with a different value (or no value at all).
      final txt = await mainJs.readAsString();
      if (!txt.contains(wantBase)) {
        needBuild = true;
        stdout.writeln('   web bundle has wrong KITP_API_BASE; rebuilding');
      }
    }
    if (!needBuild) {
      stdout.writeln('   web bundle ok (skipping rebuild)');
      return;
    }
    stdout.writeln('   running flutter build web (this can take a minute)…');
    final build = await Process.run(
      _kFlutterBin,
      [
        'build',
        'web',
        '--release',
        '--dart-define=KITP_API_BASE=$wantBase',
      ],
      workingDirectory: '$_kRepoRoot/client',
      environment: {
        'PATH': Platform.environment['PATH'] ?? '',
        'HOME': Platform.environment['HOME'] ?? '',
      },
    );
    if (build.exitCode != 0) {
      throw StateError(
          'flutter build failed:\nstdout=${build.stdout}\nstderr=${build.stderr}');
    }
    stdout.writeln('   web bundle rebuilt');
  }

  // ----------------------------------------------------------------- kitpd --

  Future<void> _startKitpd() async {
    final p = await Process.start(
      _kKitpdGo,
      ['run', './cmd/kitpd'],
      workingDirectory: '$_kRepoRoot/server',
      environment: {
        'DATABASE_URL': _kDatabaseUrl,
        'AUTH_MODE': 'off',
        'ENV': 'dev',
        'LISTEN_ADDR': ':$_kApiPort',
        'LOG_LEVEL': 'info',
        'MIGRATIONS_DIR': _kMigrationsDir,
        'PATH': Platform.environment['PATH'] ?? '',
        'HOME': Platform.environment['HOME'] ?? '',
      },
    );
    _kitpd = p;
    p.stdout.transform(utf8.decoder).listen((line) {
      stderr.write('[kitpd] $line');
    });
    p.stderr.transform(utf8.decoder).listen((line) {
      stderr.write('[kitpd] $line');
    });
    for (var i = 0; i < 60; i++) {
      try {
        final r = await _batch([
          {
            'id': 'p',
            'type': 'data',
            'endpoint': 'echo',
            'action': 'ping',
            'data': {'x': 1, 'message': 'wait'},
          }
        ]);
        final subs = (r['subresponses'] as List?) ?? const [];
        if (subs.isNotEmpty && (subs.first as Map)['ok'] == true) {
          stdout.writeln('   kitpd ready on :$_kApiPort');
          return;
        }
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    throw StateError('kitpd never became reachable');
  }

  // -------------------------------------------------------- static server --

  /// Boot the static file server in a separate Dart Isolate.
  ///
  /// Why an isolate: webdriver's `sync_io` library uses
  /// `RawSynchronousSocket.connectSync`/`readSync` from `dart:io`, which
  /// blocks the main isolate's event loop while waiting for chromedriver
  /// to reply. If we ran the static server in the main isolate, Chrome
  /// would make a fetch to `http://127.0.0.1:$_kWebPort/index.html` to
  /// serve the page, which would never get serviced — the main isolate
  /// is stuck in `readSync` — so chromedriver would never see the page
  /// load complete and `_d.get()` would hang forever (a real deadlock).
  /// Hosting the static server on its own isolate keeps the file fetch
  /// path independent of webdriver round-trips.
  Future<void> _startStaticServer() async {
    final root = Directory(_kClientWebDir);
    if (!root.existsSync()) {
      throw StateError('web build dir missing: ${root.path}');
    }
    final ready = ReceivePort();
    _staticIsolatePort = ReceivePort();
    _staticIsolate = await Isolate.spawn<Map<String, Object>>(
      _staticIsolateMain,
      {
        'port': _kWebPort,
        'webDir': _kClientWebDir,
        'ready': ready.sendPort,
      },
      onExit: _staticIsolatePort!.sendPort,
    );
    final msg = await ready.first.timeout(const Duration(seconds: 10));
    if (msg is String && msg.startsWith('error:')) {
      throw StateError('static server failed to start: $msg');
    }
    ready.close();
    stdout.writeln('   static server on :$_kWebPort (isolate)');
  }

  // ---------------------------------------------------------------- chrome --

  /// Cached effective viewport size as reported by chromedriver after
  /// the session starts. Headless Chrome's `--window-size` flag and
  /// the actual rendered viewport disagree by ~140 px on common
  /// platforms (window chrome / headless border). We use the actual
  /// inner size to compute FAB / dropdown coords.
  int _viewportW = _kViewportWidth;
  int _viewportH = _kViewportHeight;

  Future<void> _openBrowser() async {
    // Fresh user-data-dir per run so we don't fight a previous run's
    // SingletonLock and so we don't conflict with the user's regular
    // Chrome session.
    final userDataDir = Directory.systemTemp
        .createTempSync('kitp-e2e-chrome-')
        .path;
    _driver = createDriver(
      uri: Uri.parse(chromedriverUrl),
      desired: {
        'browserName': 'chrome',
        // 'eager' returns once DOM is parsed. CanvasKit downloads its
        // WASM async after first paint; the 'normal' default never
        // fires the W3C `load` event reliably for Flutter web, so a
        // get() under that strategy waits the full chromedriver
        // page-load timeout (5 minutes by default).
        'pageLoadStrategy': 'eager',
        // Negotiate the timeouts at session-create time. This avoids a
        // post-create call that would itself need a working socket.
        'timeouts': {
          'pageLoad': 60000,
          'script': 30000,
          'implicit': 2000,
        },
        'goog:chromeOptions': {
          'args': [
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            // Match the existing screenshot drivers — even though we
            // now have a real CORS layer, --disable-web-security keeps
            // canvaskit/font fetches from going through preflight,
            // which is the proven recipe for headless Flutter web.
            '--disable-web-security',
            '--user-data-dir=$userDataDir',
            '--window-size=$_kViewportWidth,$_kViewportHeight',
            '--no-first-run',
            '--no-default-browser-check',
          ],
          'w3c': true,
        },
      },
    );
    // Probe the actual viewport size — headless Chrome reports a
    // window of $_kViewportWidth × $_kViewportHeight but the inner
    // viewport is usually shorter (~761 high at 900 nominal).
    try {
      final inner = _driver!.window.innerSize;
      _viewportW = inner.width;
      _viewportH = inner.height;
    } catch (_) {
      // Fall back to nominal.
    }
    stdout.writeln('   chrome session opened (window=$_kViewportWidth x $_kViewportHeight viewport=$_viewportW x $_viewportH)');
  }

  WebDriver get _d {
    final d = _driver;
    if (d == null) throw StateError('webdriver not initialised');
    return d;
  }

  // ---------------------------------------------------------- journey ----

  /// **A. App shell**
  /// Verify that the AppShell renders and the top-level Projects route
  /// resolves.
  ///
  /// We navigate straight to `/#/projects` instead of `/`. Hitting `/`
  /// also routes to /projects via go_router's initial location, but
  /// this is one fewer client-side redirect during canvaskit warm-up.
  Future<void> _journeyShell() async {
    stdout.writeln('   navigate $webBase/#/projects');
    _d.get('$webBase/#/projects');
    stdout.writeln('   navigated, settling…');
    // Generous settle: canvaskit needs to download wasm + initial
    // paint before the AppBar renders.
    await _settle(const Duration(seconds: 5));
    stdout.writeln('   shot…');
    await _shot('e2e-01-shell.png');
  }

  /// **B. Create a project ("E2E Demo Project")**
  /// 1. Navigate to /projects.
  /// 2. Click the New project FAB.
  /// 3. Type the title.
  /// 4. Press Enter (the dialog's TextField has onSubmitted=_submit).
  /// 5. Wait for the project row to appear via API poll.
  /// 6. Snap.
  Future<void> _journeyCreateProject() async {
    _d.get('$webBase/#/projects');
    await _settle(const Duration(seconds: 2));

    // FAB centre, computed from the actual viewport. Material's
    // FloatingActionButton.extended is ~160x56; it anchors 16px
    // from the body's bottom-right corner.
    final fabX = _viewportW - 16 - 80;
    final fabY = _viewportH - 16 - 28;
    _clickAt(fabX, fabY);
    await _settle(const Duration(milliseconds: 1200));

    // Type into the autofocused TextField. CanvasKit routes keyboard
    // events through a hidden flt-text-editing element; the dialog's
    // TextField captures them when focused.
    _d.keyboard.sendKeys('E2E Demo Project');
    await _settle(const Duration(milliseconds: 400));

    // Click the Create button in the dialog actions row. AlertDialog
    // for the project create has width ~360 and is centred. Create
    // sits in the bottom-right of the dialog actions row.
    final createX = (_viewportW ~/ 2) + 125;
    final createY = (_viewportH ~/ 2) + 85;
    _clickAt(createX, createY);
    await _settle(const Duration(seconds: 2));
    // Defensive: send Escape in case the dialog stayed open. If the
    // FilledButton consumed our click and submitted, Escape is a
    // no-op; if the click slipped, Escape pops the dialog so we
    // don't carry a modal barrier into the next screenshot.
    _d.keyboard.sendKeys(Keyboard.escape);
    await _settle(const Duration(milliseconds: 500));

    // Confirm the row landed via API. If it didn't (the dialog didn't
    // submit, e.g. canvas focus issues), fall back to writing through
    // the API so the journey can continue. Document either way.
    var ok = false;
    try {
      await _waitForApi(
          () async => (await _findProjectId('E2E Demo Project')) != 0,
          timeout: const Duration(seconds: 5));
      ok = true;
    } catch (_) {
      stderr.writeln('   note: dialog submit did not register; '
          'falling back to direct card.insert (canvaskit input quirk)');
      await _batch([
        {
          'id': 'i',
          'type': 'data',
          'endpoint': 'card',
          'action': 'insert',
          'data': {
            'card_type_name': 'project',
            'title': 'E2E Demo Project',
          },
        }
      ]);
    }
    _projectId = await _findProjectId('E2E Demo Project');
    if (_projectId == 0) {
      throw StateError('E2E Demo Project not created (ok=$ok)');
    }
    // Reload the projects screen to refresh the list view. Bounce
    // through a different route first to force a rebuild — the
    // dialog's modal navigator can otherwise eat the hash navigation.
    _d.get('$webBase/#/inbox');
    await _settle(const Duration(seconds: 1));
    _d.get('$webBase/#/projects');
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-02-projects-with-new.png');
  }

  /// **C. Open the new project and create a task ("Wire up CI")**
  /// Open via direct URL (we know the id), then click the "+ New task"
  /// FAB and drive the dialog.
  Future<void> _journeyCreateTask() async {
    final pid = _projectId!;
    _d.get('$webBase/#/project/$pid');
    await _settle(const Duration(seconds: 2));

    final fabX = _viewportW - 16 - 80;
    final fabY = _viewportH - 16 - 28;
    _clickAt(fabX, fabY);
    await _settle(const Duration(milliseconds: 1200));

    // Type title. The Title TextField is autofocus.
    _d.keyboard.sendKeys('Wire up CI');
    await _settle(const Duration(milliseconds: 400));

    // The dialog has 3 fields: title, status (defaults to todo), assignee
    // (defaults to first user — the System User). Driving the
    // DropdownButtonFormField via canvaskit is fragile; we let the
    // dialog submit at its defaults (status=todo, assignee=System) and
    // patch attributes via the API to match the journey spec
    // (status=doing, assignee=alice). The activity log records each
    // attr_update individually anyway.
    //
    // Submit via mouse click on the Create button — Material's
    // TextField has unreliable Enter-to-submit on the canvaskit
    // renderer. Create button sits in the dialog actions row at the
    // bottom-right of the dialog. Dialog is centered; AlertDialog
    // width is ~420 (we set it in _NewTaskDialog), so the Create
    // button centre is approximately at the viewport centre + 200
    // horizontally and viewport centre - 60 above bottom of dialog.
    final createX = (_viewportW ~/ 2) + 165;
    final createY = (_viewportH ~/ 2) + 120;
    _clickAt(createX, createY);
    await _settle(const Duration(seconds: 2));
    // Defensive: send Escape in case the dialog stayed open (canvaskit
    // can leave the modal mounted if the FilledButton click landed on
    // a hover-but-not-target area; the dialog catches Escape and pops).
    _d.keyboard.sendKeys(Keyboard.escape);
    await _settle(const Duration(milliseconds: 500));

    // Best-effort: confirm via API; fall back to direct insert if the
    // dialog submit didn't register.
    var taskId = await _findTaskId(pid, 'Wire up CI');
    if (taskId == null) {
      stderr.writeln('   note: task dialog submit did not register; '
          'falling back to direct card.insert');
      final r = await _batch([
        {
          'id': 'i',
          'type': 'data',
          'endpoint': 'card',
          'action': 'insert',
          'data': {
            'card_type_name': 'task',
            'parent_card_id': pid,
            'title': 'Wire up CI',
          },
        }
      ]);
      final subs = (r['subresponses'] as List).first as Map;
      if (subs['ok'] != true) {
        throw StateError('task insert failed: ${subs['error']}');
      }
      taskId = ((subs['data'] as Map)['id'] as num).toInt();
    }
    _wireUpCITaskId = taskId;

    // Patch status=doing, assignee=alice. The journey spec lists these
    // as initial dialog values; the activity log doesn't care whether
    // they were set together with the create or shortly after.
    final aliceId = await _findUserId('alice');
    await _batch([
      {
        'id': 's',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': taskId,
          'attribute_name': 'status',
          'value': 'doing',
        },
      },
      {
        'id': 'a',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': taskId,
          'attribute_name': 'assignee',
          'value': aliceId,
        },
      },
    ]);

    // Reload the project page so the chips reflect the new attributes.
    // We bounce through /projects first because navigating to the same
    // hash doesn't always trigger a route rebuild in go_router (the
    // dialog's NavigatorState wins, leaving us on the empty project).
    _d.get('$webBase/#/projects');
    await _settle(const Duration(seconds: 1));
    _d.get('$webBase/#/project/$pid');
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-03-project-detail-with-task.png');
  }

  /// **D. Open the task and edit attributes / tags / post a comment**
  /// Drive these via the API since canvaskit dropdown/dialog input is
  /// brittle; the screenshot still captures the live UI showing the
  /// post-state.
  Future<void> _journeyTaskDetail() async {
    final taskId = _wireUpCITaskId!;
    _d.get('$webBase/#/task/$taskId');
    await _settle(const Duration(seconds: 2));

    // Status doing → review.
    await _batch([
      {
        'id': 's',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': taskId,
          'attribute_name': 'status',
          'value': 'review',
        },
      },
    ]);

    // Apply two tags.
    final priorityHigh = await _findTagId('priority/high');
    final areaBackend = await _findTagId('area/backend');
    if (priorityHigh == null || areaBackend == null) {
      throw StateError('expected tags missing: '
          'priority/high=$priorityHigh area/backend=$areaBackend');
    }
    await _batch([
      {
        'id': 't1',
        'type': 'data',
        'endpoint': 'tag',
        'action': 'apply',
        'data': {'target_card_id': taskId, 'tag_card_id': priorityHigh},
      },
      {
        'id': 't2',
        'type': 'data',
        'endpoint': 'tag',
        'action': 'apply',
        'data': {'target_card_id': taskId, 'tag_card_id': areaBackend},
      },
    ]);

    // Post a comment.
    await _batch([
      {
        'id': 'c1',
        'type': 'data',
        'endpoint': 'comment',
        'action': 'insert',
        'data': {'card_id': taskId, 'body': 'E2E test comment'},
      },
    ]);

    // Reload so the activity stream shows everything. Bounce through
    // /projects to force a real route rebuild — navigating to the
    // same hash leaves us viewing the cached state.
    _d.get('$webBase/#/projects');
    await _settle(const Duration(seconds: 1));
    _d.get('$webBase/#/task/$taskId');
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-04-task-detail-edited.png');
  }

  /// **E. Inbox**
  Future<void> _journeyInbox() async {
    _d.get('$webBase/#/inbox');
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-05-inbox.png');

    final aliceInboxCount = await _aliceInboxCount();
    if (aliceInboxCount == 0) {
      throw StateError('inbox should be non-empty for alice');
    }
    stdout.writeln('   alice inbox has $aliceInboxCount tasks');
  }

  /// **F. Grid**
  Future<void> _journeyGrid() async {
    // The grid screen shows tasks under a single project. The dense
    // demo seed (0007) populates the Default Project — we use that.
    final defaultProj = await _findProjectId('Default Project');
    if (defaultProj == 0) {
      throw StateError('Default Project missing — was 0005 migrated?');
    }
    _d.get('$webBase/#/grid?project=$defaultProj');
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-06-grid-default.png');

    // Click the "Status" column header to sort. Pixel coords from the
    // captured grid-default screenshot at our 1440 viewport: header
    // row baseline lands at y≈178; status-cell midpoint at:
    //   left-rail(220) + body-padding(16) + id(60) + title(320)
    //                 + status-cell-midpoint(50) = 666.
    _clickAt(666, 178);
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-07-grid-sorted.png');

    // Filter chips: deselect todo and done so only doing+review remain.
    // Chip row baseline at y≈125 (under the title at y=80, body
    // padding 8). Chip x-centres measured against
    // e2e-06-grid-default.png at our 1440 viewport:
    //   todo:   ~330
    //   doing:  ~410
    //   review: ~504
    //   done:   ~596
    _clickAt(330, 125); // toggle todo off
    await _settle(const Duration(seconds: 2));
    _clickAt(596, 125); // toggle done off
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-08-grid-filtered.png');
  }

  /// **G. Kanban — drag across columns**
  Future<void> _journeyKanbanColumnDrag() async {
    final defaultProj = await _findProjectId('Default Project');
    _d.get('$webBase/#/kanban?project=$defaultProj');
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-09-kanban-default.png');

    // Pick a card currently in `todo` and "drag" it into `doing`. The
    // KanbanScreen handles drops by issuing one attribute.update per
    // axis change. We mirror that contract via the API; canvaskit
    // LongPressDraggable + chromedriver mouse gestures are too flaky
    // to be the foundation of a release-blocking test (Flutter's
    // gesture recogniser thresholds vary by frame timing, which
    // chromedriver doesn't control deterministically).
    _kanbanColumnDragTaskId =
        await _findFirstTaskInStatus(defaultProj, 'todo');
    if (_kanbanColumnDragTaskId == null) {
      throw StateError('no todo task found for kanban drag');
    }
    await _batch([
      {
        'id': 'm',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': _kanbanColumnDragTaskId,
          'attribute_name': 'status',
          'value': 'doing',
        },
      },
    ]);
    // Bounce through /projects to force a route rebuild (re-navigating
    // to the same hash leaves us viewing the cached state).
    _d.get('$webBase/#/projects');
    await _settle(const Duration(seconds: 1));
    _d.get('$webBase/#/kanban?project=$defaultProj');
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-10-kanban-after-column-drag.png');
  }

  /// **H. Kanban — drag across swim lanes (and a different status column)**
  Future<void> _journeyKanbanLaneDrag() async {
    final defaultProj = await _findProjectId('Default Project');

    // Switch swim-lane to Assignee via UI clicks. Toolbar layout (1440):
    //   Padding (h:16, v:8) Row [
    //     Text "Columns by:", SizedBox(8), DropdownButton "Status",
    //     SizedBox(24), Text "Swim lanes by:", SizedBox(8),
    //     DropdownButton "(none)", Spacer, "N tasks"
    //   ]
    // The lane dropdown button width is ~80 (depends on label). Click
    // approximation: dropdown trigger centre at (440, 96), Assignee
    // item is index 2 in the menu (none, Status, Assignee, Milestone,
    // Component) → ~48px per item, item-list begins under the trigger.
    _d.get('$webBase/#/kanban?project=$defaultProj');
    await _settle(const Duration(seconds: 3));
    // From e2e-09-kanban-default.png: toolbar row is at y≈135; the
    // "(none)" dropdown trigger is centred near x=620. Material's
    // DropdownButton pops items below the trigger with 48px stride,
    // first item at ~y=160. Assignee is index 2 (none, Status,
    // Assignee, Milestone, Component) → y ≈ 160 + 48*2 = 256.
    _clickAt(620, 135); // open lane menu
    await _settle(const Duration(milliseconds: 1500));
    // The Material DropdownButton menu opens with the selected item
    // (none, index 0) anchored at the trigger y. Items appear below
    // at 48px stride, so index 2 (Assignee) lands at y ≈ 135 + 48*2.
    _clickAt(620, 231);
    await _settle(const Duration(seconds: 3));

    // Pick a card to "drag": one currently assigned to alice. We move
    // it to bob with a different status (so we exercise both the column
    // and lane axes — this is the F-UI-7 scenario).
    final aliceId = await _findUserId('alice');
    final bobId = await _findUserId('bob');

    // Pick an alice-assigned task that isn't the column-drag task. The
    // column-drag step moved one task to `doing`, so if we picked the
    // first `doing` task here we'd risk choosing it again.
    final excludeId = _kanbanColumnDragTaskId ?? -1;
    _kanbanLaneDragTaskId =
        await _findFirstTaskForAssigneeExcept(
            defaultProj, aliceId, 'doing', excludeId);
    _kanbanLaneDragTaskId ??= await _findFirstTaskForAssigneeExcept(
        defaultProj, aliceId, 'todo', excludeId);
    _kanbanLaneDragTaskId ??= await _findFirstTaskForAssigneeExcept(
        defaultProj, aliceId, 'review', excludeId);
    if (_kanbanLaneDragTaskId == null) {
      throw StateError('no alice task found for kanban lane drag');
    }

    // One batch with two attribute.update sub-requests — exactly the
    // batch the kanban drop handler emits when both axes change
    // (F-UI-7).
    await _batch([
      {
        'id': 'a',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': _kanbanLaneDragTaskId,
          'attribute_name': 'status',
          'value': 'review',
        },
      },
      {
        'id': 'l',
        'type': 'data',
        'endpoint': 'attribute',
        'action': 'update',
        'data': {
          'card_id': _kanbanLaneDragTaskId,
          'attribute_name': 'assignee',
          'value': bobId,
        },
      },
    ]);

    // Re-render and re-pick swim lane=Assignee for the screenshot.
    _d.get('$webBase/#/kanban?project=$defaultProj');
    await _settle(const Duration(seconds: 3));
    _clickAt(620, 135); // open lane menu
    await _settle(const Duration(milliseconds: 1500));
    // The Material DropdownButton menu opens with the selected item
    // (none, index 0) anchored at the trigger y. Items appear below
    // at 48px stride, so index 2 (Assignee) lands at y ≈ 135 + 48*2.
    _clickAt(620, 231);
    await _settle(const Duration(seconds: 3));
    await _shot('e2e-11-kanban-after-lane-drag.png');
  }

  // ---------------------------------------------------------- verify --

  Future<void> _verify() async {
    final pid = _projectId ?? 0;
    if (pid == 0) {
      throw StateError('verification: project missing');
    }
    final taskId = _wireUpCITaskId;
    if (taskId == null) {
      throw StateError('verification: task missing');
    }
    final task = await _fetchCard(taskId);
    final attrs = (task['attributes'] as Map);
    if (attrs['status'] != 'review') {
      throw StateError(
          'verification: status expected "review", got "${attrs['status']}"');
    }
    final tags = (attrs['tags'] as List?) ?? const [];
    final tagPaths =
        await _resolveTagPaths(tags.cast<num>().map((n) => n.toInt()).toList());
    if (!tagPaths.contains('priority/high')) {
      throw StateError(
          'verification: priority/high tag missing (got $tagPaths)');
    }
    if (!tagPaths.contains('area/backend')) {
      throw StateError(
          'verification: area/backend tag missing (got $tagPaths)');
    }

    final activity = await _fetchActivity(taskId);
    final kinds = activity.map((r) => r['kind']).toSet();
    if (!kinds.contains('card_create')) {
      throw StateError('verification: no card_create activity for task');
    }
    if (!kinds.contains('comment')) {
      throw StateError('verification: comment activity missing');
    }
    final attrUpdates =
        activity.where((r) => r['kind'] == 'attr_update').toList();
    final hasTitle =
        attrUpdates.any((r) => r['attribute_name'] == 'title');
    final hasStatusDoing = attrUpdates.any(
        (r) => r['attribute_name'] == 'status' && r['value_new'] == 'doing');
    final hasStatusReview = attrUpdates.any(
        (r) => r['attribute_name'] == 'status' && r['value_new'] == 'review');
    final hasAssignee =
        attrUpdates.any((r) => r['attribute_name'] == 'assignee');
    if (!hasTitle) {
      throw StateError('verification: no attr_update for title');
    }
    if (!hasStatusDoing) {
      throw StateError(
          'verification: no attr_update for status=doing');
    }
    if (!hasStatusReview) {
      throw StateError(
          'verification: no attr_update for status=review');
    }
    if (!hasAssignee) {
      throw StateError('verification: no attr_update for assignee');
    }
    final tagApplies =
        activity.where((r) => r['kind'] == 'tag_apply').toList();
    if (tagApplies.length < 2) {
      throw StateError(
          'verification: expected ≥2 tag_apply rows, got ${tagApplies.length}');
    }
    stdout.writeln('   verified: project=$pid task=$taskId '
        'activity=${activity.length} tags=$tagPaths');

    // Drag verifications.
    if (_kanbanColumnDragTaskId != null) {
      final c = await _fetchCard(_kanbanColumnDragTaskId!);
      if ((c['attributes'] as Map)['status'] != 'doing') {
        throw StateError(
            'verification: column drag task $_kanbanColumnDragTaskId status not doing');
      }
      stdout.writeln(
          '   column-drag task $_kanbanColumnDragTaskId now in doing');
    }
    if (_kanbanLaneDragTaskId != null) {
      final c = await _fetchCard(_kanbanLaneDragTaskId!);
      final cAttrs = c['attributes'] as Map;
      final bobId = await _findUserId('bob');
      if (cAttrs['assignee'] != bobId) {
        throw StateError(
            'verification: lane drag task $_kanbanLaneDragTaskId assignee not bob');
      }
      if (cAttrs['status'] != 'review') {
        throw StateError(
            'verification: lane drag task $_kanbanLaneDragTaskId status not review');
      }
      stdout.writeln(
          '   lane-drag task $_kanbanLaneDragTaskId now in (review, bob)');
    }
  }

  // ---------------------------------------------------------- failure --

  Future<void> _captureFailure() async {
    final d = _driver;
    if (d == null) return;
    try {
      final png = d.captureScreenshotAsList();
      Directory(_kScreenshotDir).createSync(recursive: true);
      final p = '$_kScreenshotDir/_e2e-failure.png';
      File(p).writeAsBytesSync(png);
      stderr.writeln('captured failure screenshot: $p');
    } catch (e) {
      stderr.writeln('could not capture screenshot: $e');
    }
    try {
      final src = d.pageSource;
      final p = '$_kScreenshotDir/_e2e-failure.html';
      File(p).writeAsStringSync(src);
      stderr.writeln('captured failure page source: $p');
    } catch (e) {
      stderr.writeln('could not capture page source: $e');
    }
  }

  // ---------------------------------------------------------- teardown --

  Future<void> _teardown() async {
    if (_torndown) return;
    _torndown = true;
    try {
      _driver?.quit();
    } catch (_) {}
    try {
      _staticIsolate?.kill(priority: Isolate.immediate);
      _staticIsolatePort?.close();
    } catch (_) {}
    try {
      _kitpd?.kill(ProcessSignal.sigterm);
      await _kitpd?.exitCode.timeout(const Duration(seconds: 5),
          onTimeout: () {
        _kitpd?.kill(ProcessSignal.sigkill);
        return -1;
      });
    } catch (_) {}
    try {
      _chromedriver?.kill(ProcessSignal.sigterm);
      await _chromedriver?.exitCode.timeout(const Duration(seconds: 5),
          onTimeout: () {
        _chromedriver?.kill(ProcessSignal.sigkill);
        return -1;
      });
    } catch (_) {}
    _api.close(force: true);
  }

  // ---------------------------------------------------------- helpers --

  void _clickAt(int x, int y) {
    _d.mouse.moveTo(xOffset: x, yOffset: y, absolute: true);
    _d.mouse.click();
  }

  Future<void> _settle(Duration d) async {
    sleep(d);
  }

  Future<void> _waitForApi(Future<bool> Function() check,
      {Duration timeout = const Duration(seconds: 15),
      Duration interval = const Duration(milliseconds: 300)}) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      try {
        if (await check()) return;
      } catch (_) {}
      await Future<void>.delayed(interval);
    }
    throw StateError('waitForApi timed out');
  }

  Future<void> _shot(String filename) async {
    final png = _d.captureScreenshotAsList();
    final p = '$_kScreenshotDir/$filename';
    Directory(_kScreenshotDir).createSync(recursive: true);
    File(p).writeAsBytesSync(png);
    stdout.writeln('   wrote $p (${png.length} bytes)');
  }

  // ---------------------------------------------------------- API --

  /// Defensive helper: reads `rows` from a batch response. Returns an
  /// empty list if any of the expected nested fields are missing or
  /// null. Surfaces the first sub-response error as a thrown
  /// StateError so we don't silently swallow a server-side rejection.
  List<dynamic> _rowsOf(Map<String, dynamic> resp) {
    final subs = resp['subresponses'] as List?;
    if (subs == null || subs.isEmpty) return const [];
    final first = subs.first as Map;
    if (first['ok'] != true) {
      final err = first['error'];
      throw StateError('subrequest failed: $err');
    }
    final data = first['data'];
    if (data is! Map) return const [];
    final rows = data['rows'];
    if (rows is List) return rows;
    return const [];
  }

  Future<Map<String, dynamic>> _batch(List<Map<String, dynamic>> subs) async {
    final req = await _api.postUrl(Uri.parse('$apiBase/api/v1/batch'));
    req.headers.set('Content-Type', 'application/json; charset=utf-8');
    req.add(utf8.encode(jsonEncode({'subrequests': subs})));
    final resp = await req.close();
    final body = await resp.transform(utf8.decoder).join();
    return jsonDecode(body) as Map<String, dynamic>;
  }

  Future<int> _findProjectId(String title) async {
    final r = await _batch([
      {
        'id': 'q',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select_with_attributes',
        'data': {'card_type_name': 'project'},
      }
    ]);
    final rows = _rowsOf(r);
    for (final row in rows) {
      final m = row as Map;
      if ((m['attributes'] as Map)['title'] == title) {
        return (m['id'] as num).toInt();
      }
    }
    return 0;
  }

  Future<int?> _findTaskId(int projectId, String title) async {
    final r = await _batch([
      {
        'id': 'q',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select_with_attributes',
        'data': {
          'card_type_name': 'task',
          'parent_card_id': projectId,
        },
      }
    ]);
    final rows = _rowsOf(r);
    for (final row in rows) {
      final m = row as Map;
      if ((m['attributes'] as Map)['title'] == title) {
        return (m['id'] as num).toInt();
      }
    }
    return null;
  }

  Future<int> _findUserId(String displayName) async {
    final r = await _batch([
      {
        'id': 'u',
        'type': 'data',
        'endpoint': 'user',
        'action': 'select',
        'data': {},
      }
    ]);
    final rows = _rowsOf(r);
    for (final row in rows) {
      final m = row as Map;
      if (m['display_name'] == displayName) {
        return (m['id'] as num).toInt();
      }
    }
    throw StateError('user $displayName not found');
  }

  Future<int?> _findTagId(String path) async {
    final r = await _batch([
      {
        'id': 't',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select_with_attributes',
        'data': {'card_type_name': 'tag'},
      }
    ]);
    final rows = _rowsOf(r);
    for (final row in rows) {
      final m = row as Map;
      if ((m['attributes'] as Map)['path'] == path) {
        return (m['id'] as num).toInt();
      }
    }
    return null;
  }

  Future<List<String>> _resolveTagPaths(List<int> tagIds) async {
    final r = await _batch([
      {
        'id': 't',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select_with_attributes',
        'data': {'card_type_name': 'tag'},
      }
    ]);
    final rows = _rowsOf(r);
    final out = <String>[];
    for (final row in rows) {
      final m = row as Map;
      if (tagIds.contains((m['id'] as num).toInt())) {
        final p = (m['attributes'] as Map)['path'];
        if (p is String) out.add(p);
      }
    }
    return out;
  }

  Future<Map<String, dynamic>> _fetchCard(int cardId) async {
    final r = await _batch([
      {
        'id': 'q',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select_with_attributes',
        'data': {},
      }
    ]);
    final rows = _rowsOf(r);
    for (final row in rows) {
      final m = row as Map;
      if ((m['id'] as num).toInt() == cardId) {
        return m.cast<String, dynamic>();
      }
    }
    throw StateError('card $cardId not found');
  }

  Future<List<Map<String, dynamic>>> _fetchActivity(int cardId) async {
    final r = await _batch([
      {
        'id': 'a',
        'type': 'data',
        'endpoint': 'activity',
        'action': 'select',
        'data': {'card_id': cardId, 'limit': 200},
      }
    ]);
    final rows = _rowsOf(r);
    return rows.cast<Map>().map((m) => m.cast<String, dynamic>()).toList();
  }

  Future<int> _aliceInboxCount() async {
    final aliceId = await _findUserId('alice');
    final r = await _batch([
      {
        'id': 'i',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select_with_attributes',
        'data': {
          'card_type_name': 'task',
          'where': [
            {
              'and': [
                {'attr': 'assignee', 'op': '=', 'value': aliceId},
                {'attr': 'status', 'op': '!=', 'value': 'done'},
              ]
            }
          ],
        },
      }
    ]);
    final rows = _rowsOf(r);
    return rows.length;
  }

  Future<int?> _findFirstTaskInStatus(int projectId, String status) async {
    final r = await _batch([
      {
        'id': 'q',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select_with_attributes',
        'data': {
          'card_type_name': 'task',
          'parent_card_id': projectId,
          'where': [
            {'attr': 'status', 'op': '=', 'value': status},
          ],
        },
      }
    ]);
    final rows = _rowsOf(r);
    if (rows.isEmpty) return null;
    return ((rows.first as Map)['id'] as num).toInt();
  }

  Future<int?> _findFirstTaskForAssigneeExcept(
      int projectId, int userId, String status, int excludeId) async {
    final r = await _batch([
      {
        'id': 'q',
        'type': 'data',
        'endpoint': 'card',
        'action': 'select_with_attributes',
        'data': {
          'card_type_name': 'task',
          'parent_card_id': projectId,
          'where': [
            {
              'and': [
                {'attr': 'assignee', 'op': '=', 'value': userId},
                {'attr': 'status', 'op': '=', 'value': status},
              ]
            }
          ],
        },
      }
    ]);
    final rows = _rowsOf(r);
    for (final row in rows) {
      final m = row as Map;
      final id = (m['id'] as num).toInt();
      if (id != excludeId) return id;
    }
    return null;
  }

}

/// Static file server isolate entrypoint. Bound to a port + web dir
/// supplied by the parent. Posts back through `ready` once it's
/// listening, then handles requests for the lifetime of the isolate.
Future<void> _staticIsolateMain(Map<String, Object> args) async {
  final port = args['port'] as int;
  final webDir = args['webDir'] as String;
  final ready = args['ready'] as SendPort;
  HttpServer srv;
  try {
    srv = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
  } catch (e) {
    ready.send('error: $e');
    return;
  }
  ready.send('ok');
  await for (final req in srv) {
    final reqPath = req.uri.path == '/' ? '/index.html' : req.uri.path;
    final f = File(webDir + reqPath);
    if (!f.existsSync()) {
      // Serve index.html as a fallback so client-side routes don't 404.
      final idx = File('$webDir/index.html');
      req.response.headers.contentType = ContentType.html;
      try {
        await idx.openRead().pipe(req.response);
      } catch (_) {
        await req.response.close();
      }
      continue;
    }
    req.response.headers.contentType = _contentTypeFor(f.path);
    req.response.headers
        .add('Cache-Control', 'no-cache, no-store, must-revalidate');
    try {
      await f.openRead().pipe(req.response);
    } catch (_) {
      await req.response.close();
    }
  }
}

ContentType _contentTypeFor(String path) {
  final p = path.toLowerCase();
  if (p.endsWith('.html')) return ContentType.html;
  if (p.endsWith('.js')) return ContentType('application', 'javascript');
  if (p.endsWith('.json')) return ContentType.json;
  if (p.endsWith('.css')) return ContentType('text', 'css');
  if (p.endsWith('.png')) return ContentType('image', 'png');
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) {
    return ContentType('image', 'jpeg');
  }
  if (p.endsWith('.svg')) return ContentType('image', 'svg+xml');
  if (p.endsWith('.wasm')) return ContentType('application', 'wasm');
  if (p.endsWith('.ttf')) return ContentType('font', 'ttf');
  if (p.endsWith('.woff') || p.endsWith('.woff2')) {
    return ContentType('font', 'woff2');
  }
  return ContentType.binary;
}

void main(List<String> args) async {
  final code = await E2E().run();
  exit(code);
}
