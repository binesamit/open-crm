// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import {
  formatDateTime,
  formatDayMonth,
  formatDuration,
  formatTime,
  localDateOf,
  localTimeOf,
  parseDuration,
  rangeDays,
  t,
  todayIn,
  zonedInstant,
  type Column,
  type TimeEntry,
} from '@bines/shared';
import {
  Avatar,
  Badge,
  Button,
  Calendar,
  Card,
  cn,
  formatIsoDate,
  Menu,
  Notice,
  Skeleton,
  SkeletonRows,
  TimeField,
  useActionMenu,
} from '@bines/ui';
import { Icon } from '../../lib/icons';
import { errorMessage, type Me } from '../../lib/api';
import { confirmDelete } from '../../lib/dialogs';
import { Popover } from '../board/cells/Popover';
import type { Member } from '../board/board-api';
import { since, useNow, useTimeEntries, useTimeMutations } from './time-api';
import { downloadFrom } from '../../lib/download';
import { showToast } from '../../lib/toast';

/** A timer running this long asks "forgot it?" (03 §3.3; the worker also notifies). */
const FORGOTTEN_AFTER_S = 12 * 3600;

/**
 * The item's time log (03 §3.3, M1.1 #11): total and per person, every entry with its source, manual entries
 * (date + start/end or a duration), inline edit and delete. Times are entered and shown in the member's region
 * (A3: their timezone, the account's time format).
 */
const toIso = (date: string, time: string) => zonedInstant(date, time.padStart(5, '0')).toISOString();

type Draft = {
  columnId: string;
  date: string;
  start: string;
  end: string;
  duration: string;
  mode: 'end' | 'duration';
  note: string;
};

const DateField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-8 rounded-[var(--radius-sm)] border border-line bg-surface px-2 text-sm"
        dir="ltr"
        aria-label={t('time.date')}
      >
        {formatIsoDate(value)}
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <Calendar
          mode="single"
          value={value}
          onChange={(v) => {
            if (v) onChange(v);
            setOpen(false);
          }}
        />
      </Popover>
    </div>
  );
};

