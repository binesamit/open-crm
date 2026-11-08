// SPDX-License-Identifier: AGPL-3.0-only
import { getLocale, hasMessage, t, type Locale, type MessageKey } from '../i18n';
import type { FilterGroup, FilterRule } from '../query/filter';
import type { Action, PeopleRef, Recipe, Trigger } from './schema';
import { DATE_EXPR_RE, dateExprShift, generateImageSources } from './schema';
import { ACTIONS } from './actions';
import { recipeItemLevel, recipeParentLevel, TRIGGERS, triggerColumns, type ItemLevel } from './triggers';
import { type ComputedEnv, computedToNames } from './computed';

/**
 * 04 §8.1 — a recipe as the builder's sentence: plain text with **slots** (the blanks you click). Each slot
 * names the recipe field it edits (`trigger.column`, `actions.1.group`); an empty one shows a placeholder.
 * The words come from i18n (`auto.t.*`, `auto.a.*`), so the same recipe reads in Hebrew and English.
 */
export type SentencePart = { text: string; slot?: string; empty?: boolean };

export type SentenceBoard = {
  columns: { key: string; title: string; type: string }[];
  groups: { id: string; title: string }[];
  boardName?: (id: string) => string | undefined;
  personName?: (id: string) => string | undefined;
  teamName?: (id: string) => string | undefined;
  /** run_agent: the agent's name. */
  /** send_document: an interactive document template's name. */
  idocTemplateName?: (id: string) => string | undefined;
  /** create_item_from_template / add_template_subitems: an item template's name. */
  itemTemplateName?: (id: string) => string | undefined;
  agentName?: (id: string) => string | undefined;
  /** run_extension / extension_trigger (D27 ת4): the extension block's name ("WhatsApp · send a message"). */
  extensionBlockName?: (block: string) => string | undefined;
  /** copy_from_linked: a column title on the board a relation column links to. */
  linkedColumnTitle?: (relation: string, key: string) => string | undefined;
  /** set_computed: the columns of the board a relation column links to (undefined = not known). */
  linkedColumns?: (relation: string) => { key: string; title: string; type: string }[] | undefined;
  /** D14: the sub-board's columns (subitem triggers, parent / subitem actions). */
  subColumns?: { key: string; title: string; type: string }[];
  /** Where the run's item lives (`recipeItemLevel`): set by `scopedSentenceBoard`. */
  itemLevel?: ItemLevel;
  /** The board has sub-subitems (hierarchy deeper than 1): subitem triggers show their level blank. */
  subLevels?: boolean;
  /** The board's own name: a subitem trigger's recipient on the parent's board reads "<column> of <board>". */
  parentBoardName?: string;
  /** send_sms: the name of one of the account's saved SMS texts (Administration → SMS). */
  smsTemplateName?: (id: string) => string | undefined;
  /** flow_failed / flow_recovered: a flow connection's name, and a flow's name in it. */
  flowConnectionName?: (id: string) => string | undefined;
  flowName?: (connectionId: string, flowId: string) => string | undefined;
};

type Scoped = SentenceBoard & {
  mainColumns?: SentenceBoard['columns'];
  parentColumns?: SentenceBoard['columns'];
};

/**
 * The board as one recipe reads it (D14): `columns` = the run item's board (the sub-board's for a subitem trigger),
 * `parentColumns` = its parent's. Idempotent.
 */
export const scopedSentenceBoard = (b: SentenceBoard, trigger: Trigger): SentenceBoard => {
  if (b.itemLevel) return b;
  const itemLevel = recipeItemLevel(trigger);
  const parentLevel = recipeParentLevel(trigger);
  const of = (l: ItemLevel | null) => (l === 'sub' ? (b.subColumns ?? []) : l === 'main' ? b.columns : []);
  const out: Scoped = {
    ...b,
    mainColumns: b.columns,
    columns: of(itemLevel),
    parentColumns: of(parentLevel),
    itemLevel,
  };
  return out;
};
const sideBoard = (b: Scoped, on: 'item' | 'parent' | 'subitems' | undefined): SentenceBoard =>
  on === 'parent'
    ? { ...b, columns: b.parentColumns ?? b.columns }
    : on === 'subitems'
      ? { ...b, columns: b.subColumns ?? [] }
      : b;

