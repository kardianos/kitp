/**
 * Watch-list marks: the symbols of the viewer's own lists a task or thread is
 * on, shown by its title on the Grid, list rows and Kanban cards so a
 * bookmarked card stands out (docs/WATCH_LISTS.md). The rows carry them when
 * card.select_with_attributes was asked `with_watch`; the list names come up
 * on hover and for a screen reader.
 */

/** One of the viewer's lists a row is on (the wire's `watch[]`). */
export interface WatchMark {
  id: bigint;
  symbol: string;
  title: string;
}

/** Decode a row's `watch` (absent / malformed → undefined). */
export function decodeWatchMarks(v: unknown): WatchMark[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WatchMark[] = [];
  for (const raw of v) {
    if (raw === null || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const id = m['id'];
    const symbol = typeof m['symbol'] === 'string' ? m['symbol'] : '';
    if (symbol === '') continue;
    out.push({
      id: typeof id === 'bigint' ? id : typeof id === 'string' && /^\d+$/.test(id) ? BigInt(id) : 0n,
      symbol,
      title: typeof m['title'] === 'string' ? m['title'] : '',
    });
  }
  return out.length > 0 ? out : undefined;
}

/** The marks for [marks] — one symbol per list — or null when there are none. */
export function watchMarks(marks: readonly WatchMark[] | undefined): HTMLElement | null {
  if (marks === undefined || marks.length === 0) return null;
  const el = document.createElement('span');
  el.className = 'watch-marks';
  el.dataset.role = 'watch-marks';
  const names = marks.map((m) => (m.title !== '' ? `${m.symbol} ${m.title}` : m.symbol)).join(', ');
  el.title = `On your lists: ${names}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `On your lists: ${marks.map((m) => m.title || m.symbol).join(', ')}`);
  for (const m of marks) {
    const s = document.createElement('span');
    s.className = 'watch-marks__symbol';
    s.dataset.watchListId = m.id.toString();
    s.textContent = m.symbol;
    el.append(s);
  }
  return el;
}
