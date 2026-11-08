// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  buttonSettingsSchema,
  colorFromText,
  COUNTRY_CODES,
  countryName,
  formatDateRange,
  formatHourValue,
  getRegion,
  GROUP_COLORS,
  GROUP_PALETTE,
  paint,
  hourFromText,
  isoWeekNumber,
  isWorkingTime,
  progressConfigured,
  t,
  timeZones,
  weekOf,
  zoneCity,
  zoneNow,
  type ButtonResultDto,
  type HourValue,
  type LocationValue,
  type PlaceSuggestion,
  type ButtonClick,
} from '@bines/shared';
import { Button, Calendar, cn, readableOn, SearchableList } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog } from '../../../lib/dialogs';
import { showToast } from '../../../lib/toast';
import { Icon } from '../../../lib/icons';
import { fetchPlace, fetchSuggestions, useGeoConfig } from '../../maps/map-api';
import type { CellProps } from './index';
import { Popover } from './Popover';
import { useBoard } from '../board-api';
import { PopupDialog } from '../workflow/popup';
import { useOpenItem } from '../open-item';

/**
 * Cells of the P1 columns (M8 ד10–ד11, 03 §3): progress, button, hour, week, world clock, colour, country and
 * location. Every editor is our own panel (no native pickers): lists, our Calendar, a palette.
 */
const base = 'relative flex h-full w-full items-center px-2 text-sm';
const clickable = (editable: boolean) => (editable ? 'cursor-pointer hover:bg-surface-2' : '');
const pad = (n: number) => String(n).padStart(2, '0');
type RowCells = Record<string, { value: unknown; text: string | null; names?: string[] } | undefined>;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---- progress ----
export const ProgressCell = ({ column, value }: CellProps) => {
  const percent = (value as { percent?: number } | null)?.percent;
  if (percent === undefined) {
    // r15cols: a column that is not set up says so (the settings say what to choose) instead of an empty cell.
    if (progressConfigured(column.settings)) return <div className={base} />;
    return (
      <div
        className={cn(base, 'text-xs text-muted')}
        data-testid="progress-unset"
        title={t('r15cols.progress.cellUnsetHint')}
      >
        <span className="truncate">{t('r15cols.progress.cellUnset')}</span>
      </div>
    );
  }
  return (
    <div className={cn(base, 'gap-2')} data-testid="progress-cell" data-percent={percent}>
      <span
        className="relative h-2 flex-1 overflow-hidden rounded-full bg-[var(--status-empty)]"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={column.title}
      >
        <span className="absolute inset-y-0 start-0 rounded-full bg-[var(--ok)]" style={{ width: `${percent}%` }} />
      </span>
      {column.settings.hide_percent ? null : (
        <span className="w-9 shrink-0 text-end text-xs text-fg-2 tabular-nums">{percent}%</span>
      )}
    </div>
  );
};

