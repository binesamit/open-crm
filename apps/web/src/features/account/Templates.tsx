// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { t, type BoardDetail, type MessageKey, type MyAccount } from '@bines/shared';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  Menu,
  MenuTrigger,
  Notice,
  Picker,
  useActionMenu,
  type MenuEntry,
} from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDelete, confirmDialog, promptDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { useWorkspaces } from '../board/board-api';

type TemplateSummary = {
  key: string;
  name: string;
  description: string | null;
  account: boolean;
  can_edit: boolean;
  item_count: number;
  /** My open working board of it ("טיוטה פתוחה", fix3). */
  draft_board_id: string | null;
};
type HiddenTemplate = { key: string; name: string; description: string | null };

const templatesKey = (accountId: string) => ['account', accountId, 'templates'];
const hiddenKey = (accountId: string) => ['account', accountId, 'templates', 'hidden'];

/** The workspace the sidebar shows (remembered there), else the first: where a template's working board goes. */
const useTargetWorkspace = (accountId: string) => {
  const list = useWorkspaces(accountId).data?.data ?? [];
  let remembered: string | null = null;
  try {
    remembered = localStorage.getItem(`bines:workspace:${accountId}`);
  } catch {
    // Blocked storage: the first workspace.
  }
  return list.find((w) => w.id === remembered)?.id ?? list[0]?.id;
};

/**
 * The templates of "new board" (07 §4.3, fix2), all of them data: the built-in ones (seeded per account) and the
 * account's own. Each can be edited (a working board made from it, saved back with the banner), renamed,
 * re-described, duplicated and deleted (a built-in one is removed from this account; an admin brings it back from
 * "removed templates"). Who may: its creator or an admin edits / deletes; admins and members duplicate.
 */
