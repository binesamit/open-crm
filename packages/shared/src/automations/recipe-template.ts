// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { ACTIONS } from './actions';
import { recipeItemLevel, recipeParentLevel, TRIGGERS, type ItemLevel } from './triggers';
import type { Trigger } from './schema';

/**
 * Account automation templates ("save as template", 04 §8): a recipe taken off its board. Every reference to that
 * board — a column (of the board or its sub-board), a group, a label of a status column — becomes a **slot** that is
 * picked again when the template is installed on another board (proposed by type and title); secrets never travel
 * (a webhook's URL becomes a text slot to fill, its secret and headers are dropped). Pure: the API reads the boards.
 */
export const TEMPLATE_SLOT_KINDS = ['column', 'group', 'label', 'text'] as const;
export const templateSlotSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(TEMPLATE_SLOT_KINDS),
  /** column / label: the board's own columns, or its sub-board's (D14). */
  board: z.enum(['main', 'sub']).optional(),
  /** column: the type the picked column must have. */
  column_type: z.string().max(40).optional(),
  /** What it was on the board the template came from (a column / group title, a label, a field name). */
  title: z.string().max(255),
  /** label: the slot of its column, and the label's id on the source column (filter values hold ids). */
  column_slot: z.string().max(200).optional(),
  source_id: z.number().int().optional(),
});
export type TemplateSlot = z.infer<typeof templateSlotSchema>;

/** A board as the template code reads it. */
export type TemplateBoard = {
  columns: { key: string; type: string; title: string; settings?: Record<string, unknown> }[];
  subColumns?: { key: string; type: string; title: string; settings?: Record<string, unknown> }[] | null;
  groups: { id: string; title: string }[];
};

type Json = Record<string, unknown>;
type Board = 'main' | 'sub';

/** One reference of the recipe to its board; the visitor returns its replacement (undefined = keep). */
export type RecipeRef =
  | { kind: 'column'; board: Board; key: string }
  | { kind: 'group'; id: string }
  /** `text` (a label as text) or `id` (a label id inside a filter value) of a label of `column` on `board`. */
  | { kind: 'label'; board: Board; column: string; text?: string; id?: number }
  | { kind: 'text'; path: string; value: string };

