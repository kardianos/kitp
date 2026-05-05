// Selenium WebDriver helpers for the Svelte e2e harness.
//
// Thin wrapper over `selenium-webdriver` that gives the journey scripts
// a small, predictable surface: start a session, find/click/type by CSS
// selector, wait for elements/URL changes, screenshot, and chain
// modifier keys. Everything is async; everything throws on failure so
// run.ts can catch and tear down cleanly.

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import {
  Browser,
  Builder,
  By,
  Key,
  until,
  type WebDriver,
  type WebElement,
} from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface StartDriverOptions {
  /** Run Chrome headless. Defaults to true; set false to debug visually. */
  headless?: boolean;
  /** Window dimensions; defaults to 1280x800 (matches the Dart harness). */
  width?: number;
  height?: number;
  /** chromedriver URL. Defaults to http://127.0.0.1:9515 (the chromedriver default). */
  serverUrl?: string;
}

/**
 * Build a WebDriver session pointed at the already-running chromedriver
 * on port 9515 (the same convention the legacy Dart harness uses).
 *
 * The caller (run.ts) is responsible for spawning chromedriver before
 * calling this.
 */
export async function startDriver(opts: StartDriverOptions = {}): Promise<WebDriver> {
  const headless = opts.headless ?? true;
  const width = opts.width ?? 1280;
  const height = opts.height ?? 800;
  const serverUrl = opts.serverUrl ?? 'http://127.0.0.1:9515';

  const chromeOptions = new chrome.Options();
  if (headless) {
    chromeOptions.addArguments('--headless=new');
  }
  chromeOptions.addArguments(
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    // Force reduced motion so CSS transitions/animations don't add visual jitter.
    '--force-prefers-reduced-motion',
  );

  const driver = await new Builder()
    .forBrowser(Browser.CHROME)
    .usingServer(serverUrl)
    .setChromeOptions(chromeOptions)
    .build();

  // Belt-and-suspenders: also size the window via the WebDriver API in
  // case --window-size is ignored under some chromedriver versions.
  try {
    await driver.manage().window().setRect({ width, height, x: 0, y: 0 });
  } catch {
    // Some headless chromes reject setRect; the CLI flag already sized us.
  }

  return driver;
}

/**
 * Take a PNG screenshot and write it to `path`. Creates parent dirs.
 */
export async function screenshot(driver: WebDriver, path: string): Promise<void> {
  const png = await driver.takeScreenshot();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, Buffer.from(png, 'base64'));
}

/**
 * Type `keys` into the element matched by CSS `selector`. Waits for the
 * element to be present + interactable first.
 */
export async function typeKeys(
  driver: WebDriver,
  selector: string,
  keys: string,
): Promise<void> {
  const el = await waitFor(driver, selector);
  await el.clear();
  await el.sendKeys(keys);
}

/**
 * Click the element matched by CSS `selector`. Waits for it to be
 * present and clickable.
 */
export async function click(driver: WebDriver, selector: string): Promise<void> {
  const el = await waitFor(driver, selector);
  await driver.wait(until.elementIsVisible(el), DEFAULT_TIMEOUT_MS);
  await driver.wait(until.elementIsEnabled(el), DEFAULT_TIMEOUT_MS);
  await el.click();
}

/**
 * Wait until the element matched by CSS `selector` is in the DOM and
 * return it. Throws if the timeout elapses.
 */
export async function waitFor(
  driver: WebDriver,
  selector: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<WebElement> {
  return driver.wait(until.elementLocated(By.css(selector)), timeoutMs);
}

/**
 * Wait until `driver.getCurrentUrl()` contains `fragment`. Useful after
 * routing actions that should land us on a different SPA route.
 */
export async function waitForUrl(
  driver: WebDriver,
  fragment: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await driver.wait(async () => {
    const url = await driver.getCurrentUrl();
    return url.includes(fragment);
  }, timeoutMs);
}

/**
 * Press a chord. Each entry in `keys` may be a literal character ("a")
 * or a Selenium `Key` constant (e.g. `Key.CONTROL`). Modifiers are held
 * in order, the final non-modifier key is pressed and released, then
 * modifiers are released in reverse order.
 *
 * Examples:
 *   pressKey(driver, 'n')                     -> 'n'
 *   pressKey(driver, Key.CONTROL, '/')        -> Ctrl+/
 *   pressKey(driver, Key.CONTROL, Key.SHIFT, 'p') -> Ctrl+Shift+P
 */
export async function pressKey(driver: WebDriver, ...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  let actions = driver.actions({ async: true });
  const modifiers = keys.slice(0, -1);
  const finalKey = keys[keys.length - 1]!;
  for (const m of modifiers) actions = actions.keyDown(m);
  actions = actions.keyDown(finalKey).keyUp(finalKey);
  for (const m of [...modifiers].reverse()) actions = actions.keyUp(m);
  await actions.perform();
}

// Re-export commonly-used selenium types/constants so journey scripts
// can avoid a second import line.
export { By, Key, until };
export type { WebDriver, WebElement };
