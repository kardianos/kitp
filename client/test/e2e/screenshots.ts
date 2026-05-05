// Screenshot path conventions for the Svelte e2e harness.
//
// All journey screenshots land under
// `<repoRoot>/docs/screenshots/svelte/<journey>/<name>.png`. This module
// owns that path layout so journey scripts don't have to know about it.

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WebDriver } from 'selenium-webdriver';

import { screenshot } from './driver.ts';

/**
 * Repo root, derived from this file's location:
 *   <repo>/client-svelte/test/e2e/screenshots.ts
 * so going up three directories from this file's directory lands at
 * <repo>/.
 *
 * The orchestrator (run.ts) also re-exports this so journey scripts
 * have a single source of truth for repo-relative paths.
 */
const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = resolve(dirname(__filename), '..', '..', '..');

export const BASELINE_DIR = join(REPO_ROOT, 'docs', 'screenshots', 'svelte');

/**
 * Build the absolute screenshot path for a (journey, name) pair without
 * actually writing anything. Mostly useful for the visual-diff step.
 */
export function screenshotPath(journey: string, name: string): string {
  // Strip a trailing .png if the caller already added one.
  const base = name.endsWith('.png') ? name.slice(0, -4) : name;
  return join(BASELINE_DIR, journey, `${base}.png`);
}

/**
 * Capture a screenshot for the named (journey, screen-state) and write
 * it to `<repo>/docs/screenshots/svelte/<journey>/<name>.png`. Returns
 * the absolute path of the written PNG.
 *
 * `name` may include slashes (e.g. `boot/landing`); they're treated as
 * subdirectories inside the journey folder.
 */
export async function captureScreenshot(
  driver: WebDriver,
  journey: string,
  name: string,
): Promise<string> {
  const out = screenshotPath(journey, name);
  await fs.mkdir(dirname(out), { recursive: true });
  await screenshot(driver, out);
  return out;
}
