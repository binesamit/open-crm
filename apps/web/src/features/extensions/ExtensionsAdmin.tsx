// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  getLocale,
  t,
  type ExtensionCatalogEntry,
  type ExtensionInstallation,
  type ExtensionSource,
  type MyAccount,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, EmptyState, Input, Notice, Segmented, SkeletonRows, Switch, Tabs } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDelete, confirmDialog } from '../../lib/dialogs';
import { copyText } from '../../lib/entity-menu';
import { Icon, type IconName } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { GatedButton, PlanGateNote, usePlanGate } from '../../lib/plan-gate';
import type { PlanGate } from '../../lib/plan-limit';
import { Panel, SectionHeader } from '../admin/admin-parts';
import { ConsentDialog, type ConsentSubject, fromPreview, isWriteScope, scopeLabel } from './ConsentDialog';
import {
  previewExtension,
  revealExtensionSecret,
  rotateExtensionSecret,
  useExtensionFeatures,
  useExtensionMutations,
  useExtensions,
} from './extensions-api';
import { ExtensionSettingsPage } from './ExtensionSlots';
import { ExportPackDialog } from './ExportPackDialog';
import { InstallationExtras } from './InstallationExtras';
import { ScopeDialog, scopeSummary, type scopeToGrant } from './ScopePicker';

const fromPending = (i: ExtensionInstallation): ConsentSubject => ({
  name: i.name,
  version: i.pending_update!.version,
  icon: i.icon,
  publisher: i.publisher.name,
  kind: i.kind,
  scopes: i.pending_update!.requested_scopes.map((s) => ({ scope: s, write: isWriteScope(s) })),
  added: i.pending_update!.added_scopes,
  frameOrigins: i.frame_origins,
  features: i.features.map((f) => ({ key: f.key, type: f.type, name: f.name })),
  data: i.data,
  warnings: [],
  initial: { board_ids: i.board_ids, workspace_ids: i.workspace_ids, allow_guests: i.allow_guests },
});

type StoreTab = 'store' | 'installed' | 'updates' | 'dev';
const STORE_TABS: StoreTab[] = ['store', 'installed', 'updates', 'dev'];
/** The open tab survives a reload of this browser tab (an admin back from an extension's settings page). */
const TAB_KEY = 'bines:ext-admin-tab';
const storedTab = (): StoreTab => {
  try {
    const v = sessionStorage.getItem(TAB_KEY) as StoreTab | null;
    return v && STORE_TABS.includes(v) ? v : 'store';
  } catch {
    return 'store';
  }
};

/** An installed extension with something to review: a waiting version, or a newer one in the catalogue. */
const hasUpdate = (i: ExtensionInstallation, catalog: ExtensionCatalogEntry[]) =>
  !!i.pending_update ||
  (i.source === 'catalog' && catalog.some((c) => c.key === i.key && c.version !== i.version && !c.killed));

const localized = (he: string, en: string | null | undefined) => (getLocale() === 'en' && en ? en : he);

/**
 * Administration → תוספות (D27, MARKETPLACE §4.4) — round 13: a store. "חנות" = cards of the platform catalogue (ת7:
 * name, description, icon, publisher, what it adds and asks for) — "התקנה" opens the same consent screen as before;
 * "מותקנות" = the installed extensions (on / off, permissions, boards, guests, versions, uninstall); "עדכונים" = the
 * ones with a version waiting for consent or a newer catalogue version; "למפתחים" = install by manifest URL or a
 * pasted manifest (each through the consent screen) and the development notes. "Save as pack" (+ copy to another
 * account) stays in the header. Admins only (the route and the server).
 */
