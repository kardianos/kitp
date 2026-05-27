/**
 * help.get_topic / help.get_screen API specs — the server's authored,
 * contextual help markdown that the `?` overlay renders alongside the live
 * keybinding cheatsheet.
 *
 *   - help.get_topic   in : { topic }              out: { title, markdown }
 *   - help.get_screen  in : { screen_card_id }     out: { title, markdown }
 *
 * Both return a `{ title, markdown }` shape so the overlay renders either
 * through one path (the markdown goes through the shared sanitized sink).
 */

import type { Api } from '../core/api.js';

export const HELP_GET_TOPIC_SPEC = 'help.get_topic';
export const HELP_GET_SCREEN_SPEC = 'help.get_screen';

export interface HelpGetTopicInput {
  topic: string;
}
export interface HelpGetScreenInput {
  screenCardId: bigint | string;
}
export interface HelpOutput {
  title: string;
  markdown: string;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function decodeHelp(raw: unknown): HelpOutput {
  const j = asObj(raw);
  return { title: asStr(j['title']), markdown: asStr(j['markdown']) };
}

/** Register the help specs. Idempotent-by-presence. */
export function registerHelpSpecs(api: Api): void {
  if (!api.registry.has({ endpoint: 'help', action: 'get_topic' })) {
    api.define<HelpGetTopicInput, HelpOutput>({
      endpoint: 'help',
      action: 'get_topic',
      encode: (i) => ({ topic: i.topic }),
      decode: decodeHelp,
    });
  }
  if (!api.registry.has({ endpoint: 'help', action: 'get_screen' })) {
    api.define<HelpGetScreenInput, HelpOutput>({
      endpoint: 'help',
      action: 'get_screen',
      encode: (i) => ({ screen_card_id: i.screenCardId }),
      decode: decodeHelp,
    });
  }
}
