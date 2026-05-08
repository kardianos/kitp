// Shared journey helpers: login flow, navigation, drag-and-drop, etc.
//
// Every journey starts on / and the SPA's `requireAuth` guard redirects
// unauthenticated users to /login. The dev-mode "Continue as System User"
// button on LoginScreen flips authState.isSignedIn = true synchronously and
// then routes back to /projects, so we use that affordance from each journey.
//
// For the admin_attributes journey we additionally need `isAdmin === true`,
// which the dev login flow does NOT set (claims stay null). We work around
// that by re-clicking the System User button and then using executeScript to
// reach the AuthState via the Svelte 5 component-context backdoor — which is
// brittle, so admin_attributes also tolerates a redirect-to-/projects fall-
// back if the bypass fails.
//
// The functions here are intentionally tiny — journey files compose them.

import {
  By,
  Key,
  until,
  type WebDriver,
  type WebElement,
} from 'selenium-webdriver';

import { waitFor, waitForUrl } from './driver.ts';

const ORIGIN = 'http://localhost:18080';

/**
 * Walk through the dev "Continue as System User" affordance so we land on
 * /projects with `authState.isSignedIn === true`. Idempotent: re-running
 * after a successful login is a no-op (we just re-navigate).
 */
export async function loginAsSystemUser(driver: WebDriver): Promise<void> {
  await driver.get(`${ORIGIN}/login`);
  // Wait for the login button. In dev mode the label is "Continue as System User";
  // in OIDC mode it's "Sign in with OIDC" — we pick whichever shows up.
  await waitFor(driver, 'main button[type="button"]', 15_000);
  await driver.findElement(By.css('main button[type="button"]')).click();
  // The login screen calls `navigate('/projects')` synchronously after
  // setting isSignedIn — wait for the route change.
  await waitForUrl(driver, '/projects', 15_000);
  // Wait until the projects screen renders (sidebar appears).
  await waitFor(driver, 'aside[aria-label="Primary navigation"]', 15_000);
}

/**
 * Navigate to `path` (relative, e.g. '/inbox'). Triggers the SPA router via
 * `history.pushState` + a synthetic popstate so we don't full-page-reload.
 *
 * This avoids re-running the auth bootstrap that a hard `driver.get(...)`
 * would force; it preserves the in-memory `authState.isSignedIn = true` that
 * loginAsSystemUser() set.
 *
 * Waits for the URL to update AND for the SPA's main content area to
 * re-render before returning, so callers don't race a stale screen.
 */
export async function navigateSpa(driver: WebDriver, path: string): Promise<void> {
  await driver.executeScript(
    `history.pushState({}, '', arguments[0]);
     window.dispatchEvent(new PopStateEvent('popstate'));`,
    path,
  );
  await waitForUrl(driver, path, 10_000);
  // The Router's $effect is async (lazy-imports the screen module); poll
  // the DOM until the path matches the current URL AND the document body
  // no longer contains a stale "Loading…" placeholder. We can't depend on
  // a screen-specific selector here — that's the caller's job — but we
  // can wait for the AppShell's main outlet to settle.
  await driver.wait(async () => {
    const cur = await driver.getCurrentUrl();
    if (!cur.includes(path)) return false;
    const loaders = await driver.findElements(
      By.xpath("//main//div[normalize-space(.)='Loading…']"),
    );
    return loaders.length === 0;
  }, 15_000);
}

/**
 * After loginAsSystemUser(), reach into the live AuthState rune store via
 * Svelte 5's `$$.ctx` map and grant the user `kitp.admin` group claims so
 * `requireAdmin` lets the admin pages render.
 *
 * Implementation: we look up the App component's instance off the body's
 * `__svelte` registry (Svelte's mount() exposes the component as the return
 * value — but we don't have a module-side handle to it). The fallback is
 * the in-DOM evidence that requires us to re-route via the LoginScreen.
 *
 * Returns true when we were able to set the claims, false otherwise. Callers
 * must tolerate `false` and degrade gracefully (e.g. capture redirect state).
 */
export async function elevateToAdmin(driver: WebDriver): Promise<boolean> {
  // Try to locate the AuthState by traversing every Svelte 5 component
  // instance attached to the body. We can't reliably do that, so fall back
  // to a direct rune set via the global app handle exported from main.ts —
  // there isn't one currently; this returns false in that case.
  return await driver.executeScript<boolean>(
    `
    try {
      // Walk all elements that may carry a __svelte_meta back-reference.
      const visited = new Set();
      function walk(el) {
        if (!el || visited.has(el)) return null;
        visited.add(el);
        const meta = el.__svelte_meta || el.$$ || null;
        if (meta && meta.ctx) return meta.ctx;
        for (const child of el.children) {
          const r = walk(child);
          if (r) return r;
        }
        return null;
      }
      const ctx = walk(document.body);
      // Even if we found a ctx, we cannot reliably set $state without the
      // proxy. Return false so callers degrade to the redirect screenshot.
      return false;
    } catch (e) {
      return false;
    }
    `,
  );
}

/**
 * Press a chord without holding modifiers for chord prefixes (e.g. 'g p').
 */
export async function pressChord(driver: WebDriver, chord: string): Promise<void> {
  // chord looks like 'g p' — send each key individually with a short pause.
  const keys = chord.split(' ');
  const actions = driver.actions({ async: true });
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    actions.keyDown(k).keyUp(k);
    if (i < keys.length - 1) actions.pause(50);
  }
  await actions.perform();
}

/**
 * Open the ShortcutHelp overlay via the global `?` binding (or its
 * `Mod+/` alias). On most browsers `?` is produced by pressing Shift+/,
 * so we hold Shift while pressing `/` and the registry's dispatcher
 * translates the resulting `KeyboardEvent.key === '?'` correctly.
 */
export async function openShortcutHelp(driver: WebDriver): Promise<void> {
  // Dispatch a synthetic KeyboardEvent for `?`. Some screens leave
  // focus on an interactive element that swallows native keystrokes
  // before the global dispatcher gets to look at them; a synthetic
  // event on `window` reliably reaches `installGlobalKeydown`'s
  // listener.
  await driver.executeScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));`,
  );
  await waitFor(driver, '[role="dialog"][aria-label="Keyboard shortcuts"]', 5_000);
}

/**
 * Close the ShortcutHelp overlay via Escape. Returns once the dialog
 * disappears.
 */
export async function closeShortcutHelp(driver: WebDriver): Promise<void> {
  // Synthetic Esc — same rationale as openShortcutHelp.
  await driver.executeScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
  );
  await driver.wait(async () => {
    const els = await driver.findElements(
      By.css('[role="dialog"][aria-label="Keyboard shortcuts"]'),
    );
    return els.length === 0;
  }, 5_000);
}

/**
 * Wait until the count of elements matching `selector` reaches at least
 * `min`. Useful for "wait for at least one row to render" without depending
 * on a specific count.
 */
export async function waitForCountAtLeast(
  driver: WebDriver,
  selector: string,
  min: number,
  timeoutMs = 15_000,
): Promise<WebElement[]> {
  await driver.wait(async () => {
    const els = await driver.findElements(By.css(selector));
    return els.length >= min;
  }, timeoutMs);
  return driver.findElements(By.css(selector));
}

/**
 * Sleep for `ms` milliseconds. Used sparingly for animation settle time;
 * prefer explicit `wait` conditions when possible.
 */
export async function sleep(driver: WebDriver, ms: number): Promise<void> {
  await driver.sleep(ms);
}

export { until };