export const Templates = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const client = api(account.id);
  const admin = account.role === 'admin';
  const canCreate = admin || account.role === 'member';
  const workspaceId = useTargetWorkspace(account.id);
  const [describing, setDescribing] = useState<TemplateSummary | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const list = useQuery({
    queryKey: templatesKey(account.id),
    queryFn: () => client.get<{ data: TemplateSummary[] }>('/templates'),
  });
  const hidden = useQuery({
    queryKey: hiddenKey(account.id),
    queryFn: () => client.get<{ data: HiddenTemplate[] }>('/templates/hidden'),
    enabled: admin,
  });
  // Both lists (and "new board", same key) refresh together.
  const refresh = () => qc.invalidateQueries({ queryKey: templatesKey(account.id) });
  const update = useMutation({
    mutationFn: (v: { key: string; name?: string; description?: string | null }) =>
      client.patch(`/templates/${v.key}`, { name: v.name, description: v.description }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (key: string) => client.delete(`/templates/${key}`), onSuccess: refresh });
  const duplicate = useMutation({
    mutationFn: (tpl: TemplateSummary) =>
      client.post<TemplateSummary>(`/templates/${tpl.key}/duplicate`, {
        name: t('templates.copyName', { name: tpl.name }).slice(0, 255),
      }),
    onSuccess: async (copy) => {
      showToast({ message: t('templates.duplicated', { name: copy.name }) });
      await refresh();
    },
  });
  const restore = useMutation({
    mutationFn: (key: string) => client.post(`/templates/${key}/restore`, {}),
    onSuccess: refresh,
  });
  // "עריכת התבנית" (fix3): my working board of it — a hidden draft (the open one, else a new one) whose banner
  // saves it back over the template. It never shows among the boards.
  const edit = useMutation({
    mutationFn: (tpl: TemplateSummary) =>
      client.post<{ board_id: string }>(`/templates/${tpl.key}/draft`, {
        name: t('templates.editBoardName', { name: tpl.name }).slice(0, 255),
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      }),
    onSuccess: async (res) => {
      await refresh();
      await navigate({
        to: '/a/$accountSlug/b/$boardId',
        params: { accountSlug: account.slug, boardId: res.board_id },
      });
    },
  });
  // "ביטול עריכה": the draft goes, the template stays as it was.
  const discard = useMutation({
    mutationFn: (boardId: string) => client.delete(`/boards/${boardId}/template-draft`),
    onSuccess: async () => {
      showToast({ message: t('templates.draftDiscarded') });
      await refresh();
    },
  });
  const error = update.error ?? remove.error ?? duplicate.error ?? restore.error ?? edit.error ?? discard.error;
  const all = list.data?.data ?? [];
  const removed = hidden.data?.data ?? [];
  return (
    <Card>
      <h2 className="mb-3 font-display text-[1rem] leading-snug font-extrabold text-heading">{t('templates.title')}</h2>
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      {list.data && !all.length ? <p className="text-sm text-muted">{t('templates.empty')}</p> : null}
      {all.length ? (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {all.map((tpl) => (
            <TemplateRow
              key={tpl.key}
              tpl={tpl}
              canDuplicate={canCreate}
              busy={
                (edit.isPending && edit.variables?.key === tpl.key) ||
                (discard.isPending && discard.variables === tpl.draft_board_id)
              }
              onEdit={workspaceId ? () => edit.mutate(tpl) : undefined}
              onDiscard={() =>
                void confirmDialog({
                  title: t('templates.draftCancelTitle', { name: tpl.name }),
                  message: t('templates.draftCancelMessage'),
                  confirmLabel: t('templates.draftCancel'),
                  danger: true,
                }).then((ok) => ok && tpl.draft_board_id && discard.mutate(tpl.draft_board_id))
              }
              onRename={async () => {
                const name = await promptDialog({
                  title: t('templates.rename'),
                  label: t('templates.name'),
                  initial: tpl.name,
                });
                if (name && name !== tpl.name) update.mutate({ key: tpl.key, name });
              }}
              onDescribe={() => setDescribing(tpl)}
              onDuplicate={() => duplicate.mutate(tpl)}
              onDelete={async () => {
                if (await confirmDelete(tpl.name)) remove.mutate(tpl.key);
              }}
            />
          ))}
        </ul>
      ) : null}
      {admin && removed.length ? (
        <div className="mt-3">
          <button
            type="button"
            data-testid="templates-hidden-toggle"
            aria-expanded={showHidden}
            onClick={() => setShowHidden((v) => !v)}
            className="text-xs font-semibold text-muted hover:text-fg hover:underline"
          >
            {t('templates.hidden', { n: removed.length })}
          </button>
          {showHidden ? (
            <ul className="mt-2 overflow-hidden rounded-[14px] border border-line-soft">
              {removed.map((h) => (
                <li
                  key={h.key}
                  data-testid="template-hidden-row"
                  data-name={h.name}
                  className="flex items-center gap-3 border-b border-line-soft bg-surface-3 px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{h.name}</span>
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="template-restore"
                    busy={restore.isPending && restore.variables === h.key}
                    onClick={() => restore.mutate(h.key)}
                  >
                    {t('templates.restore')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {describing ? (
        <DescriptionDialog
          tpl={describing}
          busy={update.isPending}
          onClose={() => setDescribing(null)}
          onSave={(description) =>
            update.mutate({ key: describing.key, description }, { onSuccess: () => setDescribing(null) })
          }
        />
      ) : null}
    </Card>
  );
};

const TemplateRow = ({
  tpl,
  canDuplicate,
  busy,
  onEdit,
  onDiscard,
  onRename,
  onDescribe,
  onDuplicate,
  onDelete,
}: {
  tpl: TemplateSummary;
  canDuplicate: boolean;
  busy: boolean;
  /** Missing while the workspaces load. */
  onEdit?: () => void;
  /** "ביטול עריכה" of my open draft. */
  onDiscard: () => void;
  onRename: () => void;
  onDescribe: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) => {
  const menu = useActionMenu();
  const label = t('templates.actions', { name: tpl.name });
  const items: MenuEntry[] = [
    ...(tpl.can_edit
      ? [
          {
            label: t((tpl.draft_board_id ? 'templates.draftContinue' : 'templates.edit') as MessageKey),
            onSelect: () => onEdit?.(),
            disabled: !onEdit,
            testId: 'template-edit',
          },
          { label: t('templates.rename'), onSelect: onRename, testId: 'template-rename' },
          { label: t('templates.describe'), onSelect: onDescribe, testId: 'template-describe' },
        ]
      : []),
    ...(canDuplicate ? [{ label: t('menu.duplicate'), onSelect: onDuplicate, testId: 'template-duplicate' }] : []),
    ...(tpl.can_edit
      ? [
          { kind: 'separator' as const },
          { label: t('menu.delete'), danger: true, onSelect: onDelete, testId: 'template-delete' },
        ]
      : []),
  ];
  return (
    <li
      className="flex items-center gap-3 border-b border-line-soft bg-surface px-3 py-2.5 last:border-b-0"
      data-testid="template-row"
      data-name={tpl.name}
      aria-busy={busy || undefined}
    >
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-heading">
        <Icon name="template" size={15} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">{tpl.name}</span>
          {tpl.account ? null : <Badge>{t('templates.builtin')}</Badge>}
        </span>
        {tpl.description ? (
          <span className="truncate text-xs text-fg-2" data-testid="template-description">
            {tpl.description}
          </span>
        ) : null}
        <span className="text-[0.6875rem] text-muted">
          {tpl.item_count ? t('templates.withItems', { n: tpl.item_count }) : t('templates.structure')}
        </span>
        {tpl.draft_board_id ? (
          // My unsaved working board (fix3): continue it, or drop it.
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="template-draft">
            <span className="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent-fg">
              {t('templates.draftOpen')}
            </span>
            <button
              type="button"
              data-testid="template-draft-continue"
              disabled={!onEdit}
              onClick={() => onEdit?.()}
              className="font-semibold text-primary hover:underline disabled:opacity-50"
            >
              {t('templates.draftContinue')}
            </button>
            <span aria-hidden className="text-muted">
              ·
            </span>
            <button
              type="button"
              data-testid="template-draft-cancel"
              onClick={onDiscard}
              className="font-semibold text-danger-fg hover:underline"
            >
              {t('templates.draftCancel')}
            </button>
          </span>
        ) : null}
      </span>
      {items.length ? (
        <>
          <MenuTrigger
            label={label}
            onClick={menu.fromTrigger}
            className="grid size-8 place-items-center rounded-[10px] text-base text-fg-2 opacity-100"
          />
          <Menu at={menu.at} onClose={menu.close} label={label} items={items} />
        </>
      ) : null}
    </li>
  );
};

/** A template's description (shown under its name here and nowhere hard-coded). Empty = none. */
const DescriptionDialog = ({
  tpl,
  busy,
  onClose,
  onSave,
}: {
  tpl: TemplateSummary;
  busy: boolean;
  onClose: () => void;
  onSave: (description: string | null) => void;
}) => {
  const [text, setText] = useState(tpl.description ?? '');
  return (
    <Dialog
      open
      title={t('templates.describe')}
      subtitle={tpl.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="template-description-save" busy={busy} onClick={() => onSave(text.trim() || null)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('templates.description')}>
        <textarea
          autoFocus
          rows={4}
          maxLength={2000}
          value={text}
          data-testid="template-description-input"
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
        />
      </Field>
    </Dialog>
  );
};

/** "שמירה כתבנית" (07 §4.3): a name, and whether the items come along. */
export const SaveTemplateDialog = ({
  accountId,
  board,
  onClose,
  initialReplace = '',
  initialWithItems = false,
  onSaved,
}: {
  accountId: string;
  board: { id: string; name: string };
  onClose: () => void;
  /** Save over this template (the "editing a template" banner). */
  initialReplace?: string;
  initialWithItems?: boolean;
  onSaved?: (template: { key: string; name: string }) => void;
}) => {
  const qc = useQueryClient();
  const templates = useQuery({
    queryKey: templatesKey(accountId),
    queryFn: () => api(accountId).get<{ data: TemplateSummary[] }>('/templates'),
  }).data?.data;
  const editable = (templates ?? []).filter((x) => x.can_edit);
  const preset = editable.find((x) => x.key === initialReplace);
  const [name, setName] = useState<string | null>(null);
  const [withItems, setWithItems] = useState(initialWithItems);
  // A new template, or save over one of those I may edit (that is how a template's content is edited).
  const [replace, setReplace] = useState(initialReplace);
  const shownName = name ?? preset?.name ?? board.name;
  const save = useMutation({
    mutationFn: () =>
      api(accountId).post<{ key: string; name: string }>(`/boards/${board.id}/save-as-template`, {
        name: shownName.trim(),
        with_items: withItems,
        ...(replace ? { replace_key: replace } : {}),
      }),
    onSuccess: async (res) => {
      showToast({ message: t('template.saved', { name: shownName.trim() }) });
      await qc.invalidateQueries({ queryKey: templatesKey(accountId) });
      onSaved?.(res);
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={t('template.save.title', { name: board.name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="template-save"
            disabled={!shownName.trim()}
            busy={save.isPending}
            onClick={() => save.mutate()}
          >
            {t('template.save.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="template-dialog">
        {editable.length ? (
          <Field label={t('template.save.target')}>
            <Picker<string>
              testId="template-target"
              label={t('template.save.target')}
              value={replace}
              onChange={(key) => {
                setReplace(key);
                const tpl = editable.find((x) => x.key === key);
                if (tpl) setName(tpl.name);
              }}
              options={[
                { value: '', label: t('template.save.new') },
                ...editable.map((x) => ({ value: x.key, label: t('template.save.replace', { name: x.name }) })),
              ]}
            />
          </Field>
        ) : null}
        <Field label={t('template.save.name')}>
          <Input autoFocus value={shownName} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="template-with-items"
            checked={withItems}
            onChange={() => setWithItems((v) => !v)}
            className="accent-[var(--check)]"
          />
          {t('template.save.withItems')}
        </label>
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};

/**
 * The bar on a template's working board (fix3), at the top of the board page: "you are editing template X" — save
 * it back over the template (the working board then goes and the templates page opens), cancel the edit, or go
 * back to the templates and continue later (the draft stays, hidden, on the template's row). Driven by the
 * board's server mark (`template_edit`), never by this browser.
 */
export const TemplateEditBanner = ({
  account,
  board,
}: {
  account: { id: string; slug: string };
  board: BoardDetail;
}) => {
  const edit = board.template_edit;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  // Administration → תבניות; the route sends a non-admin home, where their templates card is.
  const toTemplates = () =>
    navigate({ to: '/a/$accountSlug/admin/$section', params: { accountSlug: account.slug, section: 'templates' } });
  const done = async () => {
    await qc.invalidateQueries({ queryKey: templatesKey(account.id) });
    await toTemplates();
    qc.removeQueries({ queryKey: ['account', account.id, 'board', board.id] });
  };
  const discard = useMutation({
    mutationFn: () => api(account.id).delete(`/boards/${board.id}/template-draft`),
    onSuccess: async () => {
      showToast({ message: t('templates.draftDiscarded') });
      await done();
    },
  });
  if (!edit) return null;
  return (
    <div
      role="region"
      aria-label={t('templates.editing', { name: edit.name })}
      data-testid="template-edit-banner"
      className="mx-6 mt-4 flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-surface-2 px-3 py-2.5 text-sm text-fg max-md:mx-4"
    >
      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-[9px] bg-accent-soft text-accent-fg">
        <Icon name="template" size={15} />
      </span>
      <span className="min-w-0 flex-1 basis-48">
        <span className="block truncate font-semibold">{t('templates.editing', { name: edit.name })}</span>
        <span className="block text-xs text-muted">{t('templates.draftHint')}</span>
      </span>
      <Button size="sm" data-testid="template-edit-save" onClick={() => setSaving(true)}>
        {t('templates.saveBack')}
      </Button>
      <Button
        size="sm"
        variant="danger-outline"
        data-testid="template-edit-discard"
        busy={discard.isPending}
        onClick={() =>
          void confirmDialog({
            title: t('templates.draftCancelTitle', { name: edit.name }),
            message: t('templates.draftCancelMessage'),
            confirmLabel: t('templates.draftCancel'),
            danger: true,
          }).then((ok) => ok && discard.mutate())
        }
      >
        {t('templates.draftCancel')}
      </Button>
      <Button size="sm" variant="ghost" data-testid="template-edit-back" onClick={() => void toTemplates()}>
        {t('templates.backToTemplates')}
      </Button>
      {discard.isError ? (
        <p role="alert" className="w-full text-xs text-danger-fg">
          {errorMessage(discard.error)}
        </p>
      ) : null}
      {saving ? (
        <SaveDraftDialog
          accountId={account.id}
          boardId={board.id}
          edit={edit}
          onClose={() => setSaving(false)}
          onSaved={done}
        />
      ) : null}
    </div>
  );
};

/** "שמירה לתבנית": over the template, with or without the items; then the working board is gone. */
const SaveDraftDialog = ({
  accountId,
  boardId,
  edit,
  onClose,
  onSaved,
}: {
  accountId: string;
  boardId: string;
  edit: NonNullable<BoardDetail['template_edit']>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) => {
  const [withItems, setWithItems] = useState(edit.with_items);
  const save = useMutation({
    mutationFn: () =>
      api(accountId).post<{ key: string; name: string }>(`/boards/${boardId}/template-draft/save`, {
        with_items: withItems,
      }),
    onSuccess: async (res) => {
      showToast({ message: t('templates.draftSaved', { name: res.name }) });
      onClose();
      await onSaved();
    },
  });
  return (
    <Dialog
      open
      title={t('templates.saveDraftTitle', { name: edit.name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="template-save" busy={save.isPending} onClick={() => save.mutate()}>
            {t('template.save.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="template-dialog">
        <p className="text-sm text-fg-2">{t('templates.saveDraftHint')}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="template-with-items"
            checked={withItems}
            onChange={() => setWithItems((v) => !v)}
            className="accent-[var(--check)]"
          />
          {t('template.save.withItems')}
        </label>
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