type Slots = Record<string, { text: string; slot?: string }>;

/** Splits an i18n template into text and slots (`{name}`); a slot with no value shows its placeholder. */
const fill = (key: MessageKey, slots: Slots, locale: Locale): SentencePart[] => {
  const parts: SentencePart[] = [];
  const template = t(key, undefined, locale);
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (m.index! > last) parts.push({ text: template.slice(last, m.index) });
    const s = slots[m[1]!];
    if (!s) parts.push({ text: '' });
    else if (s.slot)
      parts.push(
        s.text
          ? { text: s.text, slot: s.slot }
          : { text: t(`auto.blank.${m[1]}` as MessageKey, undefined, locale), slot: s.slot, empty: true },
      );
    else parts.push({ text: s.text });
    last = m.index! + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts.filter((p) => p.text !== '' || p.slot);
};

const colTitle = (b: SentenceBoard, key: string | undefined) =>
  key === 'name' ? t('auto.word.name') : (b.columns.find((c) => c.key === key)?.title ?? key ?? '');

const orList = (xs: string[], locale: Locale) => xs.join(t('auto.word.or', undefined, locale));

/**
 * A `column:` people ref: the run item's column, or a subitem trigger's recipient on the parent's
 * board — "מנהל של Projects" / "Manager of Projects", or "of the parent item" when the board's name is not known.
 */
const columnRefText = (key: string, b: SentenceBoard, locale: Locale) => {
  const parentCol =
    b.itemLevel === 'sub' && !b.columns.some((c) => c.key === key)
      ? // A sub-subitem's parent is a subitem; the engine climbs on to the main board (notifyfix2), so look there too.
        ((b as Scoped).parentColumns?.find((c) => c.key === key) ??
        (b as Scoped).mainColumns?.find((c) => c.key === key))
      : undefined;
  if (!parentCol) return colTitle(b, key);
  const board = b.parentBoardName?.trim();
  const msg = (board ? 'auto.who.parent_column' : 'auto.who.parent_item_column') as MessageKey;
  const vars = { column: parentCol.title, board: board ?? '' };
  // Until the i18n keys are merged, a plain "<column> (<board>)" — never a raw key in the sentence.
  return hasMessage(msg)
    ? t(msg, vars, locale)
    : `${parentCol.title} (${board || t('auto.var.parent' as MessageKey, undefined, locale)})`;
};

export const peopleRefText = (
  ref: PeopleRef | 'all' | 'any',
  b: SentenceBoard,
  locale: Locale = getLocale(),
): string => {
  if (!ref) return ''; // a blank of a draft
  if (ref === 'all' || ref === 'any' || ref.startsWith('@'))
    return t(`auto.who.${ref.replace('@', '')}` as MessageKey, undefined, locale);
  if (ref.startsWith('column:')) return columnRefText(ref.slice(7), b, locale);
  if (ref.startsWith('mirror:')) {
    const [rel, col] = ref.slice(7).split('.');
    return `${colTitle(b, rel)} › ${col}`;
  }
  if (ref.startsWith('user:')) return b.personName?.(ref.slice(5)) ?? ref.slice(5);
  if (ref.startsWith('team:')) return b.teamName?.(ref.slice(5)) ?? ref.slice(5);
  return ref; // an email address
};

/** Whose timer, as people read it: unset = the automation's owner, `@all` = everyone. */
export const timerWhoText = (who: string | undefined, b: SentenceBoard, locale: Locale = getLocale()): string =>
  who === undefined || who === '@automation_owner'
    ? t('auto.who.automation_owner' as MessageKey, undefined, locale)
    : who === '@all'
      ? t('auto.who.all', undefined, locale)
      : peopleRefText(who as PeopleRef, b, locale);

const recipientsText = (to: PeopleRef | PeopleRef[] | undefined, b: SentenceBoard, locale: Locale) =>
  (Array.isArray(to) ? to : to ? [to] : []).map((r) => peopleRefText(r, b, locale)).join(', ');

