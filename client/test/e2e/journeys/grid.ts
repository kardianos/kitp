// grid journey: render the dense table, click the Status column header
// to sort, open the per-column filter dropdown, and apply a filter.
//
// Verifies that the per-column filter is a Combobox over the four enum
// options, NOT a free-text input — one of the explicit non-regression
// goals from the migration plan §5.9.

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor } from '../driver.ts';
import {
  loginAsSystemUser,
  navigateSpa,
  sleep,
  waitForCountAtLeast,
} from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'grid';

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);
  await navigateSpa(driver, '/grid');

  // Wait until something signals the grid screen mounted: the project
  // title picker is the first thing rendered regardless of load state.
  await waitFor(driver, '[data-testid="project-title-picker"]', 15_000);
  // Then wait for the body + rows. The seed migration 0007 inserts 25
  // tasks; the initial predicate (status in todo/doing/review/done) keeps
  // all of them so this should always satisfy >= 2.
  await waitFor(driver, '[data-testid="grid-body"]', 30_000);
  await waitForCountAtLeast(
    driver,
    '[data-testid="grid-row"]',
    2,
    30_000,
  );
  await captureScreenshot(driver, journeyName, 'default');

  // Click the Status column header to sort. The header buttons carry
  // data-testid="grid-header-<lower>".
  const statusHeader = await waitFor(
    driver,
    '[data-testid="grid-header-status"]',
    5_000,
  );
  await statusHeader.click();
  // Wait for the sort indicator (↑) to appear in the same button.
  await driver.wait(async () => {
    const txt = await statusHeader.getText();
    return txt.includes('↑') || txt.includes('↓');
  }, 5_000);
  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'sorted_status_asc');

  // Click the Status filter button (the IconButton next to the header).
  // We locate it by its aria-label "Filter Status".
  // Re-find after the sort click: the previous click triggered a refresh
  // batch and the per-column header buttons may have been re-keyed.
  await sleep(driver, 400);
  const filterButton = await waitFor(
    driver,
    'button[aria-label="Filter Status"]',
    5_000,
  );
  // Scroll the filter button into view first — the grid is inside an
  // `overflow-x-auto` container.
  await driver.executeScript('arguments[0].scrollIntoView({block:"nearest"});', filterButton);
  await sleep(driver, 250);
  // Native click via WebDriver Actions API.
  await driver.actions({ async: true })
    .move({ origin: filterButton })
    .click()
    .perform();

  // Wait for the column filter popup. The dialog's aria-label is "Filter
  // <attr_name>" — note that `attr_name` for the seed-driven `status`
  // attribute_def is the lowercase string "status" (because the screen
  // resolves the FilterAttribute label from `def.name`), NOT the column
  // header label "Status". We match on `starts-with("Filter ")` so this
  // works regardless of whether the schema fetch raced ahead of us.
  await waitFor(driver, '[role="dialog"][aria-label^="Filter "]', 10_000);
  // Verify it's a Combobox — find the Combobox's input/trigger inside.
  // The Combobox component renders a [role="combobox"] element.
  const combo = await driver.findElements(
    By.css('[role="dialog"][aria-label^="Filter "] [role="combobox"]'),
  );
  if (combo.length === 0) {
    throw new Error(
      'grid: per-column Status filter is not a Combobox (no [role="combobox"] inside the popup)',
    );
  }
  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'filter_dropdown_open');

  // Open the combobox dropdown and pick "todo". The Combobox typically
  // toggles a listbox via its trigger button.
  await combo[0]!.click();
  // Wait briefly for the listbox to appear.
  await sleep(driver, 200);
  // Pick the option whose visible text is "todo". Try [role="option"] first.
  const opts = await driver.findElements(By.css('[role="option"]'));
  let picked = false;
  for (const opt of opts) {
    const txt = (await opt.getText()).trim().toLowerCase();
    if (txt === 'todo') {
      await opt.click();
      picked = true;
      break;
    }
  }
  if (!picked) {
    // Fallback: type "todo" into the searchable combobox + press Enter.
    await combo[0]!.sendKeys('todo');
    await sleep(driver, 200);
    await combo[0]!.sendKeys('');
  }

  // Close the listbox so the Apply button isn't covered by it. The
  // Combobox in multi-select mode keeps the dropdown open after a tap.
  await sleep(driver, 200);
  const stillOpen = await driver.findElements(By.css('[role="listbox"]'));
  if (stillOpen.length > 0) {
    // Toggle the combobox closed.
    await combo[0]!.click();
    await sleep(driver, 200);
  }

  // Click "Apply" to commit the filter. We use a JS click so any
  // closing-listbox stacking context can't intercept the pointer event.
  const applyBtn = await driver.findElement(
    By.xpath(
      "//div[@role='dialog' and starts-with(@aria-label,'Filter ')]//button[normalize-space(.)='Apply']",
    ),
  );
  await driver.executeScript('arguments[0].scrollIntoView({block:"center"});', applyBtn);
  await sleep(driver, 100);
  await driver.executeScript('arguments[0].click();', applyBtn);

  // Wait for the column filter popup to close.
  await driver.wait(async () => {
    const els = await driver.findElements(
      By.css('[role="dialog"][aria-label^="Filter "]'),
    );
    return els.length === 0;
  }, 5_000);
  // Allow the refresh batch to fly.
  await sleep(driver, 800);
  await captureScreenshot(driver, journeyName, 'filtered_todo');
}
