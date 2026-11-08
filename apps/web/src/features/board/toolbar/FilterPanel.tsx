// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  comparesNumbers,
  isGroup,
  mirrorMatchApplies,
  MAX_FILTER_DEPTH,
  paint,
  planQuery,
  querySchema,
  readIds,
  rowMatches,
  ruleProblem,
  t,
  type Column,
  type Field,
  type FilterGroup,
  type FilterRule,
  type Group,
  type MessageKey,
  type QueryEnv,
  type QueryRow,
} from '@bines/shared';
import { Avatar, Button, cn, SearchableList } from '@bines/ui';
import { tagVars } from '../../../lib/label-color';
import { Icon } from '../../../lib/icons';
import { columnTypeLabel } from '../../../lib/locale';
import type { Member, Tag, Team } from '../board-api';
import { Popover } from '../cells/Popover';
import {
  activeRules,
  ADVANCED,
  advancedRuleCount,
  changeField,
  changeOperator,
  emptyGroup,
  fieldTitle,
  filterFields,
  newRule,
  NO_VALUE_OPS,
  operatorChoices,
  operatorLabel,
  hasQuickFilter,
  quickDateRules,
  quickValues,
  removeRuleAt,
  filterField,
  startSection,
  toggleQuick,
  withMatch,
} from './filter-model';
import { CheckRow, IconButton, PickerButton } from './parts';
import { DateRuleValues, dateValueLabel, NumberValue as RuleNumberValue } from './DateRuleValue';

export type FilterCtx = {
  env: QueryEnv;
  columns: Column[];
  groups: Group[];
  members: Member[];
  /** Account teams — a people value `team:<id>` matches the team and its members (13 §2). */
  teams: Team[];
  /** Account tags (03 §3.1) — values of tags columns. */
  tags: Tag[];
  /** The sub-board's columns (D14), filterable as `sub:<key>`; empty when the board has no subitems. */
  subColumns: Column[];
  meId: string;
};

type Label = { id: number; label: string; color?: string; is_deactivated?: boolean };
/** A member's avatar: a member without a display name (an invited user) shows by email, not "?". */
const avatarOf = (m: Member | undefined) => (m ? { name: m.name || m.email, avatar_url: m.avatar_url } : undefined);
const labelsOf = (f: Field | null) =>
  (f?.source === 'column' && Array.isArray(f.settings.labels) ? (f.settings.labels as Label[]) : []).filter(
    (l) => !l.is_deactivated,
  );

/** The words of an empty value in the quick lists: a status column says "no status", the rest "none". */
const blankLabel = (f: Field | null) =>
  f?.source === 'column' && f.column.type === 'status' ? t('filter.noStatus') : t('filter.none');

/** A quick list: a group / status / dropdown / people / tags / date column and its values. */
type Section = { id: string; title: string };

/**
 * The Filter panel (13-FILTERS §4.1–4.2; look of, canvas v3 option B): a side rail of the columns
 * that have quick lists (each with how many values are picked) and "advanced conditions"; the middle shows ONE
 * column's values as a check list with search, colours and live counts — or the advanced builder, a nested
 * AND/OR/NOT tree that is exactly the one it always was. A bottom row lists what is on as removable chips, with the
 * number of matching items and "clear". Quick lists and the builder edit the same `query.filter`.
 */