/** `today+3d@14:00` → "היום + 3 ימים, 14:00". */
export const dateExprText = (expr: string, b: SentenceBoard, locale: Locale = getLocale()): string => {
  const m = DATE_EXPR_RE.exec(expr ?? '');
  if (!m) return expr ?? '';
  const [, base, shift, at] = m;
  const head = base!.startsWith('column:')
    ? colTitle(b, base!.slice(7))
    : t(`auto.date.${base}` as MessageKey, undefined, locale);
  const parts = shift ? dateExprShift(shift) : null;
  const tail = parts
    ? ` ${parts.n < 0 ? '−' : '+'} ${t(`auto.date.unit.${parts.unit}` as MessageKey, { n: Math.abs(parts.n) }, locale)}`
    : '';
  return `${head}${tail}${at ? `, ${at.slice(1)}` : ''}`;
};

const groupTitle = (b: SentenceBoard, ref: string | undefined) =>
  !ref
    ? ''
    : ref === '@top' || ref === '@bottom'
      ? t(`auto.group.${ref.slice(1)}` as MessageKey)
      : (b.groups.find((g) => g.id === ref)?.title ?? ref);

const short = (s: string | undefined, n = 40) => (!s ? '' : s.length > n ? `${s.slice(0, n)}…` : s);

/** `https://hooks.example.com/abc/secret` → `https://hooks.example.com/…` (no path, no query: they can be secrets). */
const urlOrigin = (raw: string | undefined) => {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.pathname === '/' && !u.search ? u.origin : `${u.origin}/…`;
  } catch {
    return '…';
  }
};

/** what a `set_computed` expression reads, by name (the run item, its parent, its linked items). */
export const computedEnvOf = (b: SentenceBoard): ComputedEnv => {
  const ids = (cols: SentenceBoard['columns']) => cols.map((c) => ({ id: c.key, title: c.title }));
  return {
    item: ids(b.columns),
    parent: ids((b as Scoped).parentColumns ?? []),
    relations: b.columns
      .filter((c) => c.type === 'board_relation')
      .map((r) => {
        const cols = b.linkedColumns?.(r.key);
        return { id: r.key, title: r.title, ...(cols ? { columns: ids(cols) } : {}) };
      }),
  };
};
const computedText = (expr: string | undefined, b: SentenceBoard) => computedToNames(expr ?? '', computedEnvOf(b));

