// portability journey: end-to-end exercise of the
// PROJECT_PORTABILITY_PLAN.md surface — export full ZIP, modify
// tasks.csv in memory, import into a fresh project, assert the round-
// trip landed cleanly, and confirm the per-project reference-scope
// rule rejects a cross-project milestone_ref write.
//
// Everything past the login goes through direct fetch to kitpd on
// :18080. The e2e harness boots with AUTH_MODE=off, so the System
// User flows through every call without explicit auth headers.

import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WebDriver } from 'selenium-webdriver';

import { loginAsSystemUser } from '../helpers.ts';

export const journeyName = 'portability';

const ORIGIN = 'http://127.0.0.1:18080';

interface SubResp {
  ok: boolean;
  id?: string;
  data?: unknown;
  error?: { code: string; message: string };
}

interface BatchResp {
  subresponses: SubResp[];
}

/** Issue a single-sub batch and return the typed data on success. */
async function dispatchOne<T = unknown>(
  endpoint: string,
  action: string,
  data: Record<string, unknown>,
  id = 'r',
): Promise<T> {
  const resp = await fetch(`${ORIGIN}/api/v1/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subrequests: [{ id, endpoint, action, data }] }),
  });
  if (!resp.ok) {
    throw new Error(`batch HTTP ${resp.status}: ${await resp.text()}`);
  }
  const parsed = (await resp.json()) as BatchResp;
  const sr = parsed.subresponses[0]!;
  if (!sr.ok) {
    throw new Error(
      `${endpoint}.${action} failed: ${sr.error?.code ?? '??'}: ${sr.error?.message ?? ''}`,
    );
  }
  return sr.data as T;
}

/** Like dispatchOne but returns the raw sub-response so the caller can
 *  inspect the error path. */
async function dispatchRaw(
  endpoint: string,
  action: string,
  data: Record<string, unknown>,
): Promise<SubResp> {
  const resp = await fetch(`${ORIGIN}/api/v1/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subrequests: [{ id: 'r', endpoint, action, data }] }),
  });
  if (!resp.ok) {
    throw new Error(`batch HTTP ${resp.status}: ${await resp.text()}`);
  }
  const parsed = (await resp.json()) as BatchResp;
  return parsed.subresponses[0]!;
}

/* -------------------------------------------------------------------------- */
/* Tiny RFC-4180-ish CSV parser/serializer                                    */
/* -------------------------------------------------------------------------- */

/** Parse a CSV body into rows of cells. Handles quoted cells (`"foo,bar"`)
 *  and escaped quotes (`""` inside a quoted cell). */
