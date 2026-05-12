// large_id_roundtrip journey: bumps `card_id_seq` past 2^53, creates a
// card through the live HTTP API, and verifies the response carries the
// id intact as a JSON string (server's `json:",string"` tag) so the
// client's bigint decoder can recover it without precision loss.
//
// This is the Chrome-side gate for the "int64 IDs everywhere" rollout
// — companion to test/unit/dispatcher_bigint.test.ts which exercises
// the dispatcher's reviveIds in Node.
//
// Note: we use raw fetch + JSON inspection instead of routing through
// the Svelte dispatcher (which isn't exposed on window). The dispatcher
// is covered by the unit test; this journey covers the wire format in
// a real Chrome talking to a real kitpd.

import { execSync } from 'node:child_process';

import type { WebDriver } from 'selenium-webdriver';

import { loginAsSystemUser } from '../helpers.ts';

export const journeyName = 'large_id_roundtrip';

// 2^53 + 1 — first integer JS Number rounds. Anything above this proves
// the wire path preserves full int64 precision.
const LARGE_ID = '9007199254740993';

function dockerPsql(sql: string): string {
  return execSync(
    `docker exec kitp-pg psql -U kitp -d kitp -tAc ${JSON.stringify(sql)}`,
    { encoding: 'utf8' },
  ).trim();
}

export async function run(driver: WebDriver): Promise<void> {
  // Bump the card sequence one past the rounding boundary. The next
  // INSERT INTO card draws this exact id.
  dockerPsql(`SELECT setval('card_id_seq', ${LARGE_ID} - 1, true);`);

  await loginAsSystemUser(driver);

  // POST a card.insert via raw fetch from inside Chrome. We read the
  // response as text so we can grep the literal id digits before any
  // JSON.parse / Number() can round them.
  const result = await driver.executeAsyncScript<{
    status: number;
    text: string;
  }>(
    `const cb = arguments[arguments.length - 1];
     (async () => {
       try {
         const res = await fetch('/api/v1/batch', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             subrequests: [{
               id: 'large-id-test',
               endpoint: 'card',
               action: 'insert',
               data: {
                 card_type_name: 'project',
                 title: 'Large ID Round-Trip',
               },
             }],
           }),
         });
         cb({ status: res.status, text: await res.text() });
       } catch (e) {
         cb({ status: -1, text: String(e) });
       }
     })();`,
  );

  if (result.status !== 200) {
    throw new Error(
      `card.insert returned status ${result.status}: ${result.text}`,
    );
  }

  // The id must appear in the response body as the exact digit string —
  // both because the server emits it that way (`json:",string"`) and
  // because any IEEE-rounded value would have a different decimal form.
  if (!result.text.includes(`"${LARGE_ID}"`)) {
    throw new Error(
      `expected response to contain quoted id ${LARGE_ID}; got ${result.text}`,
    );
  }

  // Confirm the DB row matches. If the wire format dropped a bit,
  // postgres would have the rounded value and the SELECT below would
  // return 0 rows.
  const found = dockerPsql(
    `SELECT id FROM card WHERE id = ${LARGE_ID};`,
  );
  if (found !== LARGE_ID) {
    throw new Error(
      `expected card id ${LARGE_ID} in DB; got ${JSON.stringify(found)}`,
    );
  }

  // Now read it back through card.select_with_attributes and verify
  // the id field survives the response decode path the real client
  // uses. We inspect the raw text again rather than asking the page
  // to render the card — the goal is to validate the wire shape.
  const readBack = await driver.executeAsyncScript<{
    status: number;
    text: string;
  }>(
    `const cb = arguments[arguments.length - 1];
     (async () => {
       try {
         const res = await fetch('/api/v1/batch', {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify({
             subrequests: [{
               id: 'large-id-read',
               endpoint: 'card',
               action: 'select_with_attributes',
               data: { cardTypeName: 'project' },
             }],
           }),
         });
         cb({ status: res.status, text: await res.text() });
       } catch (e) {
         cb({ status: -1, text: String(e) });
       }
     })();`,
  );
  if (readBack.status !== 200) {
    throw new Error(`select returned ${readBack.status}: ${readBack.text}`);
  }
  if (!readBack.text.includes(`"${LARGE_ID}"`)) {
    throw new Error(
      `expected select response to contain "${LARGE_ID}"; got ${readBack.text}`,
    );
  }
}
