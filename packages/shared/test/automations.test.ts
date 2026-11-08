// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  he,
  ACTIONS,
  actionSentence,
  AUTOMATION_TEMPLATES,
  conditionText,
  recipeText,
  triggerSentence,
  dateFireAt,
  dateScheduleHash,
  evaluateConditions,
  evaluateDateExpr,
  firesWhenLate,
  matchTrigger,
  nextPeriodFire,
  normalizeRecipe,
  recipeSchema,
  renderDeep,
  renderTemplate,
  templatePaths,
  TRIGGERS,
  validateRecipe,
  zonedToUtc,
  type AutomationEvent,
  type NormalizeBoard,
  type QueryEnv,
  type QueryRow,
  type Recipe,
  type TriggerContext,
} from '../src';

type SeedColumn = { id: string; title: string; type: string; settings?: Record<string, unknown> };
type Template = { key: string; columns: SeedColumn[]; add_columns?: SeedColumn[] };
type SeedAutomation = { id: string; board: string } & Record<string, unknown>;

const root = join(__dirname, '../../../seed');
const templates = new Map<string, Template>(
  readdirSync(join(root, 'templates'))
    .filter((f) => f.endsWith('.json') && f !== 'README.json')
    .map((f) => JSON.parse(readFileSync(join(root, 'templates', f), 'utf8')) as Template)
    .filter((t) => t.key)
    .map((t) => [t.key, t]),
);
const recipesIn = (dir: string): SeedAutomation[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap(
      (f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { automations?: SeedAutomation[] }).automations ?? [],
    );
/** Sample recipes on the built-in templates (a fixture; per-account recipes are private — SEED_AUTOMATIONS_DIR). */
const seeds = recipesIn(join(__dirname, 'fixtures/seed-automations'));
/** The private recipes, when a maintainer points SEED_AUTOMATIONS_DIR at them (the folder automations:seed reads). */
const PRIVATE_DIR = process.env.SEED_AUTOMATIONS_DIR?.trim();

const boardOf = (key: string): NormalizeBoard => {
  const t = templates.get(key);
  return {
    columns: [...(t?.columns ?? []), ...(t?.add_columns ?? [])].map((c) => ({
      key: c.id,
      title: c.title,
      type: c.type,
    })),
    resolveBoard: (ref) => (templates.has(ref) ? `brd_${ref}` : null),
  };
};
const normalized = (id: string) => {
  const seed = seeds.find((s) => s.id === id)!;
  const r = normalizeRecipe(seed, boardOf(seed.board));
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('seed automation recipes', () => {
  const normalizesAll = (list: SeedAutomation[]) => {
    for (const s of list) {
      const r = normalizeRecipe(s, boardOf(s.board));
      expect(r.ok, `${s.id}: ${r.ok ? '' : r.error}`).toBe(true);
      if (r.ok) expect(recipeSchema.parse(r.recipe)).toEqual(r.recipe);
    }
  };

  it('every sample recipe normalizes into the canonical schema', () => {
    expect(seeds.length).toBeGreaterThan(0);
    normalizesAll(seeds);
  });

  it.runIf(PRIVATE_DIR)('every private recipe (SEED_AUTOMATIONS_DIR) normalizes too', () => {
    normalizesAll(recipesIn(PRIVATE_DIR!));
  });

  it('rewrites the shorthands (04 §1.4)', () => {
    const l1 = normalized('L1').recipe;
    expect(l1.actions[1]).toEqual({ type: 'assign', column: 'multiple_person_mm6xr34v', who: '@creator', mode: 'add' });
    const q2 = normalized('Q2').recipe;
    expect(q2.actions[1]).toMatchObject({ type: 'notify', to: '@board_owners', message: 'הצעה פגה: {item.name}' });
    const p4 = normalized('P4').recipe;
    expect(p4.actions[0]).toMatchObject({ type: 'send_email', subject: '{item.name}: {item.client_status}' });
    expect(normalized('T1').recipe.actions[0]).toEqual({
      type: 'copy_from_linked',
      relation: 'board_relation_mm6x61vz',
      source: 'board_relation_mm6x9vct',
      column: 'account',
    });
    expect(normalized('T2a').recipe.actions[0]).toEqual({ type: 'start_time_tracking', column: 'duration_mm6zy9r5' });
  });

  it('D26: L3, S3c/S3d and T1 are built from built-in actions and fit their boards; only Q1 stays a webhook', () => {
    const fits = (id: string) => {
      const seed = seeds.find((s) => s.id === id)!;
      const t = templates.get(seed.board)!;
      const r = normalized(id).recipe;
      const columns = [...t.columns, ...(t.add_columns ?? [])].map((c) => ({
        key: c.id,
        title: c.title,
        type: c.type,
        settings: c.settings ?? {},
      }));
      return { recipe: r, ...validateRecipe(r, { columns, groups: [] }) };
    };
    for (const id of ['L3', 'S3c', 'S3d', 'T1']) {
      const { recipe, errors, warnings } = fits(id);
      expect(errors, id).toEqual([]);
      expect(warnings, id).toEqual([]);
      expect(JSON.stringify(recipe), id).not.toMatch(/MCP_URL|run_extension|webhook/);
    }
    expect(fits('L3').recipe.actions[0]).toMatchObject({
      type: 'create_item',
      board: 'brd_accounts',
      connect_column: 'board_relation_mm6x36x0',
    });
    expect(fits('L3').recipe.conditions?.rules[0]).toMatchObject({
      column_id: 'board_relation_mm6x36x0',
      operator: 'is_empty',
    });
    expect(fits('S3c').recipe.actions[0]).toMatchObject({ type: 'set_date', value: 'now+4h' });
    expect(fits('S3d').recipe.actions[0]).toMatchObject({ type: 'set_date', value: 'now+24h' });
    const q1 = normalized('Q1').recipe.actions[0];
    expect(q1).toMatchObject({ type: 'webhook' });
    expect(JSON.stringify(q1)).toContain('{{N8N_URL}}');
    expect(JSON.stringify(seeds)).not.toContain('MCP_URL');
  });

  it('copy_from_linked needs a relation column; run_agent templates are checked', () => {
    const board = {
      columns: [
        { key: 'rel', type: 'board_relation', title: 'r', settings: {} },
        { key: 'txt', type: 'text', title: 't', settings: {} },
        { key: 'f', type: 'formula', title: 'f', settings: {} },
      ],
      groups: [],
    };
    const recipe = (actions: unknown[]) => recipeSchema.parse({ trigger: { type: 'item_created' }, actions }) as Recipe;
    expect(
      validateRecipe(recipe([{ type: 'copy_from_linked', relation: 'txt', source: 'name', column: 'f' }]), board)
        .errors,
    ).toEqual([
      { path: 'actions.0.column', code: 'column_read_only', detail: 'formula' },
      { path: 'actions.0.relation', code: 'column_type', detail: 'text' },
    ]);
    const ok = validateRecipe(
      recipe([{ type: 'run_agent', agent: 'A1', prompt: 'סווג {item.txt} {item.nope}' }]),
      board,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([{ path: 'actions.0.prompt', code: 'unknown_template', detail: 'item.nope' }]);
  });

  it('resolves column titles in templates to the board keys', () => {
    const l4 = normalized('L4').recipe;
    expect(l4.actions[0]).toMatchObject({ message: 'מעקב: {item.name} ({item.color_mm6x5rvw})' });
    expect(normalized('A2').recipe.actions[0]).toMatchObject({ board: 'brd_tasks', fixed: { account: '{item.id}' } });
  });

  it('reports what the board cannot resolve instead of guessing', () => {
    const p3 = normalized('P3');
    expect(p3.unresolved).toContain('board:@portal:{client}');
  });

  it('turns the condition list into a filter tree', () => {
    const l5 = normalized('L5').recipe;
    expect(l5.conditions?.rules).toEqual([
      { kind: 'rule', column_id: 'color_mm6x5rvw', operator: 'any_of', values: ['חדש'], negate: false },
      // A creation log reads the item's created_at (always set: no "is not empty" half).
      { kind: 'rule', column_id: '__created_at__', operator: 'within_the_last', values: [2, 'days'], negate: true },
    ]);
    const onDate = normalizeRecipe(
      {
        trigger: { type: 'item_created' },
        conditions: [{ column: 'due', operator: 'older_than_days', values: [3] }],
        actions: [{ type: 'archive_item' }],
      },
      { columns: [{ key: 'due', title: 'יעד', type: 'date' }] },
    );
    expect(onDate.ok && onDate.recipe.conditions?.rules[0]).toMatchObject({
      kind: 'group',
      rules: [{ operator: 'is_not_empty' }, { negate: true }],
    });
  });

  it('rejects invalid recipes with the zod path', () => {
    const bad = normalizeRecipe(
      { trigger: { type: 'item_created' }, actions: [{ type: 'set_date', column: 'date', value: 'tomorrow' }] },
      { columns: [] },
    );
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('actions.0.value') });
    expect(
      normalizeRecipe({ trigger: { type: 'nope' }, actions: [{ type: 'archive_item' }] }, { columns: [] }).ok,
    ).toBe(false);
    expect(normalizeRecipe({ trigger: { type: 'item_created' }, actions: [] }, { columns: [] }).ok).toBe(false);
  });
});

const statusLabels = [
  { id: 0, label: 'חדש', color: '#579bfc', index: 0 },
  { id: 1, label: 'זכינו', color: '#00c875', index: 1, is_done: true },
  { id: 2, label: 'אבד', color: '#e2445c', index: 2 },
];
const ctx: TriggerContext = {
  automationId: 'aut_1',
  columns: [
    { id: 'status', type: 'status', settings: { labels: statusLabels } },
    { id: 'done', type: 'checkbox', settings: {} },
    { id: 'owner', type: 'people', settings: {} },
    { id: 'amount', type: 'numbers', settings: {} },
  ],
};
const ev = (e: Partial<AutomationEvent>): AutomationEvent => ({
  id: 'evt',
  type: 'cell.changed',
  board_id: 'brd',
  item_id: 'itm',
  actor: { type: 'user', id: 'usr' },
  ...e,
});
const cell = (key: string, before: unknown, after: unknown) =>
  ev({ column_key: key, before: { value: before }, after: { value: after } });

describe('triggers (04 §2)', () => {
  it('status_changed matches label texts, optional from_labels, and not a no-op', () => {
    const t = { type: 'status_changed' as const, column: 'status', labels: ['זכינו', 'אבד'] };
    expect(matchTrigger(t, cell('status', { index: 0 }, { index: 1 }), ctx)).toBe(true);
    expect(matchTrigger(t, cell('status', { index: 1 }, { index: 0 }), ctx)).toBe(false);
    expect(matchTrigger(t, cell('status', { index: 1 }, { index: 1 }), ctx)).toBe(false);
    expect(matchTrigger(t, cell('other', null, { index: 1 }), ctx)).toBe(false);
    expect(matchTrigger({ ...t, from_labels: ['אבד'] }, cell('status', { index: 0 }, { index: 1 }), ctx)).toBe(false);
    expect(
      matchTrigger(
        { type: 'status_changed', column: 'status', labels: 'any' },
        cell('status', { index: 1 }, null),
        ctx,
      ),
    ).toBe(true);
  });

  it('checkbox_checked fires on the transition to the wanted state', () => {
    const t = { type: 'checkbox_checked' as const, column: 'done', state: 'checked' as const };
    expect(matchTrigger(t, cell('done', null, { checked: true }), ctx)).toBe(true);
    expect(matchTrigger(t, cell('done', { checked: true }, null), ctx)).toBe(false);
    expect(matchTrigger({ ...t, state: 'unchecked' }, cell('done', { checked: true }, null), ctx)).toBe(true);
  });

  it('number_threshold fires only on crossing', () => {
    const t = { type: 'number_threshold' as const, column: 'amount', operator: 'greater_than' as const, value: 100 };
    expect(matchTrigger(t, cell('amount', 50, 150), ctx)).toBe(true);
    expect(matchTrigger(t, cell('amount', 120, 150), ctx)).toBe(false);
    expect(matchTrigger(t, cell('amount', null, 101), ctx)).toBe(true);
  });

  it('person_assigned fires for added people only (and a specific person)', () => {
    const p = (...ids: string[]) => ({ persons_and_teams: ids.map((id) => ({ id, kind: 'person' })) });
    const t = { type: 'person_assigned' as const, column: 'owner', who: 'any' as const };
    expect(matchTrigger(t, cell('owner', p('A'), p('A', 'B')), ctx)).toBe(true);
    expect(matchTrigger(t, cell('owner', p('A', 'B'), p('A')), ctx)).toBe(false);
    const dana = { ...t, who: 'user:01JDANA0000000000000000000' };
    expect(matchTrigger(dana, cell('owner', p(), p('01JDANA0000000000000000000')), ctx)).toBe(true);
    expect(matchTrigger(dana, cell('owner', p(), p('B')), ctx)).toBe(false);
  });

  it('item triggers ignore the sub-board; subitem triggers listen only to it', () => {
    const created = ev({ type: 'item.created', after: { group_id: 'g1' } });
    expect(matchTrigger({ type: 'item_created' }, created, ctx)).toBe(true);
    expect(matchTrigger({ type: 'item_created' }, { ...created, sub: true }, ctx)).toBe(false);
    expect(matchTrigger({ type: 'subitem_created' }, { ...created, sub: true }, ctx)).toBe(true);
    expect(matchTrigger({ type: 'item_created_in_group', group: 'g1' }, created, ctx)).toBe(true);
    expect(matchTrigger({ type: 'item_created_in_group', group: 'g2' }, created, ctx)).toBe(false);
  });

  it('scheduled triggers match only their own schedule rows', () => {
    const t = { type: 'date_arrived' as const, column: 'd', offset_days: 0, time: '09:00' };
    expect(matchTrigger(t, ev({ type: 'schedule.fired', meta: { automation_id: 'aut_1' } }), ctx)).toBe(true);
    expect(matchTrigger(t, ev({ type: 'schedule.fired', meta: { automation_id: 'aut_2' } }), ctx)).toBe(false);
  });

  it('update_posted filters by text; column_changed on name = rename', () => {
    const t = { type: 'update_posted' as const, contains: 'דחוף' };
    expect(matchTrigger(t, ev({ type: 'update.created', update_text: 'זה דחוף מאוד' }), ctx)).toBe(true);
    expect(matchTrigger(t, ev({ type: 'update.created', update_text: 'רגיל' }), ctx)).toBe(false);
    expect(matchTrigger({ type: 'column_changed', column: 'name' }, ev({ type: 'item.renamed' }), ctx)).toBe(true);
  });

  it('every trigger and action has a registry entry', () => {
    for (const [k, d] of Object.entries(TRIGGERS)) expect(d.type).toBe(k);
    for (const [k, d] of Object.entries(ACTIONS)) expect(d.type).toBe(k);
  });
});

describe('templates (04 §4.3)', () => {
  const vars: Record<string, unknown> = {
    'item.name': 'ליד <דנה>',
    'item.status': 'זכינו',
    'item.due': '2026-10-15',
    'item.amount': 1234.5,
    tags: ['א', 'ב'],
  };
  const lookup = (p: string) => vars[p];

  it('renders paths and helpers, unknown paths empty with a warning', () => {
    expect(renderTemplate('{item.name} — {item.status|upper}', lookup).text).toBe('ליד <דנה> — זכינו');
    expect(renderTemplate('{item.due|date:DD/MM/YYYY}', lookup).text).toBe('15/10/2026');
    expect(renderTemplate('{item.amount|number:2}', lookup).text).toBe('1234.50');
    expect(renderTemplate('{tags|join: · }', lookup).text).toBe('א · ב');
    expect(renderTemplate('{missing|default:—}', lookup).text).toBe('—');
    expect(renderTemplate('x{nope}y', lookup)).toEqual({ text: 'xy', warnings: ['unknown:nope'] });
  });

  it('escapes HTML in HTML contexts unless |raw; {{ is a literal brace', () => {
    expect(renderTemplate('<b>{item.name}</b>', lookup, { html: true }).text).toBe('<b>ליד &lt;דנה&gt;</b>');
    expect(renderTemplate('{item.name|raw}', lookup, { html: true }).text).toBe('ליד <דנה>');
    expect(renderTemplate('{{literal}', lookup).text).toBe('{literal}');
  });

  it('renders object payloads deeply, keeping |json types', () => {
    const w: string[] = [];
    expect(renderDeep({ n: '{item.name}', a: '{item.amount|json}', l: ['{item.status}'] }, lookup, w)).toEqual({
      n: 'ליד <דנה>',
      a: 1234.5,
      l: ['זכינו'],
    });
    expect(templatePaths('{item.name} {item.x|upper} {{no}')).toEqual(['item.name', 'item.x']);
  });
});

describe('date expressions (set_date)', () => {
  const env = {
    today: '2026-01-31',
    timezone: 'Asia/Jerusalem',
    now: new Date('2026-01-31T08:30:00Z'),
    columnDate: (k: string) => (k === 'due' ? '2026-03-10' : k === 'at' ? '2026-03-10T07:00:00Z' : null),
  };
  it('evaluates today/now/column with calendar shifts', () => {
    expect(evaluateDateExpr('today', env)).toEqual({ date: '2026-01-31' });
    expect(evaluateDateExpr('today+3d', env)).toEqual({ date: '2026-02-03' });
    expect(evaluateDateExpr('today+1m', env)).toEqual({ date: '2026-02-28' });
    expect(evaluateDateExpr('column:due-1w', env)).toEqual({ date: '2026-03-03' });
    expect(evaluateDateExpr('column:at', env)).toEqual({ date: '2026-03-10', time: '07:00' });
    expect(evaluateDateExpr('now', env)).toEqual({ date: '2026-01-31', time: '08:30' });
    expect(evaluateDateExpr('clear', env)).toBeNull();
    expect(evaluateDateExpr('column:empty', env)).toBeUndefined();
  });
  it('hours move the instant (an SLA), whole days on a plain date', () => {
    expect(evaluateDateExpr('now+4h', env)).toEqual({ date: '2026-01-31', time: '12:30' });
    expect(evaluateDateExpr('now+24h', env)).toEqual({ date: '2026-02-01', time: '08:30' });
    expect(evaluateDateExpr('column:at-8h', env)).toEqual({ date: '2026-03-09', time: '23:00' });
    expect(evaluateDateExpr('today+48h', env)).toEqual({ date: '2026-02-02' });
  });
  it('@HH:MM is local account time, stored as UTC (DST aware)', () => {
    expect(evaluateDateExpr('today@14:00', env)).toEqual({ date: '2026-01-31', time: '12:00' }); // winter UTC+2
    expect(zonedToUtc('2026-10-03', '14:00', 'Asia/Jerusalem').toISOString()).toBe('2026-10-03T11:00:00.000Z');
    expect(zonedToUtc('2026-10-25', '14:00', 'Asia/Jerusalem').toISOString()).toBe('2026-10-25T12:00:00.000Z');
  });
});

describe('conditions (04 §3 = the query model)', () => {
  const env: QueryEnv = {
    today: '2026-10-03',
    timezone: 'Asia/Jerusalem',
    weekend: 'fri_sat',
    firstDay: 0,
    meId: null,
    columns: [
      { id: 'name', type: 'name', settings: {} },
      { id: 'status', type: 'status', settings: { labels: statusLabels } },
      { id: 'created', type: 'creation_log', settings: {} },
    ],
  };
  const row = (status: number | null, createdAt: string): QueryRow => ({
    id: 'itm',
    group_id: 'g',
    parent_item_id: null,
    depth: 0,
    name: 'x',
    position: 'a',
    key: null,
    cells: {
      ...(status === null ? {} : { status: { value: { index: status }, text: statusLabels[status]!.label } }),
      created: { value: { at: createdAt, by: null }, text: null },
    },
    created_at: createdAt,
    created_by: null,
    updated_at: createdAt,
  });
  // L5's shape on a board whose keys are `status` / `created`.
  const l5 = (): Recipe['conditions'] => ({
    kind: 'group',
    operator: 'and',
    negate: false,
    rules: [
      { kind: 'rule', column_id: 'status', operator: 'any_of', values: ['חדש'], negate: false },
      { kind: 'rule', column_id: '__created_at__', operator: 'within_the_last', values: [2, 'days'], negate: true },
    ],
  });

  it('matches label texts and "older than N days", reporting the first failing rule', () => {
    expect(evaluateConditions(l5(), row(0, '2026-09-20T10:00:00Z'), env)).toEqual({ matched: true });
    expect(evaluateConditions(l5(), row(0, '2026-10-02T10:00:00Z'), env)).toEqual({
      matched: false,
      failed_rule: '__created_at__',
    });
    expect(evaluateConditions(l5(), row(1, '2026-09-20T10:00:00Z'), env)).toEqual({
      matched: false,
      failed_rule: 'status',
    });
    expect(evaluateConditions(l5(), row(null, '2026-09-20T10:00:00Z'), env).matched).toBe(false);
    expect(evaluateConditions(undefined, row(null, '2026-09-20T10:00:00Z'), env)).toEqual({ matched: true });
  });
});

describe('scheduled triggers (04 §5.6)', () => {
  const tz = 'Asia/Jerusalem';
  const arrived = { type: 'date_arrived' as const, column: 'd', offset_days: 0, time: '09:00' };

  it('date triggers fire at the local time, shifted by the offset', () => {
    expect(dateFireAt(arrived, '2026-10-15', tz).toISOString()).toBe('2026-10-15T06:00:00.000Z'); // IDT
    expect(dateFireAt(arrived, '2026-12-15', tz).toISOString()).toBe('2026-12-15T07:00:00.000Z'); // IST
    const before = { type: 'date_arrives_before' as const, column: 'd', days: 7, time: '09:00' };
    expect(dateFireAt(before, '2026-10-15', tz).toISOString()).toBe('2026-10-08T06:00:00.000Z');
    // A date with its own time fires at that moment (± offset).
    expect(dateFireAt({ ...arrived, offset_days: 1 }, '2026-10-15T13:30:00Z', tz).toISOString()).toBe(
      '2026-10-16T13:30:00.000Z',
    );
    expect(dateScheduleHash(arrived, '2026-10-15')).not.toBe(
      dateScheduleHash({ ...arrived, time: '10:00' }, '2026-10-15'),
    );
  });

  it('a date set in the past fires once only when ≤24h late and not a "before" trigger', () => {
    const at = new Date('2026-10-15T06:00:00Z');
    expect(firesWhenLate(arrived, at, new Date('2026-10-15T20:00:00Z'))).toBe(true);
    expect(firesWhenLate(arrived, at, new Date('2026-10-17T06:00:00Z'))).toBe(false);
    expect(firesWhenLate({ ...arrived, offset_days: 2 }, at, new Date('2026-10-15T07:00:00Z'))).toBe(false);
  });

  it('periods advance to the next local time strictly after now', () => {
    const day = {
      type: 'every_time_period' as const,
      period: 'day' as const,
      time: '09:00',
      scope: 'each_item' as const,
    };
    expect(nextPeriodFire(day, new Date('2026-10-03T05:00:00Z'), tz).toISOString()).toBe('2026-10-03T06:00:00.000Z');
    expect(nextPeriodFire(day, new Date('2026-10-03T06:00:00Z'), tz).toISOString()).toBe('2026-10-04T06:00:00.000Z');
    // Across the DST change (2026-10-25): still 09:00 local.
    expect(nextPeriodFire(day, new Date('2026-10-25T00:00:00Z'), tz).toISOString()).toBe('2026-10-25T07:00:00.000Z');
    const week = { ...day, period: 'week' as const, weekday: 'mon' as const };
    expect(nextPeriodFire(week, new Date('2026-10-03T12:00:00Z'), tz).toISOString()).toBe('2026-10-05T06:00:00.000Z'); // Sat → Mon
    const month = { ...day, period: 'month' as const, day_of_month: 1 };
    expect(nextPeriodFire(month, new Date('2026-10-03T12:00:00Z'), tz).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    const hour = { ...day, period: 'hour' as const };
    expect(nextPeriodFire(hour, new Date('2026-10-03T12:34:00Z'), tz).toISOString()).toBe('2026-10-03T13:00:00.000Z');
  });
});

describe('sentences (04 §8.1)', () => {
  const board = {
    columns: [
      { key: 'status', title: 'סטטוס', type: 'status' },
      { key: 'due', title: 'יעד', type: 'date' },
      { key: 'owner', title: 'אחראי', type: 'people' },
    ],
    groups: [{ id: 'g1', title: 'סגורים' }],
  };

  it('reads a recipe as Hebrew with slots for its blanks', () => {
    const parts = triggerSentence({ type: 'status_changed', column: 'status', labels: ['זכינו', 'אבד'] }, board);
    expect(parts.map((p) => p.text).join('')).toBe('כשסטטוס משתנה לזכינו או אבד');
    expect(parts.filter((p) => p.slot).map((p) => p.slot)).toEqual(['trigger.column', 'trigger.labels']);
    const move = actionSentence({ type: 'move_to_group', group: 'g1' }, 0, board);
    expect(move.map((p) => p.text).join('')).toBe('הזז לקבוצה סגורים');
    expect(
      recipeText(
        {
          trigger: { type: 'date_arrived', column: 'due', offset_days: 0, time: '09:00' },
          actions: [
            { type: 'notify', to: 'column:owner', message: 'מעקב: {item.name}' },
            { type: 'set_date', column: 'due', value: 'today+3d' },
          ],
        },
        board,
      ),
    ).toBe('כשמגיע התאריך ביעד ביום עצמו, בשעה 09:00, אז שלח התראה לאחראי: מעקב: {שם} וגם קבע את יעד להיום + 3 ימים');
  });

  it('"only if" honours a top-level OR and reads nested groups in parentheses, at any depth', () => {
    const rule = (column_id: string, operator: 'is_empty' | 'is_not_empty') =>
      ({ kind: 'rule', column_id, operator, values: [], negate: false }) as const;
    const conditions = {
      kind: 'group',
      operator: 'or',
      negate: false,
      rules: [
        rule('due', 'is_empty'),
        {
          kind: 'group',
          operator: 'and',
          negate: false,
          rules: [
            rule('owner', 'is_not_empty'),
            {
              kind: 'group',
              operator: 'or',
              negate: false,
              rules: [rule('status', 'is_empty'), rule('due', 'is_not_empty')],
            },
          ],
        },
      ],
    } as const;
    const recipe = {
      trigger: { type: 'item_created' },
      conditions,
      actions: [{ type: 'archive_item' }],
    } as unknown as Recipe;
    const text = recipeText(recipe, board);
    expect(text).toContain('ורק אם יעד ריק או (אחראי לא ריק וגם (סטטוס ריק או יעד לא ריק))');
    expect(text).not.toContain('…');
    expect(conditionText({ ...conditions, operator: 'and' } as never, board)).toBe(
      'יעד ריק וגם (אחראי לא ריק וגם (סטטוס ריק או יעד לא ריק))',
    );
    expect(conditionText(undefined, board)).toBe('');
  });

  it('every catalogue template renders, its missing fields shown as empty slots', () => {
    for (const tpl of AUTOMATION_TEMPLATES) {
      const t = triggerSentence(tpl.draft.trigger as never, board);
      const a = tpl.draft.actions.flatMap((x, i) => actionSentence(x as never, i, board));
      for (const p of [...t, ...a]) expect(p.text, tpl.id).not.toMatch(/undefined|NaN/);
    }
    const blank = actionSentence({ type: 'set_status' } as never, 0, board);
    expect(blank.filter((p) => p.empty).map((p) => p.slot)).toEqual(['actions.0.column', 'actions.0.label']);
  });

  // Runs once the phoneui i18n fragment (auto.a.send_sms) is merged into he.json.
  it.skipIf(!('auto.a.send_sms' in he))('send_sms reads a saved template by its name, in the message blank', () => {
    const sb = { ...board, smsTemplateName: (id: string) => (id === 'tpl_1' ? 'Reminder' : undefined) };
    const parts = actionSentence({ type: 'send_sms', column: 'x', template: 'tpl_1' } as never, 0, sb);
    expect(parts.find((p) => p.slot === 'actions.0.message')?.text).toBe('Reminder');
    const own = actionSentence({ type: 'send_sms', column: 'x', message: 'Hi {item.name}' } as never, 0, sb);
    expect(own.find((p) => p.slot === 'actions.0.message')?.text).toContain('Hi');
    expect(AUTOMATION_TEMPLATES.some((tpl) => tpl.draft.actions.some((a) => a.type === 'send_sms'))).toBe(true);
  });
});
