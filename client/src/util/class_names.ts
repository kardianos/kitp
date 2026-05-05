/**
 * Tiny `cx(...args)` class-name composer.
 *
 * Accepts strings, numbers, falsy values (filtered), arrays (recursively), and
 * plain objects whose truthy values include their keys. Mirrors the common
 * `clsx` / `classnames` API without pulling in a dependency.
 */

export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | { [key: string]: unknown }
  | ClassValue[];

export function cx(...args: ClassValue[]): string {
  const out: string[] = [];
  for (const a of args) {
    if (a === null || a === undefined || a === false || a === '') continue;
    if (typeof a === 'string') {
      out.push(a);
    } else if (typeof a === 'number') {
      out.push(String(a));
    } else if (Array.isArray(a)) {
      const inner = cx(...a);
      if (inner !== '') out.push(inner);
    } else if (typeof a === 'object') {
      for (const [k, v] of Object.entries(a)) {
        if (v) out.push(k);
      }
    }
  }
  return out.join(' ');
}
