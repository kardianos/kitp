// Smoke journey: verifies the e2e harness can boot Chrome, hit the
// served Svelte app, and write a screenshot. This journey deliberately
// makes no DOM assertions — full journeys arrive in task #25.

import type { WebDriver } from 'selenium-webdriver';

import { captureScreenshot } from '../screenshots.ts';

export const journeyName = '_smoke';

export async function run(driver: WebDriver): Promise<void> {
  await driver.get('http://localhost:18080/');
  // Give the SPA shell a moment to mount its first paint. We don't
  // wait on a specific selector here because the smoke journey runs
  // before the app structure is settled.
  await driver.sleep(500);
  await captureScreenshot(driver, journeyName, 'landing');
}
