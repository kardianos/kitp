// gallery_esc journey: confirm the two-press Esc contract on the
// AttachmentsPreviewStrip gallery modal.
//
//   1. upload a tiny PNG so the strip renders one tile.
//   2. click the tile to open the gallery overlay.
//   3. press Esc once → gallery closes, URL stays on /task/<id>.
//   4. press Esc a second time → screen-level goBack fires, URL
//      leaves /task/.
//
// The capture-phase listener in AttachmentsPreviewStrip is what makes
// this work (the global Esc shortcut would otherwise fire FIRST and
// pop the screen on the very first press).

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { By, Key, type WebDriver } from 'selenium-webdriver';

import { waitFor, waitForUrl } from '../driver.ts';
import { loginAsSystemUser, sleep, waitForCountAtLeast } from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'gallery_esc';

// Minimal PNG: 1×1 red pixel. The exact bytes were generated once and
// pasted as base64 to keep the journey hermetic — image.Decode in the
// thumbnail generator only needs a valid PNG header + IDAT, and a
// 1×1 image is the smallest legal one.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function pressKey(driver: WebDriver, key: string): Promise<void> {
  await driver.actions({ async: true }).keyDown(key).keyUp(key).perform();
}

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);

  // 1. Drill into a task via the projects list, same as the
  //    attachments journey.
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
  const taskUrl = await driver.getCurrentUrl();
  await waitFor(driver, '[data-testid="task-detail"]', 15_000);
  await waitFor(driver, '[data-testid="attachments-dropzone"]', 15_000);
  await sleep(driver, 300);

  // 2. Upload the PNG. Decode the base64 to disk so the file input
  //    accepts it.
  const tmpFile = join(tmpdir(), 'kitp-gallery-esc.png');
  // Decode via Uint8Array — `Buffer` from node:buffer has a stricter
  // typing in @types/node 22 that node:fs.writeFile won't accept
  // unconditionally.
  const pngBytes = Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'));
  await fs.writeFile(tmpFile, pngBytes);
  const fileInput = await driver.findElement(
    By.css('[data-testid="attachments-dropzone"] input[type="file"]'),
  );
  await fileInput.sendKeys(tmpFile);

  // 3. Wait for the preview strip to mount (the strip only renders
  //    when at least one image/pdf attachment exists). The tile is a
  //    button with [data-testid="attachment-thumb-tile"].
  await waitFor(driver, '[data-testid="attachment-thumb-tile"]', 15_000);
  await sleep(driver, 400); // let the thumb URL settle so click hits a stable node
  await captureScreenshot(driver, journeyName, 'strip_visible');

  // 4. Click the tile → gallery modal opens.
  await (await driver.findElement(By.css('[data-testid="attachment-thumb-tile"]'))).click();
  await waitFor(driver, '[data-testid="attachment-gallery"]', 5_000);
  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'gallery_open');

  // 5. First Esc: gallery closes, URL stays on /task/<id>.
  await pressKey(driver, Key.ESCAPE);
  await driver.wait(async () => {
    const els = await driver.findElements(By.css('[data-testid="attachment-gallery"]'));
    return els.length === 0;
  }, 5_000);
  const stillOnTask = await driver.getCurrentUrl();
  if (stillOnTask !== taskUrl) {
    throw new Error(
      `first Esc should leave URL on the task; before=${taskUrl} after=${stillOnTask}`,
    );
  }
  await captureScreenshot(driver, journeyName, 'after_first_esc');

  // 6. Second Esc: screen-level goBack fires, we leave /task/.
  await pressKey(driver, Key.ESCAPE);
  await driver.wait(async () => {
    const cur = await driver.getCurrentUrl();
    return !cur.includes('/task/');
  }, 5_000);
  await captureScreenshot(driver, journeyName, 'after_second_esc');

  try {
    await fs.unlink(tmpFile);
  } catch {
    // ignored
  }
}
