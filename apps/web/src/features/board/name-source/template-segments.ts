// SPDX-License-Identifier: AGPL-3.0-only
import { parseNameTemplate, type NameSource, type NameSourceMode } from '@bines/shared';

/**
 * The name template as people build it ("way 2"): pieces of text with column chips between them — no
 * braces to type. Always alternates text / column / text …, starting and ending with text (possibly empty), so
 * there is a text field before, between and after every chip. Stored as the template string with `{key}`
 * placeholders (`{{` / `}}` for literal braces).
 */
export type Segment = { kind: 'text'; text: string } | { kind: 'column'; key: string };

/** Merges neighbouring texts and puts a (possibly empty) text around every column. */
export const normalizeSegments = (segs: Segment[]): Segment[] => {
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (s.kind === 'text') {
      if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + s.text };
      else out.push(s);
    } else {
      if (last?.kind !== 'text') out.push({ kind: 'text', text: '' });
      out.push(s);
    }
  }
  if (out[out.length - 1]?.kind !== 'text') out.push({ kind: 'text', text: '' });
  return out;
};

export const templateToSegments = (template: string | undefined): Segment[] =>
  normalizeSegments(
    parseNameTemplate(template ?? '').map((p): Segment =>
      'key' in p ? { kind: 'column', key: p.key } : { kind: 'text', text: p.text },
    ),
  );

export const segmentsToTemplate = (segs: Segment[]): string =>
  segs.map((s) => (s.kind === 'column' ? `{${s.key}}` : s.text.replace(/\{/g, '{{').replace(/\}/g, '}}'))).join('');

/**
 * A column chip inserted inside text segment `index` at `offset` (the caret) — the text splits around it. A
 * missing / non-text index appends the column at the end.
 */
export const insertColumn = (segs: Segment[], key: string, at?: { index: number; offset: number }): Segment[] => {
  const target = at ? segs[at.index] : undefined;
  if (!at || target?.kind !== 'text') return normalizeSegments([...segs, { kind: 'column', key }]);
  const offset = Math.max(0, Math.min(at.offset, target.text.length));
  return normalizeSegments([
    ...segs.slice(0, at.index),
    { kind: 'text', text: target.text.slice(0, offset) },
    { kind: 'column', key },
    { kind: 'text', text: target.text.slice(offset) },
    ...segs.slice(at.index + 1),
  ]);
};

/** Removes the column chip at `index` (its neighbouring texts join). */
export const removeSegment = (segs: Segment[], index: number): Segment[] =>
  normalizeSegments(segs.filter((_, i) => i !== index));

export const setSegmentText = (segs: Segment[], index: number, text: string): Segment[] =>
  segs.map((s, i) => (i === index && s.kind === 'text' ? { kind: 'text', text } : s));

/** Column keys the segments use, in order, without repeats. */
export const segmentRefs = (segs: Segment[]): string[] => [
  ...new Set(segs.flatMap((s) => (s.kind === 'column' ? [s.key] : []))),
];

/** The draft the dialog edits → the `NameSource` it saves (keys only). */
export const draftToSource = (d: {
  mode: NameSourceMode;
  columnId: string | null;
  segments: Segment[];
  emptyText: string;
  warn: boolean;
  openOnCreate?: boolean;
}): NameSource => {
  const common = {
    ...(d.emptyText.trim() ? { empty_text: d.emptyText.trim() } : {}),
    warn_duplicates: d.warn,
    ...(d.openOnCreate ? { open_on_create: true } : {}),
  };
  if (d.mode === 'column') return { mode: 'column', column_id: d.columnId ?? undefined, ...common };
  if (d.mode === 'template') return { mode: 'template', template: segmentsToTemplate(d.segments), ...common };
  return { mode: 'free', warn_duplicates: d.warn };
};

/** Can this draft be saved (a column picked, a template with at least one column)? */
export const draftReady = (d: { mode: NameSourceMode; columnId: string | null; segments: Segment[] }) =>
  d.mode === 'free' || (d.mode === 'column' ? !!d.columnId : segmentRefs(d.segments).length > 0);
