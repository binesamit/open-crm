// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getLocale,
  KIT_ILLUSTRATIONS,
  type KitGallery,
  type PlatformAccount,
  type StarterKitDetail,
  type StarterKitOption,
  t,
  tDynamic,
  slugFromName,
} from '@bines/shared';
import { Badge, Button, Dialog, EmptyState, Field, Input, Notice, Picker, SkeletonRows, Switch } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';

/**
 * Owner console → Starter kits (M11 stage 3, product decision): the kits a new account can open with, as data —
 * saved from boards of an account the owner administers, edited (first workspace's name, folders, which board in
 * which folder, the default kit), previewed, versioned (restore any earlier version) and removed. No code, no file.
 */
const KITS = ['platform', 'starter-kits'] as const;
const kitKey = (key: string) => ['platform', 'starter-kits', key] as const;
const enc = encodeURIComponent;

export const useKits = () =>
  useQuery({
    queryKey: KITS,
    queryFn: () => api().get<{ data: StarterKitOption[] }>('/platform/starter-kits'),
  });

const useKit = (key: string | null) =>
  useQuery({
    queryKey: kitKey(key ?? ''),
    queryFn: () => api().get<StarterKitDetail>(`/platform/starter-kits/${enc(key!)}`),
    enabled: !!key,
  });

export const kitName = (k: { name: string; name_en: string | null }) => (getLocale() === 'en' && k.name_en) || k.name;

/** The kit picker of "new account": none, or a kit — with what it makes, so the owner sees it before choosing. */
export const KitPicker = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  const kits = useKits().data?.data ?? [];
  const chosen = kits.find((k) => k.key === value);
  const preview = useKit(chosen ? chosen.key : null);
  return (
    <div className="flex flex-col gap-1.5">
      <Picker
        label={t('owner.accounts.templateSet')}
        value={value}
        testId="owner-kit-picker"
        onChange={onChange}
        options={[
          { value: 'empty', label: t('owner.accounts.templateSet.empty') },
          ...kits.map((k) => ({
            value: k.key,
            label: `${k.icon ? `${k.icon} ` : ''}${kitName(k)}${k.default ? ` · ${t('owner.kits.default')}` : ''}`,
            testId: `starter-kit-${k.key}`,
          })),
        ]}
      />
      {preview.data ? <KitPreview kit={preview.data} compact /> : null}
    </div>
  );
};

/** What a new account opens with: the workspace, its folders and the boards in each. */
const KitPreview = ({ kit, compact }: { kit: StarterKitDetail; compact?: boolean }) => {
  const root = kit.boards.filter((b) => !b.folder || !kit.folders.includes(b.folder));
  return (
    <div className="space-y-1 rounded-[10px] bg-surface-2 p-2.5 text-xs text-fg-2" data-testid="owner-kit-preview">
      {kit.description ? <p className="text-muted">{kit.description}</p> : null}
      <p className="font-semibold text-heading">🗂 {kit.workspace_name ?? t('owner.kits.workspaceIsAccount')}</p>
      <ul className="space-y-0.5 ps-3">
        {kit.folders.map((f) => {
          const inside = kit.boards.filter((b) => b.folder === f);
          return (
            <li key={f}>
              📁 {f}
              {!compact && inside.length ? (
                <span className="text-muted"> — {inside.map((b) => b.name ?? b.template).join(', ')}</span>
              ) : (
                <span className="text-muted"> ({inside.length})</span>
              )}
            </li>
          );
        })}
        {root.length ? (
          <li>
            {compact
              ? t('owner.kits.rootBoards', { n: root.length })
              : root.map((b) => `📋 ${b.name ?? b.template}`).join(' · ')}
          </li>
        ) : null}
      </ul>
      <p className="text-muted">
        {t('owner.kits.counts', {
          boards: kit.boards.length,
          recipes: kit.automation_recipes,
          version: kit.version,
        })}
      </p>
      {kit.dashboards?.length || kit.docs?.length ? (
        <p className="text-muted" data-testid="owner-kit-preview-extra">
          {[...(kit.dashboards ?? []), ...(kit.docs ?? [])].join(' · ')}
        </p>
      ) : null}
    </div>
  );
};

