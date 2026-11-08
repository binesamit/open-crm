// SPDX-License-Identifier: AGPL-3.0-only
import { AI_STYLE_COUNT_DEFAULT, getLocale, t, tDynamic } from '@bines/shared';

/**
 * r18board 5 (product owner: "show names, not raw values"): how a blank of the automation sentence reads in
 * the builder — columns by title (whatever level they live on), people by name, status labels by name (not an
 * index or id), dates formatted, and `{variables}` in texts as readable chips ("שם הפריט", "סטטוס") instead of
 * `{item.name}` / `{item.status}` keys. Pure: the builder renders the segments.
 */
export type DisplayColumn = { id: string; title: string; type: string; settings?: unknown };

/** A piece of a blank: plain text, or a template variable shown as a chip. */
export type Segment = { text: string } | { chip: string; raw: string };

export type DisplayEnv = {
  /** The run item's columns (the sub-board's for a subitem trigger). */
  itemColumns: DisplayColumn[];
  /** Its parent's columns (empty when the item has no parent). */
  parentColumns: DisplayColumn[];
  /** The sub-board's columns (empty without one). */
  subColumns: DisplayColumn[];
  /** The board's own columns. */
  mainColumns: DisplayColumn[];
  groups: { id: string; title: string }[];
  personName: (id: string) => string | undefined;
  teamName?: (id: string) => string | undefined;
};

/** A column's title: the given level first, then any level the board knows (never the raw key when known). */
export const columnTitle = (env: DisplayEnv, key: string | undefined, first?: DisplayColumn[]): string => {
  if (!key) return '';
  if (key === 'name') return t('auto.word.name');
  for (const list of [first ?? [], env.itemColumns, env.mainColumns, env.subColumns, env.parentColumns]) {
    const c = list.find((x) => x.id === key);
    if (c) return c.title;
  }
  return key;
};

const findColumn = (env: DisplayEnv, key: unknown, first?: DisplayColumn[]) => {
  if (typeof key !== 'string') return undefined;
  for (const list of [first ?? [], env.itemColumns, env.mainColumns, env.subColumns, env.parentColumns]) {
    const c = list.find((x) => x.id === key);
    if (c) return c;
  }
  return undefined;
};

/** A template variable as people read it; null = not a variable we know (kept as written). */
export const variableLabel = (raw: string, env: DisplayEnv): string | null => {
  const [root, key] = raw.split('.') as [string, string | undefined];
  if (!key) {
    if (root === 'actor') return t('auto.var.actor');
    if (root === 'today') return t('auto.date.today');
    return null;
  }
  if (root === 'board' && key === 'name') return t('auto.var.board');
  if (root === 'item') {
    if (key === 'name') return t('r18.auto.var.itemName');
    if (key === 'url') return t('auto.var.url');
    const c = findColumn(env, key, env.itemColumns);
    return c ? c.title : null;
  }
  if (root === 'parent' || root === 'subitem') {
    const head = t(`auto.var.${root}`);
    if (key === 'name') return `${head} › ${t('auto.word.name')}`;
    const c = findColumn(env, key, root === 'parent' ? env.parentColumns : env.subColumns);
    return c ? `${head} › ${c.title}` : null;
  }
  return null;
};