// ---- button ----
export const ButtonCell = ({ column, editable, accountId, itemId, boardId, rowCells }: CellProps) => {
  const qc = useQueryClient();
  const s = buttonSettingsSchema.parse(column.settings ?? {});
  // phase 2: a popup button asks first; its answers go with the click.
  const [asking, setAsking] = useState(false);
  const board = useBoard(accountId, boardId).data;
  // P1-03: a "create a linked item" button — its popup is about an item of the other board: a new one, or the linked
  // one its reuse rule finds (with that item's values).
  const linkedAct = s.action.kind === 'create_linked' ? s.action : null;
  const targetBoard = useBoard(accountId, linkedAct?.board_id ?? '').data;
  const [linkedOpen, setLinkedOpen] = useState<{ id: string | null; name: string; cells: RowCells } | null>(null);
  const openItem = useOpenItem(boardId);
  const click = useMutation({
    mutationFn: (answers?: ButtonClick) =>
      api(accountId).post<ButtonResultDto>(`/items/${itemId}/buttons/${column.id}`, answers ?? {}),
    onSuccess: async (res) => {
      if (res.url) window.open(res.url, '_blank', 'noopener,noreferrer');
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['account', accountId, 'board', boardId, 'items'] }),
        qc.invalidateQueries({ queryKey: ['account', accountId, 'item', itemId] }),
        // a popup's subitems.
        ...(board?.subitems_board_id
          ? [qc.invalidateQueries({ queryKey: ['account', accountId, 'board', board.subitems_board_id, 'items'] })]
          : []),
      ]);
      if (res.skipped.length) showToast({ message: t('button.skipped', { n: res.skipped.length }), tone: 'error' });
      if (res.linked) {
        const made = res.linked;
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'board', made.board_id, 'items'] });
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'item', made.item_id] });
        if (linkedAct?.after === 'open') openItem(made.item_id);
        else
          showToast({
            message: t(made.created ? 'button.linked.created' : 'button.linked.updated', { name: made.name }),
            action: { label: t('button.linked.open'), run: () => openItem(made.item_id) },
            seconds: 8,
          });
      } else if (res.written.length)
        showToast({
          message: t('button.done', { name: s.label || column.title }),
          action: {
            label: t('undo.action'),
            run: async () => {
              await api(accountId).post(`/activity/batches/${res.batch_id}/undo`, {});
              await qc.invalidateQueries({ queryKey: ['account', accountId] });
            },
          },
        });
    },
    // A popup shows its own error (and stays open).
    onError: (e) => {
      if (!asking && !linkedOpen) showToast({ message: errorMessage(e), tone: 'error' });
    },
  });
  const startLinked = async () => {
    if (!linkedAct) return;
    try {
      // The open linked item, or a new one's first values (copied from this item, fixed ones).
      const found = await api(accountId).get<{ item_id: string | null; name: string; cells: RowCells }>(
        `/items/${itemId}/buttons/${column.id}/linked`,
      );
      const asks = linkedAct.popup.fields.length > 0 || !!linkedAct.popup.subitems || linkedAct.popup.note !== 'off';
      if (!asks) {
        // Nothing to ask: an open linked item is shown, else the item is made at once.
        if (found.item_id) openItem(found.item_id);
        else click.mutate(undefined);
        return;
      }
      const cells = found.item_id
        ? ((await api(accountId).get<{ cells: RowCells }>(`/items/${found.item_id}`)).cells ?? {})
        : found.cells;
      setLinkedOpen({ id: found.item_id, name: found.name, cells });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    }
  };
  const run = async () => {
    if (s.confirm) {
      const ok = await confirmDialog({
        title: s.label || column.title,
        message: t('button.confirm'),
        confirmLabel: s.label || column.title,
      });
      if (!ok) return;
    }
    if (s.action.kind === 'popup') setAsking(true);
    else if (s.action.kind === 'create_linked') await startLinked();
    else click.mutate(undefined);
  };
  return (
    <div className={cn(base, 'justify-center px-1.5')}>
      <button
        type="button"
        disabled={!editable || click.isPending}
        onClick={() => void run()}
        data-testid="button-cell"
        className="h-6 max-w-full truncate rounded-[6px] px-2.5 text-xs font-normal shadow-sm transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        style={{ background: s.color, color: readableOn(s.color) }}
        title={editable ? undefined : t('board.readOnly')}
      >
        {s.label || column.title}
      </button>
      {asking && s.action.kind === 'popup' && board ? (
        <PopupDialog
          accountId={accountId}
          board={board}
          itemId={itemId}
          rowCells={rowCells ?? {}}
          popup={s.action.popup}
          title={s.label || column.title}
          onClose={() => setAsking(false)}
          onSubmit={(cells, note, subitems) =>
            click.mutateAsync({ cells, ...(note ? { note } : {}), ...(subitems ? { subitems } : {}) })
          }
        />
      ) : null}
      {linkedOpen && linkedAct && targetBoard ? (
        <PopupDialog
          accountId={accountId}
          board={targetBoard}
          itemId={linkedOpen.id ?? ''}
          rowCells={linkedOpen.cells}
          popup={linkedAct.popup}
          title={
            linkedOpen.id
              ? t('button.linked.titleEdit', { title: `${s.label || column.title} · ${linkedOpen.name}` })
              : `${s.label || column.title} · ${linkedOpen.name}`
          }
          subtitle={
            linkedOpen.id
              ? t('button.linked.subtitleEdit', { board: targetBoard.name })
              : t('button.linked.subtitleNew', { board: targetBoard.name })
          }
          onClose={() => setLinkedOpen(null)}
          onSubmit={(cells, note, subitems) =>
            click.mutateAsync({
              cells,
              ...(note ? { note } : {}),
              ...(subitems ? { subitems } : {}),
              ...(linkedOpen.id ? { target_item_id: linkedOpen.id } : {}),
            })
          }
        />
      ) : null}
    </div>
  );
};