/** The kits section of the owner console. */
export const StarterKitsPanel = () => {
  const kits = useKits();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const remove = useMutation({
    mutationFn: (key: string) => api().delete(`/platform/starter-kits/${enc(key)}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KITS });
      showToast({ message: t('owner.kits.removed') });
    },
  });
  const rows = kits.data?.data ?? [];
  return (
    <section className="space-y-2.5" data-testid="owner-starter-kits">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-0.5">
          <h2 className="font-display text-base font-bold text-heading">{t('owner.kits.title')}</h2>
          <p className="max-w-[640px] text-xs text-muted">{t('owner.kits.hint')}</p>
        </div>
        <Button variant="accent" data-testid="owner-kit-save-from-boards" onClick={() => setSaving(true)}>
          {t('owner.kits.fromBoards')}
        </Button>
      </header>
      {kits.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {kits.isError ? <Notice tone="error">{errorMessage(kits.error)}</Notice> : null}
      {kits.data && !rows.length ? (
        <EmptyState icon={<Icon name="building" size={28} />} title={t('owner.kits.empty')} />
      ) : null}
      {rows.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface">
          {rows.map((k) => (
            <li
              key={k.key}
              className="flex flex-wrap items-center gap-2 px-3 py-2.5"
              data-testid={`owner-kit-${k.key}`}
            >
              <span aria-hidden className="text-lg">
                {k.icon ?? '🧰'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-heading">{kitName(k)}</span>
                <span className="block truncate text-xs text-muted">
                  {k.description ?? t('owner.kits.size', { folders: k.folders ?? 0, boards: k.boards ?? 0 })}
                </span>
              </span>
              {k.default ? <Badge tone="ok">{t('owner.kits.default')}</Badge> : null}
              {k.version ? <Badge>{`v${k.version}`}</Badge> : null}
              <Button size="sm" variant="ghost" data-testid="owner-kit-edit" onClick={() => setEditing(k.key)}>
                {t('owner.kits.open')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="owner-kit-remove"
                busy={remove.isPending && remove.variables === k.key}
                onClick={async () => {
                  const ok = await confirmDialog({
                    title: t('owner.kits.removeTitle', { name: kitName(k) }),
                    message: t('owner.kits.removeMessage'),
                    danger: true,
                  });
                  if (ok) remove.mutate(k.key);
                }}
              >
                {t('owner.kits.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {remove.isError ? <Notice tone="error">{errorMessage(remove.error)}</Notice> : null}
      {editing ? <KitEditor kitKeyValue={editing} onClose={() => setEditing(null)} /> : null}
      {saving ? (
        <SaveKitDialog
          onClose={() => setSaving(false)}
          onSaved={(key) => {
            setSaving(false);
            setEditing(key);
          }}
        />
      ) : null}
    </section>
  );
};

/** The key suggested from a name (the shared slug rule; 48 = a kit key's maximum). */
const slugify = (s: string) => slugFromName(s, 48);

/** "Save as starter kit": boards of an account I administer → a kit (their folders, automations optional). */
const SaveKitDialog = ({ onClose, onSaved }: { onClose: () => void; onSaved: (key: string) => void }) => {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: queryKeys.platformAccounts,
    queryFn: () => api().get<{ data: PlatformAccount[] }>('/platform/accounts'),
  });
  const [accountId, setAccountId] = useState('');
  const boards = useQuery({
    queryKey: ['platform', 'kit-boards', accountId],
    queryFn: () =>
      api().get<{
        data: { id: string; name: string; workspace: string; folder: string | null }[];
        dashboards?: { id: string; name: string; workspace: string }[];
        docs?: { id: string; name: string; workspace: string }[];
      }>(`/platform/accounts/${enc(accountId)}/kit-boards`),
    enabled: !!accountId,
    retry: false,
  });
  const [chosen, setChosen] = useState<string[]>([]);
  // Phase B: that account's dashboards and docs can come along.
  const [dashboards, setDashboards] = useState<string[]>([]);
  const [docs, setDocs] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [keepFolders, setKeepFolders] = useState(true);
  const [automations, setAutomations] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api().post<StarterKitDetail>('/platform/starter-kits', {
        key,
        name,
        ...(description.trim() ? { description: description.trim() } : {}),
        account_id: accountId,
        board_ids: chosen,
        include_automations: automations,
        workspace_name: workspace.trim() || null,
        keep_folders: keepFolders,
        default: isDefault,
        dashboard_ids: dashboards,
        doc_ids: docs,
      }),
    onSuccess: async (kit) => {
      await qc.invalidateQueries({ queryKey: KITS });
      showToast({ message: t('owner.kits.saved', { name: kit.name }) });
      onSaved(kit.key);
    },
  });
  const boardList = boards.data?.data;
  const byWorkspace = useMemo(() => {
    const out = new Map<string, NonNullable<typeof boardList>>();
    for (const b of boardList ?? []) out.set(b.workspace, [...(out.get(b.workspace) ?? []), b]);
    return [...out];
  }, [boardList]);
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const ready = !!accountId && chosen.length > 0 && !!name.trim() && /^[a-z][a-z0-9-]{1,47}$/.test(key);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('owner.kits.fromBoards')}
      subtitle={t('owner.kits.fromBoardsHint')}
      className="max-w-xl!"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!ready} busy={save.isPending} data-testid="owner-kit-create" onClick={() => save.mutate()}>
            {t('owner.kits.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="owner-kit-save-dialog">
        <Field label={t('owner.kits.account')}>
          <Picker
            label={t('owner.kits.account')}
            value={accountId}
            placeholder={t('owner.kits.accountPlaceholder')}
            searchable
            testId="owner-kit-account"
            onChange={(id) => {
              setAccountId(id);
              setChosen([]);
              setDashboards([]);
              setDocs([]);
            }}
            options={(accounts.data?.data ?? []).map((a) => ({ value: a.id, label: a.name, keywords: a.slug }))}
          />
        </Field>
        {boards.isError ? <Notice tone="error">{errorMessage(boards.error)}</Notice> : null}
        {boards.isFetching ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
        {byWorkspace.length ? (
          <div className="max-h-56 space-y-2 overflow-y-auto rounded-[10px] border border-line p-2">
            {byWorkspace.map(([ws, list]) => (
              <div key={ws}>
                <p className="px-1 text-xs font-semibold text-muted">{ws}</p>
                {list.map((b) => (
                  <label
                    key={b.id}
                    className="flex items-center gap-2 rounded-[8px] px-1.5 py-1 text-sm hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={chosen.includes(b.id)}
                      onChange={() => toggle(b.id)}
                      data-testid="owner-kit-board"
                      data-name={b.name}
                    />
                    <span className="flex-1 truncate">{b.name}</span>
                    {b.folder ? <span className="text-xs text-muted">📁 {b.folder}</span> : null}
                  </label>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        <ExtraPicks
          label={t('owner.kits.dashboards')}
          list={boards.data?.dashboards ?? []}
          chosen={dashboards}
          onChange={setDashboards}
          testId="owner-kit-dashboard"
        />
        <ExtraPicks
          label={t('owner.kits.docs')}
          list={boards.data?.docs ?? []}
          chosen={docs}
          onChange={setDocs}
          testId="owner-kit-doc"
        />
        <Field label={t('owner.kits.name')}>
          <Input
            value={name}
            data-testid="owner-kit-name"
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(slugify(e.target.value));
            }}
          />
        </Field>
        <Field label={t('owner.kits.key')} hint={t('owner.kits.keyHint')}>
          <Input
            dir="ltr"
            className="text-end font-mono"
            value={key}
            data-testid="owner-kit-key"
            onChange={(e) => {
              setKeyTouched(true);
              setKey(e.target.value);
            }}
          />
        </Field>
        <Field label={t('owner.kits.description')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t('owner.kits.workspaceName')} hint={t('owner.kits.workspaceNameHint')}>
          <Input
            value={workspace}
            placeholder={t('owner.kits.workspaceIsAccount')}
            data-testid="owner-kit-workspace"
            onChange={(e) => setWorkspace(e.target.value)}
          />
        </Field>
        <SwitchRow label={t('owner.kits.keepFolders')} checked={keepFolders} onChange={setKeepFolders} />
        <SwitchRow label={t('owner.kits.automations')} checked={automations} onChange={setAutomations} />
        <SwitchRow label={t('owner.kits.makeDefault')} checked={isDefault} onChange={setIsDefault} />
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};

/** Dashboards / docs of the source account a kit may take (phase B). */
const ExtraPicks = ({
  label,
  list,
  chosen,
  onChange,
  testId,
}: {
  label: string;
  list: { id: string; name: string; workspace: string }[];
  chosen: string[];
  onChange: (v: string[]) => void;
  testId: string;
}) =>
  list.length ? (
    <div className="space-y-1">
      <p className="text-xs text-fg-2">{label}</p>
      <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-[10px] border border-line p-2">
        {list.map((x) => (
          <label key={x.id} className="flex items-center gap-2 rounded-[8px] px-1.5 py-1 text-sm hover:bg-surface-2">
            <input
              type="checkbox"
              className="size-4 accent-[var(--primary)]"
              checked={chosen.includes(x.id)}
              onChange={() => onChange(chosen.includes(x.id) ? chosen.filter((y) => y !== x.id) : [...chosen, x.id])}
              data-testid={testId}
              data-name={x.name}
            />
            <span className="flex-1 truncate">{x.name}</span>
            <span className="text-xs text-muted">{x.workspace}</span>
          </label>
        ))}
      </div>
    </div>
  ) : null;

/** The kit's card on the start screen: shown or not, its place, group and drawing. */
const GalleryFields = ({ value, onChange }: { value: KitGallery; onChange: (v: KitGallery) => void }) => (
  <fieldset className="space-y-2 rounded-[10px] border border-line p-3" data-testid="owner-kit-gallery">
    <legend className="px-1 text-xs text-fg-2">{t('owner.kits.gallery.title')}</legend>
    <p className="text-xs text-muted">{t('owner.kits.gallery.hint')}</p>
    <SwitchRow
      label={t('owner.kits.gallery.show')}
      checked={value.show}
      onChange={(show) => onChange({ ...value, show })}
      testId="owner-kit-gallery-show"
    />
    <SwitchRow
      label={t('owner.kits.gallery.recommended')}
      checked={value.recommended}
      onChange={(recommended) => onChange({ ...value, recommended })}
    />
    <div className="grid gap-3 md:grid-cols-3">
      <Field label={t('owner.kits.gallery.category')}>
        <Input
          value={value.category ?? ''}
          maxLength={40}
          onChange={(e) => onChange({ ...value, category: e.target.value })}
        />
      </Field>
      <Field label={t('owner.kits.gallery.order')} hint={t('owner.kits.gallery.orderHint')}>
        <Input
          inputMode="numeric"
          value={String(value.order)}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, '') || 0);
            onChange({ ...value, order: Math.min(999, n) });
          }}
        />
      </Field>
      <Field label={t('owner.kits.gallery.illustration')}>
        <Picker
          label={t('owner.kits.gallery.illustration')}
          value={value.illustration}
          onChange={(illustration) => onChange({ ...value, illustration })}
          options={KIT_ILLUSTRATIONS.map((k) => ({ value: k, label: tDynamic(`owner.kits.gallery.art.${k}`) }))}
        />
      </Field>
    </div>
  </fieldset>
);

const SwitchRow = ({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) => (
  <label className="flex items-center justify-between gap-3 text-sm">
    <span>{label}</span>
    <Switch checked={checked} onChange={onChange} testId={testId} />
  </label>
);

type BoardRow = { template: string; name: string | null; folder: string | null };

/** A kit opened: preview, edit (a new version on save), versions to restore. */
const KitEditor = ({ kitKeyValue, onClose }: { kitKeyValue: string; onClose: () => void }) => {
  const kit = useKit(kitKeyValue);
  return (
    <Dialog
      open
      onClose={onClose}
      title={kit.data ? kitName(kit.data) : t('owner.kits.title')}
      subtitle={kit.data ? `v${kit.data.version} · ${kit.data.key}` : undefined}
      className="max-w-2xl!"
    >
      {kit.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
      {kit.isError ? <Notice tone="error">{errorMessage(kit.error)}</Notice> : null}
      {kit.data ? <KitForm key={kit.data.version} kit={kit.data} /> : null}
    </Dialog>
  );
};

const KitForm = ({ kit }: { kit: StarterKitDetail }) => {
  const qc = useQueryClient();
  const [name, setName] = useState(kit.name);
  const [description, setDescription] = useState(kit.description ?? '');
  const [workspace, setWorkspace] = useState(kit.workspace_name ?? '');
  const [folders, setFolders] = useState<string[]>(kit.folders);
  const [boards, setBoards] = useState<BoardRow[]>(
    // The boards the kit lists (built-in "all but" ones follow their template's folder and are not edited here).
    kit.boards.filter((b) => b.listed),
  );
  const [isDefault, setIsDefault] = useState(kit.default);
  const [newFolder, setNewFolder] = useState('');
  const [gallery, setGallery] = useState<KitGallery>(kit.gallery);
  const refresh = async (k: StarterKitDetail) => {
    qc.setQueryData(kitKey(k.key), k);
    await qc.invalidateQueries({ queryKey: KITS });
  };
  const save = useMutation({
    mutationFn: () =>
      api().patch<StarterKitDetail>(`/platform/starter-kits/${enc(kit.key)}`, {
        name,
        description: description.trim() || null,
        workspace_name: workspace.trim() || null,
        folders,
        boards: boards.map((b) => ({
          template: b.template,
          folder: b.folder && folders.includes(b.folder) ? b.folder : null,
        })),
        default: isDefault,
        gallery: { ...gallery, category: gallery.category?.trim() || null },
      }),
    onSuccess: async (k) => {
      await refresh(k);
      showToast({ message: t('owner.kits.savedVersion', { version: k.version }) });
    },
  });
  const restore = useMutation({
    mutationFn: (id: string) =>
      api().post<StarterKitDetail>(`/platform/starter-kits/${enc(kit.key)}/versions/${enc(id)}/restore`, {}),
    onSuccess: async (k) => {
      await refresh(k);
      showToast({ message: t('owner.kits.restored', { version: k.version }) });
    },
  });
  const removable = kit.templates.filter((tpl) => !boards.some((b) => b.template === tpl.key));
  const move = (i: number, d: -1 | 1) =>
    setFolders((f) => {
      const j = i + d;
      if (j < 0 || j >= f.length) return f;
      const next = [...f];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  return (
    <div className="space-y-4" data-testid="owner-kit-editor">
      <KitPreview kit={kit} />
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('owner.kits.name')}>
          <Input value={name} data-testid="owner-kit-edit-name" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('owner.kits.workspaceName')} hint={t('owner.kits.workspaceNameHint')}>
          <Input
            value={workspace}
            placeholder={t('owner.kits.workspaceIsAccount')}
            data-testid="owner-kit-edit-workspace"
            onChange={(e) => setWorkspace(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t('owner.kits.description')}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-fg-2">{t('owner.kits.folders')}</p>
        <ul className="space-y-1" data-testid="owner-kit-folders">
          {folders.map((f, i) => (
            <li key={`${i}:${f}`} className="flex items-center gap-1.5">
              <Input
                value={f}
                aria-label={t('owner.kits.folderName')}
                onChange={(e) => {
                  const v = e.target.value;
                  setBoards((bs) => bs.map((b) => (b.folder === f ? { ...b, folder: v } : b)));
                  setFolders((fs) => fs.map((x, k) => (k === i ? v : x)));
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                title={t('owner.kits.up')}
                aria-label={t('owner.kits.up')}
                onClick={() => move(i, -1)}
              >
                ↑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title={t('owner.kits.down')}
                aria-label={t('owner.kits.down')}
                onClick={() => move(i, 1)}
              >
                ↓
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title={t('owner.kits.removeFolder')}
                aria-label={t('owner.kits.removeFolder')}
                onClick={() => {
                  setFolders((fs) => fs.filter((_, k) => k !== i));
                  setBoards((bs) => bs.map((b) => (b.folder === f ? { ...b, folder: null } : b)));
                }}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-1.5">
          <Input
            value={newFolder}
            placeholder={t('owner.kits.newFolder')}
            data-testid="owner-kit-new-folder"
            onChange={(e) => setNewFolder(e.target.value)}
          />
          <Button
            variant="ghost"
            disabled={!newFolder.trim() || folders.includes(newFolder.trim())}
            onClick={() => {
              setFolders((fs) => [...fs, newFolder.trim()]);
              setNewFolder('');
            }}
          >
            {t('owner.kits.addFolder')}
          </Button>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-fg-2">{t('owner.kits.boards')}</p>
        <ul className="space-y-1" data-testid="owner-kit-boards">
          {boards.map((b) => (
            <li key={b.template} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">📋 {b.name ?? b.template}</span>
              <Picker
                label={t('owner.kits.boardFolder')}
                value={b.folder ?? ''}
                className="w-44"
                onChange={(v) => setBoards((bs) => bs.map((x) => (x === b ? { ...x, folder: v || null } : x)))}
                options={[
                  { value: '', label: t('owner.kits.atRoot') },
                  ...folders.map((f) => ({ value: f, label: f })),
                ]}
              />
              <Button
                size="sm"
                variant="ghost"
                title={t('owner.kits.removeBoard')}
                aria-label={t('owner.kits.removeBoard')}
                onClick={() => setBoards((bs) => bs.filter((x) => x !== b))}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
        {removable.length ? (
          <Picker
            label={t('owner.kits.addBoard')}
            placeholder={t('owner.kits.addBoard')}
            value=""
            onChange={(tpl) =>
              setBoards((bs) => [
                ...bs,
                { template: tpl, name: kit.templates.find((x) => x.key === tpl)?.name ?? tpl, folder: null },
              ])
            }
            options={removable.map((x) => ({ value: x.key, label: x.name }))}
          />
        ) : null}
        {kit.all_builtin_templates ? <p className="text-xs text-muted">{t('owner.kits.allBuiltin')}</p> : null}
      </div>
      <SwitchRow
        label={t('owner.kits.makeDefault')}
        checked={isDefault}
        onChange={setIsDefault}
        testId="owner-kit-default"
      />
      <GalleryFields value={gallery} onChange={setGallery} />
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <div className="flex justify-end">
        <Button busy={save.isPending} data-testid="owner-kit-save" onClick={() => save.mutate()}>
          {t('owner.kits.saveVersion')}
        </Button>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-fg-2">{t('owner.kits.versions')}</p>
        <ul className="divide-y divide-line rounded-[10px] border border-line text-sm" data-testid="owner-kit-versions">
          {kit.versions.map((v, i) => (
            <li key={v.id} className="flex items-center gap-2 px-2.5 py-1.5">
              <Badge tone={i === 0 ? 'ok' : 'neutral'}>{`v${v.version}`}</Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {[
                  v.note ? tDynamic(`owner.kits.note.${v.note}`) : null,
                  v.created_by,
                  new Date(v.created_at).toLocaleString(getLocale()),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {i > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="owner-kit-restore"
                  busy={restore.isPending && restore.variables === v.id}
                  onClick={() => restore.mutate(v.id)}
                >
                  {t('owner.kits.restore')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {restore.isError ? <Notice tone="error">{errorMessage(restore.error)}</Notice> : null}
      </div>
    </div>
  );
};