export const ExtensionsAdmin = ({ account }: { account: MyAccount }) => {
  const list = useExtensions(account.id);
  const m = useExtensionMutations(account.id);
  // Plan feature gate: installing and approving updates need `extensions`; installed ones keep running.
  const extGate = usePlanGate(account.id, 'extensions');
  const [tab, setTabState] = useState<StoreTab>(storedTab);
  const setTab = (next: StoreTab) => {
    setTabState(next);
    try {
      sessionStorage.setItem(TAB_KEY, next);
    } catch {
      // not remembered — still switches
    }
  };
  const [mode, setMode] = useState<'url' | 'json'>('url');
  const [url, setUrl] = useState('');
  const [json, setJson] = useState('');
  const [checking, setChecking] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [consent, setConsent] = useState<
    | { kind: 'install'; source: ExtensionSource; subject: ConsentSubject; digest: string }
    | { kind: 'update'; installation: ExtensionInstallation }
    | null
  >(null);

  const openPreview = async (source: ExtensionSource, busyKey = 'dev') => {
    setChecking(busyKey);
    setAddError(null);
    try {
      const p = await previewExtension(account.id, source);
      if (p.existing) {
        const msg = t('ext.admin.alreadyInstalled', { version: p.existing.version });
        if (busyKey === 'dev') setAddError(msg);
        else showToast({ message: msg });
      } else setConsent({ kind: 'install', source, subject: fromPreview(p), digest: p.digest });
    } catch (err) {
      if (busyKey === 'dev') setAddError(errorMessage(err));
      else showToast({ message: errorMessage(err) });
    } finally {
      setChecking(null);
    }
  };

  const check = () => {
    if (mode === 'url') return openPreview({ manifest_url: url.trim() });
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setAddError(t('ext.admin.notJson'));
      return;
    }
    return openPreview({ manifest: parsed as Record<string, unknown> });
  };

  const installed = list.data?.installed ?? [];
  const catalog = list.data?.catalog ?? [];
  const updates = installed.filter((i) => hasUpdate(i, catalog));

  const installedRow = (i: ExtensionInstallation) => (
    <InstalledRow
      key={i.id}
      accountId={account.id}
      inst={i}
      busy={m.update.isPending || m.uninstall.isPending || m.checkUpdate.isPending}
      onToggle={(on) => m.update.mutate({ id: i.id, status: on ? 'enabled' : 'disabled' })}
      onGuests={(on) => m.update.mutate({ id: i.id, allow_guests: on })}
      onScope={(grant) => m.update.mutateAsync({ id: i.id, ...grant })}
      onRevoke={(scope) => m.update.mutate({ id: i.id, scopes: i.granted_scopes.filter((s) => s !== scope) })}
      onCheck={async () => {
        try {
          const r = await m.checkUpdate.mutateAsync(i.id);
          showToast({ message: t(`ext.admin.update.${r.status}`) });
        } catch (err) {
          showToast({ message: errorMessage(err) });
        }
      }}
      gate={extGate}
      onApprove={() => setConsent({ kind: 'update', installation: i })}
      onUninstall={async () => {
        if (!(await confirmDelete(i.name))) return;
        await m.uninstall.mutateAsync(i.id);
        showToast({ message: t('ext.admin.uninstalled', { name: i.name }) });
      }}
      extras={<InstalledExtras accountId={account.id} accountSlug={account.slug} inst={i} />}
    />
  );

  return (
    <div className="space-y-4" data-testid="ext-admin" data-tab={tab}>
      <SectionHeader
        title={t('ext.admin.title')}
        subtitle={t('r13.store.subtitle')}
        actions={
          <Button variant="secondary" onClick={() => setExporting(true)} data-testid="ext-export-open">
            {t('ext.export.title')}
          </Button>
        }
      />
      <PlanGateNote gate={extGate} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'store', label: t('r13.store.tab.store'), testId: 'ext-tab-store' },
          {
            value: 'installed',
            label: (
              <>
                {t('r13.store.tab.installed')}
                {installed.length ? <Badge tone="neutral">{installed.length}</Badge> : null}
              </>
            ),
            testId: 'ext-tab-installed',
          },
          {
            value: 'updates',
            label: (
              <>
                {t('r13.store.tab.updates')}
                {updates.length ? <Badge tone="warn">{updates.length}</Badge> : null}
              </>
            ),
            testId: 'ext-tab-updates',
          },
          { value: 'dev', label: t('r13.store.tab.dev'), testId: 'ext-tab-dev' },
        ]}
      />

      {tab === 'store' ? (
        list.isLoading ? (
          <SkeletonRows rows={3} label={t('app.loading')} />
        ) : !catalog.length ? (
          <EmptyState icon={<Icon name="ext" size={28} />} title={t('r13.store.empty')}>
            {t('r13.store.emptyHint')}
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="ext-store">
            {catalog.map((c) => (
              <StoreCard
                key={c.key}
                entry={c}
                busy={checking === c.key}
                gate={extGate}
                update={installed.some((i) => i.key === c.key && hasUpdate(i, catalog))}
                onInstall={() => void openPreview({ catalog_key: c.key }, c.key)}
                onManage={() =>
                  setTab(installed.some((i) => i.key === c.key && hasUpdate(i, catalog)) ? 'updates' : 'installed')
                }
              />
            ))}
          </ul>
        )
      ) : tab === 'installed' || tab === 'updates' ? (
        <Panel
          title={tab === 'installed' ? t('ext.admin.installedTitle') : t('r13.store.updatesTitle')}
          testId={tab === 'installed' ? 'ext-installed' : 'ext-updates'}
        >
          {list.isLoading ? (
            <SkeletonRows rows={3} label={t('app.loading')} />
          ) : !(tab === 'installed' ? installed : updates).length ? (
            <EmptyState
              icon={<Icon name="ext" size={28} />}
              title={tab === 'installed' ? t('ext.admin.none') : t('r13.store.noUpdates')}
            >
              {tab === 'installed' ? t('ext.admin.noneHint') : t('r13.store.noUpdatesHint')}
            </EmptyState>
          ) : (
            <ul>{(tab === 'installed' ? installed : updates).map(installedRow)}</ul>
          )}
        </Panel>
      ) : (
        <div className="space-y-4" data-testid="ext-dev-area">
          <Notice tone="info">{t('ext.admin.security')}</Notice>
          <Panel title={t('ext.admin.add')} hint={t('r13.store.devHint')} testId="ext-add">
            <div className="space-y-3 px-3.5 py-3">
              <Segmented
                label={t('ext.admin.add')}
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'url', label: t('ext.admin.byUrl'), testId: 'ext-mode-url' },
                  { value: 'json', label: t('ext.admin.byJson'), testId: 'ext-mode-json' },
                ]}
              />
              {mode === 'url' ? (
                <Input
                  dir="ltr"
                  value={url}
                  placeholder="https://…/manifest.json"
                  onChange={(e) => setUrl(e.target.value)}
                  data-testid="ext-url-input"
                />
              ) : (
                <textarea
                  dir="ltr"
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  rows={8}
                  data-testid="ext-json-input"
                  className="w-full rounded-[10px] border border-line-strong bg-surface p-2.5 font-mono text-xs text-fg focus:border-primary focus:outline-none"
                />
              )}
              <div className="flex items-center gap-2">
                <GatedButton
                  gate={extGate}
                  upgrade={false}
                  busy={checking === 'dev'}
                  disabled={mode === 'url' ? !url.trim() : !json.trim()}
                  onClick={() => void check()}
                  data-testid="ext-check"
                >
                  {t('ext.admin.check')}
                </GatedButton>
              </div>
              {addError ? (
                <div data-testid="ext-add-error">
                  <Notice tone="error">{addError}</Notice>
                </div>
              ) : null}
            </div>
          </Panel>
          <Panel title={t('r13.store.devToolsTitle')} testId="ext-dev-tools">
            {/* s37market: the guide inside the app — table of contents, search, copy buttons. */}
            <div className="flex flex-wrap gap-2 px-4 pt-3" data-testid="ext-dev-in-app">
              {(
                [
                  ['guide', 's37market.devTool.readGuide', 'ext-dev-open-guide'],
                  ['quickstart', 's37market.devTool.readQuickstart', 'ext-dev-open-quickstart'],
                ] as const
              ).map(([doc, key, testId]) => (
                <Link
                  key={doc}
                  to="/a/$accountSlug/admin/extensions/docs/$doc"
                  params={{ accountSlug: account.slug, doc }}
                  data-testid={testId}
                  className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-primary px-2.5 text-[0.8125rem] font-semibold whitespace-nowrap text-on-primary hover:opacity-90"
                >
                  <Icon name="file" size={14} />
                  {t(key)}
                </Link>
              ))}
            </div>
            {/* s37docs: the guide is served by this deployment (/api/docs/extensions) — same origin, any domain. */}
            <p className="px-4 pt-3 text-xs text-muted">{t('s37market.devTool.publicHint')}</p>
            <div className="flex flex-wrap gap-2 px-4 pt-1.5" data-testid="ext-dev-docs">
              {(
                [
                  ['/api/docs/extensions', 's37docs.devTool.guide', 'ext-dev-guide'],
                  ['/api/docs/extensions/quickstart', 's37docs.devTool.quickstart', 'ext-dev-quickstart'],
                ] as const
              ).map(([href, key, testId]) => (
                <a
                  key={href}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={testId}
                  className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] whitespace-nowrap text-heading hover:bg-surface-2"
                >
                  {t(key)}
                  <Icon name="ext" size={14} />
                </a>
              ))}
            </div>
            <ul className="list-disc space-y-1.5 px-8 py-3 text-sm text-fg-2">
              <li>{t('s37docs.devTool.cli')}</li>
              <li>{t('s37docs.devTool.sdk')}</li>
              <li>{t('r13.store.devTool.local')}</li>
              <li>{t('r13.store.devTool.pack')}</li>
            </ul>
          </Panel>
        </div>
      )}

      {exporting ? <ExportPackDialog accountId={account.id} onClose={() => setExporting(false)} /> : null}
      {consent?.kind === 'install' ? (
        <ConsentDialog
          accountId={account.id}
          subject={consent.subject}
          confirmLabel={t('ext.consent.install')}
          onClose={() => setConsent(null)}
          onConfirm={async (c) => {
            // EXT-RT3: install exactly the manifest the admin was shown.
            await m.install.mutateAsync({ source: consent.source, consent: c, manifest_digest: consent.digest });
            setUrl('');
            setJson('');
            setTab('installed');
            showToast({ message: t('ext.admin.installedToast', { name: consent.subject.name }) });
          }}
        />
      ) : consent?.kind === 'update' ? (
        <ConsentDialog
          accountId={account.id}
          subject={fromPending(consent.installation)}
          confirmLabel={t('ext.consent.approveUpdate')}
          onClose={() => setConsent(null)}
          onConfirm={(c) =>
            m.approveUpdate.mutateAsync({
              id: consent.installation.id,
              consent: c,
              version: consent.installation.pending_update?.version,
            })
          }
        />
      ) : null}
    </div>
  );
};