/** A template as people read it: `{item.color_x}` → `{סטטוס}`, `{item.name}` → `{שם}`. */
export const readableTemplate = (text: string | undefined, b: SentenceBoard, locale: Locale = getLocale()) =>
  (text ?? '').replace(
    /(?<!\{)\{(item|parent|subitem)\.([a-z][a-z0-9_]*)([^{}]*)\}/g,
    (whole, root: string, key: string, rest: string) => {
      if (key === 'name') return `{${t('auto.word.name', undefined, locale)}${rest}}`;
      const cols =
        root === 'parent'
          ? ((b as Scoped).parentColumns ?? b.columns)
          : root === 'subitem'
            ? (b.subColumns ?? [])
            : b.columns;
      const col = cols.find((c) => c.key === key);
      return col ? `{${col.title}${rest}}` : whole;
    },
  );
const shortT = (s: string | undefined, b: SentenceBoard, n = 40) => short(readableTemplate(s, b), n);

export const triggerSentence = (tr: Trigger, b0: SentenceBoard, locale: Locale = getLocale()): SentencePart[] => {
  const parts = triggerParts(tr, b0, locale);
  // D14: which level of the sub-board a subitem trigger hears — shown when the board has sub-subitems or it is set.
  const level = 'level' in tr ? tr.level : undefined;
  if (TRIGGERS[tr.type]?.sub && (b0.subLevels || level))
    parts.push(
      { text: ' · ' },
      { text: t(`auto.level.${level ?? 'any'}` as MessageKey, undefined, locale), slot: 'trigger.level' },
    );
  return parts;
};

const triggerParts = (tr: Trigger, b0: SentenceBoard, locale: Locale): SentencePart[] => {
  const s = (field: string, text: string) => ({ text, slot: `trigger.${field}` });
  const key = `auto.t.${tr.type}` as MessageKey;
  // A trigger's column is on the board — a subitem trigger's on the sub-board.
  const main = (b0 as Scoped).mainColumns ?? b0.columns;
  const b: SentenceBoard = { ...b0, columns: TRIGGERS[tr.type]?.sub ? (b0.subColumns ?? []) : main };
  switch (tr.type) {
    case 'item_created_in_group':
    case 'item_moved_to_group':
      return fill(
        key,
        { group: s('group', tr.group === 'any' ? t('auto.group.any', undefined, locale) : groupTitle(b, tr.group)) },
        locale,
      );
    case 'status_changed':
    case 'subitem_status_changed':
      return fill(
        key,
        {
          column: s('column', colTitle(b, tr.column)),
          labels: s(
            'labels',
            tr.labels === 'any' ? t('auto.word.anything', undefined, locale) : orList(tr.labels ?? [], locale),
          ),
        },
        locale,
      );
    case 'file_added':
      return fill(
        key,
        {
          column: s(
            'column',
            tr.column ? colTitle(b, tr.column) : t('auto.word.any_file_column' as MessageKey, undefined, locale),
          ),
        },
        locale,
      );
    case 'column_changed':
    case 'subitem_column_changed':
      // several columns read "Quantity or Service".
      return fill(
        key,
        {
          column: s(
            'column',
            orList(
              triggerColumns(tr).map((c) => colTitle(b, c)),
              locale,
            ),
          ),
        },
        locale,
      );
    case 'button_clicked':
    case 'connected_items_all_done':
      return fill(key, { column: s('column', colTitle(b, tr.column)) }, locale);
    case 'date_arrived':
      return fill(
        key,
        {
          column: s('column', colTitle(b, tr.column)),
          offset: s(
            'offset_days',
            !tr.offset_days
              ? t('auto.date.same_day', undefined, locale)
              : t(
                  tr.offset_days > 0
                    ? tr.workdays
                      ? 'auto.date.after_wd'
                      : 'auto.date.after'
                    : tr.workdays
                      ? 'auto.date.before_wd'
                      : 'auto.date.before',
                  { n: Math.abs(tr.offset_days) },
                  locale,
                ),
          ),
          time: s('time', tr.time),
        },
        locale,
      );
    case 'date_arrives_before':
      return fill(
        tr.workdays ? 'auto.t.date_arrives_before_wd' : key,
        {
          column: s('column', colTitle(b, tr.column)),
          days: s('days', String(tr.days ?? '')),
          time: s('time', tr.time),
        },
        locale,
      );
    case 'every_time_period': {
      const period =
        tr.period === 'week'
          ? t(
              'auto.period.week_on',
              { day: t(`auto.weekday.${tr.weekday ?? 'sun'}` as MessageKey, undefined, locale) },
              locale,
            )
          : tr.period === 'month'
            ? t('auto.period.month_on', { day: tr.day_of_month ?? 1 }, locale)
            : t(`auto.period.${tr.period}` as MessageKey, undefined, locale);
      return fill(
        key,
        { period: s('period', period), time: s('time', tr.period === 'hour' ? '' : tr.time) },
        locale,
      ).filter((p) => !(tr.period === 'hour' && p.slot === 'trigger.time'));
    }
    case 'checkbox_checked':
      return fill(
        key,
        {
          column: s('column', colTitle(b, tr.column)),
          state: s('state', t(`auto.checkbox.${tr.state}` as MessageKey, undefined, locale)),
        },
        locale,
      );
    case 'update_posted':
      return fill(
        key,
        { contains: s('contains', tr.contains ? t('auto.word.containing', { text: tr.contains }, locale) : '') },
        locale,
      ).map((p) => (p.slot && p.empty ? { ...p, text: '' } : p));
    case 'person_assigned':
      return fill(
        key,
        { column: s('column', colTitle(b, tr.column)), who: s('who', peopleRefText(tr.who, b, locale)) },
        locale,
      );
    case 'number_threshold':
      return fill(
        key,
        {
          column: s('column', colTitle(b, tr.column)),
          operator: s('operator', t(`auto.op.${tr.operator}` as MessageKey, undefined, locale)),
          value: s('value', String(tr.value ?? '')),
        },
        locale,
      );
    case 'flow_failed':
    case 'flow_recovered': {
      const conn = tr.connection ?? 'any';
      return fill(
        key,
        {
          connection: s(
            'connection',
            conn === 'any'
              ? t('auto.flow.any_connection' as MessageKey, undefined, locale)
              : (b.flowConnectionName?.(conn) ?? conn),
          ),
          flow: s(
            'flow',
            !tr.flow
              ? t('auto.flow.any_flow' as MessageKey, undefined, locale)
              : (b.flowName?.(conn, tr.flow) ?? tr.flow),
          ),
        },
        locale,
      );
    }
    case 'extension_trigger':
      // The block's own name (the extension says what it is); its key until the list of blocks is known.
      return [{ text: b.extensionBlockName?.(tr.block) ?? tr.block }];
    default:
      return fill(key, {}, locale);
  }
};

export const actionSentence = (
  a: Action,
  index: number,
  b: SentenceBoard,
  locale: Locale = getLocale(),
): SentencePart[] => {
  const s = (field: string, text: string) => ({ text, slot: `actions.${index}.${field}` });
  const key = `auto.a.${a.type}` as MessageKey;
  const def = ACTIONS[a.type];
  const col = s('column', colTitle(sideBoard(b, def?.columnOn), (a as { column?: string }).column));
  switch (a.type) {
    case 'set_parent_column':
    case 'set_subitems_column':
      return fill(
        key,
        {
          column: col,
          value: s(
            'value',
            typeof a.value === 'string' ? shortT(a.value, b) : a.value == null ? '' : JSON.stringify(a.value),
          ),
        },
        locale,
      );
    case 'copy_from_parent':
    case 'copy_to_parent':
    case 'copy_to_subitems':
      return fill(
        key,
        {
          column: col,
          source: s(
            'source',
            a.source === 'name'
              ? t('auto.word.name', undefined, locale)
              : colTitle(sideBoard(b, def.sourceOn), a.source),
          ),
        },
        locale,
      );
    case 'set_status':
      return fill(key, { column: col!, label: s('label', a.label) }, locale);
    case 'set_column':
      return fill(
        key,
        {
          column: col!,
          value: s(
            'value',
            typeof a.value === 'string' ? short(a.value) : a.value == null ? '' : JSON.stringify(a.value),
          ),
        },
        locale,
      );
    case 'set_date':
      return fill(key, { column: col!, value: s('value', dateExprText(a.value, b, locale)) }, locale);
    case 'set_item_name':
    case 'create_subitem':
      return fill(key, { name: s('name', shortT(a.name, b)) }, locale);
    case 'increment_number':
      return fill(key, { column: col!, by: s('by', String(a.by ?? '')) }, locale);
    case 'set_computed': {
      const parts = fill(
        key,
        { column: col!, expression: s('expression', short(computedText(a.expression, b), 60)) },
        locale,
      );
      // How it rounds and what an empty value does — one blank, shown when not the defaults.
      const opts = [
        ...(a.round !== undefined ? [t('auto.computed.round_n' as MessageKey, { n: a.round }, locale)] : []),
        ...(a.on_empty && a.on_empty !== 'skip'
          ? [t(`auto.computed.on_empty.${a.on_empty}` as MessageKey, undefined, locale)]
          : []),
      ];
      parts.push(
        { text: ' · ' },
        {
          text: opts.join(', ') || t('auto.computed.options' as MessageKey, undefined, locale),
          slot: s('on_empty', '').slot,
        },
      );
      return parts;
    }
    case 'move_to_group':
      return fill(key, { group: s('group', groupTitle(b, a.group)) }, locale);
    case 'move_to_board':
    case 'create_item':
      return fill(
        key,
        {
          board: s(
            'board',
            a.board === '@self' ? t('auto.word.this_board', undefined, locale) : (b.boardName?.(a.board) ?? ''),
          ),
        },
        locale,
      );
    case 'assign':
    case 'unassign':
      return fill(key, { column: col!, who: s('who', peopleRefText(a.who, b, locale)) }, locale);
    case 'start_time_tracking':
    case 'stop_time_tracking': {
      // Whose timer: unset = the automation's owner (saved before the option existed).
      const tt = (k: string) => t(k as MessageKey, undefined, locale);
      const who = timerWhoText(a.who, b, locale);
      const parts = [...fill(key, { column: col! }, locale), { text: ` ${tt('auto.timer.for')} ` }, s('who', who)];
      if (a.who !== '@actor') return parts;
      const fallback = a.fallback ? peopleRefText(a.fallback, b, locale) : tt('auto.timer.skip');
      return [...parts, { text: ` (${tt('auto.timer.no_actor')} ` }, s('fallback', fallback), { text: ')' }];
    }
    case 'notify':
      return fill(
        key,
        { to: s('to', recipientsText(a.to, b, locale)), message: s('message', shortT(a.message, b)) },
        locale,
      );
    case 'send_email':
      return fill(
        key,
        { to: s('to', recipientsText(a.to, b, locale)), subject: s('subject', shortT(a.subject, b)) },
        locale,
      );
    case 'webhook':
      // Only the address's origin: a hook URL's path is itself a secret (Make / Zapier), and the sentence becomes the
      // automation's title, which every board reader — and an AI tool — sees (AI-RT8).
      return fill(key, { url: s('url', urlOrigin(a.url)) }, locale);
    case 'create_update':
      return fill(key, { body: s('body', shortT(a.body, b)) }, locale);
    case 'send_sms':
      return fill(
        key,
        {
          column: col!,
          message: s(
            'message',
            a.template ? (b.smsTemplateName?.(a.template) ?? a.template) : shortT(a.message ?? '', b),
          ),
        },
        locale,
      );
    case 'send_to_integrations':
      return fill(
        key,
        { channel: s('channel', a.channel?.trim() || t('auto.word.any_channel' as MessageKey, undefined, locale)) },
        locale,
      );
    case 'run_extension':
      return fill(key, { block: s('block', b.extensionBlockName?.(a.block) ?? a.block) }, locale);
    case 'generate_image': {
      // the photo columns it starts from (in order), or the description only.
      const sources = generateImageSources(a).columns;
      // Round 3: + the style examples' column ("and the style of «Approved sketch»").
      const style = a.style_examples
        ? ` ${t('auto.word.style_of' as MessageKey, { column: colTitle(b, a.style_examples.column) }, locale)}`
        : '';
      // Round 4: one image per photo, variations, how much may change — said only when not the default.
      const extras = [
        sources.length && a.photo_mode === 'each' ? t('auto.word.each_photo' as MessageKey, undefined, locale) : '',
        a.variations && a.variations > 1 ? t('auto.word.variations' as MessageKey, { n: a.variations }, locale) : '',
        a.fidelity && a.fidelity !== 'free' ? t(`ai2.fidelity.${a.fidelity}` as MessageKey, undefined, locale) : '',
      ].filter(Boolean);
      return fill(
        key,
        {
          column: col!,
          source_columns: s(
            'source_columns',
            (sources.length
              ? sources.map((k) => colTitle(b, k)).join(', ')
              : t('auto.word.text_only' as MessageKey, undefined, locale)) +
              style +
              (extras.length ? ` (${extras.join(', ')})` : ''),
          ),
          prompt: s('prompt', shortT(a.prompt, b)),
        },
        locale,
      );
    }
    case 'send_document':
      return fill(key, { template: s('template', b.idocTemplateName?.(a.template) ?? '') }, locale);
    case 'create_item_from_template':
      return fill(
        key,
        {
          template: s('template', b.itemTemplateName?.(a.template) ?? ''),
          board: s(
            'board',
            a.board === '@self' ? t('auto.word.this_board', undefined, locale) : (b.boardName?.(a.board) ?? ''),
          ),
        },
        locale,
      );
    case 'add_template_subitems':
      return fill(key, { template: s('template', b.itemTemplateName?.(a.template) ?? '') }, locale);
    case 'run_agent':
      return fill(
        key,
        { agent: s('agent', b.agentName?.(a.agent) ?? ''), prompt: s('prompt', shortT(a.prompt, b)) },
        locale,
      );
    case 'copy_from_linked':
      return fill(
        key,
        {
          column: col!,
          relation: s('relation', colTitle(b, a.relation)),
          source: s(
            'source',
            a.source === 'name'
              ? t('auto.word.name', undefined, locale)
              : (b.linkedColumnTitle?.(a.relation, a.source) ?? a.source),
          ),
        },
        locale,
      );
    default:
      return fill(key, { column: col }, locale);
  }
};

/** A rule value in words: people / teams / groups by name, "me", the rest as written. */
const ruleValueText = (v: unknown, r: FilterRule, b: SentenceBoard, locale: Locale): string => {
  const x = String(v);
  if (r.column_id === '__group__') return b.groups.find((g) => g.id === x)?.title ?? x;
  if (x === 'me') return t('filter.me', undefined, locale);
  if (x.startsWith('user:')) return b.personName?.(x.slice(5)) ?? x;
  if (x.startsWith('team:')) return b.teamName?.(x.slice(5)) ?? x;
  return x;
};

/** A condition's column: a system field, a sub-board column (`sub:<key>`, r16) or a column of the item's board. */
const ruleColumnText = (id: string, b: SentenceBoard, locale: Locale) => {
  if (id.startsWith('__')) return t(`filter.field.${id}` as MessageKey, undefined, locale);
  if (id.startsWith('sub:')) {
    const sub = b.subColumns?.find((c) => c.key === id.slice(4));
    return `${t('auto.var.subitem' as MessageKey, undefined, locale)} › ${sub?.title ?? id.slice(4)}`;
  }
  return colTitle(b, id);
};

const ruleText = (r: FilterRule, b: SentenceBoard, locale: Locale) => {
  const values = r.values
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map((v) => ruleValueText(v, r, b, locale))
    .join(t('auto.word.or', undefined, locale));
  const op = t(`filter.op.${r.operator}` as MessageKey, undefined, locale);
  const column = ruleColumnText(r.column_id, b, locale);
  return `${r.negate ? t('auto.word.not', undefined, locale) : ''}${column} ${op}${values ? ` ${values}` : ''}`;
};

const joinWord = (g: FilterGroup, locale: Locale) =>
  t(g.operator === 'or' ? 'auto.word.or' : 'auto.word.and', undefined, locale);

/** A nested group as "(a or (b and c))", at any depth; a negated group starts with "not". */
const groupText = (g: FilterGroup, b: SentenceBoard, locale: Locale): string =>
  `${g.negate ? t('auto.word.not', undefined, locale) : ''}(${g.rules
    .map((x) => (x.kind === 'rule' ? ruleText(x, b, locale) : groupText(x, b, locale)))
    .join(joinWord(g, locale))})`;

/** "Only if" as one line per top-level rule (a nested group reads as "(a or (b and c))"). */
export const conditionLines = (g: FilterGroup | undefined, b: SentenceBoard, locale: Locale = getLocale()): string[] =>
  (g?.rules ?? []).map((r) => (r.kind === 'group' ? groupText(r, b, locale) : ruleText(r, b, locale)));

/** "Only if" as one line: the top-level rules joined by the group's own "and" / "or" (empty without rules). */
export const conditionText = (g: FilterGroup | undefined, b: SentenceBoard, locale: Locale = getLocale()): string => {
  const lines = conditionLines(g, b, locale);
  if (!g || !lines.length) return '';
  const text = lines.join(joinWord(g, locale));
  return g.negate ? `${t('auto.word.not', undefined, locale)}(${text})` : text;
};

/** The whole recipe as one plain line (list titles, notifications). */
export const recipeText = (r: Recipe, b0: SentenceBoard, locale: Locale = getLocale()): string => {
  const b = scopedSentenceBoard(b0, r.trigger);
  const join = (parts: SentencePart[]) => parts.map((p) => p.text).join('');
  const conditions = conditionText(r.conditions, b, locale);
  return [
    join(triggerSentence(r.trigger, b, locale)),
    conditions ? `${t('auto.word.only_if', undefined, locale)} ${conditions}` : '',
    `${t('auto.word.then', undefined, locale)} ${r.actions.map((a, i) => join(actionSentence(a, i, b, locale))).join(t('auto.word.and', undefined, locale))}`,
  ]
    .filter(Boolean)
    .join(', ');
};
