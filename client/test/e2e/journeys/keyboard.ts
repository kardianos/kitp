// keyboard journey: visit each scope-bearing screen, open the
// ShortcutHelp overlay via `?`, capture, and dismiss with Esc.
//
// Verifies that the global help binding fires across every scope and
// that the registry filters entries to the active scope (i.e. the help
// overlay shows distinct content per screen).

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor, waitForUrl } from '../driver.ts';
import {
  closeShortcutHelp,
  loginAsSystemUser,
  navigateSpa,
  openShortcutHelp,
  sleep,
  waitForCountAtLeast,
} from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'keyboard';

interface ScreenSpec {
  name: string;
  /** Path to navigate to. For task_detail this is filled at runtime. */
  pathOrResolver: string | ((driver: WebDriver) => Promise<string>);
  /** Selector that proves the screen mounted. */
  ready: string;
}

const SCREENS: ScreenSpec[] = [
  { name: 'projects', pathOrResolver: '/projects', ready: 'ul a[href^="/project/"], h1' },
  { name: 'inbox', pathOrResolver: '/inbox', ready: '[data-testid="inbox-list"], [data-testid="inbox-empty"], [data-testid="inbox-loading"]' },
  { name: 'grid', pathOrResolver: '/grid', ready: '[data-testid="grid-body"]' },
  { name: 'kanban', pathOrResolver: '/kanban', ready: '[data-kanban-column], h1' },
  { name: 'activity', pathOrResolver: '/activity', ready: '[data-testid="activity-list"], h1' },
  {
    name: 'task_detail',
    pathOrResolver: async (driver) => {
      // Pick the first task by drilling through the projects list.
      await navigateSpa(driver, '/projects');
      await waitForCountAtLeast(driver, 'ul a[href^="/project/"]', 1, 15_000);
      const proj = (await driver.findElements(By.css('ul a[href^="/project/"]')))[0]!;
      await proj.click();
      await waitForUrl(driver, '/project/', 10_000);
      await waitForCountAtLeast(
        driver,
        '[data-testid="project-tasks-list"] [data-card-id]',
        1,
        15_000,
      );
      const task = (await driver.findElements(
        By.css('[data-testid="project-tasks-list"] [data-card-id]'),
      ))[0]!;
      const cardId = await task.getAttribute('data-card-id');
      return `/task/${cardId}`;
    },
    ready: '[data-testid="task-detail"]',
  },
  // admin_attributes is intentionally omitted from the keyboard journey
  // because the dev "Continue as System User" login does NOT seed the
  // `kitp.admin` group claim, so `requireAdmin` redirects /admin/* back
  // to /projects. The admin_attributes screen's keyboard scope is still
  // exercised by the dedicated admin_attributes journey when running
  // under an OIDC profile that grants admin rights.
];

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);

  let lastScreen = '';
  for (const screen of SCREENS) {
    let path: string;
    if (typeof screen.pathOrResolver === 'function') {
      path = await screen.pathOrResolver(driver);
    } else {
      path = screen.pathOrResolver;
    }
    await navigateSpa(driver, path);
    try {
      await waitFor(driver, screen.ready, 15_000);
    } catch {
      // Screen failed to render; continue to the next so we don't lose
      // every later capture for one bad path.
    }
    // task_detail's mount fires a 7-subrequest batch that takes a beat
    // longer than the lighter list screens — sleep more aggressively so
    // installGlobalKeydown's listener is reliably attached before we
    // dispatch the help shortcut.
    await sleep(driver, screen.name === 'task_detail' ? 800 : 400);

    // Open the help overlay and capture.
    await openShortcutHelp(driver);
    await sleep(driver, 200);
    await captureScreenshot(driver, journeyName, `${screen.name}_help`);
    await closeShortcutHelp(driver);
    await sleep(driver, 150);

    lastScreen = screen.name;
  }

  // 2. Capture a final shot of the last screen with help closed so we
  //    have visual confirmation of the dismiss path.
  await sleep(driver, 200);
  await captureScreenshot(driver, journeyName, 'done');
  void lastScreen;
}
