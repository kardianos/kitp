/**
 * Pure helpers used by `LoginScreen.svelte`.
 *
 * Kept in a separate module so they can be unit-tested without spinning up
 * a Svelte component (the test suite does not include
 * `@testing-library/svelte`, so component-level tests are out of scope).
 */

/** Parsed `?error=...` payload, suitable for direct rendering. */
export interface LoginError {
  message: string;
}

/**
 * Read an `?error=...` value out of a `URLSearchParams` (typically derived
 * from `window.location.search`).
 *
 *   - Returns `{ message }` when the param is present and non-empty.
 *   - Returns `null` when the param is absent or empty after trim.
 *   - When the param appears multiple times, the first non-empty value wins
 *     (matches `URLSearchParams.get` semantics).
 *
 * The message is returned verbatim; the caller is responsible for any
 * sanitisation / truncation when rendering.
 */
export function parseLoginError(
  params: URLSearchParams,
): LoginError | null {
  const raw = params.get('error');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return { message: trimmed };
}
