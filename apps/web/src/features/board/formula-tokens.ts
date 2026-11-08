// SPDX-License-Identifier: AGPL-3.0-only
/**
 * r15cols — the formula editor's "{" list: what is being typed after an open "{", the columns and functions that
 * match it, and the text once one is picked. The engine reads a column as `{<column key>}` and a function as
 * `NAME(…)`; pure, so the rules are unit-tested (formula-tokens.test.ts).
 */

export type TokenOption =
  | { kind: 'column'; key: string; title: string; type?: string }
  | { kind: 'function'; name: string; he?: string; syntax?: string };

/** The open "{" before the caret and the text typed after it, or null when the caret is not in one. */
export const tokenQuery = (text: string, caret: number): { start: number; query: string } | null => {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('{');
  if (start < 0) return null;
  const query = before.slice(start + 1);
  // Closed already, or the line moved on: not a token being typed.
  if (/[}\n]/.test(query) || query.length > 64) return null;
  return { start, query };
};

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The options matching `query`, best first: columns before functions; within each, a start-of-word match before
 * one inside the text. An empty query lists every column (functions too, after them).
 */
export const filterTokenOptions = (options: TokenOption[], query: string, max = 50): TokenOption[] => {
  const q = norm(query);
  const scored: { o: TokenOption; score: number; i: number }[] = [];
  options.forEach((o, i) => {
    const hay = (o.kind === 'column' ? [o.title, o.key] : [o.name, o.he ?? '']).map(norm);
    let score = -1;
    if (!q) score = 0;
    else if (hay.some((h) => h.startsWith(q))) score = 0;
    else if (hay.some((h) => h.split(/[\s_.-]+/).some((w) => w.startsWith(q)))) score = 1;
    else if (hay.some((h) => h.includes(q))) score = 2;
    if (score < 0) return;
    scored.push({ o, score: score + (o.kind === 'function' ? 10 : 0), i });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .slice(0, max)
    .map((s) => s.o);
};

/** What an option writes: `{key}` for a column, `NAME()` for a function (the caret goes inside the brackets). */
export const tokenText = (o: TokenOption): { text: string; caretBack: number } =>
  o.kind === 'column' ? { text: `{${o.key}}`, caretBack: 0 } : { text: `${o.name}()`, caretBack: 1 };

/**
 * Replaces the typed "{query" (from `start` to the caret) with the option's text. A "}" right after the caret
 * (an already closed token being re-picked) is replaced too, so no "}}" is left behind.
 */
export const insertToken = (
  text: string,
  start: number,
  caret: number,
  o: TokenOption,
): { text: string; caret: number } => {
  const { text: token, caretBack } = tokenText(o);
  let end = caret;
  if (o.kind === 'column') {
    // The rest of a token the caret sits in ("{sta|tus}"): replace up to and including its "}".
    const rest = /^[^{}\n\s]*\}/.exec(text.slice(caret));
    if (rest) end = caret + rest[0].length;
  }
  const next = text.slice(0, start) + token + text.slice(end);
  return { text: next, caret: start + token.length - caretBack };
};