const FEATURE_ICON: Record<string, IconName> = {
  board_view: 'table',
  item_view: 'cards',
  board_menu_action: 'menu',
  batch_action: 'check',
  dashboard_widget: 'chart',
  account_settings_page: 'gear',
  user_settings_page: 'person',
  panel: 'cards',
  app_page: 'ext',
  automation_action: 'bolt',
  automation_trigger: 'bolt',
};

/** One catalogue entry as a store card: what it is, who publishes it, what it adds and asks for, install. */
const StoreCard = ({
  entry: c,
  busy,
  gate,
  update,
  onInstall,
  onManage,
}: {
  entry: ExtensionCatalogEntry;
  busy: boolean;
  gate: PlanGate;
  update: boolean;
  onInstall: () => void;
  onManage: () => void;
}) => {
  const writes = (c.permissions ?? []).some(isWriteScope);
  const description = localized(c.description ?? '', c.description_en);
  return (
    <li
      className="flex min-w-0 flex-col gap-3 rounded-[var(--radius)] border border-line bg-surface p-4"
      data-testid={`ext-catalog-${c.key}`}
      data-installed={c.installed || undefined}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-12 shrink-0 place-items-center rounded-[14px] bg-surface-2 text-2xl leading-none"
        >
          {c.icon ?? '🧩'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-base leading-snug font-bold break-words text-heading">
            {localized(c.name, c.name_en)}
          </span>
          <span className="block text-xs text-muted">
            {t('ext.admin.by', { publisher: c.publisher?.name ?? '—' })}
            <span dir="ltr"> · v{c.version}</span>
          </span>
        </span>
      </div>
      {description ? <p className="line-clamp-4 text-sm break-words text-fg-2">{description}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={c.kind === 'code' ? 'violet' : 'info'}>{t(`ext.kind.${c.kind}`)}</Badge>
        {c.kind === 'code' ? (
          <Badge tone={writes ? 'warn' : 'ok'}>{t(writes ? 'r13.store.canWrite' : 'r13.store.readOnly')}</Badge>
        ) : null}
        {(c.feature_types ?? []).map((f) => (
          <span
            key={f}
            className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 px-2 text-xs text-fg-2"
            data-testid="ext-card-feature"
          >
            <Icon name={FEATURE_ICON[f] ?? 'ext'} size={12} />
            {tDynamic(`r13.store.feature.${f}`)}
          </span>
        ))}
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {c.killed ? (
          <Badge tone="danger">{t('ext.admin.killed')}</Badge>
        ) : c.installed ? (
          <>
            <Badge tone="ok">{t('ext.admin.installed')}</Badge>
            {update ? <Badge tone="warn">{t('r13.store.updateAvailable')}</Badge> : null}
            <Button size="sm" variant="ghost" onClick={onManage} data-testid={`ext-manage-${c.key}`}>
              {t('r13.store.manage')}
            </Button>
          </>
        ) : (
          <GatedButton
            gate={gate}
            upgrade={false}
            size="sm"
            variant="accent"
            busy={busy}
            onClick={onInstall}
            data-testid={`ext-install-${c.key}`}
          >
            {t('ext.admin.install')}
          </GatedButton>
        )}
      </div>
    </li>
  );
};

/** Where it works ("the whole account" / "2 workspaces · 3 boards") and a button to change it. */
const ScopeLine = ({
  accountId,
  inst: i,
  onSave,
}: {
  accountId: string;
  inst: ExtensionInstallation;
  onSave: (grant: ReturnType<typeof scopeToGrant>) => Promise<unknown>;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="ms-2 inline-flex items-center gap-1">
      <span className="text-muted" data-testid={`ext-scope-summary-${i.key}`}>
        {scopeSummary(i)}
      </span>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid={`ext-scope-edit-${i.key}`}>
        {t('ext.admin.editScope')}
      </Button>
      {open ? (
        <ScopeDialog accountId={accountId} name={i.name} initial={i} onClose={() => setOpen(false)} onSave={onSave} />
      ) : null}
    </span>
  );
};

const InstalledRow = ({
  accountId,
  inst: i,
  busy,
  onToggle,
  onGuests,
  onScope,
  onRevoke,
  onCheck,
  gate,
  onApprove,
  onUninstall,
  extras,
}: {
  accountId: string;
  inst: ExtensionInstallation;
  busy: boolean;
  gate: PlanGate;
  onToggle: (on: boolean) => void;
  onGuests: (on: boolean) => void;
  onScope: (grant: ReturnType<typeof scopeToGrant>) => Promise<unknown>;
  onRevoke: (scope: string) => void;
  onCheck: () => Promise<void>;
  onApprove: () => void;
  onUninstall: () => Promise<void>;
  extras?: ReactNode;
}) => (
  <li
    className="space-y-2 border-b border-line-soft px-3.5 py-3 last:border-b-0"
    data-testid={`ext-installed-${i.key}`}
  >
    <div className="flex flex-wrap items-center gap-3">
      <span aria-hidden className="text-xl">
        {i.icon ?? '🧩'}
      </span>
      <span className="min-w-0 flex-1 basis-60">
        <span className="font-semibold text-fg">{i.name}</span>{' '}
        <span className="text-xs text-muted" dir="ltr">
          v{i.version}
        </span>
        <span className="block text-xs text-muted">{t('ext.admin.by', { publisher: i.publisher.name })}</span>
      </span>
      <Badge tone={i.kind === 'code' ? 'violet' : 'info'}>{t(`ext.kind.${i.kind}`)}</Badge>
      {i.killed ? <Badge tone="danger">{t('ext.admin.killed')}</Badge> : null}
      <Switch
        checked={i.status === 'enabled'}
        label={t('ext.admin.enabled')}
        disabled={busy}
        onChange={onToggle}
        testId={`ext-status-${i.key}`}
      />
    </div>
    {i.pending_update ? (
      <div className="flex flex-wrap items-center gap-2" data-testid={`ext-pending-${i.key}`}>
        <Notice tone="warn">
          {t('ext.admin.pending', {
            version: i.pending_update.version,
            scopes: i.pending_update.added_scopes.map(scopeLabel).join(', ') || '—',
          })}
        </Notice>
        <GatedButton
          gate={gate}
          upgrade={false}
          size="sm"
          variant="accent"
          onClick={onApprove}
          data-testid={`ext-approve-${i.key}`}
        >
          {t('ext.admin.review')}
        </GatedButton>
      </div>
    ) : null}
    {i.kind === 'code' ? (
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted">{t('ext.admin.permissions')}</span>
        {i.granted_scopes.length ? (
          i.granted_scopes.map((s) => (
            <button
              type="button"
              key={s}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 px-2"
              title={t('ext.admin.revoke')}
              onClick={() => onRevoke(s)}
              data-testid={`ext-granted-${i.key}-${s}`}
            >
              {scopeLabel(s)} ×
            </button>
          ))
        ) : (
          <span>{t('ext.admin.noPermissions')}</span>
        )}
        <ScopeLine accountId={accountId} inst={i} onSave={onScope} />
        <label className="ms-2 inline-flex items-center gap-1.5">
          <span className="text-muted">{t('ext.consent.guests')}</span>
          <Switch checked={i.allow_guests} disabled={busy} onChange={onGuests} />
        </label>
      </div>
    ) : null}
    {/* ת6: its own server, automatic updates, version lock and history, development mode. */}
    <InstallationExtras accountId={accountId} inst={i} />
    <div className="flex flex-wrap items-center gap-2">
      {i.source !== 'manifest' ? (
        <Button size="sm" variant="ghost" onClick={() => void onCheck()} data-testid={`ext-check-update-${i.key}`}>
          {t('ext.admin.checkUpdate')}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="danger-outline"
        onClick={() => void onUninstall()}
        data-testid={`ext-uninstall-${i.key}`}
      >
        {t('ext.admin.uninstall')}
      </Button>
    </div>
    {extras}
  </li>
);

/**
 * ת4/ת5 under an installed extension: its settings page (its own page in a frame, admins only — its token reads no
 * board) and, when it has automation blocks, the signing secret its server needs (shown on request, rotatable).
 */
const InstalledExtras = ({
  accountId,
  accountSlug,
  inst,
}: {
  accountId: string;
  accountSlug: string;
  inst: ExtensionInstallation;
}) => {
  const enabled = inst.status === 'enabled' && !inst.killed;
  const settings = useExtensionFeatures(accountId, undefined, enabled).data?.data.find(
    (f) => f.type === 'account_settings_page' && f.installation_id === inst.id,
  );
  const hasBlocks = inst.features.some((f) => f.type === 'automation_action' || f.type === 'automation_trigger');
  // A panel is opened from outside the app, e.g. a browser extension's side panel: its address.
  const panelUrl =
    enabled && inst.features.some((f) => f.type === 'panel')
      ? `${window.location.origin}/a/${encodeURIComponent(accountSlug)}/x/${inst.id}/panel`
      : null;
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!settings && !hasBlocks && !panelUrl) return null;
  const run = async (fn: () => Promise<{ secret: string }>) => {
    setError(null);
    try {
      setSecret((await fn()).secret);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <div className="space-y-2" data-testid={`ext-extras-${inst.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        {settings && enabled ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOpen((o) => !o)}
            data-testid={`ext-settings-open-${inst.key}`}
          >
            <Icon name="gear" size={14} />
            {t('ext.admin.settingsPage')}
          </Button>
        ) : null}
        {hasBlocks ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void run(() => revealExtensionSecret(accountId, inst.id))}
              data-testid={`ext-secret-show-${inst.key}`}
            >
              <Icon name="key" size={14} />
              {t('ext.admin.secret.show')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void confirmDialog({
                  title: t('ext.admin.secret.rotate'),
                  message: t('ext.admin.secret.rotateWarn'),
                  danger: true,
                }).then((ok) => {
                  if (ok) void run(() => rotateExtensionSecret(accountId, inst.id));
                })
              }
              data-testid={`ext-secret-rotate-${inst.key}`}
            >
              {t('ext.admin.secret.rotate')}
            </Button>
          </>
        ) : null}
      </div>
      {secret ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">{t('ext.admin.secret.label')}</span>
          <code
            dir="ltr"
            className="rounded bg-surface-2 px-2 py-1 font-mono break-all"
            data-testid={`ext-secret-${inst.key}`}
          >
            {secret}
          </code>
          <button type="button" className="underline" onClick={() => copyText(secret)}>
            {t('tokens.copy')}
          </button>
          <span className="basis-full text-muted">{t('ext.admin.secret.hint')}</span>
        </div>
      ) : null}
      {panelUrl ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">{t('ext.admin.panelUrl')}</span>
          <code
            dir="ltr"
            className="rounded bg-surface-2 px-2 py-1 font-mono break-all"
            data-testid={`ext-panel-url-${inst.key}`}
          >
            {panelUrl}
          </code>
          <button type="button" className="underline" onClick={() => copyText(panelUrl)}>
            {t('tokens.copy')}
          </button>
          <span className="basis-full text-muted">{t('ext.admin.panelUrlHint')}</span>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {open && settings ? <ExtensionSettingsPage accountId={accountId} feature={settings} /> : null}
    </div>
  );
};
