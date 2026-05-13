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
// Gate 9 (FLOW_AND_SCREEN_KERNEL): per-project chords (g i / g g / g k)
// are now data-driven — registered from the loaded screen cards under
// the active project. The expected path is therefore
// /project/<id>/screen/<slug>, not the old /inbox alias.
//
// Why a dedicated journey rather than folding into keyboard.ts: the
// keyboard journey already opens / closes the help overlay per screen,
// which navigates via navigateSpa() (not the SPA chord path). Mixing
// the two flows would obscure which step actually exercised the chord.

import { By, type WebDriver } from 'selenium-webdriver';

import { waitFor, waitForUrl } from '../driver.ts';
import {
  loginAsSystemUser,
  navigateSpa,
  pickFirstProjectId,
  pressChord,
  sleep,
} from '../helpers.ts';
import { captureScreenshot } from '../screenshots.ts';

export const journeyName = 'nav_chords';

interface ChordCase {
  /** Two-letter chord, space-separated (matches the dispatcher's wire form). */
  chord: string;
  /** Expected URL after the chord fires. */
  expectedPath: string;
  /** Selector that proves the destination screen rendered. */
  ready: string;
  /** Stable name for the screenshot. */
  capture: string;
}

export async function run(driver: WebDriver): Promise<void> {
  await loginAsSystemUser(driver);

  // Resolve the per-project chord targets from the first project in
  // the projects list. The chord handlers AppShell registers reference
  // the same project so this must match.
  const projectId = await pickFirstProjectId(driver);
  const inboxPath = `/project/${projectId}/screen/inbox`;
  const gridPath = `/project/${projectId}/screen/grid`;
  const kanbanPath = `/project/${projectId}/screen/kanban`;

  const cases: ChordCase[] = [
    {
      chord: 'g i',
      expectedPath: inboxPath,
      ready:
        '[data-testid="inbox-list"], [data-testid="inbox-empty"], [data-testid="inbox-loading"]',
      capture: 'inbox',
    },
    {
      chord: 'g g',
      expectedPath: gridPath,
      ready: '[data-testid="grid-body"]',
      capture: 'grid',
    },
    {
      chord: 'g k',
      expectedPath: kanbanPath,
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

  // Park on the inbox screen so AppShell's project-screens fetch has
  // resolved and the dynamic chord registry is populated before we
  // press the first chord.
  await navigateSpa(driver, inboxPath);
  // Wait for the per-project sidebar group to render — it implies
  // projectScreensStore has loaded and the chord registrations are
  // live.
  await waitFor(driver, '[data-testid^="nav-screen-"]', 15_000);

  for (const c of cases) {
    // Move to a non-target route first so the URL transition is
    // observable. /grid-equivalent is a safe parking spot for every
    // case except the gg case; we send those through /projects instead.
    const parking = c.expectedPath === gridPath ? '/projects' : gridPath;
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

  // Mark imports as used in case the lint config doesn't see them.
  void By;
}