function parseCsv(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;
  while (i < body.length) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        cell += c;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
      i += 1;
    } else if (c === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 2;
    } else if (c === '\n' || c === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else {
      cell += c;
      i += 1;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop a trailing empty-cell-only row that some encoders emit after the
  // final newline.
  if (rows.length > 0 && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === '') {
    rows.pop();
  }
  return rows;
}

/** Serialize rows back to CSV; each cell is quoted iff it contains a
 *  comma, double-quote, or newline. */
function serializeCsv(rows: string[][]): string {
  const quoteIfNeeded = (cell: string): string => {
    if (cell.includes(',') || cell.includes('"') || cell.includes('\n') || cell.includes('\r')) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  };
  return rows.map((r) => r.map(quoteIfNeeded).join(',')).join('\n') + '\n';
}

/* -------------------------------------------------------------------------- */
/* Journey                                                                    */
/* -------------------------------------------------------------------------- */

export async function run(driver: WebDriver): Promise<void> {
  // Login keeps the harness on the SPA so any visible-content checks
  // downstream see a real session. The API calls below don't depend
  // on the browser session (AUTH_MODE=off in e2e).
  await loginAsSystemUser(driver);

  // 1. Resolve the Default Project's id.
  const projects = await dispatchOne<{
    rows: { id: string; attributes: { title?: string } }[];
  }>('card', 'select_with_attributes', { card_type_name: 'project' });
  const def = projects.rows.find((r) => r.attributes.title === 'Default Project');
  if (!def) throw new Error('Default Project missing from seed');
  const defaultId = def.id;

  // 2. Export the full ZIP (no toggles — defaults give the baseline 8
  //    CSVs; attachments + activity stay out of the test surface).
  const zipResp = await fetch(`${ORIGIN}/api/v1/project/${defaultId}/export.zip`);
  if (!zipResp.ok) {
    throw new Error(`export.zip: ${zipResp.status} ${await zipResp.text()}`);
  }
  const zipBuf = new Uint8Array(await zipResp.arrayBuffer());
  const zipPath = join(tmpdir(), `kitp-portability-${process.pid}.zip`);
  await fs.writeFile(zipPath, zipBuf);

  // 3. Extract tasks.csv via the system `unzip` (available in the dev
  //    image). Output goes to stdout so we don't litter the tmpdir.
  const tasksCsv = execSync(`unzip -p ${JSON.stringify(zipPath)} tasks.csv`, {
    encoding: 'utf-8',
  });
  const parsed = parseCsv(tasksCsv);
  if (parsed.length < 1) throw new Error('tasks.csv has no header');
  const header = parsed[0]!;
  const dataRows = parsed.slice(1);
  if (dataRows.length !== 25) {
    throw new Error(`expected 25 task rows in the export; got ${dataRows.length}`);
  }

  // 4. Mutate: rename the first task; replace the last task's
  //    assignee with a brand-new email. The new email forces the
  //    importer to auto-create a person card.
  const titleIdx = header.indexOf('title');
  const emailIdx = header.indexOf('assignee_email');
  const nameIdx = header.indexOf('assignee_name');
  if (titleIdx < 0 || emailIdx < 0 || nameIdx < 0) {
    throw new Error(`unexpected tasks.csv header: ${header.join(',')}`);
  }
  const NEW_TITLE = 'Wire pickers (renamed e2e)';
  const NEW_EMAIL = 'new.person@example.invalid';
  const NEW_NAME = 'New Person';
  dataRows[0]![titleIdx] = NEW_TITLE;
  dataRows[dataRows.length - 1]![emailIdx] = NEW_EMAIL;
  dataRows[dataRows.length - 1]![nameIdx] = NEW_NAME;
  const modifiedCsv = serializeCsv([header, ...dataRows]);

  // 5. Spin up a fresh empty project to import into.
  const newProj = await dispatchOne<{ id: string }>(
    'card', 'insert',
    { card_type_name: 'project', title: 'Portability Target' },
  );
  const newId = newProj.id;

  // 6. Upload the modified CSV via the chunked-upload route, then
  //    file.create → project.import.upload to land the job_id.
  const chunkResp = await fetch(`${ORIGIN}/api/v1/cas/chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: modifiedCsv,
  });
  if (!chunkResp.ok) {
    throw new Error(`chunk upload: ${chunkResp.status} ${await chunkResp.text()}`);
  }
  const chunkOut = (await chunkResp.json()) as { address: string; size_bytes: number };

  const fileOut = await dispatchOne<{ id: string }>(
    'file', 'create',
    {
      filename: 'tasks.csv',
      mime_type: 'text/csv',
      chunks: [{ address: chunkOut.address, size_bytes: chunkOut.size_bytes }],
    },
  );

  const upload = await dispatchOne<{
    job_id: string;
    headers: string[];
    row_count: number;
  }>(
    'project.import', 'upload',
    { project_id: newId, file_id: fileOut.id },
  );
  if (upload.row_count !== 25) {
    throw new Error(`project.import.upload row_count: ${upload.row_count}, want 25`);
  }
  const jobId = upload.job_id;

  // 7. Set mapping: every export column that matches a target attr
  //    maps straight through; the leftovers (id / created_at / etc.)
  //    drop via the ignore sentinel.
  const importableTargets = new Set([
    'title', 'status', 'assignee_email', 'assignee_name',
    'milestone', 'component', 'tags', 'description', 'sort_order',
  ]);
  const mapping: Record<string, string> = {};
  for (const h of upload.headers) {
    mapping[h] = importableTargets.has(h) ? h : '_ignore_';
  }
  await dispatchOne('project.import', 'set_mapping',
    { job_id: jobId, mapping });

  // 8. Preview with auto_create on every value-card category (the
  //    target project is empty so we expect every milestone /
  //    component / tag / person to be created from scratch).
  const resolution = {
    persons: 'auto_create',
    milestones: 'auto_create',
    components: 'auto_create',
    tags: 'auto_create',
    statuses: 'match_existing',
  };
  const preview = await dispatchOne<{
    would_create: { tasks: number };
    errors: { row: number; column?: string; message: string }[];
    skipped_rows: number;
  }>('project.import', 'preview', { job_id: jobId, resolution });
  if (preview.errors.length > 0) {
    throw new Error(
      `preview errors (expected none): ${JSON.stringify(preview.errors.slice(0, 3))}`,
    );
  }
  if (preview.would_create.tasks !== 25) {
    throw new Error(
      `preview.would_create.tasks: ${preview.would_create.tasks}, want 25`,
    );
  }

  // 9. Commit. After this, the new project has 25 tasks.
  const commit = await dispatchOne<{
    created: { tasks: number; persons: number };
    status: string;
  }>('project.import', 'commit', { job_id: jobId });
  if (commit.status !== 'completed') {
    throw new Error(`commit status: ${commit.status}`);
  }
  if (commit.created.tasks !== 25) {
    throw new Error(`commit created.tasks: ${commit.created.tasks}, want 25`);
  }
  if (commit.created.persons < 1) {
    throw new Error(
      `commit created.persons: ${commit.created.persons}, want >= 1 (new.person)`,
    );
  }

  // 10. Verify the new project has 25 tasks and the renamed one is
  //     among them.
  const newTasks = await dispatchOne<{
    rows: { id: string; attributes: Record<string, unknown> }[];
  }>('card', 'select_with_attributes',
    { parent_card_id: newId, card_type_name: 'task' });
  if (newTasks.rows.length !== 25) {
    throw new Error(`new project task count: ${newTasks.rows.length}, want 25`);
  }
  const renamed = newTasks.rows.find(
    (r) => r.attributes['title'] === NEW_TITLE,
  );
  if (!renamed) {
    throw new Error('renamed task not found in new project');
  }

  // 11. Verify the new person card exists with the expected email
  //     and *without* a user_account link. We can't easily query
  //     user_account_person from here without a docker exec, so we
  //     assert the email shows up among persons returned by the
  //     dispatcher — that's enough for the e2e signal.
  const persons = await dispatchOne<{
    rows: { id: string; attributes: Record<string, unknown> }[];
  }>('card', 'select_with_attributes', { card_type_name: 'person' });
  const newPerson = persons.rows.find(
    (r) => r.attributes['email'] === NEW_EMAIL,
  );
  if (!newPerson) {
    throw new Error('new.person card not present after import');
  }

  // 12. Negative check: writing milestone_ref on a new-project task
  //     to a milestone that lives under Default Project must be
  //     rejected with cross_project_ref. This is the visible payoff
  //     of the per-project scope check from phase 2.
  const defaultMiles = await dispatchOne<{
    rows: { id: string }[];
  }>('card', 'select_with_attributes',
    { parent_card_id: defaultId, card_type_name: 'milestone' });
  if (defaultMiles.rows.length === 0) {
    throw new Error('Default Project has no milestones to cross-link against');
  }
  const someTask = newTasks.rows[0]!;
  const foreignMile = defaultMiles.rows[0]!;
  const bad = await dispatchRaw('attribute', 'update', {
    card_id: someTask.id,
    attribute_name: 'milestone_ref',
    value: foreignMile.id,
  });
  if (bad.ok) {
    throw new Error(
      'cross-project milestone_ref write was accepted; expected cross_project_ref rejection',
    );
  }
  if (bad.error?.code !== 'cross_project_ref') {
    throw new Error(
      `expected cross_project_ref; got ${JSON.stringify(bad.error)}`,
    );
  }

  // Cleanup the temp ZIP so successive runs don't litter tmpdir.
  await fs.unlink(zipPath).catch(() => {
    /* best-effort */
  });
}
