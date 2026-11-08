// SPDX-License-Identifier: AGPL-3.0-only
/**
 * the before / after of "improve with AI" as one text a person reads — kept, added and removed parts.
 * Lines are matched first (instructions are mostly lines); inside a changed block, words are matched, so a small
 * edit in a long line shows as a few words, not the whole line twice. Plain LCS: instructions are at most 20,000
 * characters, and a block too large for a word match shows as removed + added.
 */
export type DiffPart = { kind: 'same' | 'add' | 'del'; text: string };

/** Above this many cells (tokens before × after) a changed block is not matched word by word. */
const MAX_WORD_CELLS = 250_000;
const MAX_LINE_CELLS = 4_000_000;

type Op<T> = { kind: DiffPart['kind']; value: T };

/** Longest common subsequence of two lists, as keep / add / del steps in order. */
const lcs = <T>(a: T[], b: T[]): Op<T>[] => {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * w + j] =
        a[i] === b[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
  const ops: Op<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', value: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) ops.push({ kind: 'del', value: a[i++]! });
    else ops.push({ kind: 'add', value: b[j++]! });
  }
  while (i < n) ops.push({ kind: 'del', value: a[i++]! });
  while (j < m) ops.push({ kind: 'add', value: b[j++]! });
  return ops;
};

/** Lines with their line break, so joining the parts gives the text back. */
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** Words, runs of spaces and single marks (Hebrew and other letters count as word characters). */
const words = (s: string) => s.match(/[\p{L}\p{N}_'"״׳-]+|\s+|[^\s\p{L}\p{N}]/gu) ?? [];

const push = (out: DiffPart[], kind: DiffPart['kind'], text: string) => {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
};

/** A changed block (removed lines, added lines): word by word when small enough, else as a whole. */
const block = (out: DiffPart[], removed: string, added: string) => {
  const a = words(removed);
  const b = words(added);
  if (!a.length || !b.length || a.length * b.length > MAX_WORD_CELLS) {
    push(out, 'del', removed);
    push(out, 'add', added);
    return;
  }
  for (const op of lcs(a, b)) push(out, op.kind, op.value);
};

export const textDiff = (before: string, after: string): DiffPart[] => {
  const a = lines(before);
  const b = lines(after);
  const out: DiffPart[] = [];
  if (a.length * b.length > MAX_LINE_CELLS) {
    push(out, 'del', before);
    push(out, 'add', after);
    return out;
  }
  let removed = '';
  let added = '';
  const flush = () => {
    block(out, removed, added);
    removed = '';
    added = '';
  };
  for (const op of lcs(a, b)) {
    if (op.kind === 'same') {
      flush();
      push(out, 'same', op.value);
    } else if (op.kind === 'del') removed += op.value;
    else added += op.value;
  }
  flush();
  return out;
};
