/**
 * Trimming received replies for display (docs/CONVERSATIONS.md): a customer's
 * mail program quotes the earlier messages, so a stored reply repeats the
 * thread above it. kitp keeps the original as received and shows its own
 * text, with the quoted tail folded behind "Show quoted text".
 *
 * The rules match the server's (server/internal/dom/comm/quote.go
 * SplitQuoted), which cuts quoted messages down the same way before quoting
 * them in an outgoing reply; keep the two in step. It is a guess, so it only
 * trims the tail, and never everything: when nothing would be left of the
 * message, it is shown whole.
 */

const ON_WROTE = /^\s*On\s.{0,300}\bwrote:\s*$/i;
const ON_START = /^\s*On\s.{4,}$/i;
const WROTE_END = /^.{0,200}\bwrote:\s*$/i;
const ORIGINAL = /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i;
const FROM_LINE = /^\s*\*?From:\*?\s+\S/i;
const SENT_LINE = /^\s*\*?(Sent|Date):\*?\s+\S/i;
const UNDERLINE = /^\s*_{8,}\s*$/;
const TRAILER = /^(Ref|Task):\s*\S+\s*$/;

const isQuote = (ln: string): boolean => ln.trimStart().startsWith('>');
const blank = (ln: string): boolean => ln.trim() === '';

/** A reply split into its own text and the quoted history below it
 *  (`quoted` is '' when nothing was trimmed). */
export interface SplitReply {
  own: string;
  quoted: string;
}

/** The index of the first line of the quoted tail, or -1. */
function quoteCut(lines: readonly string[]): number {
  const toEnd = (i: number, ok: (ln: string) => boolean): boolean => lines.slice(i).every((ln) => blank(ln) || ok(ln));
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const next = lines[i + 1];
    if (ON_WROTE.test(ln)) return i;
    if (ON_START.test(ln) && next !== undefined && WROTE_END.test(next) && !ON_START.test(next)) return i;
    if (ORIGINAL.test(ln)) return i;
    if (FROM_LINE.test(ln) && lines.slice(i + 1, i + 5).some((l) => SENT_LINE.test(l))) {
      return i > 0 && UNDERLINE.test(lines[i - 1]!) ? i - 1 : i;
    }
    if (isQuote(ln) && toEnd(i, (l) => isQuote(l) || TRAILER.test(l))) return i;
    if (TRAILER.test(ln) && toEnd(i, (l) => TRAILER.test(l))) return i;
  }
  return -1;
}

/** Split a received message into its own text and the quoted tail. */
export function splitQuoted(body: string): SplitReply {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const cut = quoteCut(lines);
  if (cut < 0) return { own: body, quoted: '' };
  const own = lines.slice(0, cut).join('\n').replace(/[ \t\n]+$/, '');
  if (own.trim() === '') return { own: body, quoted: '' };
  return { own, quoted: lines.slice(cut).join('\n').replace(/^\n+|\n+$/g, '') };
}