// ---- hour ----
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
export const HourCell = ({ column, value, text, editable, onChange }: CellProps) => {
  const [open, setOpen] = useState(false);
  const v = value as HourValue | null;
  const [typed, setTyped] = useState('');
  const [hour, setHour] = useState<number | null>(null);
  const fmt =
    column.settings.format === '12h' || column.settings.format === '24h'
      ? column.settings.format
      : getRegion().time_format;
  const set = (next: HourValue | null) => {
    setOpen(false);
    if (!same(next, value)) onChange(next);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    const parsed = typed.trim() ? hourFromText(typed) : null;
    if (parsed !== undefined) set(parsed);
  };
  return (
    <div
      className={cn(base, 'justify-center', clickable(editable))}
      onClick={() => {
        if (!editable || open) return;
        setTyped(v ? formatHourValue(v, fmt) : '');
        setHour(v?.hour ?? null);
        setOpen(true);
      }}
    >
      <span dir="ltr" className="tabular-nums">
        {text}
      </span>
      <Popover open={open} onClose={() => setOpen(false)} className="w-56 p-2">
        <input
          autoFocus
          dir="ltr"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={onKey}
          placeholder="09:30"
          data-testid="hour-input"
          aria-label={t('hour.type')}
          className="mb-2 h-8 w-full rounded-[8px] border border-line-strong bg-surface px-2 text-sm tabular-nums focus:border-primary focus:outline-none"
        />
        <div className="flex gap-1" dir="ltr">
          <ul className="grid max-h-48 flex-1 grid-cols-4 gap-0.5 overflow-auto" aria-label={t('time.hours')}>
            {Array.from({ length: 24 }, (_, h) => (
              <li key={h}>
                <button
                  type="button"
                  data-testid="hour-option"
                  data-hour={h}
                  onClick={() => setHour(h)}
                  className={cn(
                    'h-7 w-full rounded-[6px] text-xs tabular-nums hover:bg-surface-2',
                    hour === h && 'bg-primary text-[var(--on-primary)] hover:bg-primary',
                  )}
                >
                  {fmt === '12h' ? `${h % 12 || 12}${h < 12 ? 'a' : 'p'}` : pad(h)}
                </button>
              </li>
            ))}
          </ul>
          <ul className="grid max-h-48 w-14 grid-cols-1 gap-0.5 overflow-auto" aria-label={t('time.minutes')}>
            {MINUTES.map((m) => (
              <li key={m}>
                <button
                  type="button"
                  data-testid="minute-option"
                  data-minute={m}
                  disabled={hour === null}
                  onClick={() => hour !== null && set({ hour, minute: m })}
                  className="h-7 w-full rounded-[6px] text-xs tabular-nums hover:bg-surface-2 disabled:opacity-40"
                >
                  :{pad(m)}
                </button>
              </li>
            ))}
          </ul>
        </div>
        {v ? (
          <button type="button" className="mt-2 text-xs text-muted hover:text-fg" onClick={() => set(null)}>
            {t('cell.clear')}
          </button>
        ) : null}
      </Popover>
    </div>
  );
};

// ---- week ----
export const WeekCell = ({ column, value, editable, onChange }: CellProps) => {
  const [open, setOpen] = useState(false);
  const v = value as { start: string; end: string } | null;
  const region = getRegion();
  const first = typeof column.settings.first_day === 'number' ? column.settings.first_day : region.first_day;
  return (
    <div
      className={cn(base, 'justify-center gap-1.5', clickable(editable))}
      onClick={() => editable && !open && setOpen(true)}
    >
      {v ? (
        <>
          <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-[0.6875rem] font-normal text-fg-2" dir="ltr">
            W{isoWeekNumber(v.start)}
          </span>
          <span className="truncate text-xs tabular-nums" dir="ltr">
            {formatDateRange(v.start, v.end, { year: 'never' }, region)}
          </span>
        </>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)}>
        <Calendar
          mode="range"
          weekStartsOn={first}
          value={{ from: v?.start ?? null, to: v?.end ?? null }}
          onChange={(next) => {
            const clicked = next.to ?? next.from;
            setOpen(false);
            const week = clicked ? weekOf(clicked, first) : null;
            if (!same(week, value)) onChange(week);
          }}
        />
      </Popover>
    </div>
  );
};