const TEMPLATE_RE = /(?<!\{)\{(item|parent|subitem)\.([a-z][a-z0-9_]*)/g;
const DATE_COLUMN_RE = /^column:([a-z][a-z0-9_]{0,49})/;
const TEXT_FIELDS = ['name', 'message', 'subject', 'body_html', 'body', 'prompt', 'item_id', 'value'] as const;

/**
 * Walks every board reference of a (draft) recipe, in place. Keys passed to the visitor are always the original
 * ones (a label is found through its column's original key).
 */
export const mapRecipeRefs = (recipe: Json, visit: (ref: RecipeRef) => unknown): Json => {
  const r = structuredClone(recipe) as Json & { trigger: Json; actions?: Json[]; conditions?: Json };
  const trigger = r.trigger;
  const tdef = TRIGGERS[trigger.type as keyof typeof TRIGGERS];
  if (!tdef) return r;
  const itemLevel = recipeItemLevel(trigger as Trigger);
  const parentLevel = recipeParentLevel(trigger as Trigger);
  const asBoard = (l: ItemLevel | null): Board | null => (l === 'sub' ? 'sub' : l === 'main' ? 'main' : null);
  const itemBoard = asBoard(itemLevel)!;

  const col = (board: Board | null, key: unknown) => {
    if (!board || typeof key !== 'string' || key === 'name' || key === 'id' || key.startsWith('__')) return key;
    const out = visit({ kind: 'column', board, key });
    return out === undefined ? key : out;
  };
  const label = (board: Board, column: unknown, text: unknown) => {
    if (typeof column !== 'string' || typeof text !== 'string') return text;
    const out = visit({ kind: 'label', board, column, text });
    return out === undefined ? text : out;
  };
  const group = (id: unknown) => {
    if (typeof id !== 'string' || id === 'any' || id.startsWith('@')) return id;
    const out = visit({ kind: 'group', id });
    return out === undefined ? id : out;
  };
  const people = (ref: unknown) => {
    if (typeof ref !== 'string') return ref;
    if (ref.startsWith('column:')) return `column:${col(itemBoard, ref.slice(7)) as string}`;
    if (ref.startsWith('mirror:')) {
      const [rel, c] = ref.slice(7).split('.');
      return `mirror:${col(itemBoard, rel) as string}.${c}`;
    }
    return ref;
  };
  const templated = (text: string) =>
    text.replace(TEMPLATE_RE, (whole, root: string, key: string) => {
      const board = root === 'item' ? itemBoard : root === 'parent' ? asBoard(parentLevel) : 'sub';
      const out = col(board, key);
      return typeof out === 'string' ? `{${root}.${out}` : whole;
    });
  const deep = (v: unknown): unknown =>
    typeof v === 'string'
      ? templated(v)
      : Array.isArray(v)
        ? v.map(deep)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
          : v;
  const filter = (g: unknown, board: Board) => {
    if (!g || typeof g !== 'object') return g;
    const walk = (node: Json): Json => {
      if (node.kind === 'group' && Array.isArray(node.rules))
        return { ...node, rules: (node.rules as Json[]).map(walk) };
      const key = node.column_id;
      if (typeof key !== 'string' || key.startsWith('__')) return node;
      const sub = key.startsWith('sub:');
      const b: Board = sub ? 'sub' : board;
      const raw = sub ? key.slice(4) : key;
      const mapped = col(b, raw);
      const values = Array.isArray(node.values)
        ? node.values.map((v) => {
            if (typeof v !== 'number') return v;
            const out = visit({ kind: 'label', board: b, column: raw, id: v });
            return out === undefined ? v : out;
          })
        : node.values;
      return { ...node, column_id: sub ? `sub:${mapped as string}` : mapped, values };
    };
    return walk(g as Json);
  };

  // ---- the trigger ----
  const tBoard: Board = tdef.sub ? 'sub' : 'main';
  const tCol = trigger.column;
  if (Array.isArray(trigger.labels)) trigger.labels = trigger.labels.map((l) => label(tBoard, tCol, l));
  if (Array.isArray(trigger.from_labels)) trigger.from_labels = trigger.from_labels.map((l) => label(tBoard, tCol, l));
  if ('column' in trigger) trigger.column = col(tBoard, tCol);
  if ('group' in trigger) trigger.group = group(trigger.group);
  if (trigger.type === 'person_assigned') trigger.who = people(trigger.who);
  const lookup = trigger.item_lookup as Json | undefined;
  if (lookup) lookup.column = col('main', lookup.column);
  if (trigger.type === 'webhook_in') delete trigger.secret; // a new one is made where it is installed
  // A flow connection / flow is this account's own: a template listens to any (picked again where it is installed).
  if (trigger.type === 'flow_failed' || trigger.type === 'flow_recovered') {
    trigger.connection = 'any';
    delete trigger.flow;
  }

  // ---- "only if" ----
  if (r.conditions) r.conditions = filter(r.conditions, itemBoard) as Json;

  // ---- the actions ----
  r.actions = (r.actions ?? []).map((a0, i) => {
    const a = a0;
    const def = ACTIONS[a.type as keyof typeof ACTIONS];
    if (!def) return a;
    const side = (on: 'item' | 'parent' | 'subitems' | undefined): Board | null =>
      on === 'parent' ? asBoard(parentLevel) : on === 'subitems' ? 'sub' : itemBoard;
    const colBoard = side(def.columnOn);
    const self = a.board === '@self';
    // Labels first: they are found through the column's original key.
    if (a.type === 'set_status' && colBoard) a.label = label(colBoard, a.column, a.label);
    if ('column' in a && !(a.type === 'connect_items' && a.target === 'trigger_item'))
      a.column = col(colBoard, a.column);
    if ('source' in a && def.sourceOn) a.source = col(side(def.sourceOn), a.source);
    if (a.type === 'copy_from_linked') a.relation = col(itemBoard, a.relation);
    if (a.type === 'move_to_group' || a.type === 'duplicate_item' || (self && 'group' in a)) a.group = group(a.group);
    if (a.type === 'create_item' || a.type === 'create_item_from_template') {
      a.connect_column = col(itemBoard, a.connect_column);
      if (self) a.connect_back_column = col('main', a.connect_back_column);
    }
    // Item templates: each variable's source is a column of the trigger item (the template itself is the board's).
    if (
      (a.type === 'create_item_from_template' || a.type === 'add_template_subitems') &&
      a.variables &&
      typeof a.variables === 'object'
    )
      a.variables = Object.fromEntries(
        Object.entries(a.variables as Json).map(([key, from]) => [key, col(itemBoard, from)]),
      );
    if ('who' in a) a.who = people(a.who);
    if ('to' in a) a.to = Array.isArray(a.to) ? a.to.map(people) : people(a.to);
    if (a.type === 'set_date' && typeof a.value === 'string') {
      const m = DATE_COLUMN_RE.exec(a.value);
      if (m) a.value = `column:${col(itemBoard, m[1]) as string}${a.value.slice(m[0].length)}`;
    }
    // mapping {target: source} / fixed {target: value}: sources are the item's; targets the new item's board.
    const targetBoard: Board | null = a.type === 'create_subitem' ? 'sub' : self ? 'main' : null;
    if (a.mapping && typeof a.mapping === 'object')
      a.mapping = Object.fromEntries(
        Object.entries(a.mapping as Json).map(([to, from]) => [
          targetBoard ? (col(targetBoard, to) as string) : to,
          col(itemBoard, from),
        ]),
      );
    if (a.fixed && typeof a.fixed === 'object')
      a.fixed = Object.fromEntries(
        Object.entries(a.fixed as Json).map(([to, v]) => [
          targetBoard ? (col(targetBoard, to) as string) : to,
          deep(v),
        ]),
      );
    if (a.where) a.where = filter(a.where, 'sub');
    for (const k of TEXT_FIELDS) if (typeof a[k] === 'string') a[k] = templated(a[k]);
    if (a.payload && typeof a.payload === 'object') a.payload = deep(a.payload);
    if (a.type === 'webhook') {
      // A hook URL is itself a secret (Make / Zapier): it is filled in again where the template is installed.
      const out = visit({ kind: 'text', path: `actions.${i}.url`, value: String(a.url ?? '') });
      if (out !== undefined) a.url = out;
      delete a.secret;
      delete a.headers;
    }
    return a;
  });
  return r;
};

const labelsOf = (c: { settings?: Record<string, unknown> } | undefined) =>
  (Array.isArray(c?.settings?.labels)
    ? (c.settings.labels as { id: number; label: string; is_deactivated?: boolean }[])
    : []
  ).filter((l) => !l.is_deactivated);

const slotId = (ref: RecipeRef) =>
  ref.kind === 'column'
    ? `column:${ref.board}:${ref.key}`
    : ref.kind === 'group'
      ? `group:${ref.id}`
      : ref.kind === 'text'
        ? `text:${ref.path}`
        : `label:${ref.board}:${ref.column}:${ref.text ?? ref.id}`;

/**
 * "Save as template": the recipe with its secrets dropped, and the slots it needs. A reference the board no longer
 * has (a deleted column) stays as it is — the install then reports it, like a broken automation.
 */
export const extractTemplate = (recipe: Json, board: TemplateBoard): { recipe: Json; slots: TemplateSlot[] } => {
  const slots = new Map<string, TemplateSlot>();
  const colsOf = (b: Board) => (b === 'sub' ? (board.subColumns ?? []) : board.columns);
  const out = mapRecipeRefs(recipe, (ref) => {
    if (ref.kind === 'column') {
      const c = colsOf(ref.board).find((x) => x.key === ref.key);
      if (!c) return undefined;
      slots.set(slotId(ref), {
        id: slotId(ref),
        kind: 'column',
        board: ref.board,
        column_type: c.type,
        title: c.title,
      });
      return undefined;
    }
    if (ref.kind === 'group') {
      const g = board.groups.find((x) => x.id === ref.id || x.title.trim() === ref.id.trim());
      if (!g) return undefined;
      const id = slotId({ kind: 'group', id: g.id });
      slots.set(id, { id, kind: 'group', title: g.title });
      return g.id;
    }
    if (ref.kind === 'label') {
      const c = colsOf(ref.board).find((x) => x.key === ref.column);
      const l = labelsOf(c).find((x) =>
        ref.text !== undefined ? x.label.trim() === ref.text.trim() : x.id === ref.id,
      );
      if (!c || !l) return undefined;
      // One slot per label of a column, whether the recipe names it by text or by id.
      const id = `label:${ref.board}:${ref.column}:${l.label.trim()}`;
      slots.set(id, {
        id,
        kind: 'label',
        board: ref.board,
        title: l.label.trim(),
        column_slot: `column:${ref.board}:${ref.column}`,
        source_id: l.id,
      });
      return undefined;
    }
    slots.set(slotId(ref), { id: slotId(ref), kind: 'text', title: ref.path });
    return '';
  });
  return { recipe: out, slots: [...slots.values()] };
};

export type SlotOption = { value: string; title: string };
export type SlotProposal = TemplateSlot & { value: string | null; options: SlotOption[] };

/**
 * The install form: every slot with what it can be on the target board and a proposal — a column of the same type
 * (the same title first, each target column once), the group / label of the same title. `chosen` overrides.
 */
export const proposeSlots = (
  slots: TemplateSlot[],
  target: TemplateBoard,
  chosen: Record<string, string> = {},
): SlotProposal[] => {
  const colsOf = (b: Board | undefined) => (b === 'sub' ? (target.subColumns ?? []) : target.columns);
  const used = new Set<string>();
  const byId = new Map<string, string | null>();
  const norm = (s: string) => s.trim().toLowerCase();
  const out: SlotProposal[] = [];
  // Columns first (labels depend on them); explicit picks are reserved before proposals.
  for (const s of slots) if (s.kind === 'column' && chosen[s.id]) used.add(`${s.board}:${chosen[s.id]}`);
  const ordered = [...slots.filter((s) => s.kind === 'column'), ...slots.filter((s) => s.kind !== 'column')];
  for (const s of ordered) {
    let options: SlotOption[] = [];
    let value: string | null = null;
    if (s.kind === 'column') {
      const fits = colsOf(s.board).filter((c) => c.type === s.column_type && c.type !== 'name');
      options = fits.map((c) => ({ value: c.key, title: c.title }));
      const pick = chosen[s.id];
      if (pick !== undefined) value = fits.some((c) => c.key === pick) ? pick : null;
      else {
        const free = fits.filter((c) => !used.has(`${s.board}:${c.key}`));
        const c = free.find((x) => norm(x.title) === norm(s.title)) ?? free[0];
        value = c?.key ?? null;
        if (c) used.add(`${s.board}:${c.key}`);
      }
    } else if (s.kind === 'group') {
      options = target.groups.map((g) => ({ value: g.id, title: g.title }));
      const pick = chosen[s.id];
      value =
        pick !== undefined
          ? options.some((o) => o.value === pick)
            ? pick
            : null
          : ((target.groups.find((g) => norm(g.title) === norm(s.title)) ?? target.groups[0])?.id ?? null);
    } else if (s.kind === 'label') {
      const colKey = s.column_slot ? byId.get(s.column_slot) : null;
      const c = colKey ? colsOf(s.board).find((x) => x.key === colKey) : undefined;
      options = labelsOf(c).map((l) => ({ value: l.label.trim(), title: l.label.trim() }));
      const pick = chosen[s.id];
      value =
        pick !== undefined
          ? options.some((o) => o.value === pick.trim())
            ? pick.trim()
            : null
          : (options.find((o) => norm(o.value) === norm(s.title))?.value ?? null);
    } else {
      const pick = chosen[s.id];
      value = pick?.trim() ? pick.trim() : null;
    }
    byId.set(s.id, value);
    out.push({ ...s, value, options });
  }
  // Back in the template's order.
  return slots.map((s) => out.find((o) => o.id === s.id)!);
};

/**
 * Install: the template's recipe on the target board, every slot replaced by its pick (or proposal). `missing` =
 * the slots nothing fits (the form asks for them).
 */
export const applyTemplate = (
  recipe: Json,
  slots: TemplateSlot[],
  target: TemplateBoard,
  chosen: Record<string, string> = {},
): { recipe: Json; missing: string[]; proposals: SlotProposal[] } => {
  const proposals = proposeSlots(slots, target, chosen);
  const value = new Map(proposals.map((p) => [p.id, p.value]));
  const missing = proposals.filter((p) => p.value === null).map((p) => p.id);
  const colsOf = (b: Board) => (b === 'sub' ? (target.subColumns ?? []) : target.columns);
  const out = mapRecipeRefs(recipe, (ref) => {
    if (ref.kind === 'column') return value.get(slotId(ref)) ?? undefined;
    if (ref.kind === 'group') return value.get(slotId(ref)) ?? undefined;
    if (ref.kind === 'text') return value.get(slotId(ref)) ?? '';
    // A label: by the slot of its text (texts) or the source label it was saved from (ids, in filters).
    const prefix = `label:${ref.board}:${ref.column}:`;
    const slot = slots.find(
      (s) =>
        s.kind === 'label' &&
        (ref.text !== undefined
          ? s.id === `${prefix}${ref.text.trim()}`
          : s.id.startsWith(prefix) && s.source_id === ref.id),
    );
    if (!slot) return undefined;
    const text = value.get(slot.id);
    if (!text) return undefined;
    if (ref.text !== undefined) return text;
    const colKey = value.get(`column:${ref.board}:${ref.column}`);
    const c = colsOf(ref.board).find((x) => x.key === colKey);
    return labelsOf(c).find((l) => l.label.trim() === text)?.id;
  });
  return { recipe: out, missing, proposals };
};
