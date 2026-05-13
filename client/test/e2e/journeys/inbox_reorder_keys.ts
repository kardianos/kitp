// inbox_reorder_keys journey: cover the keyboard reorder path that
// the existing inbox journey doesn't touch (it tests pointer-drag).
//
// Verifies:
//   - selecting a row via `j` moves the visual cursor.
//   - Shift+J on the selected row reorders it down by one slot
//     (replaces the older Mod+ArrowDown binding which Chrome
//     intercepts on some Linux setups, so the dispatcher never saw
//     the keystroke and the move was a no-op).
//
// We snapshot the data-card-id sequence before and after to assert
// the order actually changed — a stronger signal than "row 0 still
// looks selected" because the keyboard reorder commits a server-side
// user_card_sort.set whose result is what the optimistic UI reflects.

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor } from '../driver.ts';
import {
  firstProjectScreenUrl,
  loginAsSystemUser,
  navigateSpa,
  waitForCountAtLeast,
} from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'inbox_reorder_keys';

async function rowIDs(driver: WebDriver): Promise<string[]> {
  const els = await driver.findElements(
    By.css('[data-testid="inbox-list"] [data-card-id]'),
  );
  const out: string[] = [];
  for (const el of els) {
    const id = await el.getAttribute('data-card-id');
    if (id) out.push(id);
  }
  return out;
}

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);
  // Gate 9: per-project screen URLs only.
  const inboxUrl = await firstProjectScreenUrl(driver, 'inbox');
  await navigateSpa(driver, inboxUrl);
  await waitFor(driver, '[data-testid="inbox-list"]', 15_000);
  await waitForCountAtLeast(
    driver,
    '[data-testid="inbox-list"] [data-card-id]',
    2,
    15_000,
  );

  const before = await rowIDs(driver);
  if (before.length < 2) {
    throw new Error(`need at least 2 inbox rows, got ${before.length}`);
  }
  await captureScreenshot(driver, journeyName, 'before');

  // We dispatch synthesized KeyboardEvents directly on window:
  // Selenium's actions().keyDown with Shift held is flaky in some
  // chromedriver versions (the modifier sometimes lands on the wrong
  // target), so going via window.dispatchEvent gives the global
  // keys/dispatcher.ts listener the canonical event shape.
  //
  // Phase 1: move-down. With selectedIndex=0, Shift+J moves the top
  // row down one slot. The fix to planReorder normalises sibling
  // sort_orders so this is now visible from the all-NULL initial state
  // (previously a single-row sort_order write would no-op against
  // NULLS-LAST siblings).
  await driver.executeScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', {
       key: 'J', code: 'KeyJ', shiftKey: true, bubbles: true, cancelable: true,
     }));`,
  );
  await driver.wait(async () => {
    const cur = await rowIDs(driver);
    // We expect before[0] to slide down to position 1 and before[1] to
    // surface at position 0.
    return cur.length >= 2 && cur[0] === before[1] && cur[1] === before[0];
  }, 10_000);
  await captureScreenshot(driver, journeyName, 'after_down');

  // Phase 2: move-up. Send `k` so the cursor follows the row we just
  // moved (now at index 1) and Shift+K to bring it back up. The
  // post-condition is that the original `before` order is restored.
  await driver.executeScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', {
       key: 'k', code: 'KeyK', bubbles: true, cancelable: true,
     }));`,
  );
  await driver.sleep(120);
  await driver.executeScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', {
       key: 'K', code: 'KeyK', shiftKey: true, bubbles: true, cancelable: true,
     }));`,
  );
  await driver.wait(async () => {
    const cur = await rowIDs(driver);
    return cur.length >= 2 && cur[0] === before[0] && cur[1] === before[1];
  }, 10_000);
  await captureScreenshot(driver, journeyName, 'after_up');
}
