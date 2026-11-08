// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import {
  appNavPlace,
  canHideNavSlot,
  NAV_PRESET_SIDE,
  NAV_PRESET_TOP,
  NAV_SLOTS,
  navPresetOf,
  t,
  type ExtensionAppPage,
  type MessageKey,
  type MyAccount,
  type NavLayout,
  type NavPlace,
  type NavPreset,
  type NavSlot,
} from '@bines/shared';
import { Button, Card, cn, Notice, RadioCard, Segmented, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon, type IconName } from '../../lib/icons';
import { useNavLayout, useSetAccountNav, useSetMyNav } from '../../lib/nav-layout';
import { appPageIcon, appPageKey, appPageName, useAppPages } from '../extensions/app-pages';
import { showToast } from '../../lib/toast';
import { h2 } from '../admin/admin-parts';

/**
 * Prod (canvas "סרגל עליון וניווט", approved): where each of the shell's general places sits on a
 * computer. Administration → מראה וניווט sets the account's default (quick presets, a row per place, a live preview,
 * "apply to everyone"); הפרופיל שלי → מראה lets a member follow it or keep their own (unless it is locked). The board
 * tree and the profile menu always stay in the sidebar.
 */

const LABEL: Record<NavSlot, MessageKey> = {
  account: 'navLayout.slot.account' as MessageKey,
  home: 'nav.home' as MessageKey,
  my_work: 'nav.myWork' as MessageKey,
  inbox: 'nav.inbox' as MessageKey,
  automations: 'nav.automations' as MessageKey,
  flows: 'flows.title' as MessageKey,
  agents: 'nav.agents' as MessageKey,
  search: 'navLayout.slot.search' as MessageKey,
  assistant: 'navLayout.slot.assistant' as MessageKey,
  help: 'navLayout.slot.help' as MessageKey,
  bell: 'navLayout.slot.bell' as MessageKey,
};

/** The same drawings as the shell's links. */
const ICON: Record<NavSlot, ReactNode> = {
  account: <Icon name="building" size={16} />,
  home: <Icon name="home" size={16} />,
  my_work: <Icon name="myWork" size={16} />,
  inbox: <Icon name="inbox" size={16} />,
  automations: <Icon name="bolt" size={16} />,
  flows: <Icon name="flow" size={16} />,
  agents: <Icon name="agent" size={16} />,
  search: <Icon name="search" size={16} />,
  assistant: <Icon name="sparkle" size={16} />,
  help: <Icon name="info" size={16} />,
  bell: <Icon name="bell" size={16} />,
};

const slotLabel = (s: NavSlot) => t(LABEL[s]);

/** One row per place: its name and a sidebar / top bar choice; then the two places that never move. */
const PlacementList = ({
  layout,
  onChange,
  disabled,
  compact,
  apps = [],
  onAppChange,
}: {
  layout: NavLayout;
  onChange: (slot: NavSlot, place: NavPlace) => void;
  disabled?: boolean;
  /** The profile: two columns, short choice names. */
  compact?: boolean;
  /** the extensions' pages, placed like the destinations (`<extension>.<page>`). */
  apps?: ExtensionAppPage[];
  onAppChange?: (key: string, place: NavPlace) => void;
}) => {
  const row = (
    id: string,
    icon: ReactNode,
    label: string,
    value: NavPlace,
    pick: (p: NavPlace) => void,
    canHide: boolean,
  ) => (
    <div key={id} className="flex min-h-10 items-center gap-2.5 border-t border-line-soft px-3.5 py-1 first:border-t-0">
      {icon}
      <span className={cn('min-w-0 flex-1 truncate', value === 'hidden' && 'text-muted')}>{label}</span>
      <Segmented<NavPlace>
        label={label}
        value={value}
        onChange={pick}
        testId={`nav-place-${id}`}
        className="shrink-0 [&>button]:h-7 [&>button]:px-3 [&>button]:text-xs"
        options={[
          {
            value: 'side',
            label: compact ? t('navLayout.sideShort' as MessageKey) : t('navLayout.side' as MessageKey),
            testId: `nav-place-${id}-side`,
            disabled,
          },
          {
            value: 'top',
            label: compact ? t('navLayout.topShort' as MessageKey) : t('navLayout.top' as MessageKey),
            testId: `nav-place-${id}-top`,
            disabled,
          },
          // Not interested in it (automations, flows…): in neither bar; the account's mark always shows.
          ...(canHide
            ? [
                {
                  value: 'hidden' as const,
                  label: t('navLayout.hidden' as MessageKey),
                  testId: `nav-place-${id}-hidden`,
                  disabled,
                },
              ]
            : []),
        ]}
      />
    </div>
  );
  const fixed = (icon: IconName, label: string) => (
    <div className="flex min-h-10 items-center gap-2.5 border-t border-line-soft px-3.5 text-muted first:border-t-0">
      <Icon name={icon} size={16} />
      <span className="min-w-0 flex-1">{label}</span>
      <span className="flex items-center gap-1.5 text-xs">
        <Icon name="lock" size={13} />
        {compact ? t('navLayout.fixedShort' as MessageKey) : t('navLayout.fixed' as MessageKey)}
      </span>
    </div>
  );
  return (
    <div
      data-testid="nav-layout-list"
      className={cn(
        'overflow-hidden rounded-[12px] border border-line',
        compact && 'grid grid-cols-1 sm:grid-cols-2 sm:gap-x-6',
        disabled && 'opacity-60',
      )}
    >
      {NAV_SLOTS.map((s) => row(s, ICON[s], slotLabel(s), layout[s], (p) => onChange(s, p), canHideNavSlot(s)))}
      {onAppChange
        ? apps.map((a) => {
            const key = appPageKey(a);
            return row(
              key,
              <Icon name={appPageIcon(a)} size={16} />,
              appPageName(a),
              appNavPlace(layout, key),
              (p) => onAppChange(key, p),
              true,
            );
          })
        : null}
      {fixed('folder', t('navLayout.fixed.tree' as MessageKey))}
      {fixed('person', t('navLayout.fixed.profile' as MessageKey))}
    </div>
  );
};