export const FilterPanel = ({
  filter,
  onChange,
  ctx,
  rows,
  matching,
  matchChildren,
  onMatchChildren,
  strict,
  onStrict,
}: {
  filter: FilterGroup | undefined;
  onChange: (f: FilterGroup | undefined) => void;
  ctx: FilterCtx;
  rows: QueryRow[];
  matching: number;
  /** Search and Person also find an item through its subitems (13 §1 match_children). */
  matchChildren: boolean;
  onMatchChildren: (on: boolean) => void;
  /** Strict subitem filtering: a subitem that fails hides everything under it. */
  strict?: boolean;
  onStrict?: (on: boolean) => void;
}) => {
  const quickColumns = ctx.columns.filter((c) => {
    const f = filterField(c.id, ctx.env);
    return (
      hasQuickFilter(f) && (f.model === 'label' || f.model === 'labels' || f.model === 'people' || f.model === 'tags')
    );
  });
  // Fix: date columns get relative quick filters (today, this week, overdue…), stored as tokens.
  const dateColumns = ctx.columns.filter((c) => {
    const f = filterField(c.id, ctx.env);
    return f?.source === 'column' && f.model === 'date' && quickDateRules(c.id, f).length > 0;
  });
  // Subitems (the item card's subitem filter) have no groups.
  const sections: Section[] = [
    ...(ctx.groups.length ? [{ id: '__group__', title: t('filter.field.__group__') }] : []),
    ...quickColumns.map((c) => ({ id: c.id, title: c.title })),
    ...dateColumns.map((c) => ({ id: c.id, title: c.title })),
  ];
  const quickIds = sections.map((s) => s.id);
  const [picked, setPicked] = useState(() => startSection(filter, quickIds));
  // A column removed while the panel is open: back to the first list.
  const section = picked === ADVANCED || quickIds.includes(picked) ? picked : (quickIds[0] ?? ADVANCED);
  const advancedCount = advancedRuleCount(filter, quickIds);
  const chips = activeRules(filter);
  const root = filter ?? emptyGroup();

  const optionsOf = (id: string): QuickOption[] => {
    if (id === '__group__')
      return ctx.groups.map((g) => ({
        value: g.id,
        label: g.title,
        count: rows.filter((r) => r.group_id === g.id).length,
      }));
    if (dateColumns.some((c) => c.id === id)) return quickDateOptions(id, rows, ctx.env);
    const f = filterField(id, ctx.env)!;
    const counts = new Map<string, number>();
    let empty = 0;
    for (const r of rows) {
      const ids = readIds(r, f);
      if (!ids.length) empty++;
      for (const v of ids) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const options: QuickOption[] =
      f.model === 'people'
        ? [
            {
              value: 'me',
              label: t('filter.assignedToMe'),
              count: counts.get(ctx.meId) ?? 0,
              avatar: avatarOf(ctx.members.find((m) => m.user_id === ctx.meId)),
            },
            ...ctx.members
              .filter((m) => m.user_id !== ctx.meId && counts.get(m.user_id))
              .map((m) => ({
                value: `user:${m.user_id}`,
                label: m.name || m.email,
                count: counts.get(m.user_id) ?? 0,
                avatar: avatarOf(m),
              })),
            ...ctx.teams
              .filter((x) => counts.get(x.id))
              .map((x) => ({
                value: `team:${x.id}`,
                label: x.name,
                count: counts.get(x.id) ?? 0,
                avatar: { name: x.name, avatar_url: null },
              })),
          ]
        : f.model === 'tags'
          ? ctx.tags
              .filter((x) => counts.get(x.id))
              .map((x) => ({ value: x.id, label: `#${x.name}`, count: counts.get(x.id) ?? 0 }))
          : labelsOf(f).map((l) => ({
              value: l.label,
              label: l.label,
              color: f.model === 'label' ? paint(l.color) : undefined,
              count: counts.get(String(l.id)) ?? 0,
            }));
    return [...options, { value: null, label: blankLabel(f), count: empty, blank: true }];
  };

  const railRow = (on: boolean) =>
    cn(
      'flex h-9 shrink-0 items-center gap-2 rounded-[10px] px-2.5 text-start text-sm text-fg-2 hover:bg-surface-2 hover:text-fg md:w-full',
      on && 'bg-surface font-medium text-heading shadow-[var(--shadow-xs,0_1px_2px_rgb(0_0_0/0.08))] hover:bg-surface',
    );
  const badge = (n: number, on: boolean, testId: string) =>
    n ? (
      <span
        data-testid={testId}
        className={cn(
          'ms-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[0.6875rem] font-semibold tabular-nums',
          on ? 'bg-primary text-on-primary' : 'bg-primary-soft text-primary',
        )}
      >
        {n}
      </span>
    ) : null;

  return (
    <div className="flex w-full min-w-0 flex-col" data-testid="filter-panel" data-section={section}>
      {/* Phones: the panel is a bottom sheet — its grip. */}
      <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong md:hidden" />
      <div className="flex min-h-0 flex-1 flex-col md:grid md:min-h-[300px] md:grid-cols-[11rem_minmax(0,1fr)]">
        {/* The rail: one entry per quick list, then the advanced conditions. Phones: a row that scrolls sideways. */}
        <nav
          aria-label={t('toolbar.filter')}
          data-testid="filter-rail"
          className="flex gap-1 overflow-x-auto border-line px-3 py-2 [scrollbar-width:none] md:flex-col md:overflow-y-auto md:border-e md:bg-surface-2/60 md:p-2.5 [&::-webkit-scrollbar]:hidden"
        >
          {sections.map((s) => {
            const on = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={on || undefined}
                data-testid={`filter-rail-${s.id}`}
                onClick={() => setPicked(s.id)}
                className={railRow(on)}
              >
                <span className="truncate">{s.title}</span>
                {badge(quickValues(filter, s.id).length, on, `filter-rail-count-${s.id}`)}
              </button>
            );
          })}
          {sections.length ? (
            <span aria-hidden className="mx-1 my-1.5 w-px shrink-0 bg-line md:mx-1 md:h-px md:w-auto" />
          ) : null}
          <button
            type="button"
            aria-current={section === ADVANCED || undefined}
            data-testid="filter-rail-advanced"
            onClick={() => setPicked(ADVANCED)}
            className={railRow(section === ADVANCED)}
          >
            <Icon name="filter" size={15} className="shrink-0" />
            <span className="truncate">{t('filter.advanced')}</span>
            {badge(advancedCount, section === ADVANCED, 'filter-rail-count-advanced')}
          </button>
        </nav>

        <div className="min-w-0 overflow-y-auto px-3 pb-3 md:max-h-[min(440px,60vh)] md:p-3.5">
          {section === ADVANCED ? (
            <div data-testid="filter-advanced">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-display text-[0.9375rem] font-bold text-heading">{t('filter.advanced')}</h3>
                {ctx.subColumns.length ? (
                  <CheckRow
                    checked={matchChildren}
                    onToggle={() => onMatchChildren(!matchChildren)}
                    className="w-auto text-xs text-fg-2"
                  >
                    <span data-testid="filter-match-children">{t('filter.matchChildren')}</span>
                  </CheckRow>
                ) : null}
                {ctx.subColumns.length && onStrict ? (
                  <CheckRow checked={!!strict} onToggle={() => onStrict(!strict)} className="w-auto text-xs text-fg-2">
                    <span data-testid="filter-strict" title={t('filter.strictHint')}>
                      {t('filter.strict')}
                    </span>
                  </CheckRow>
                ) : null}
              </div>
              <FilterGroupEditor
                group={root}
                depth={1}
                ctx={ctx}
                onChange={(g) => onChange(g.rules.length ? g : undefined)}
              />
            </div>
          ) : (
            <QuickColumn
              key={section}
              columnId={section}
              filter={filter}
              onChange={onChange}
              options={optionsOf(section)}
            />
          )}
        </div>
      </div>

      {/* What is on: a chip per complete rule (any depth), the matching count and "clear". */}
      <div
        className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2.5"
        data-testid="filter-active-row"
      >
        {chips.length ? <span className="text-xs text-muted">{t('filter.active')}</span> : null}
        {chips.map(({ path, rule }) => {
          const label = ruleChipLabel(rule, ctx);
          return (
            <span
              key={path.join('.')}
              data-testid="filter-active-chip"
              className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-primary-soft ps-2.5 pe-1 text-[0.8125rem] text-primary"
            >
              <span className="truncate">{label}</span>
              <button
                type="button"
                aria-label={t('filterChip.remove', { label })}
                title={t('filterChip.remove', { label })}
                onClick={() => onChange(removeRuleAt(filter, path))}
                className="grid size-5 shrink-0 place-items-center rounded-full hover:bg-surface"
              >
                <Icon name="x" size={11} strokeWidth={2.4} />
              </button>
            </span>
          );
        })}
        <span
          className="ms-auto text-[0.8125rem] font-medium text-heading tabular-nums"
          data-testid="filter-count"
          title={t('filter.showing', { n: matching, total: rows.length })}
        >
          {t('filter.matching', { n: matching })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!filter}
          onClick={() => onChange(undefined)}
          data-testid="filter-clear"
        >
          {t('filter.clear')}
        </Button>
      </div>
    </div>
  );
};

