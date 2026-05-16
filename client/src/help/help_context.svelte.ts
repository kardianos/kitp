/**
 * Per-page help topic — the bridge between a mounted screen and the
 * <HelpButton> in the AppShell header.
 *
 * Screens publish their topic on mount (`setHelpTopic({...})`) and the
 * button reads it reactively to decide which RPC to fire when clicked.
 * Two flavours:
 *
 *   - `{ kind: 'topic', topic: 'admin.screens' }` — static lookup,
 *     served by `help.get_topic`. Used by every admin screen.
 *   - `{ kind: 'screen', screenCardId }` — composed at request time
 *     by `help.get_screen` (layout primer + filter prose).
 *
 * A screen may also call `clearHelpTopic()` on unmount so the button
 * does not pretend to know help for the next screen until it has had a
 * chance to publish its own topic.
 */

import type { ID } from '../reg/types';

export type HelpTopic =
  | { kind: 'topic'; topic: string }
  | { kind: 'screen'; screenCardId: ID };

class HelpContext {
  /** Current topic, or null while the active screen hasn't published one. */
  topic = $state<HelpTopic | null>(null);
}

export const helpContext = new HelpContext();

/** Publish [t] as the current page's help topic. */
export function setHelpTopic(t: HelpTopic): void {
  helpContext.topic = t;
}

/** Clear the published topic (call from a screen's onMount cleanup). */
export function clearHelpTopic(): void {
  helpContext.topic = null;
}
