// boot journey: app loads, dev login redirects to /projects, AppShell
// sidebar renders, the "Projects" nav link is highlighted.
//
// Maps to migration plan §8.3 boot row: "App loads, login redirect, OIDC
// code exchange (mocked or real dex)." We use the dev "Continue as System
// User" affordance instead of dex.

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor } from '../driver.ts';
import { loginAsSystemUser } from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'boot';

export async function run(driver: WebDriver): Promise<void> {
  // 1. Hit the bare origin and follow the redirect chain. The router
  //    redirects "/" -> "/projects", and requireAuth bounces us to /login.
  await driver.get('http://localhost:18080/');
  // Wait for /login to render — the login screen is the first thing an
  // unauthenticated user sees.
  await waitFor(driver, 'main[aria-labelledby="login-heading"]', 15_000);
  await captureScreenshot(driver, journeyName, 'landing');

  // 2. Click "Continue as System User" — flips authState.isSignedIn = true
  //    and navigates to /projects.
  await loginAsSystemUser(driver);

  // 3. Verify the AppShell sidebar mounted.
  const sidebar = await driver.findElement(
    By.css('aside[aria-label="Primary navigation"]'),
  );
  if (!sidebar) throw new Error('boot: nav sidebar did not render');

  // 4. Verify the "Projects" link is highlighted (active route). The
  //    NavSidebar marks the active item with aria-current="page".
  const projectsLink = await driver.findElement(
    By.css('aside[aria-label="Primary navigation"] a[href="/projects"]'),
  );
  const ariaCurrent = await projectsLink.getAttribute('aria-current');
  if (ariaCurrent !== 'page') {
    throw new Error(
      `boot: Projects nav link not active (aria-current=${ariaCurrent ?? 'null'})`,
    );
  }

  // 5. Wait for the Projects screen body to render before capturing.
  //    The h1 with "Projects" comes from ProjectsScreen.
  await waitFor(driver, 'h1', 10_000);
  await captureScreenshot(driver, journeyName, 'projects_list');
}
