// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { type ActivityEntry, type Column, columnTypes, getRegion, type Group, t } from '@bines/shared';
import { Avatar, cn } from '@bines/ui';
import { LabelTag } from '../../lib/label-color';
import { Icon } from '../../lib/icons';
import type { Member } from './board-api';

/** What the change log needs to show a value the way its column does (labels, people, dates). */
export type ChangeCtx = {
  columns: Pick<Column, 'id' | 'type' | 'title' | 'settings'>[];
  groups: Pick<Group, 'id' | 'title'>[];
  members: Member[];
};

const MAX_CHARS = 80;
const clip = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s);

const isEmpty = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === '' ||
  (Array.isArray(v) && !v.length) ||
  (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length);

const chipCls = 'inline-flex h-5 max-w-[12rem] items-center truncate rounded-[6px] px-1.5 text-xs font-semibold';

/** A label of a status column, in its colour. */
const LabelChip = ({ text, color }: { text: string; color?: string }) =>
  color ? (
    <LabelTag color={color} className="h-5 max-w-[12rem]">
      {text || '—'}
    </LabelTag>
  ) : (
    <span className={cn(chipCls, 'bg-surface-2 text-fg-2')}>{text || '—'}</span>
  );

/** One value as its column shows it; anything unknown as short text. */
const ColumnValue = ({
  column,
  value,
  ctx,
}: {
  column: ChangeCtx['columns'][number];
  value: unknown;
  ctx: ChangeCtx;
}) => {
  const def = columnTypes.get(column.type);
  if (!def) return <>{clip(typeof value === 'string' ? value : JSON.stringify(value))}</>;
  const parsedSettings = def.settingsSchema.safeParse(column.settings ?? def.defaultSettings);
  const settings = parsedSettings.success ? parsedSettings.data : def.defaultSettings;
  const parsed = def.valueSchema.safeParse(value);
  if (!parsed.success) return <>{clip(typeof value === 'string' ? value : JSON.stringify(value))}</>;
  const v = parsed.data as Record<string, unknown>;
  if (column.type === 'status') {
    const label = (settings as { labels: { id: number; label: string; color: string }[] }).labels.find(
      (l) => l.id === v.index,
    );
    return <LabelChip text={label?.label ?? ''} color={label?.color} />;
  }
  if (column.type === 'dropdown') {
    const labels = (settings as { labels: { id: number; label: string }[] }).labels;
    return (
      <span className="inline-flex flex-wrap gap-1">
        {(v.ids as number[]).map((id) => (
          <LabelChip key={id} text={labels.find((l) => l.id === id)?.label ?? ''} />
        ))}
      </span>
    );
  }
  if (column.type === 'people') {
    const list = v.persons_and_teams as { id: string; kind: string }[];
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {list.map((p) => {
          const m = ctx.members.find((x) => x.user_id === p.id);
          const name = m?.name || m?.email || p.id;
          return (
            <span key={p.id} className="inline-flex items-center gap-1">
              <Avatar name={name} url={m?.avatar_url} size={18} />
              <bdi className="max-w-[9rem] truncate">{name}</bdi>
            </span>
          );
        })}
      </span>
    );
  }
  const text = def.toText(parsed.data, settings, {
    userName: (id) => ctx.members.find((m) => m.user_id === id)?.name,
    region: getRegion(),
  });
  return <bdi>{clip(text || JSON.stringify(value))}</bdi>;
};

/** A side of the change: the old one faded and struck through, the new one plain. */
const Side = ({ old, children, testId }: { old?: boolean; children: ReactNode; testId: string }) => (
  <span
    data-testid={testId}
    className={cn('inline-flex min-w-0 items-center', old && 'text-muted line-through decoration-1 opacity-70')}
  >
    {children}
  </span>
);

const EmptyValue = () => <span className="text-muted">{t('activity.change.empty')}</span>;

/**
 * Before → after of one activity row: a cell change shows both values with the column's look
 * (status colours, people's avatars, dates in the reader's format), a rename both names, a group move both groups.
 * Rows without a stored before / after show nothing.
 */
export const ActivityChange = ({ entry: e, ctx }: { entry: ActivityEntry; ctx: ChangeCtx }) => {
  const before = (e.before ?? null) as Record<string, unknown> | null;
  const after = (e.after ?? null) as Record<string, unknown> | null;
  let from: ReactNode = null;
  let to: ReactNode = null;
  if (e.type === 'cell.changed' || e.type === 'cell.geocoded') {
    const column = ctx.columns.find((c) => c.id === e.column_id);
    if (!column || (!before && !after)) return null;
    const show = (v: unknown) =>
      column.type === 'checkbox' ? (
        // No cell = unchecked.
        <Icon name={(v as { checked?: boolean } | null)?.checked ? 'check' : 'x'} size={14} />
      ) : isEmpty(v) ? (
        <EmptyValue />
      ) : (
        <ColumnValue column={column} value={v} ctx={ctx} />
      );
    from = show(before?.value);
    to = show(after?.value);
  } else if (e.type === 'item.renamed') {
    if (typeof before?.name !== 'string' || typeof after?.name !== 'string') return null;
    from = <bdi>{clip(before.name)}</bdi>;
    to = <bdi>{clip(after.name)}</bdi>;
  } else if (e.type === 'item.moved_to_group') {
    const title = (id: unknown) => ctx.groups.find((g) => g.id === id)?.title;
    const a = title(before?.group_id);
    const b = title(after?.group_id);
    if (!a && !b) return null;
    from = a ? <bdi>{a}</bdi> : <EmptyValue />;
    to = b ? <bdi>{b}</bdi> : <EmptyValue />;
  } else return null;
  return (
    <span
      className="flex flex-wrap items-center gap-1.5 text-sm text-fg-2"
      data-testid="activity-change"
      aria-label={t('activity.change.label')}
    >
      <Side old testId="activity-before">
        {from}
      </Side>
      <Icon name="chevronEnd" size={14} className="shrink-0 text-muted" />
      <Side testId="activity-after">{to}</Side>
    </span>
  );
};
