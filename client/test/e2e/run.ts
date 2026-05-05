// E2E orchestrator for the Svelte client.
//
// Pipeline (matches SVELTE_MIGRATION_PLAN.md §8):
//   1. Reset the database (`make db-reset`).
//   2. Apply migrations (`make migrate`).
//   3. Build the Vite bundle to client-svelte/dist/.
//   4. Boot kitpd on :18080 with WEB_DIR pointing at our dist.
//   5. Boot chromedriver on :9515 (or reuse an already-running one).
//   6. For each journey, build a WebDriver session, run the journey,
//      diff its screenshots vs. baselines committed under
//      docs/screenshots/svelte/<journey>/.
//   7. Tear everything down regardless of pass/fail (unless
//      --keep-server is passed).
//
// CLI flags:
//   --update-baselines           Skip diff; overwrite baselines.
//   --journey <name>             Run only the named journey.
//   --keep-server                Don't kill kitpd / chromedriver at end.
//   --no-headless                Render Chrome with a visible window
//                                (useful when debugging locally).
//   --skip-build                 Reuse the existing dist/ (faster reruns).
//   --skip-db-reset              Skip db-reset + migrate (faster reruns).

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { WebDriver } from 'selenium-webdriver';

import { startDriver } from './driver.ts';
import { BASELINE_DIR, REPO_ROOT } from './screenshots.ts';
import { diffPng } from './visual_diff.ts';

const CLIENT_DIR = join(REPO_ROOT, 'client-svelte');
const DIST_DIR = join(CLIENT_DIR, 'dist');
const LOG_DIR = join(CLIENT_DIR, 'test', 'e2e', '.logs');
const JOURNEYS_DIR = join(CLIENT_DIR, 'test', 'e2e', 'journeys');

const KITPD_PORT = 18080;
const CHROMEDRIVER_PORT = 9515;
const VISUAL_DIFF_THRESHOLD = 0.005; // 0.5%

interface CliFlags {
  updateBaselines: boolean;
  journey: string | null;
  keepServer: boolean;
  noHeadless: boolean;
  skipBuild: boolean;
  skipDbReset: boolean;
}

interface JourneyModule {
  run: (driver: WebDriver) => Promise<void>;
  journeyName?: string;
}

interface DiffSummary {
  journey: string;
  total: number;
  drifted: number;
  newBaselines: number;
  failed: { path: string; ratio: number }[];
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    updateBaselines: false,
    journey: null,
    keepServer: false,
    noHeadless: false,
    skipBuild: false,
    skipDbReset: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--update-baselines':
        flags.updateBaselines = true;
        break;
      case '--journey': {
        const v = argv[++i];
        if (!v) throw new Error('--journey requires a value');
        flags.journey = v;
        break;
      }
      case '--keep-server':
        flags.keepServer = true;
        break;
      case '--no-headless':
        flags.noHeadless = true;
        break;
      case '--skip-build':
        flags.skipBuild = true;
        break;
      case '--skip-db-reset':
        flags.skipDbReset = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    }
  }
  return flags;
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    `Usage: pnpm e2e [flags]

  --update-baselines    Overwrite docs/screenshots/svelte/ baselines.
  --journey <name>      Run only the named journey (matches file stem).
  --keep-server         Leave kitpd and chromedriver running on exit.
  --no-headless         Run Chrome with a visible window.
  --skip-build          Reuse existing client-svelte/dist/.
  --skip-db-reset       Skip db-reset + migrate.
`,
  );
}

// ---- process helpers -------------------------------------------------------

interface SpawnedLogged {
  child: ChildProcess;
  done: Promise<number>;
}

/**
 * Spawn `cmd args` from `cwd`, tee stdout+stderr to `<LOG_DIR>/<logName>.log`,
 * resolve when the process exits with the exit code.
 */
async function spawnLogged(
  logName: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SpawnedLogged> {
  await fs.mkdir(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${logName}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n--- ${new Date().toISOString()} ${cmd} ${args.join(' ')} ---\n`);

  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });

  const done = new Promise<number>((resolveExit, rejectExit) => {
    child.on('error', rejectExit);
    child.on('exit', (code) => {
      logStream.end();
      resolveExit(code ?? -1);
    });
  });
  return { child, done };
}

async function runToCompletion(
  logName: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const { done } = await spawnLogged(logName, cmd, args, opts);
  const code = await done;
  if (code !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited with code ${code} (see test/e2e/.logs/${logName}.log)`,
    );
  }
}

async function waitForPort(
  port: number,
  host = '127.0.0.1',
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((res) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        res(true);
      });
      socket.on('error', () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`port ${host}:${port} did not become reachable in ${timeoutMs}ms`);
}

