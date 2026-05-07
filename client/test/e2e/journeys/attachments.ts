// attachments journey: upload a tiny text file from the task detail
// screen, wait for it to appear in the AttachmentsSection list, then
// "view" it by clicking the filename. Verifies the download URL returns
// the same bytes by re-fetching from the page's JS context.
//
// We can't easily watch Chrome's download directory in the e2e harness
// (headless save-as paths vary across chromedriver versions), so the
// click-to-view step is exercised through the AttachmentsSection's own
// `downloadAttachment` (which runs the auth'd fetch + blob URL trick),
// and we corroborate with a direct `fetch('/api/v1/attachment/{id}/download')`
// from the page to assert the bytes round-trip end-to-end.

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor, waitForUrl } from '../driver.ts';
import {
  loginAsSystemUser,
  sleep,
  waitForCountAtLeast,
} from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'attachments';

const FILE_NAME = 'kitp-e2e-attachment.txt';
const FILE_BODY = 'kitp e2e attachment payload — round-trip me\n';

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);

  // 1. Open the first project and the first task under it. Same shape
  //    as the task_detail journey — we depend on the seed data having
  //    at least one task somewhere.
  await waitForCountAtLeast(driver, 'ul a[href^="/project/"]', 1, 15_000);
  await (await driver.findElements(By.css('ul a[href^="/project/"]')))[0]!.click();
  await waitForUrl(driver, '/project/', 10_000);
  await waitFor(driver, '[data-testid="project-tasks-list"]', 15_000);
  await waitForCountAtLeast(
    driver,
    '[data-testid="project-tasks-list"] [data-card-id]',
    1,
    15_000,
  );
  await (
    await driver.findElements(
      By.css('[data-testid="project-tasks-list"] [data-card-id]'),
    )
  )[0]!.click();
  await waitForUrl(driver, '/task/', 10_000);

  // 2. Wait for the task detail screen to settle and the attachments
  //    dropzone to mount.
  await waitFor(driver, '[data-testid="task-detail"]', 15_000);
  await waitFor(driver, '[data-testid="attachments-dropzone"]', 15_000);
  // Brief settle so the in-flight initial fetches don't compete with
  // the upload XHR for the spinner.
  await sleep(driver, 400);
  await captureScreenshot(driver, journeyName, 'before_upload');

  // 3. Write a tiny text file to disk and upload it via the hidden
  //    <input type="file"> the dropzone exposes. Selenium's sendKeys
  //    on a file input is the canonical "browse and pick this file"
  //    affordance — it bypasses the OS file picker but still fires the
  //    `change` event the section listens for.
  const tmpFile = join(tmpdir(), FILE_NAME);
  await fs.writeFile(tmpFile, FILE_BODY, 'utf8');
  const fileInput = await driver.findElement(
    By.css('[data-testid="attachments-dropzone"] input[type="file"]'),
  );
  await fileInput.sendKeys(tmpFile);

  // 4. Wait for the row to appear in the list with our filename.
  await driver.wait(async () => {
    const items = await driver.findElements(
      By.css('[data-testid="attachments-list"] li button'),
    );
    for (const it of items) {
      const txt = (await it.getText()).trim();
      if (txt === FILE_NAME) return true;
    }
    return false;
  }, 15_000);
  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'after_upload');

  // 5. Pull the attachment id off the matching DOM node before we click —
  //    the in-page download fetch needs it for the `verify` step below.
  //    We grab it via a tiny script that walks the rendered list and
  //    reads the row's React-style key out of the data attributes the
  //    section sets when it mounts.
  //
  //    The list items don't carry an explicit data-id today, so we use
  //    the JSON dispatcher: call `attachment.list` from the page and
  //    pluck the row whose filename matches. That keeps the assertion
  //    independent of the DOM contract.
  const listResult = await driver.executeAsyncScript<string>(
    `
    const cb = arguments[arguments.length - 1];
    fetch('/api/v1/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subrequests: [{
          id: 'l',
          type: 'data',
          endpoint: 'attachment',
          action: 'list',
          ref: {},
          key: {},
          data: { card_id: Number(location.pathname.split('/').pop()) },
        }],
      }),
    })
      .then(r => r.json())
      .then(j => cb(JSON.stringify(j)))
      .catch(e => cb('ERR:' + String(e)));
    `,
  );
  if (listResult.startsWith('ERR:')) {
    throw new Error(`attachment.list fetch failed: ${listResult.slice(4)}`);
  }
  const parsed = JSON.parse(listResult) as {
    subresponses?: Array<{
      ok: boolean;
      data?: { rows?: Array<{ id: number; filename: string }> };
    }>;
  };
  const rows = parsed.subresponses?.[0]?.data?.rows ?? [];
  const ours = rows.find((r) => r.filename === FILE_NAME);
  if (ours === undefined) {
    throw new Error(
      `uploaded row not in attachment.list response: ${JSON.stringify(rows)}`,
    );
  }
  const attachmentId = ours.id;

  // 6. Click the filename button — the page's downloadAttachment runs
  //    fetch + blob-URL + programmatic anchor click. We can't easily
  //    inspect chrome's save-as outcome, but we can confirm the click
  //    didn't throw and didn't surface an error toast.
  const fileButton = await driver
    .findElements(By.css('[data-testid="attachments-list"] li button'))
    .then(async (els) => {
      for (const el of els) {
        if ((await el.getText()).trim() === FILE_NAME) return el;
      }
      throw new Error('uploaded file button not found in list');
    });
  await fileButton.click();
  // A brief settle: Toast is async (notify queues; the renderer flushes
  // on next tick). The Toast.svelte renderer flags errors via the danger
  // border-color utility — `border-danger` is the stable hook (the rest
  // of the class string changes with Tailwind). Match toast role + that
  // class to find error toasts only.
  await sleep(driver, 400);
  const errorToasts = await driver.findElements(
    By.css('[role="status"].border-danger'),
  );
  if (errorToasts.length > 0) {
    const messages = await Promise.all(errorToasts.map((t) => t.getText()));
    throw new Error(`error toast after download click: ${messages.join(' / ')}`);
  }

  // 7. Independent verification: fetch the download URL from the page's
  //    own context and confirm we get back the exact bytes we uploaded.
  //    This exercises the same auth path the click does, but lets us
  //    inspect the body.
  const downloadResult = await driver.executeAsyncScript<string>(
    `
    const cb = arguments[arguments.length - 1];
    const id = arguments[0];
    fetch('/api/v1/attachment/' + id + '/download')
      .then(async r => cb(JSON.stringify({ status: r.status, body: await r.text() })))
      .catch(e => cb('ERR:' + String(e)));
    `,
    attachmentId,
  );
  if (downloadResult.startsWith('ERR:')) {
    throw new Error(`download fetch failed: ${downloadResult.slice(4)}`);
  }
  const dl = JSON.parse(downloadResult) as { status: number; body: string };
  if (dl.status !== 200) {
    throw new Error(`download status ${dl.status}, want 200`);
  }
  if (dl.body !== FILE_BODY) {
    throw new Error(
      `download body mismatch: got ${JSON.stringify(dl.body)}, want ${JSON.stringify(FILE_BODY)}`,
    );
  }

  await captureScreenshot(driver, journeyName, 'after_view');

  // 8. Best-effort cleanup of the temp file. Failure to delete is
  //    non-fatal (the OS sweeps tmp anyway).
  try {
    await fs.unlink(tmpFile);
  } catch {
    // ignore
  }
}
