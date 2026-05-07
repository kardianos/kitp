// nav_chords journey: walk through every advertised top-level chord
// (g p / g i / g g / g k / g a) and assert each one navigates to the
// expected route AND that the matching screen mounts. Catches both
// halves of the contract:
//
//   - chord registration: pressing 'g' starts the chord buffer, then
//     the second key resolves to the navigate handler.
//   - actual route effect: not just "URL changed" — the screen's
//     ready-selector renders, so the user is really on the right page.
//
// Why a dedicated journey rather than folding into keyboard.ts: the
// keyboard journey already opens / closes the help overlay per screen,
// which navigates via navigateSpa() (not the SPA chord path). Mixing
// the two flows would obscure which step actually exercised the chord.

import { type WebDriver } from 'selenium-webdriver';

import { waitFor, waitForUrl } from '../driver.ts';
import { loginAsSystemUser, navigateSpa, pressChord, sleep } from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'nav_chords';

interface ChordCase {
  /** Two-letter chord, space-separated (matches the dispatcher's wire form). */
  chord: string;
  expectedPath: string;
  /** Selector that proves the destination screen rendered. */
  ready: string;
  /** Stable name for the screenshot. */
  capture: string;
}

const CASES: ChordCase[] = [
  {
    chord: 'g i',
    expectedPath: '/inbox',
    ready:
      '[data-testid="inbox-list"], [data-testid="inbox-empty"], [data-testid="inbox-loading"]',
    capture: 'inbox',
  },
  {
    chord: 'g g',
    expectedPath: '/grid',
    ready: '[data-testid="grid-body"]',
    capture: 'grid',
  },
  {
    chord: 'g k',
    expectedPath: '/kanban',
    ready: '[data-kanban-column], h1',
    capture: 'kanban',
  },
  {
    chord: 'g a',
    expectedPath: '/activity',
    ready: '[data-testid="activity-list"], h1',
    capture: 'activity',
  },
  {
    chord: 'g p',
    expectedPath: '/projects',
    ready: 'aside[aria-label="Primary navigation"]',
    capture: 'projects',
  },
];

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);
  // We start on /projects after login. Park us on /inbox via SPA nav so
  // the first chord (g i) actually has work to do — without this the
  // chord might "succeed" trivially because we were already there.
  await navigateSpa(driver, '/inbox');

  for (const c of CASES) {
    // Move to a non-target route first so the URL transition is
    // observable. /grid is a safe parking spot for every test except
    // the g g case, which we redirect to /projects beforehand instead.
    const parking = c.expectedPath === '/grid' ? '/projects' : '/grid';
    if (parking !== c.expectedPath) {
      await navigateSpa(driver, parking);
    }
    // Briefly settle so any in-flight screen render finishes before we
    // hand off to the chord — chord prefix-detection looks at the live
    // event target and we want it landing on a non-input element.
    await sleep(driver, 150);

    await pressChord(driver, c.chord);
    await waitForUrl(driver, c.expectedPath, 5_000);
    await waitFor(driver, c.ready, 10_000);
    await sleep(driver, 200);
    await captureScreenshot(driver, journeyName, c.capture);
  }
}