/** Add / edit form. `entry` = edit mode (start/end/note only). */
const EntryForm = ({
  columns,
  entry,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  columns: Column[];
  entry?: TimeEntry;
  busy: boolean;
  error: unknown;
  onSubmit: (v: { columnId: string; started_at: string; ended_at?: string; duration_s?: number; note: string }) => void;
  onCancel: () => void;
}) => {
  const hm = { hourLabel: t('time.hours'), minuteLabel: t('time.minutes') };
  // A new entry defaults to the last hour.
  const [d, setD] = useState<Draft>(() => {
    const start = entry ? new Date(entry.started_at) : new Date(Date.now() - 3600_000);
    const end = entry?.ended_at ? new Date(entry.ended_at) : new Date();
    return {
      columnId: entry?.column_id ?? columns[0]!.id,
      date: entry ? localDateOf(start) : todayIn(),
      start: localTimeOf(start),
      end: localTimeOf(end),
      duration: '01:00',
      mode: 'end',
      note: entry?.note ?? '',
    };
  });
  const [local, setLocal] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocal(null);
    const started_at = toIso(d.date, d.start);
    if (d.mode === 'duration' && !entry) {
      const seconds = parseDuration(d.duration);
      if (!seconds) return setLocal(t('time.badDuration'));
      return onSubmit({ columnId: d.columnId, started_at, duration_s: seconds, note: d.note });
    }
    // An end earlier than the start means it ended after midnight.
    let ended_at = toIso(d.date, d.end);
    if (ended_at <= started_at) ended_at = new Date(new Date(ended_at).getTime() + 86_400_000).toISOString();
    onSubmit({ columnId: d.columnId, started_at, ended_at, note: d.note });
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-[14px] border border-line-soft bg-surface-3 p-3"
      data-testid="time-form"
    >
      {!entry && columns.length > 1 ? (
        <div role="radiogroup" aria-label={t('time.column')} className="flex flex-wrap gap-1">
          {columns.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={d.columnId === c.id}
              onClick={() => set({ columnId: c.id })}
              className={cn(
                'rounded-full border px-2 py-0.5 text-xs',
                d.columnId === c.id ? 'border-primary bg-primary-soft text-primary' : 'border-line',
              )}
            >
              {c.title}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <DateField value={d.date} onChange={(date) => set({ date })} />
        <TimeField label={t('time.start.label')} {...hm} value={d.start} onChange={(start) => set({ start })} />
        {d.mode === 'end' || entry ? (
          <>
            <span className="text-muted">–</span>
            <TimeField label={t('time.end')} {...hm} value={d.end} onChange={(end) => set({ end })} />
          </>
        ) : (
          <TimeField label={t('time.duration')} {...hm} value={d.duration} onChange={(duration) => set({ duration })} />
        )}
        {!entry ? (
          <button
            type="button"
            className="text-xs text-primary hover:underline"
            onClick={() => set({ mode: d.mode === 'end' ? 'duration' : 'end' })}
          >
            {d.mode === 'end' ? t('time.byDuration') : t('time.byEnd')}
          </button>
        ) : null}
      </div>
      <input
        aria-label={t('time.note')}
        placeholder={t('time.note')}
        value={d.note}
        onChange={(e) => set({ note: e.target.value })}
        className="h-8 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-2 text-sm"
      />
      {local ? <p className="text-xs text-[var(--danger)]">{local}</p> : null}
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" busy={busy}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
};

/** "היום" / "אתמול" / "1 אוק׳" for an entry's day (the canvas's "היום • טיימר"). */
const dayLabel = (iso: string, now: number) => {
  const days = rangeDays(localDateOf(iso), localDateOf(now)) - 1;
  if (days === 0) return t('calendar.today');
  if (days === 1) return t('filter.date.YESTERDAY');
  return formatDayMonth(iso);
};

/** ⋯ (three dots) — icons.tsx has no such glyph. */
const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="5" cy="12" r="1.3" />
    <circle cx="12" cy="12" r="1.3" />
    <circle cx="19" cy="12" r="1.3" />
  </svg>
);

const StopIcon = () => <Icon name="stop" size={14} />;

/** One entry of the log: who, what, when, how long — edit / delete in its ⋯ menu (canvas Item-Time). */
const EntryRow = ({
  entry: e,
  seconds,
  now,
  avatarUrl,
  editable,
  onEdit,
  onDelete,
}: {
  entry: TimeEntry;
  seconds: number;
  now: number;
  avatarUrl: string | null | undefined;
  editable: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const menu = useActionMenu();
  const span = (
    <span dir="ltr">
      {formatTime(e.started_at)}–{e.ended_at ? formatTime(e.ended_at) : '…'}
    </span>
  );
  return (
    <li
      data-testid="time-entry"
      onContextMenu={editable ? menu.onContextMenu : undefined}
      onKeyDown={editable ? menu.onKeyDown : undefined}
      className={cn(
        'flex items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0',
        e.edited_at && 'bg-[color-mix(in_srgb,var(--warn)_8%,var(--surface))]',
      )}
    >
      <Avatar name={e.user?.name ?? '?'} url={avatarUrl} size={24} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold text-fg">{e.note || span}</p>
        <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted">
          <span title={formatDateTime(e.started_at)}>{dayLabel(e.started_at, now)}</span>
          {e.note ? (
            <>
              <span aria-hidden>•</span>
              {span}
            </>
          ) : null}
          <span aria-hidden>•</span>
          <span>{t(e.source === 'manual' ? 'time.source.manual' : 'time.source.timer')}</span>
          {e.edited_by ? (
            <>
              <span aria-hidden>•</span>
              <span>{t('time.editedBy', { name: e.edited_by.name })}</span>
            </>
          ) : null}
        </p>
      </div>
      {!e.ended_at ? <Badge tone="ok">{t('time.running')}</Badge> : null}
      {!e.ended_at && seconds > FORGOTTEN_AFTER_S ? (
        <span data-testid="time-forgotten">
          <Badge tone="danger">{t('time.forgotten')}</Badge>
        </span>
      ) : null}
      <span className="font-bold text-fg tabular-nums" dir="ltr">
        {formatDuration(seconds)}
      </span>
      {editable ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-haspopup="menu"
            aria-label={t('menu.actions')}
            title={t('menu.actions')}
            data-testid="time-entry-more"
            onClick={menu.fromTrigger}
            className="w-8 shrink-0 px-0 text-muted"
          >
            <DotsIcon />
          </Button>
          <Menu
            at={menu.at}
            onClose={menu.close}
            label={t('menu.actions')}
            items={[
              { label: t('item.edit'), icon: <Icon name="edit" size={16} />, onSelect: onEdit },
              { kind: 'separator' },
              { label: t('item.delete'), icon: <Icon name="trash" size={16} />, danger: true, onSelect: onDelete },
            ]}
          />
        </>
      ) : null}
    </li>
  );
};

export const TimeLog = ({
  accountId,
  me,
  itemId,
  columns,
  members,
  canEdit,
  isAdmin,
}: {
  accountId: string;
  me: Me;
  itemId: string;
  columns: Column[];
  members: Member[];
  canEdit: boolean;
  isAdmin: boolean;
}) => {
  const entries = useTimeEntries(accountId, itemId);
  const m = useTimeMutations(accountId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const list = entries.data?.data ?? [];
  const now = useNow(list.some((e) => !e.ended_at));
  const seconds = (e: TimeEntry) => e.duration_s ?? since(e.started_at, now);
  const total = list.reduce((s, e) => s + seconds(e), 0);
  const byUser = [...new Map(list.map((e) => [e.user?.id ?? '', e.user])).values()].map((u) => ({
    user: u,
    seconds: list.filter((e) => (e.user?.id ?? '') === (u?.id ?? '')).reduce((s, e) => s + seconds(e), 0),
  }));
  const avatar = (id?: string) => members.find((x) => x.user_id === id)?.avatar_url;
  // N11: my timer per time-tracking column (several columns = one button each, named after its column).
  const myRunning = (columnId: string) =>
    list.some((e) => !e.ended_at && e.user?.id === me.user.id && e.column_id === columnId);
  const timerBusy = m.start.isPending || m.stop.isPending;

  return (
    <div className="flex flex-col gap-3.5" data-testid="time-log">
      <Card soft className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <p className="text-xs text-muted">{t('time.total')}</p>
          <p
            className="font-display text-[1.75rem] leading-tight font-extrabold text-heading tabular-nums"
            dir="ltr"
            data-testid="time-total"
          >
            {entries.isPending ? <Skeleton className="my-2 h-5 w-20" /> : formatDuration(total)}
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            {columns.map((c) => {
              const running = myRunning(c.id);
              const label = running ? t('time.stop') : t('time.start');
              return (
                <Button
                  key={c.id}
                  variant={running ? 'danger-outline' : 'accent'}
                  data-testid="card-timer"
                  data-tour="item.timer"
                  data-column={c.id}
                  data-running={running}
                  disabled={timerBusy || entries.isPending}
                  aria-label={columns.length > 1 ? `${label} · ${c.title}` : label}
                  onClick={() => (running ? m.stop : m.start).mutate({ itemId, columnId: c.id })}
                >
                  {running ? <StopIcon /> : <Icon name="play" size={14} />}
                  {label}
                  {columns.length > 1 ? <span className="font-normal opacity-80">· {c.title}</span> : null}
                </Button>
              );
            })}
            {!adding ? (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                <Icon name="plus" size={15} />
                {t('time.addEntry')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card>
      {m.start.isError || m.stop.isError ? (
        <Notice tone="error">{errorMessage(m.start.error ?? m.stop.error)}</Notice>
      ) : null}
      {byUser.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {byUser.map(({ user, seconds: s }) => (
            <span
              key={user?.id ?? 'none'}
              className="flex h-7 items-center gap-1.5 rounded-full bg-surface-2 ps-0.5 pe-2.5 text-xs font-semibold text-fg-2"
            >
              <Avatar name={user?.name ?? '?'} url={avatar(user?.id)} size={18} />
              {user?.name ?? '?'}
              <span className="tabular-nums" dir="ltr">
                {formatDuration(s, { show_seconds: false })}
              </span>
            </span>
          ))}
        </div>
      ) : null}
      {adding ? (
        <EntryForm
          columns={columns}
          busy={m.add.isPending}
          error={m.add.error}
          onCancel={() => setAdding(false)}
          onSubmit={(v) =>
            m.add.mutate(
              {
                itemId,
                input: {
                  column_id: v.columnId,
                  started_at: v.started_at,
                  ...(v.ended_at ? { ended_at: v.ended_at } : { duration_s: v.duration_s }),
                  ...(v.note.trim() ? { note: v.note.trim() } : {}),
                },
              },
              { onSuccess: () => setAdding(false) },
            )
          }
        />
      ) : null}
      {entries.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {!list.length && !entries.isPending ? <p className="text-sm text-muted">{t('time.empty')}</p> : null}
      {list.length ? (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {list.map((e) => {
            const mine = e.user?.id === me.user.id;
            const editable = canEdit && (mine || isAdmin);
            if (editing === e.id) {
              return (
                <li key={e.id} className="border-b border-line-soft p-2 last:border-b-0">
                  <EntryForm
                    columns={columns}
                    entry={e}
                    busy={m.edit.isPending}
                    error={m.edit.error}
                    onCancel={() => setEditing(null)}
                    onSubmit={(v) =>
                      m.edit.mutate(
                        {
                          id: e.id,
                          patch: {
                            started_at: v.started_at,
                            ...(e.ended_at && v.ended_at ? { ended_at: v.ended_at } : {}),
                            note: v.note.trim() || null,
                          },
                        },
                        { onSuccess: () => setEditing(null) },
                      )
                    }
                  />
                </li>
              );
            }
            return (
              <EntryRow
                key={e.id}
                entry={e}
                seconds={seconds(e)}
                now={now}
                avatarUrl={avatar(e.user?.id)}
                editable={editable}
                onEdit={() => setEditing(e.id)}
                onDelete={() => void confirmDelete(t('time.entry')).then((ok) => ok && m.remove.mutate(e.id))}
              />
            );
          })}
        </ul>
      ) : null}
      {list.length ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          data-testid="time-log-csv"
          onClick={() =>
            void downloadFrom(accountId, `/items/${itemId}/time/entries.csv`, 'time-log.csv').catch((err) =>
              showToast({ message: errorMessage(err), tone: 'error' }),
            )
          }
        >
          <Icon name="download" size={15} />
          {t('time.exportCsv')}
        </Button>
      ) : null}
    </div>
  );
};
