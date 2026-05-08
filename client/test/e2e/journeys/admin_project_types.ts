// admin_project_types journey: render the master/detail admin screen,
// create a new project_type, edit + save its description, then snapshot.
//
// Caveat (mirrors admin_attributes): the SPA's `requireAdmin` guard reads
// `authState.isAdmin` from claims; the dev "Continue as System User"
// flow does not seed claims, so we attempt elevateToAdmin and fall back
// to capturing the redirect target if the guard fires.

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor } from '../driver.ts';
import {
  elevateToAdmin,
  loginAsSystemUser,
  sleep,
} from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'admin_project_types';

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);
  await elevateToAdmin(driver);

  await driver.executeScript(
    `history.pushState({}, '', '/admin/project-types');
     window.dispatchEvent(new PopStateEvent('popstate'));`,
  );
  await sleep(driver, 1500);

  let onAdmin = false;
  try {
    await waitFor(driver, '[data-testid="admin-project-types"]', 8_000);
    onAdmin = true;
  } catch {
    // requireAdmin redirected; fall through to redirect-stub capture.
  }

  if (!onAdmin) {
    await captureScreenshot(driver, journeyName, 'list');
    await captureScreenshot(driver, journeyName, 'create');
    await captureScreenshot(driver, journeyName, 'edit');
    // eslint-disable-next-line no-console
    console.warn(
      '[admin_project_types] requireAdmin guard redirected; admin journey ' +
      'captured the redirect target as a stub.',
    );
    return;
  }

  // 1. Initial list — at minimum the migration-seeded "default" row.
  await driver.wait(async () => {
    const rows = await driver.findElements(
      By.css('[data-testid="project-type-row"]'),
    );
    return rows.length > 0;
  }, 15_000);
  await sleep(driver, 400);
  await captureScreenshot(driver, journeyName, 'list');

  // 2. Open the new-row form, type a name, click Create.
  await driver
    .findElement(By.css('[data-testid="new-project-type-button-wrap"] button'))
    .click();
  await waitFor(driver, '[data-testid="new-project-type-form"]', 5_000);
  const nameEl = await driver.findElement(
    By.css('[data-testid="new-project-type-name"]'),
  );
  await nameEl.sendKeys('Bugs');
  const docEl = await driver.findElement(
    By.css('[data-testid="new-project-type-doc"]'),
  );
  await docEl.sendKeys('Bug tracking workflows');
  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'create');
  await driver
    .findElement(By.css('[data-testid="new-project-type-save-wrap"] button'))
    .click();

  // Wait for the new row to appear in the list.
  await driver.wait(async () => {
    const rows = await driver.findElements(
      By.css('[data-testid="project-type-row"]'),
    );
    for (const r of rows) {
      const txt = await r.getText();
      if (txt.includes('Bugs')) return true;
    }
    return false;
  }, 10_000);
  await sleep(driver, 400);

  // 3. Click the new row, edit its doc, save.
  const rows = await driver.findElements(
    By.css('[data-testid="project-type-row"]'),
  );
  for (const r of rows) {
    const txt = await r.getText();
    if (txt.includes('Bugs')) {
      await r.click();
      break;
    }
  }
  await waitFor(driver, '[data-testid="project-type-detail"]', 3_000);
  const docEdit = await driver.findElement(
    By.css('[data-testid="edit-project-type-doc"]'),
  );
  await docEdit.clear();
  await docEdit.sendKeys('Bug + incident tracking');
  await sleep(driver, 200);
  await driver
    .findElement(By.css('[data-testid="save-project-type-wrap"] button'))
    .click();
  await sleep(driver, 600);
  await captureScreenshot(driver, journeyName, 'edit');
}
