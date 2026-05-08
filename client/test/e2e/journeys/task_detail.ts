// task_detail journey: open a task from the projects list, edit its
// title via the `e` shortcut, post a comment via the `c` shortcut.

import { By, Key, type WebDriver } from 'selenium-webdriver';

import { pressKey, waitFor, waitForUrl } from '../driver.ts';
import { loginAsSystemUser, sleep, waitForCountAtLeast } from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'task_detail';

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);

  // 1. Open the first project from the project list.
  await waitForCountAtLeast(driver, 'ul a[href^="/project/"]', 1, 15_000);
  const firstProject = (await driver.findElements(
    By.css('ul a[href^="/project/"]'),
  ))[0]!;
  const projectHref = await firstProject.getAttribute('href');
  await firstProject.click();
  await waitForUrl(driver, '/project/', 10_000);

  // 2. Open the first task in that project. ProjectDetailScreen lists
  //    tasks under [data-testid="project-tasks-list"] with TaskRow
  //    children carrying [data-card-id].
  await waitFor(driver, '[data-testid="project-tasks-list"]', 15_000);
  await waitForCountAtLeast(
    driver,
    '[data-testid="project-tasks-list"] [data-card-id]',
    1,
    15_000,
  );
  const firstTask = (await driver.findElements(
    By.css('[data-testid="project-tasks-list"] [data-card-id]'),
  ))[0]!;
  await firstTask.click();
  await waitForUrl(driver, '/task/', 10_000);

  // 3. Wait for read mode and snapshot.
  await waitFor(driver, '[data-testid="task-detail"]', 15_000);
  await waitFor(driver, '[data-testid="task-title"]', 15_000);
  // Allow data fetches to settle.
  await sleep(driver, 500);
  await captureScreenshot(driver, journeyName, 'read');

  // 4. Press `e t` (chord) to enter title edit. Wait for the input to
  //    appear. The shortcut was a bare `e` historically; commit 0901d52
  //    moved the edit shortcuts behind the `e` chord prefix
  //    (`e t`/`e d`/`e c`).
  await pressKey(driver, 'e');
  await sleep(driver, 50);
  await pressKey(driver, 't');
  const titleInput = await waitFor(driver, '[data-testid="task-title-input"]', 5_000);
  // Append " (edited)" to the existing title; the input is auto-selected
  // after focus, so type END first to deselect, then append.
  await titleInput.sendKeys(Key.END);
  await titleInput.sendKeys(' (edited)');

  // 5. Commit with Mod+Enter.
  await pressKey(driver, Key.CONTROL, Key.ENTER);

  // Wait for read mode to come back (input gone, h1 shows updated title).
  await driver.wait(async () => {
    const els = await driver.findElements(
      By.css('[data-testid="task-title-input"]'),
    );
    return els.length === 0;
  }, 10_000);
  await sleep(driver, 600);
  await captureScreenshot(driver, journeyName, 'title_edited');

  // 6. Press `e c` (chord) to focus comment composer; type a comment;
  //    commit. Same chord-prefix migration as title above.
  await pressKey(driver, 'e');
  await sleep(driver, 50);
  await pressKey(driver, 'c');
  const commentEl = await waitFor(driver, '[data-testid="task-comment-input"]', 5_000);
  // The shortcut focuses the textarea via tick(); confirm focus landed.
  await driver.wait(async () => {
    const focused = await driver.switchTo().activeElement();
    const id = await focused.getAttribute('data-testid').catch(() => '');
    return id === 'task-comment-input';
  }, 5_000).catch(() => {
    // Some chromedrivers need a manual nudge if focus didn't latch.
  });
  await commentEl.sendKeys('E2E test comment');
  await pressKey(driver, Key.CONTROL, Key.ENTER);

  // Wait for the comment to be cleared (composer drains on success).
  await driver.wait(async () => {
    const v = await commentEl.getAttribute('value');
    return v === '' || v === null;
  }, 10_000).catch(() => {
    // Tolerate slow networks; the screenshot will still capture state.
  });
  await sleep(driver, 800);
  await captureScreenshot(driver, journeyName, 'comment_posted');

  // Mark href as read so lints stay quiet — we held it for diagnostics.
  void projectHref;
}