/** A small drawing of the shell with the chosen layout: the top bar (when anything is there), the sidebar, the page. */
const Preview = ({ layout }: { layout: NavLayout }) => {
  const top = NAV_SLOTS.filter((s) => s !== 'account' && layout[s] === 'top');
  const side = NAV_SLOTS.filter((s) => s !== 'account' && layout[s] === 'side');
  const accountTop = layout.account === 'top';
  const logo = <span className="size-4 shrink-0 rounded-full bg-accent" />;
  const bar = (w: string) => <span className="h-1.5 rounded-full bg-[var(--shell-line-strong)]" style={{ width: w }} />;
  return (
    <div
      aria-hidden
      data-testid="nav-layout-preview"
      className="flex h-[15.625rem] flex-col overflow-hidden rounded-[10px] bg-shell text-shell-fg"
    >
      {accountTop || top.length ? (
        <div className="flex h-[1.875rem] shrink-0 items-center gap-[0.4375rem] px-2.5" data-testid="nav-preview-top">
          {accountTop ? logo : null}
          {top.map((s) => (
            <span key={s} className="[&_svg]:size-[0.8125rem]">
              {ICON[s]}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[6.5rem] shrink-0 flex-col gap-1.5 p-2">
          {accountTop ? null : logo}
          <div className="flex flex-wrap gap-[0.3125rem]" data-testid="nav-preview-side">
            {side.map((s) => (
              <span key={s} className="[&_svg]:size-[0.8125rem]">
                {ICON[s]}
              </span>
            ))}
          </div>
          {bar('80%')}
          {bar('60%')}
          {bar('70%')}
          {bar('50%')}
          {bar('65%')}
          <span className="flex-1" />
          <span className="size-4 rounded-full bg-[#e8c9a8]" />
        </div>
        <div className="mb-1.5 ms-0 me-1.5 flex flex-1 flex-col gap-[0.4375rem] rounded-[8px] bg-surface p-3">
          <span className="h-2.5 w-[35%] rounded bg-line" />
          <span className="h-[0.4375rem] rounded bg-line" />
          <span className="h-[0.4375rem] rounded bg-line" />
          <span className="h-[0.4375rem] w-[85%] rounded bg-line" />
          <span className="h-[0.4375rem] rounded bg-line" />
          <span className="h-[0.4375rem] w-[70%] rounded bg-line" />
        </div>
      </div>
    </div>
  );
};

const PRESETS: { id: NavPreset; layout: NavLayout | null }[] = [
  { id: 'side', layout: NAV_PRESET_SIDE },
  { id: 'top', layout: NAV_PRESET_TOP },
  { id: 'custom', layout: null },
];

/** Administration → מראה וניווט: the account's default layout and its lock. */
export const AdminNavLayout = ({ account }: { account: MyAccount }) => {
  const nav = useNavLayout(account.id);
  const save = useSetAccountNav(account.id);
  const apps = useAppPages(account.id).data?.data ?? [];
  const stored = { ...NAV_PRESET_SIDE, ...nav.account.placement } as NavLayout;
  const storedKey = JSON.stringify([stored, nav.account.locked]);
  // My edits, made on top of one server answer: a newer answer (after load or a save) resets the form.
  const [edit, setEdit] = useState<{ base: string; layout: NavLayout; locked: boolean } | null>(null);
  const live = edit?.base === storedKey ? edit : null;
  const draft = live?.layout ?? stored;
  const locked = live?.locked ?? nav.account.locked;
  const setDraft = (next: NavLayout | ((d: NavLayout) => NavLayout)) =>
    setEdit({ base: storedKey, layout: typeof next === 'function' ? next(draft) : next, locked });
  const setLocked = (on: boolean) => setEdit({ base: storedKey, layout: draft, locked: on });
  const preset = navPresetOf(draft);
  const dirty = JSON.stringify([draft, locked]) !== storedKey;

  return (
    <div className="space-y-5" data-testid="admin-appearance">
      <div className="space-y-1">
        <h2 className={h2}>{t('navLayout.adminTitle' as MessageKey)}</h2>
        <p className="text-sm text-muted">{t('navLayout.adminHint' as MessageKey)}</p>
        <p className="text-xs text-muted">{t('navLayout.desktopOnly' as MessageKey)}</p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="min-w-0 space-y-4">
          <section aria-label={t('navLayout.presets' as MessageKey)} className="space-y-2">
            <p className="text-xs text-muted">{t('navLayout.presets' as MessageKey)}</p>
            <div className="grid gap-2.5 sm:grid-cols-3">
              {PRESETS.map((p) => (
                <RadioCard
                  key={p.id}
                  name="nav-preset"
                  checked={preset === p.id}
                  onSelect={() => {
                    // A preset places the destinations; the extensions' pages keep their places.
                    if (p.layout) setDraft({ ...p.layout, ...(draft.apps ? { apps: draft.apps } : {}) });
                  }}
                  title={t(`navLayout.preset.${p.id}` as MessageKey)}
                  hint={t(`navLayout.preset.${p.id}.hint` as MessageKey)}
                  testId={`nav-preset-${p.id}`}
                />
              ))}
            </div>
          </section>
          <section aria-label={t('navLayout.items' as MessageKey)} className="space-y-2">
            <p className="text-xs text-muted">{t('navLayout.items' as MessageKey)}</p>
            <PlacementList
              layout={draft}
              onChange={(s, p) => setDraft((d) => ({ ...d, [s]: p }))}
              apps={apps}
              onAppChange={(k, p) => setDraft((d) => ({ ...d, apps: { ...d.apps, [k]: p } }))}
            />
          </section>
        </div>
        <div className="min-w-0 space-y-3.5">
          <Card className="space-y-2">
            <p className="text-xs text-muted">{t('navLayout.preview' as MessageKey)}</p>
            <Preview layout={draft} />
          </Card>
          <Card>
            <label className="flex items-start gap-3">
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-sm text-heading">{t('navLayout.lock' as MessageKey)}</span>
                <span className="block text-xs text-muted">{t('navLayout.lock.hint' as MessageKey)}</span>
              </span>
              <Switch checked={locked} onChange={setLocked} testId="nav-lock" />
            </label>
          </Card>
          <div className="flex gap-2">
            <Button
              busy={save.isPending}
              disabled={!dirty}
              data-testid="nav-save"
              onClick={() =>
                save.mutate(
                  { placement: draft, locked },
                  {
                    onSuccess: () => showToast({ message: t('navLayout.saved' as MessageKey) }),
                    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
                  },
                )
              }
            >
              {t('common.save')}
            </Button>
            <Button variant="secondary" disabled={!dirty} onClick={() => setEdit(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

/** הפרופיל שלי → מראה: follow the account's layout, or keep my own (saved on every change). */
export const ProfileNavLayout = ({ account }: { account: MyAccount }) => {
  const nav = useNavLayout(account.id);
  const save = useSetMyNav(account.id);
  const apps = useAppPages(account.id).data?.data ?? [];
  const locked = nav.account.locked;
  const mine = !locked && nav.mine !== null;
  const put = (placement: NavLayout | null) =>
    save.mutate({ placement }, { onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }) });
  const accountPreset = navPresetOf({ ...NAV_PRESET_SIDE, ...nav.account.placement } as NavLayout);

  return (
    <div className="space-y-3" data-testid="profile-nav-layout">
      <p className="text-sm text-muted">{t('navLayout.profileHint' as MessageKey)}</p>
      {locked ? (
        <Notice tone="warn">
          <span data-testid="nav-locked">{t('navLayout.locked' as MessageKey)}</span>
        </Notice>
      ) : null}
      <div className="grid gap-2.5 sm:grid-cols-2">
        <RadioCard
          name="nav-mode"
          checked={!mine}
          disabled={locked}
          onSelect={() => {
            if (nav.mine !== null) put(null);
          }}
          title={t('navLayout.mode.account' as MessageKey)}
          hint={t('navLayout.mode.account.hint' as MessageKey, {
            preset: t(`navLayout.preset.${accountPreset}` as MessageKey),
          })}
          testId="nav-mode-account"
        />
        <RadioCard
          name="nav-mode"
          checked={mine}
          disabled={locked}
          onSelect={() => {
            if (!mine) put({ ...nav.layout });
          }}
          title={t('navLayout.mode.mine' as MessageKey)}
          hint={t('navLayout.mode.mine.hint' as MessageKey)}
          testId="nav-mode-mine"
        />
      </div>
      <PlacementList
        compact
        layout={nav.layout}
        disabled={!mine}
        onChange={(s, p) => put({ ...nav.layout, [s]: p })}
        apps={apps}
        onAppChange={(k, p) => put({ ...nav.layout, apps: { ...nav.layout.apps, [k]: p } })}
      />
      <p className="text-xs text-muted">{t('navLayout.desktopOnly' as MessageKey)}</p>
    </div>
  );
};