/** A date column's quick-filter choices (only those its type supports), each with how many rows it matches now. */
const quickDateOptions = (columnId: string, rows: QueryRow[], env: QueryEnv): QuickOption[] => {
  const field = filterField(columnId, env);
  return (field ? quickDateRules(columnId, field) : []).map(({ value, rule }) => {
    const plan = planQuery(querySchema.parse({ filter: { kind: 'group', operator: 'and', rules: [rule] } }), env);
    return {
      value,
      label: value === null ? t('filter.none') : t(`filter.date.${value}` as MessageKey),
      count: rows.filter((r) => rowMatches(plan, r, env.timezone)).length,
      blank: value === null,
    };
  });
};

type QuickOption = {
  value: unknown;
  label: string;
  count: number;
  /** A status label's colour: the value shows as its coloured tag. */
  color?: string;
  avatar?: { name: string; avatar_url: string | null };
  /** The "empty" choice (muted words). */
  blank?: boolean;
};

/** One column's values: a search, then a check row per value with its colour / avatar and live count. */
const QuickColumn = ({
  columnId,
  filter,
  onChange,
  options,
}: {
  columnId: string;
  filter: FilterGroup | undefined;
  onChange: (f: FilterGroup | undefined) => void;
  options: QuickOption[];
}) => {
  const selected = quickValues(filter, columnId);
  return (
    <div className="min-w-0" data-testid={`quick-${columnId}`}>
      <SearchableList
        items={options}
        text={(o) => o.label}
        searchable
        placeholder={t('filter.searchValue')}
        testId={`quick-search-${columnId}`}
        autoFocus={false}
        compact
      >
        {(shown) => (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {shown.map((o) => {
              const on = selected.some((v) => v === o.value);
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(toggleQuick(filter, columnId, o.value))}
                  className={cn(
                    'flex min-h-9 w-full shrink-0 items-center gap-2.5 rounded-[8px] px-2 text-start text-sm text-heading hover:bg-surface-2',
                    on && 'bg-primary-soft/60 hover:bg-primary-soft',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'grid size-4 shrink-0 place-items-center rounded-[4px] border-[1.5px]',
                      on ? 'border-primary bg-primary text-on-primary' : 'border-line-strong',
                    )}
                  >
                    {on ? <Icon name="check" size={11} strokeWidth={3} /> : null}
                  </span>
                  {o.avatar ? <Avatar name={o.avatar.name} url={o.avatar.avatar_url} size={22} /> : null}
                  {o.color ? (
                    <span className="label-tag min-w-0 truncate px-2 text-xs leading-5" style={tagVars(o.color)}>
                      {o.label}
                    </span>
                  ) : (
                    <span className={cn('min-w-0 truncate', o.blank && 'text-muted')}>{o.label}</span>
                  )}
                  <span className="ms-auto ps-2 text-[0.6875rem] text-muted tabular-nums">{o.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </SearchableList>
    </div>
  );
};

// ---- advanced builder ----

/** "+ תנאי" -> "תנאי": the button draws the plus as an icon (F4); the full text stays its accessible name. */
const plain = (label: string) => label.replace(/^\+\s*/, '');

/**
 * The nested AND/OR/NOT group editor (13 §4.2) — the board filter's advanced builder, also the automation builder's
 * "only if" (r16). `makeRule` is the rule "+ condition" adds (default: the first field with its first operator).
 */
export const FilterGroupEditor = ({
  group,
  depth,
  ctx,
  onChange,
  onRemove,
  makeRule,
}: {
  group: FilterGroup;
  depth: number;
  ctx: FilterCtx;
  onChange: (g: FilterGroup) => void;
  onRemove?: () => void;
  makeRule?: () => FilterRule;
}) => {
  const freshRule = () => (makeRule ? makeRule() : newRule(ctx.columns, ctx.env));
  const set = (i: number, node: FilterRule | FilterGroup | null) => {
    const rules = [...group.rules];
    if (node) rules[i] = node;
    else rules.splice(i, 1);
    onChange({ ...group, rules });
  };
  return (
    <div
      className={cn(
        'space-y-2',
        depth > 1 && 'rounded-[var(--radius)] border border-line bg-surface-2/50 p-2',
        group.negate && 'border-[var(--danger)]/50',
      )}
      data-testid={`filter-group-${depth}`}
    >
      {depth > 1 || group.negate ? (
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            aria-pressed={group.negate}
            onClick={() => onChange({ ...group, negate: !group.negate })}
            className={cn(
              'rounded-full border px-2 py-0.5',
              group.negate ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-line text-muted',
            )}
          >
            {t('filter.not')}
          </button>
          {onRemove ? (
            <button type="button" className="ms-auto text-muted hover:text-[var(--danger)]" onClick={onRemove}>
              {t('filter.removeGroup')}
            </button>
          ) : null}
        </div>
      ) : null}
      {group.rules.map((node, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex h-9 w-14 shrink-0 items-center text-xs">
            {i === 0 ? (
              <span className="text-muted">{t('filter.where')}</span>
            ) : i === 1 ? (
              <PickerButton
                label={t(`filter.${group.operator}`)}
                placeholder=""
                menuLabel={t('filter.combine')}
                className="h-9 w-14 gap-0.5 px-1.5 text-xs"
                testId="filter-combinator"
                items={(['and', 'or'] as const).map((op) => ({
                  label: t(`filter.${op}`),
                  checked: group.operator === op,
                  onSelect: () => onChange({ ...group, operator: op }),
                }))}
              />
            ) : (
              <span className="block px-1.5 text-muted">{t(`filter.${group.operator}`)}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {isGroup(node) ? (
              <FilterGroupEditor
                group={node}
                depth={depth + 1}
                ctx={ctx}
                makeRule={makeRule}
                onChange={(g) => set(i, g)}
                onRemove={() => set(i, null)}
              />
            ) : (
              <RuleEditor rule={node} ctx={ctx} onChange={(r) => set(i, r)} onRemove={() => set(i, null)} />
            )}
          </div>
        </div>
      ))}
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          data-testid="filter-add-rule"
          aria-label={t('filter.addRule')}
          onClick={() => onChange({ ...group, rules: [...group.rules, freshRule()] })}
        >
          <Icon name="plus" size={15} strokeWidth={2} />
          {plain(t('filter.addRule'))}
        </Button>
        {depth < MAX_FILTER_DEPTH ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="filter-add-group"
            aria-label={t('filter.addGroup')}
            onClick={() =>
              onChange({
                ...group,
                rules: [
                  ...group.rules,
                  { ...emptyGroup(group.operator === 'and' ? 'or' : 'and'), rules: [freshRule()] },
                ],
              })
            }
          >
            <Icon name="plus" size={15} strokeWidth={2} />
            {plain(t('filter.addGroup'))}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

export const RuleEditor = ({
  rule,
  ctx,
  onChange,
  onRemove,
}: {
  rule: FilterRule;
  ctx: FilterCtx;
  onChange: (r: FilterRule) => void;
  onRemove: () => void;
}) => {
  const field = filterField(rule.column_id, ctx.env);
  // A saved rule that cannot run here (column gone, or its type lacks the operator — old or imported data): the
  // query skips it; here it is marked, and can be fixed (pick a column / operator) or removed.
  const problem = ruleProblem(rule, ctx.env);
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        problem && 'rounded-[10px] border border-dashed border-[var(--danger)]/60 p-1.5',
      )}
      data-testid="filter-rule"
      data-invalid={problem ?? undefined}
    >
      <PickerButton
        label={fieldTitle(rule.column_id, ctx.columns, ctx.subColumns)}
        placeholder={t('filter.column')}
        menuLabel={t('filter.column')}
        className="h-9 w-[180px]"
        testId="rule-column"
        items={filterFields(ctx.columns, ctx.subColumns).map((f) => ({
          label: f.title,
          keywords: f.type ? columnTypeLabel(f.type) : undefined,
          checked: f.id === rule.column_id,
          onSelect: () => onChange(changeField(rule, f.id, ctx.env)),
        }))}
      />
      <PickerButton
        label={operatorLabel(rule.operator, field)}
        placeholder={t('filter.operator')}
        menuLabel={t('filter.operator')}
        className="h-9 w-[128px]"
        testId="rule-operator"
        items={(field ? operatorChoices(field) : []).map((op) => ({
          label: operatorLabel(op, field),
          checked: op === rule.operator,
          onSelect: () => onChange(changeOperator(rule, op)),
        }))}
      />
      {/* a mirror's rule over several linked items — one of them (default) or all of them. */}
      {field && !problem && mirrorMatchApplies(field, rule.operator) ? (
        <PickerButton
          label={t(rule.match === 'all' ? 'filter.match.all' : 'filter.match.any')}
          placeholder={t('filter.match.label')}
          menuLabel={t('filter.match.label')}
          className="h-9 w-[150px]"
          testId="rule-match"
          items={(['any', 'all'] as const).map((m) => ({
            label: t(m === 'all' ? 'filter.match.all' : 'filter.match.any'),
            checked: (rule.match ?? 'any') === m,
            onSelect: () => onChange(withMatch(rule, m)),
          }))}
        />
      ) : null}
      {problem ? (
        <span className="text-xs text-[var(--danger)]" data-testid="filter-rule-invalid">
          {t('filter.invalidRule')}
        </span>
      ) : field && !NO_VALUE_OPS.has(rule.operator) ? (
        <ValueEditor rule={rule} field={field} ctx={ctx} onChange={(values) => onChange({ ...rule, values })} />
      ) : null}
      <IconButton label={t('filter.removeRule')} onClick={onRemove} className="ms-auto">
        ✕
      </IconButton>
    </div>
  );
};

const inputClass =
  'h-9 rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm outline-none focus:border-heading';

const ValueEditor = ({
  rule,
  field,
  ctx,
  onChange,
}: {
  rule: FilterRule;
  field: Field;
  ctx: FilterCtx;
  onChange: (values: unknown[]) => void;
}) => {
  const op = rule.operator;
  const textOp = op === 'contains_text' || op === 'not_contains_text' || op === 'starts_with' || op === 'ends_with';
  // A number comparison on a mirror / formula reads its number (comparesNumbers).
  const numeric = comparesNumbers(field.model, op);
  if (!numeric && (textOp || field.model === 'text' || field.model === 'files' || field.model === 'links'))
    return <TextValue value={String(rule.values[0] ?? '')} onChange={(v) => onChange(v ? [v] : [])} />;

  if (numeric) {
    if (op === 'between')
      return (
        <span className="flex items-center gap-1">
          <NumberValue value={rule.values[0]} onChange={(v) => onChange([v, rule.values[1] ?? null])} />
          <span className="text-xs text-muted">{t('filter.and')}</span>
          <NumberValue value={rule.values[1]} onChange={(v) => onChange([rule.values[0] ?? null, v])} />
        </span>
      );
    return <NumberValue value={rule.values[0]} onChange={(v) => onChange(v === null ? [] : [v])} />;
  }

  if (field.model === 'date')
    return <DateRuleValues operator={op} values={rule.values} onChange={onChange} firstDay={ctx.env.firstDay} />;

  // id models: labels, tags, people, group
  const options: { value: unknown; label: string; color?: string }[] =
    field.model === 'people'
      ? [
          { value: 'me', label: t('filter.assignedToMe') },
          ...ctx.members.map((m) => ({ value: `user:${m.user_id}`, label: m.name || m.email })),
          ...ctx.teams.map((x) => ({ value: `team:${x.id}`, label: x.name })),
          { value: null, label: blankLabel(field) },
        ]
      : field.model === 'ids'
        ? ctx.groups.map((g) => ({ value: g.id, label: g.title }))
        : field.model === 'tags'
          ? [...ctx.tags.map((x) => ({ value: x.id, label: `#${x.name}` })), { value: null, label: blankLabel(field) }]
          : [
              ...labelsOf(field).map((l) => ({
                value: l.label,
                label: l.label,
                color: field.model === 'label' ? paint(l.color) : undefined,
              })),
              { value: null, label: blankLabel(field) },
            ];
  return <MultiValue options={options} values={rule.values} onChange={onChange} />;
};

const TextValue = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
  <input
    className={cn(inputClass, 'w-44')}
    value={value}
    placeholder={t('filter.value')}
    onChange={(e) => onChange(e.target.value)}
    data-testid="rule-text"
  />
);

/** The rule's number input: `DateRuleValue`'s (one component for both files — duplication audit #16), wider here. */
const NumberValue = ({ value, onChange }: { value: unknown; onChange: (v: number | null) => void }) => (
  <RuleNumberValue value={value} onChange={onChange} width="w-24" />
);

const dateLabel = dateValueLabel;

/** The words of one rule value — the same names the builder shows (people, groups, tags, labels, dates). */
const valueText = (v: unknown, field: Field | null, ctx: FilterCtx): string => {
  if (v === null) return field?.model === 'date' ? t('filter.none') : blankLabel(field);
  if (field?.model === 'date') return dateLabel(v) ?? String(v);
  if (typeof v !== 'string') return String(v);
  if (field?.model === 'people') {
    if (v === 'me') return t('filter.assignedToMe');
    if (v.startsWith('user:')) {
      const m = ctx.members.find((x) => x.user_id === v.slice(5));
      return m ? m.name || m.email : v;
    }
    if (v.startsWith('team:')) return ctx.teams.find((x) => x.id === v.slice(5))?.name ?? v;
  }
  if (field?.model === 'ids') return ctx.groups.find((g) => g.id === v)?.title ?? v;
  if (field?.model === 'tags') {
    const tag = ctx.tags.find((x) => x.id === v);
    return tag ? `#${tag.name}` : v;
  }
  return v;
};

/**
 * A rule as one line for its toolbar chip (N2): "אחראי: אני", "סכום: גדול מ- 100", "תאריך: לפני היום".
 * Generic — the column title, the operator's wording (none for a plain "is") and the values' names.
 */
export const ruleChipLabel = (rule: FilterRule, ctx: FilterCtx): string => {
  const field = filterField(rule.column_id, ctx.env);
  const title = fieldTitle(rule.column_id, ctx.columns, ctx.subColumns);
  const op = rule.operator;
  let values = '';
  if (!NO_VALUE_OPS.has(op)) {
    if (op === 'within_the_last' || op === 'within_the_next')
      values = `${String(rule.values[0] ?? '')} ${t(`filter.unit.${String(rule.values[1] ?? 'days')}` as MessageKey)}`;
    else if (op === 'between')
      values = `${valueText(rule.values[0] ?? '', field, ctx)} – ${valueText(rule.values[1] ?? '', field, ctx)}`;
    else values = rule.values.map((v) => valueText(v, field, ctx)).join(', ');
  }
  const opText = op === 'any_of' ? '' : operatorLabel(op, field);
  const all = rule.match === 'all' && !!field && mirrorMatchApplies(field, op) ? t('filter.match.all') : '';
  const body = [all, opText, values].filter(Boolean).join(' ');
  return `${title}: ${rule.negate ? `${t('filter.not')} ` : ''}${body}`;
};

const MultiValue = ({
  options,
  values,
  onChange,
}: {
  options: { value: unknown; label: string; color?: string }[];
  values: unknown[];
  onChange: (values: unknown[]) => void;
}) => {
  const [open, setOpen] = useState(false);
  const chosen = options.filter((o) => values.some((v) => v === o.value));
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="rule-values"
        onClick={() => setOpen(true)}
        className={cn(inputClass, 'flex min-w-40 max-w-[360px] items-center gap-1', !chosen.length && 'text-muted')}
      >
        {chosen.length ? (
          chosen.map((o) => (
            <span
              key={String(o.value)}
              className={cn('truncate px-1.5 text-xs leading-5', o.color ? 'label-tag' : 'rounded')}
              style={o.color ? tagVars(o.color) : { backgroundColor: 'var(--surface-2)' }}
            >
              {o.label}
            </span>
          ))
        ) : (
          <span>{t('filter.pickValues')}</span>
        )}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} className="w-56">
        <SearchableList items={options} text={(o) => o.label} testId="rule-values-search">
          {(shown) => (
            <div className="max-h-72 overflow-y-auto">
              {shown.map((o) => {
                const on = values.some((v) => v === o.value);
                return (
                  <CheckRow
                    key={String(o.value)}
                    checked={on}
                    onToggle={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])}
                  >
                    {o.color ? <span className="h-3.5 w-1.5 rounded-sm" style={{ backgroundColor: o.color }} /> : null}
                    <span className="truncate">{o.label}</span>
                  </CheckRow>
                );
              })}
            </div>
          )}
        </SearchableList>
      </Popover>
    </div>
  );
};
