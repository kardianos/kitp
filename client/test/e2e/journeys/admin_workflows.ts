// admin_workflows journey: render the workflow admin screen and
// snapshot it. Same requireAdmin redirect-stub fallback as the other
// admin journeys.

import { type WebDriver } from 'selenium-webdriver';

import { waitFor } from '../driver.ts';
import {
  elevateToAdmin,
  loginAsSystemUser,
  sleep,
} from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'admin_workflows';

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);
  await elevateToAdmin(driver);

  await driver.executeScript(
    `history.pushState({}, '', '/admin/workflows');
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
  await sleep(driver, 1500);

  let onAdmin = false;
  try {
    await waitFor(driver, '[data-testid="admin-workflows"]', 8_000);
    onAdmin = true;
  } catch {
    // requireAdmin redirected.
  }

  if (!onAdmin) {
    await captureScreenshot(driver, journeyName, 'list');
    // eslint-disable-next-line no-console
    console.warn(
      '[admin_workflows] requireAdmin guard redirected; admin journey ' +
      'captured the redirect target as a stub.',
    );
    return;
  }

  // The list may be empty (no workflow_def cards seeded) which is the
  // expected initial state — we just snapshot the empty admin shell.
  await sleep(driver, 400);
  await captureScreenshot(driver, journeyName, 'list');
}