/** `"Task {item.name} is {item.status}"` → text and chips. */
export const templateSegments = (text: string, env: DisplayEnv): Segment[] => {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(/(?<!\{)\{([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)?)([^{}]*)\}/gi)) {
    const label = variableLabel(m[1]!, env);
    if (!label) continue;
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    const rest = m[2]!.trim();
    out.push({ chip: rest ? `${label} ${rest}` : label, raw: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
};

/** Shortens text segments to about `n` characters in all (chips count as their label), with "…". */
const clip = (segs: Segment[], n = 48): Segment[] => {
  const out: Segment[] = [];
  let used = 0;
  for (const s of segs) {
    const len = 'chip' in s ? s.chip.length : s.text.length;
    if (used + len <= n) {
      out.push(s);
      used += len;
      continue;
    }
    if ('text' in s) out.push({ text: `${s.text.slice(0, Math.max(0, n - used))}…` });
    else out.push({ text: '…' });
    break;
  }
  return out;
};

export const formatDate = (iso: string, time?: string | null): string => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const day = new Intl.DateTimeFormat(getLocale() === 'he' ? 'he-IL' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
  return time ? `${day}, ${time.slice(0, 5)}` : day;
};

type Label = { id?: number | string; label: string; index?: number };

/** A cell value written by an action, in words for its column's type. */
export const valueText = (value: unknown, column: DisplayColumn | undefined, env: DisplayEnv): string => {
  if (value === null || value === undefined) return '';
  const type = column?.type;
  const labels = ((column?.settings as { labels?: Label[] } | undefined)?.labels ?? []) as Label[];
  const labelOf = (x: unknown) => {
    if (typeof x === 'string') {
      const hit = labels.find((l) => l.label === x || String(l.id) === x);
      return hit?.label ?? x;
    }
    if (typeof x === 'number') return labels.find((l) => l.index === x || l.id === x)?.label ?? String(x);
    return undefined;
  };
  if (type === 'status' || type === 'dropdown') {
    if (typeof value === 'string' || typeof value === 'number') return labelOf(value) ?? '';
    const v = value as { label?: string; index?: number; id?: number | string; ids?: unknown[]; labels?: unknown[] };
    if (Array.isArray(v.labels)) return v.labels.map(labelOf).filter(Boolean).join(', ');
    if (Array.isArray(v.ids)) return v.ids.map(labelOf).filter(Boolean).join(', ');
    return labelOf(v.label ?? v.index ?? v.id) ?? '';
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.persons_and_teams))
      return (v.persons_and_teams as { id: string; kind?: string }[])
        .map((p) => (p.kind === 'team' ? (env.teamName?.(p.id) ?? p.id) : (env.personName(p.id) ?? p.id)))
        .join(', ');
    if (typeof v.date === 'string') return formatDate(v.date, typeof v.time === 'string' ? v.time : null);
    if (typeof v.from === 'string' && typeof v.to === 'string') return `${formatDate(v.from)} – ${formatDate(v.to)}`;
    if (typeof v.checked === 'boolean') return t(v.checked ? 'auto.checkbox.checked' : 'auto.checkbox.unchecked');
    if (typeof v.label === 'string') return v.label;
    if (typeof v.text === 'string') return v.text;
    if (typeof v.url === 'string') return String(v.text ?? v.url);
    if (typeof v.email === 'string') return v.email;
    if (typeof v.phone === 'string') return v.phone;
    return JSON.stringify(value);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  return String(value);
};

/** A people reference (`column:x`, `user:id`, `team:id`, `@actor`…) by name. */
export const peopleText = (ref: unknown, env: DisplayEnv): string => {
  if (Array.isArray(ref)) return ref.map((r) => peopleText(r, env)).join(', ');
  if (typeof ref !== 'string' || !ref) return '';
  if (ref === 'any' || ref === 'all' || ref.startsWith('@')) return tDynamic(`auto.who.${ref.replace('@', '')}`);
  if (ref.startsWith('column:')) return columnTitle(env, ref.slice(7), env.itemColumns);
  if (ref.startsWith('user:')) return env.personName(ref.slice(5)) ?? ref.slice(5);
  if (ref.startsWith('team:')) return env.teamName?.(ref.slice(5)) ?? ref.slice(5);
  return ref;
};

/** Text blanks with template variables. */
const TEMPLATE_FIELDS = new Set(['message', 'subject', 'body', 'body_html', 'name', 'prompt']);

/**
 * How one blank reads, or null to keep the shared sentence's text. `ownerColumns` = the columns the owner's
 * `column` lives in (the builder's `columnsOf`).
 */
export const slotDisplay = (
  owner: Record<string, unknown> & { type: string },
  field: string,
  env: DisplayEnv,
  ownerColumns?: DisplayColumn[],
): Segment[] | null => {
  const v = owner[field];
  if (v === undefined || v === null || v === '') return null;
  // a "when … changes" trigger on several columns reads "Quantity or Service".
  const more = field === 'column' && Array.isArray(owner.columns) ? (owner.columns as string[]) : [];
  if (more.length > 1)
    return [
      {
        text: [...new Set([String(v), ...more])].map((c) => columnTitle(env, c, ownerColumns)).join(t('auto.word.or')),
      },
    ];
  if (field === 'column' || field === 'relation') {
    const title = columnTitle(env, String(v), ownerColumns);
    return [{ text: title }];
  }
  if (field === 'to' || field === 'who' || field === 'fallback') {
    if (owner.type === 'start_time_tracking' || owner.type === 'stop_time_tracking') {
      if (v === '@automation_owner' || v === '@all') return null; // the shared wording
    }
    const text = peopleText(v, env);
    return text ? [{ text }] : null;
  }
  if (field === 'group') {
    const g = env.groups.find((x) => x.id === v);
    return g ? [{ text: g.title }] : null;
  }
  if (field === 'value') {
    if (owner.type === 'set_date' || owner.type === 'number_threshold') return null;
    if (typeof v === 'string') {
      const col = findColumn(env, owner.column, ownerColumns);
      if (col && (col.type === 'status' || col.type === 'dropdown') && !v.includes('{'))
        return [{ text: valueText(v, col, env) }];
      return clip(templateSegments(v, env));
    }
    return [{ text: valueText(v, findColumn(env, owner.column, ownerColumns), env) }];
  }
  if (TEMPLATE_FIELDS.has(field) && typeof v === 'string') {
    if (owner.type === 'send_sms' && owner.template) return null;
    return clip(templateSegments(v, env));
  }
  return null;
};

/** The run test's field names people read (r27); a field without one shows its key. */
const PREVIEW_FIELDS = new Set([
  'column',
  'group',
  'to',
  'who',
  'fallback',
  'value',
  'label',
  'message',
  'subject',
  'body',
  'body_html',
  'name',
  'prompt',
  'board',
  'relation',
  'source',
  'source_column',
  'source_columns',
  'style_examples',
  'by',
  'mode',
]);
export const previewFieldLabel = (field: string): string =>
  PREVIEW_FIELDS.has(field) ? tDynamic(`r27.test.field.${field}`) : field;

/**
 * r27: one field of "run a test"'s preview (the action with its templates already rendered for the item) as people
 * read it — group names, people refs by name ("בעלי הלוח", a people column by its title), columns by title, cell
 * values in words — never a raw id, `@board_owners` or `column:owner`. `boardName` names a target board.
 */
export const previewFieldText = (
  owner: Record<string, unknown> & { type: string },
  field: string,
  env: DisplayEnv,
  ownerColumns?: DisplayColumn[],
  boardName?: (id: string) => string | undefined,
): string => {
  const v = owner[field];
  if (v === undefined || v === null) return '';
  // generate_image's photo columns: their titles, in order.
  if (field === 'source_columns' && Array.isArray(v))
    return v.map((k) => (typeof k === 'string' ? columnTitle(env, k, ownerColumns) : String(k))).join(', ');
  // Round 3: the style examples' column and how many (the filter is the builder's).
  if (field === 'style_examples' && typeof v === 'object' && typeof (v as { column?: unknown }).column === 'string') {
    const style = v as { column: string; count?: number };
    return `${columnTitle(env, style.column, ownerColumns)} (${style.count ?? AI_STYLE_COUNT_DEFAULT})`;
  }
  if (field === 'column' || field === 'relation' || field === 'source' || field.endsWith('_column'))
    return typeof v === 'string' ? columnTitle(env, v, ownerColumns) : String(v);
  if (field === 'to' || field === 'who' || field === 'fallback') return peopleText(v, env) || String(v);
  if (field === 'group') return env.groups.find((g) => g.id === v)?.title ?? String(v);
  if (field === 'board' && typeof v === 'string') return boardName?.(v) ?? v;
  if (field === 'value' || field === 'label') return valueText(v, findColumn(env, owner.column, ownerColumns), env);
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return t(v ? 'auto.checkbox.checked' : 'auto.checkbox.unchecked');
  return valueText(v, undefined, env);
};