// ---- world clock ----
/** "Now" for live clocks: one tick a minute (the cells share nothing; each re-renders itself). */
const useMinute = () => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

export const WorldClockCell = ({ column, value, editable, onChange }: CellProps) => {
  const [open, setOpen] = useState(false);
  const now = useMinute();
  const tz = (value as { timezone?: string } | null)?.timezone;
  const fmt =
    column.settings.format === '12h' || column.settings.format === '24h'
      ? column.settings.format
      : getRegion().time_format;
  const zones = useMemo(() => (open ? timeZones() : []), [open]);
  const at = tz ? zoneNow(tz, now) : null;
  const working = tz ? isWorkingTime(tz, column.settings, now) : false;
  return (
    <div
      className={cn(base, 'justify-center gap-1.5', clickable(editable))}
      onClick={() => editable && !open && setOpen(true)}
      data-working={tz ? String(working) : undefined}
    >
      {tz && at ? (
        <>
          <span
            aria-hidden
            className={cn('size-2 shrink-0 rounded-full', working ? 'bg-[var(--ok)]' : 'bg-[var(--mark-off)]')}
          />
          <span className={cn('tabular-nums', !working && 'text-muted')} dir="ltr">
            {formatHourValue({ hour: at.hour, minute: at.minute }, fmt)}
          </span>
          <span className="truncate text-xs text-fg-2" title={tz}>
            {zoneCity(tz)}
          </span>
        </>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} className="w-72">
        <SearchableList
          items={zones}
          text={(z) => `${z} ${zoneCity(z)}`}
          searchable
          placeholder={t('worldClock.search')}
          testId="world-clock-search"
        >
          {(shown) => (
            <ul className="max-h-64 overflow-auto p-1" data-testid="world-clock-list">
              {shown.slice(0, 200).map((z) => {
                const n = zoneNow(z, now);
                return (
                  <li key={z}>
                    <button
                      type="button"
                      data-testid="world-clock-option"
                      data-zone={z}
                      onClick={() => {
                        setOpen(false);
                        if (z !== tz) onChange({ timezone: z });
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-start text-sm hover:bg-surface-2',
                        z === tz && 'bg-surface-2 font-normal',
                      )}
                    >
                      <span className="flex-1 truncate">{zoneCity(z)}</span>
                      <span className="truncate text-xs text-muted" dir="ltr">
                        {z}
                      </span>
                      <span className="text-xs tabular-nums" dir="ltr">
                        {pad(n.hour)}:{pad(n.minute)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </SearchableList>
        {tz ? (
          <button type="button" className="m-2 text-xs text-muted hover:text-fg" onClick={() => onChange(null)}>
            {t('cell.clear')}
          </button>
        ) : null}
      </Popover>
    </div>
  );
};

// ---- colour ----
/** Our palette's colours (light values), the colour column stores the hex itself. */
const SWATCHES = GROUP_PALETTE.map((k) => GROUP_COLORS[k]);
export const ColorCell = ({ value, text, editable, onChange }: CellProps) => {
  const [open, setOpen] = useState(false);
  const color = (value as { color?: string } | null)?.color;
  const [hex, setHex] = useState('');
  // r17ui: a swatch keeps the palette open (try another, compare); "save" of a typed code and
  // "clear" close it, as do an outside click and Esc.
  const pick = (c: string | null, close = true) => {
    if (close) setOpen(false);
    const next = c ? { color: c } : null;
    if (!same(next, value)) onChange(next);
  };
  return (
    <div
      className={cn(base, 'justify-center gap-1.5', clickable(editable))}
      onClick={() => {
        if (!editable || open) return;
        setHex(color ?? '');
        setOpen(true);
      }}
    >
      {color ? (
        <>
          <span
            aria-hidden
            className="size-4 shrink-0 rounded-[4px] border border-line"
            style={{ background: color }}
          />
          <span className="truncate text-xs tabular-nums" dir="ltr">
            {text}
          </span>
        </>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} className="w-60 p-2.5">
        <div className="grid grid-cols-8 gap-1" data-testid="color-palette">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              title={c}
              data-testid="color-swatch"
              data-color={c}
              onClick={() => pick(c, false)}
              className={cn(
                'size-6 rounded-[5px] border border-black/10 hover:scale-110',
                color === c && 'ring-2 ring-primary ring-offset-1',
              )}
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="mt-2.5 flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-7 shrink-0 rounded-[6px] border border-line"
            style={{ background: colorFromText(hex) ?? 'transparent' }}
          />
          <input
            dir="ltr"
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && colorFromText(hex)) pick(colorFromText(hex)!);
            }}
            placeholder={GROUP_COLORS.forest.toUpperCase()}
            data-testid="color-hex"
            aria-label={t('color.hex')}
            className="h-8 min-w-0 flex-1 rounded-[8px] border border-line-strong bg-surface px-2 text-sm focus:border-primary focus:outline-none"
          />
          <Button size="sm" disabled={!colorFromText(hex)} onClick={() => pick(colorFromText(hex)!)}>
            {t('common.save')}
          </Button>
        </div>
        {color ? (
          <button type="button" className="mt-2 text-xs text-muted hover:text-fg" onClick={() => pick(null)}>
            {t('cell.clear')}
          </button>
        ) : null}
      </Popover>
    </div>
  );
};

// ---- country ----
/** Flag images (MIT, country-flag-icons) — one small file each, loaded when shown; Windows has no emoji flags. */
const FLAGS = import.meta.glob<string>('../../../../node_modules/country-flag-icons/3x2/*.svg', {
  query: '?url',
  import: 'default',
});
const flagUrls = new Map<string, Promise<string | null>>();
const flagUrl = (code: string) => {
  let p = flagUrls.get(code);
  if (!p) {
    const load = Object.entries(FLAGS).find(([path]) => path.endsWith(`/${code}.svg`))?.[1];
    p = load ? load().catch(() => null) : Promise.resolve(null);
    flagUrls.set(code, p);
  }
  return p;
};
export const Flag = ({ code, className }: { code: string; className?: string }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void flagUrl(code).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [code]);
  return url ? (
    <img src={url} alt="" aria-hidden className={cn('h-3.5 w-5 shrink-0 rounded-[2px] object-cover', className)} />
  ) : (
    <span aria-hidden className={cn('h-3.5 w-5 shrink-0 rounded-[2px] bg-surface-2', className)} />
  );
};

export const CountryCell = ({ value, editable, onChange }: CellProps) => {
  const [open, setOpen] = useState(false);
  const code = (value as { code?: string } | null)?.code;
  const lang = getRegion().language;
  const list = useMemo(
    () =>
      open
        ? [...COUNTRY_CODES]
            .map((c) => ({ code: c, name: countryName(c, lang), other: countryName(c, lang === 'he' ? 'en' : 'he') }))
            .sort((a, b) => a.name.localeCompare(b.name, lang))
        : [],
    [open, lang],
  );
  return (
    <div
      className={cn(base, 'gap-1.5', clickable(editable))}
      onClick={() => editable && !open && setOpen(true)}
      data-code={code}
    >
      {code ? (
        <>
          <Flag code={code} />
          <span className="truncate">{countryName(code, lang)}</span>
        </>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} className="w-64">
        <SearchableList
          items={list}
          text={(c) => `${c.name} ${c.other} ${c.code}`}
          searchable
          placeholder={t('country.search')}
          testId="country-search"
        >
          {(shown) => (
            <ul className="max-h-64 overflow-auto p-1">
              {shown.map((c) => (
                <li key={c.code}>
                  <button
                    type="button"
                    data-testid="country-option"
                    data-code={c.code}
                    onClick={() => {
                      setOpen(false);
                      if (c.code !== code) onChange({ code: c.code });
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-start text-sm hover:bg-surface-2',
                      c.code === code && 'bg-surface-2 font-normal',
                    )}
                  >
                    <Flag code={c.code} />
                    <span className="truncate">{c.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SearchableList>
        {code ? (
          <button type="button" className="m-2 text-xs text-muted hover:text-fg" onClick={() => onChange(null)}>
            {t('cell.clear')}
          </button>
        ) : null}
      </Popover>
    </div>
  );
};

// ---- location ----
const MapCanvas = lazy(() => import('../../maps/MapCanvas'));

export const LocationCell = ({ value, text, editable, onChange, accountId }: CellProps) => {
  const [open, setOpen] = useState(false);
  const v = value as LocationValue | null;
  const [draft, setDraft] = useState('');
  const geo = useGeoConfig(accountId).data;
  // Fix: ask only after a pause in typing (300ms) — the providers are shared, free services.
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(draft.trim()), 300);
    return () => clearTimeout(id);
  }, [draft]);
  const suggestions = useQuery({
    queryKey: ['account', accountId, 'geo', 'suggest', q],
    queryFn: () => fetchSuggestions(accountId, q),
    enabled: open && !!geo?.autocomplete && q.length >= 3 && q !== v?.address,
    staleTime: 60_000,
  });
  const choose = useMutation({
    // A Photon suggestion is the place itself (address + coordinates); a Google one is looked up.
    mutationFn: async (s: PlaceSuggestion) =>
      s.lat !== undefined && s.lng !== undefined
        ? { address: s.address ?? s.text, lat: s.lat, lng: s.lng, place_id: s.place_id, country_code: s.country_code }
        : fetchPlace(accountId, s.place_id),
    onSuccess: (p) => {
      setOpen(false);
      onChange({ address: p.address, lat: p.lat, lng: p.lng, place_id: p.place_id, country_code: p.country_code });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const save = () => {
    const address = draft.trim();
    setOpen(false);
    if (!address) {
      if (v) onChange(null);
      return;
    }
    // A changed address loses its old coordinates; the server's queue finds the new ones.
    if (address !== v?.address) onChange({ address: address.slice(0, 500) });
  };
  const hasPoint = v?.lat !== undefined && v.lng !== undefined;
  return (
    <div
      className={cn(base, 'gap-1.5', clickable(editable || hasPoint))}
      onClick={() => {
        if (open || (!editable && !hasPoint)) return;
        setDraft(v?.address ?? '');
        setOpen(true);
      }}
      data-geocoded={v ? (hasPoint ? 'yes' : v.geocode_failed ? 'failed' : 'pending') : undefined}
    >
      {v ? (
        <>
          <Icon name="place" size={14} className={cn('shrink-0', hasPoint ? 'text-primary' : 'text-muted')} />
          <span className="truncate" title={text ?? ''}>
            {text}
          </span>
        </>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} className="w-80 p-2.5">
        {editable ? (
          <>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
              placeholder={t('location.placeholder')}
              data-testid="location-input"
              aria-label={t('location.address')}
              className="h-8 w-full rounded-[8px] border border-line-strong bg-surface px-2 text-sm focus:border-primary focus:outline-none"
            />
            {suggestions.data?.length ? (
              <ul
                className="mt-1 max-h-48 overflow-auto rounded-[8px] border border-line"
                data-testid="location-suggestions"
              >
                {suggestions.data.map((s) => (
                  <li key={s.place_id}>
                    <button
                      type="button"
                      className="w-full px-2 py-1.5 text-start text-sm hover:bg-surface-2"
                      data-testid="location-suggestion"
                      onClick={() => choose.mutate(s)}
                    >
                      {s.text}
                    </button>
                  </li>
                ))}
                {geo?.autocomplete_provider === 'photon' ? (
                  <li
                    className="border-t border-line-soft px-2 py-1 text-[0.6875rem] text-muted"
                    data-testid="location-attribution"
                    dir="ltr"
                  >
                    {t('location.attributionPhoton')}
                  </li>
                ) : null}
              </ul>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={save} data-testid="location-save">
                {t('common.save')}
              </Button>
              {v ? (
                <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => onChange(null)}>
                  {t('cell.clear')}
                </button>
              ) : null}
              <span className="ms-auto text-xs text-muted" data-testid="location-status">
                {v
                  ? hasPoint
                    ? ''
                    : v.geocode_failed
                      ? t('location.notFound')
                      : geo?.geocoding === false
                        ? ''
                        : t('location.pending')
                  : ''}
              </span>
            </div>
          </>
        ) : (
          <p className="text-sm">{v?.address}</p>
        )}
        {hasPoint && geo ? (
          <div className="mt-2 h-40 overflow-hidden rounded-[8px] border border-line">
            <Suspense fallback={null}>
              <MapCanvas
                single
                styleUrl={geo.style_url}
                markers={[{ id: 'here', lat: v.lat!, lng: v.lng!, color: paint('blue'), label: v.address }]}
              />
            </Suspense>
          </div>
        ) : null}
      </Popover>
    </div>
  );
};
