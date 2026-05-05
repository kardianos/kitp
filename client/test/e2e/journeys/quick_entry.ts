// quick_entry journey: rapid-fire creation via `n`, plain Enter, and
// finally Ctrl+Enter to close.
//
// Maps to migration plan §5.7 — "Enter to add another, Ctrl+Enter to add
// and close". Captures the overlay between each Enter so reviewers can
// visually confirm the inputs cleared and focus snapped back to title.

import { By, Key, type WebDriver } from 'selenium-webdriver';

import { pressKey, waitFor } from '../driver.ts';
import { loginAsSystemUser, sleep } from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'quick_entry';

async function waitForTitleEmpty(driver: WebDriver): Promise<void> {
  // After plain Enter the overlay clears the inputs and refocuses the
  // title — but we ONLY require the value to be empty. Focus may shift to
  // the document body briefly while Svelte reflows, and snapping it back
  // happens via tick(); we don't need to assert focus to know the
  // submission round-tripped.
  await driver.wait(async () => {
    const inputs = await driver.findElements(By.css('#qe-title'));
    if (inputs.length === 0) return false;
    const v = await inputs[0]!.getAttribute('value');
    return v === '' || v === null;
  }, 15_000);
}

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);
  // /projects is the landing route post-login.
  await waitFor(driver, 'h1', 15_000);

  // Open quick entry.
  await pressKey(driver, 'n');
  const title = await waitFor(driver, '#qe-title', 5_000);

  // Round 1: type "Quick A" and press plain Enter.
  await title.sendKeys('Quick A');
  await driver.actions({ async: true }).keyDown(Key.ENTER).keyUp(Key.ENTER).perform();
  // Wait for inputs to clear + refocus title.
  await waitForTitleEmpty(driver);
  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'after_a');

  // Round 2: type "Quick B" and press plain Enter.
  const title2 = await driver.findElement(By.css('#qe-title'));
  await title2.sendKeys('Quick B');
  await driver.actions({ async: true }).keyDown(Key.ENTER).keyUp(Key.ENTER).perform();
  await waitForTitleEmpty(driver);
  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'after_b');

  // Round 3: type "Quick C" and submit-and-close with Ctrl+Enter.
  const title3 = await driver.findElement(By.css('#qe-title'));
  await title3.sendKeys('Quick C');
  await pressKey(driver, Key.CONTROL, Key.ENTER);
  // Wait for the overlay to close.
  await driver.wait(async () => {
    const els = await driver.findElements(
      By.css('[role="dialog"][aria-label="Quick entry"]'),
    );
    return els.length === 0;
  }, 10_000);
  // Allow the projects list refresh to land.
  await sleep(driver, 800);
  await captureScreenshot(driver, journeyName, 'closed');

  // 4. Verify the three projects exist in the list. We don't need to
  //    assert exact ordering; presence is enough.
  await driver.wait(async () => {
    const links = await driver.findElements(By.css('ul a[href^="/project/"]'));
    const titles = await Promise.all(links.map((l) => l.getText()));
    const blob = titles.join('\n');
    return blob.includes('Quick A') && blob.includes('Quick B') && blob.includes('Quick C');
  }, 15_000);
}