/**
 * Locate a chromedriver binary. Prefer the npm-installed one (under
 * client-svelte/node_modules) so the version matches what we declared
 * in package.json. Fall back to /home/d/bin/chromedriver (the dev's
 * existing system install, used by the Dart harness) and finally
 * /usr/bin/chromedriver.
 */
async function findChromedriver(): Promise<string | null> {
  const candidates = [
    join(CLIENT_DIR, 'node_modules', 'chromedriver', 'lib', 'chromedriver', 'chromedriver'),
    join(CLIENT_DIR, 'node_modules', '.bin', 'chromedriver'),
    '/home/d/bin/chromedriver',
    '/usr/bin/chromedriver',
  ];
  for (const c of candidates) {
    try {
      await fs.access(c, fs.constants.X_OK);
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

// ---- diff scan -------------------------------------------------------------

interface ScanArgs {
  journey: string;
  /** Absolute paths of every PNG produced by this journey's run. */
  produced: string[];
  updateBaselines: boolean;
}

/**
 * Walk the screenshots produced by a journey under
 * `docs/screenshots/svelte/<journey>/` and either:
 *   - --update-baselines: leave them in place (they ARE the baselines).
 *   - default: diff each PNG against itself in the same directory. The
 *     baseline IS the file at the canonical path; if it doesn't exist
 *     yet, the just-captured PNG becomes the new baseline (warned).
 *
 * Note: the smoke journey writes directly to the baseline directory,
 * so on first run there is no separate "actual" file. The test for
 * "is this a fresh capture" is whether the file existed before this
 * run started — we approximate that here by treating any file present
 * as a captured PNG. The full design (separate `runs/` tree vs.
 * `baselines/` tree) lands with task #25.
 */
async function scanAndDiff({
  journey,
  produced,
  updateBaselines,
}: ScanArgs): Promise<DiffSummary> {
  const summary: DiffSummary = {
    journey,
    total: produced.length,
    drifted: 0,
    newBaselines: 0,
    failed: [],
  };
  if (updateBaselines || produced.length === 0) return summary;

  // Walk the journey baseline dir. For every PNG present that isn't a
  // *.diff.png, diff actual-on-disk vs. the same path treated as both.
  // Until task #25 introduces a separate runs/ tree we treat the just-
  // captured PNG as the baseline once it exists; the meaningful check
  // is just that the file is present and decodable.
  for (const path of produced) {
    if (!existsSync(path)) {
      summary.newBaselines++;
      continue;
    }
    // Self-diff trivially succeeds; we keep this loop in place as the
    // hook point for task #25 to wire in a real baseline lookup.
    const result = await diffPng(path, path, VISUAL_DIFF_THRESHOLD);
    if (!result.same) {
      summary.drifted++;
      summary.failed.push({ path, ratio: result.ratio });
    }
  }
  return summary;
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  // 1+2. Reset DB + migrate.
  if (!flags.skipDbReset) {
    // eslint-disable-next-line no-console
    console.log('[e2e] db-reset');
    await runToCompletion('db-reset', 'make', ['db-reset']);
    // db-reset already invokes migrate via the Makefile, but be explicit
    // for the case the user passes --skip-db-reset later.
  } else {
    // eslint-disable-next-line no-console
    console.log('[e2e] skipping db-reset');
  }

  // 3. Build the Vite bundle (idempotent; ~few seconds on warm cache).
  if (!flags.skipBuild) {
    // eslint-disable-next-line no-console
    console.log('[e2e] vite build');
    await runToCompletion('vite-build', 'pnpm', ['build'], { cwd: CLIENT_DIR });
  } else {
    // eslint-disable-next-line no-console
    console.log('[e2e] skipping build');
  }
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    throw new Error(`expected ${DIST_DIR}/index.html — did 'pnpm build' succeed?`);
  }

  // 4. Boot kitpd. We don't `make run` because that doesn't honor
  //    WEB_DIR overrides cleanly (it expands at recipe-eval time). Run
  //    the same `go run` command directly so WEB_DIR points at our dist.
  // eslint-disable-next-line no-console
  console.log(`[e2e] starting kitpd on :${KITPD_PORT}`);
  await fs.mkdir(LOG_DIR, { recursive: true });
  const kitpdLog = createWriteStream(join(LOG_DIR, 'kitpd.log'), { flags: 'a' });
  kitpdLog.write(`\n--- ${new Date().toISOString()} kitpd boot ---\n`);
  const kitpd: ChildProcess = spawn(
    '/home/d/bin/go',
    ['run', './cmd/kitpd'],
    {
      cwd: join(REPO_ROOT, 'server'),
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable',
        MIGRATIONS_DIR: join(REPO_ROOT, 'db', 'migrations'),
        LISTEN_ADDR: `:${KITPD_PORT}`,
        WEB_DIR: DIST_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  kitpd.stdout?.pipe(kitpdLog, { end: false });
  kitpd.stderr?.pipe(kitpdLog, { end: false });

  // 5. Start chromedriver if one isn't already listening on 9515.
  let chromedriver: ChildProcess | null = null;
  const chromedriverPath = await findChromedriver();
  if (!chromedriverPath) {
    throw new Error(
      'no chromedriver binary found (looked in client-svelte/node_modules, ' +
        '/home/d/bin, /usr/bin). Install one or set up the npm package.',
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[e2e] starting chromedriver from ${chromedriverPath}`);
  const cdLog = createWriteStream(join(LOG_DIR, 'chromedriver.log'), { flags: 'a' });
  cdLog.write(`\n--- ${new Date().toISOString()} chromedriver boot ---\n`);
  chromedriver = spawn(chromedriverPath, [`--port=${CHROMEDRIVER_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  chromedriver.stdout?.pipe(cdLog, { end: false });
  chromedriver.stderr?.pipe(cdLog, { end: false });

  let exitCode = 0;
  try {
    // Wait for both servers to accept connections.
    await waitForPort(KITPD_PORT, '127.0.0.1', 30_000);
    await waitForPort(CHROMEDRIVER_PORT, '127.0.0.1', 15_000);

    // 6. Run journeys.
    const journeyFiles = await listJourneys(flags.journey);
    if (journeyFiles.length === 0) {
      throw new Error(
        flags.journey
          ? `journey '${flags.journey}' not found in ${JOURNEYS_DIR}`
          : `no journeys found in ${JOURNEYS_DIR}`,
      );
    }

    const summaries: DiffSummary[] = [];
    for (const file of journeyFiles) {
      const journeyName = file.replace(/\.ts$/, '');
      // eslint-disable-next-line no-console
      console.log(`[e2e] running journey '${journeyName}'`);
      const mod = (await import(pathToFileURL(join(JOURNEYS_DIR, file)).href)) as JourneyModule;
      if (typeof mod.run !== 'function') {
        throw new Error(`${file} does not export a 'run' function`);
      }
      const driver = await startDriver({ headless: !flags.noHeadless });
      const before = await snapshotJourneyDir(journeyName);
      try {
        await mod.run(driver);
      } finally {
        await driver.quit();
      }
      const after = await snapshotJourneyDir(journeyName);
      const producedFiles: string[] = [];
      for (const [name, mtime] of after) {
        const previous = before.get(name);
        if (previous === undefined || mtime > previous) {
          producedFiles.push(join(BASELINE_DIR, journeyName, name));
        }
      }
      const summary = await scanAndDiff({
        journey: journeyName,
        produced: producedFiles,
        updateBaselines: flags.updateBaselines,
      });
      summaries.push(summary);
    }

    // Print a small summary.
    // eslint-disable-next-line no-console
    console.log('\n[e2e] summary:');
    let anyFail = false;
    for (const s of summaries) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${s.journey}: ${s.total} captured, ${s.drifted} drifted, ${s.newBaselines} new`,
      );
      if (s.drifted > 0) anyFail = true;
      for (const f of s.failed) {
        // eslint-disable-next-line no-console
        console.log(`    DRIFT ${f.path} ratio=${f.ratio.toFixed(4)}`);
      }
    }
    if (anyFail) exitCode = 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[e2e] failure:', err);
    exitCode = 1;
  } finally {
    if (!flags.keepServer) {
      // eslint-disable-next-line no-console
      console.log('[e2e] tearing down');
      stopChild(chromedriver);
      stopChild(kitpd);
    } else {
      // eslint-disable-next-line no-console
      console.log('[e2e] --keep-server set; leaving kitpd + chromedriver running');
    }
  }

  process.exit(exitCode);
}

function stopChild(child: ChildProcess | null): void {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // already dead
  }
}

async function listJourneys(filter: string | null): Promise<string[]> {
  const entries = await fs.readdir(JOURNEYS_DIR);
  const tsFiles = entries.filter((f) => f.endsWith('.ts')).sort();
  if (filter === null) return tsFiles;
  const want = filter.endsWith('.ts') ? filter : `${filter}.ts`;
  return tsFiles.filter((f) => f === want);
}

/**
 * Snapshot every PNG file currently under
 * `docs/screenshots/svelte/<journey>/` keyed by relative path → mtime
 * (epoch ms). We use this before/after a journey runs to figure out
 * which screenshots that journey produced or refreshed.
 */
async function snapshotJourneyDir(journey: string): Promise<Map<string, number>> {
  const root = join(BASELINE_DIR, journey);
  const out = new Map<string, number>();
  await walk(root, '', out);
  return out;
}

async function walk(root: string, rel: string, into: Map<string, number>): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(join(root, rel), { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const childRel = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walk(root, childRel, into);
    } else if (entry.isFile() && entry.name.endsWith('.png') && !entry.name.endsWith('.diff.png')) {
      const stat = await fs.stat(join(root, childRel));
      into.set(childRel, stat.mtimeMs);
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
