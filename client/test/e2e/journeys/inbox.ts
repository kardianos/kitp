// inbox journey: render the per-user inbox, drag a row to reorder, and
// confirm the optimistic update settles. Mid-drag we capture a screenshot
// to verify the fat-placeholder DropZone is visible.

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor } from '../driver.ts';
import { loginAsSystemUser, navigateSpa, sleep, waitForCountAtLeast } from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'inbox';

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);
  await navigateSpa(driver, '/inbox');

  // Wait for the inbox list. InboxScreen renders rows under
  // [data-testid="inbox-list"] with each TaskRow carrying [data-card-id].
  await waitFor(driver, '[data-testid="inbox-list"]', 15_000);
  const rows = await waitForCountAtLeast(
    driver,
    '[data-testid="inbox-list"] [data-card-id]',
    2,
    15_000,
  );
  await captureScreenshot(driver, journeyName, 'list');

  // Drag the first row down past the second using a pointer-events drag.
  // The DragHandle is a wrapper above each row; the underlying div is
  // marked with [data-row-id]. We grab the first row and drag down ~80px.
  const first = rows[0]!;
  const second = rows[1]!;
  const secondRect = await second.getRect();
  const firstRect = await first.getRect();
  const verticalDelta = Math.max(80, secondRect.height + 16);

  // Selenium's actions API uses Pointer move semantics. We move into the
  // first row, press, drag down, capture mid-drag, then release.
  // moveToElement(origin: el, x, y) — keep x/y at element center via 0.
  const actions = driver.actions({ async: true });
  await actions
    .move({ origin: first })
    .press()
    .move({
      origin: first,
      x: 0,
      y: Math.max(8, Math.floor((firstRect.height ?? 32) / 2) + 4),
    })
    // The dnd rune commits the drag once movement passes 4px; we move a
    // little further to ensure commit, then snapshot.
    .perform();

  // Now move past the second row to land on a distant DropZone.
  await driver.actions({ async: true })
    .move({
      origin: first,
      x: 0,
      y: verticalDelta,
    })
    .perform();

  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'drag_in_flight');

  // Release on the spot. Selenium's release() uses the current position.
  await driver.actions({ async: true }).release().perform();

  // Wait for the optimistic reorder to settle: post-drop the screen
  // refreshes via dispatcher.request<UserCardSortSetInput>; allow ~1s.
  await sleep(driver, 1200);

  // After reorder we expect a fresh row list — re-query and screenshot.
  await driver.wait(async () => {
    const elements = await driver.findElements(
      By.css('[data-testid="inbox-list"] [data-card-id]'),
    );
    return elements.length >= 2;
  }, 15_000);
  await captureScreenshot(driver, journeyName, 'after_reorder');
}
