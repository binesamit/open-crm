// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t, type AutomationTemplateDto, type TemplateProposal, tDynamic } from '@bines/shared';
import { ApiError } from '@bines/sdk';
import {
  Button,
  Dialog,
  Field,
  Input,
  Menu,
  Notice,
  Picker,
  SkeletonRows,
  Switch,
  useActionMenu,
  type MenuEntry,
} from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { useAllBoards } from './automations-api';
import { useAutomationTemplates, useTemplateMutations, useTemplateProposal } from './templates-api';

/**
 * The account's automation templates (product decision: "save as template"): any automation saved with its board's
 * columns, groups and labels as blanks, installed on another board by picking them again. Admins manage the
 * library (members too when the account allows it — the switch here); every member installs.
 */

/** ⋯ (the same mark as the automations list's; kept here so the two files do not import each other). */
const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="5" cy="12" r="1.3" />
    <circle cx="12" cy="12" r="1.3" />
    <circle cx="19" cy="12" r="1.3" />
  </svg>
);

/** "Save as template" (from any automation's ⋯): a name and a line saying what it does. */
export const SaveTemplateDialog = ({
  accountId,
  automation,
  onClose,
}: {
  accountId: string;
  automation: { id: string; title: string };
  onClose: () => void;
}) => {
  const m = useTemplateMutations(accountId);
  const [name, setName] = useState(automation.title);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    m.save.mutate(
      { automationId: automation.id, name: name.trim() || undefined, description: description.trim() || undefined },
      {
        onSuccess: () => {
          showToast({ message: t('autoTpl.saved', { name: name.trim() || automation.title }) });
          onClose();
        },
        onError: (e) => setError(errorMessage(e)),
      },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('autoTpl.save_title')}
      subtitle={t('autoTpl.save_hint')}
      className="max-w-[520px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="accent" busy={m.save.isPending} onClick={save} data-testid="tpl-save-confirm">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="tpl-save-dialog">
        <Field label={t('autoTpl.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="tpl-name" />
        </Field>
        <Field label={t('autoTpl.description')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} data-testid="tpl-description" />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};

const EditTemplateDialog = ({
  accountId,
  template,
  onClose,
}: {
  accountId: string;
  template: AutomationTemplateDto;
  onClose: () => void;
}) => {
  const m = useTemplateMutations(accountId);
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('autoTpl.edit_title')}
      className="max-w-[520px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="accent"
            busy={m.update.isPending}
            data-testid="tpl-edit-save"
            onClick={() =>
              m.update.mutate(
                { id: template.id, name: name.trim() || template.name, description: description.trim() || null },
                { onSuccess: onClose, onError: (e) => setError(errorMessage(e)) },
              )
            }
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t('autoTpl.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="tpl-edit-name" />
        </Field>
        <Field label={t('autoTpl.description')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};

type Slot = TemplateProposal['slots'][number];
const slotLabel = (s: Slot) =>
  s.kind === 'text'
    ? t('autoTpl.slot.text', { field: s.title })
    : tDynamic(`autoTpl.slot.${s.kind}${s.board === 'sub' ? '_sub' : ''}`, { title: s.title });

/** Install: pick a board, then every blank (proposed by type and title; a blank nothing fits must be picked). */
const InstallTemplateDialog = ({
  accountId,
  template,
  onClose,
}: {
  accountId: string;
  template: AutomationTemplateDto;
  onClose: () => void;
}) => {
  const boards = useAllBoards(accountId);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proposal = useTemplateProposal(accountId, template.id, boardId, mapping);
  const m = useTemplateMutations(accountId);
  const slots = proposal.data?.board_id === boardId ? (proposal.data?.slots ?? []) : [];
  const unfilled = slots.filter((s) => s.value === null);
  const install = () => {
    if (!boardId) return;
    setError(null);
    m.install.mutate(
      { id: template.id, board_id: boardId, mapping, is_active: active },
      {
        onSuccess: () => {
          showToast({ message: t('autoTpl.installed', { name: template.name }) });
          onClose();
        },
        onError: (e) => {
          const issues =
            e instanceof ApiError ? (e.body.details as { issues?: { detail?: string; code: string }[] })?.issues : [];
          setError(
            [
              errorMessage(e),
              ...(issues ?? []).map((i) => tDynamic(`auto.issue.${i.code}`, { detail: i.detail ?? '' })),
            ]
              .filter(Boolean)
              .join(' · '),
          );
        },
      },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('autoTpl.install_title', { name: template.name })}
      subtitle={template.sentence}
      className="max-w-[640px]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="accent"
            busy={m.install.isPending}
            disabled={!boardId || !!unfilled.length || !!proposal.data?.needs_subitems}
            onClick={install}
            data-testid="tpl-install-confirm"
          >
            {t('autoTpl.install')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="tpl-install-dialog">
        <Field label={t('autoTpl.board')}>
          <Picker
            label={t('autoTpl.board')}
            value={boardId ?? ''}
            placeholder={t('autoTpl.pick_board')}
            testId="tpl-install-board"
            options={boards.map((b) => ({ value: b.id, label: b.name }))}
            onChange={(id) => {
              setBoardId(id);
              setMapping({});
            }}
          />
        </Field>
        {proposal.data?.needs_subitems ? <Notice tone="warn">{t('autoTpl.needs_subitems')}</Notice> : null}
        {boardId && proposal.isLoading ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {slots.length ? (
          <section className="flex flex-col gap-2" data-testid="tpl-install-slots">
            <h3 className="text-xs font-semibold text-fg-2">{t('autoTpl.blanks')}</h3>
            {slots.map((s) => (
              <div
                key={s.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2"
                data-testid="tpl-slot"
                data-slot={s.id}
                data-empty={s.value === null ? 'true' : undefined}
              >
                <span className="truncate text-sm" title={s.title}>
                  {slotLabel(s)}
                </span>
                {s.kind === 'text' ? (
                  <Input
                    dir="ltr"
                    value={mapping[s.id] ?? ''}
                    placeholder="https://"
                    onChange={(e) => setMapping((x) => ({ ...x, [s.id]: e.target.value }))}
                    data-testid="tpl-slot-text"
                  />
                ) : (
                  <Picker
                    label={slotLabel(s)}
                    value={s.value ?? ''}
                    placeholder={s.options.length ? t('autoTpl.pick') : t('autoTpl.nothing_fits')}
                    testId="tpl-slot-pick"
                    options={s.options.map((o) => ({ value: o.value, label: o.title }))}
                    onChange={(v) => setMapping((x) => ({ ...x, [s.id]: v }))}
                  />
                )}
              </div>
            ))}
          </section>
        ) : null}
        {boardId ? (
          <label className="inline-flex items-center gap-2 text-sm">
            <Switch checked={active} onChange={setActive} label={t('autoTpl.activate')} testId="tpl-install-active" />
            <span>{t('autoTpl.activate')}</span>
          </label>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};

/** Admins: whether members may also save, edit and delete templates (an account setting, default off). */
const MembersManageSwitch = ({ accountId }: { accountId: string }) => {
  const qc = useQueryClient();
  const key = ['account', accountId, 'detail-permissions'];
  const detail = useQuery({
    queryKey: key,
    queryFn: () =>
      api(accountId).get<{ settings: { permissions: { members_manage_automation_templates?: boolean } } }>(
        '/accounts/me',
      ),
  });
  const save = useMutation({
    mutationFn: (on: boolean) =>
      api(accountId).patch('/accounts/me', { settings: { permissions: { members_manage_automation_templates: on } } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account', accountId] }),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  if (!detail.data) return null;
  return (
    <label className="inline-flex items-center gap-2 text-xs text-fg-2">
      <Switch
        checked={!!detail.data.settings.permissions.members_manage_automation_templates}
        disabled={save.isPending}
        onChange={(on) => save.mutate(on)}
        label={t('autoTpl.members_manage')}
        testId="tpl-members-manage"
      />
      <span>{t('autoTpl.members_manage')}</span>
    </label>
  );
};

export const AutomationTemplatesLibrary = ({ accountId, isAdmin }: { accountId: string; isAdmin: boolean }) => {
  const list = useAutomationTemplates(accountId);
  const m = useTemplateMutations(accountId);
  const menu = useActionMenu();
  const [menuFor, setMenuFor] = useState<AutomationTemplateDto | null>(null);
  const [installing, setInstalling] = useState<AutomationTemplateDto | null>(null);
  const [editing, setEditing] = useState<AutomationTemplateDto | null>(null);
  const canManage = !!list.data?.can_manage;
  const rows = list.data?.data ?? [];
  const items = (x: AutomationTemplateDto): MenuEntry[] => [
    { label: t('autoTpl.install'), icon: <Icon name="plus" />, onSelect: () => setInstalling(x) },
    ...(canManage
      ? [
          { label: t('auto.list.edit'), icon: <Icon name="edit" />, onSelect: () => setEditing(x) },
          { kind: 'separator' as const },
          {
            label: t('common.delete'),
            icon: <Icon name="trash" />,
            danger: true,
            onSelect: () =>
              void confirmDialog({
                title: t('autoTpl.delete_title'),
                message: x.name,
                danger: true,
                confirmLabel: t('common.delete'),
              }).then(
                (ok) =>
                  ok &&
                  m.remove.mutate(x.id, { onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }) }),
              ),
          },
        ]
      : []),
  ];
  if (list.isError) return null; // viewers and guests have no templates
  return (
    <section className="flex flex-col gap-2" data-testid="automation-templates" data-tour="automations.templates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-extrabold text-heading">{t('autoTpl.title')}</h2>
        {isAdmin ? <MembersManageSwitch accountId={accountId} /> : null}
      </div>
      <p className="text-xs text-muted">{t('autoTpl.intro')}</p>
      {list.isLoading ? (
        <SkeletonRows rows={2} label={t('app.loading')} />
      ) : !rows.length ? (
        <p className="text-sm text-muted" data-testid="tpl-empty">
          {t('autoTpl.empty')}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {rows.map((x) => (
            <li
              key={x.id}
              className="flex items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 text-sm last:border-b-0"
              data-testid="tpl-row"
              data-name={x.name}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-semibold break-words text-fg">{x.name}</span>
                <span className="text-xs break-words text-muted">{x.description || x.sentence}</span>
                <span className="text-[0.6875rem] text-muted">{t('autoTpl.blanks_n', { n: x.slots.length })}</span>
              </span>
              <Button variant="secondary" size="sm" onClick={() => setInstalling(x)} data-testid="tpl-install">
                {t('autoTpl.install')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-haspopup="menu"
                aria-label={t('menu.actions')}
                title={t('menu.actions')}
                className="w-8 shrink-0 px-0 text-muted"
                data-testid="tpl-row-menu"
                onClick={(e) => {
                  setMenuFor(x);
                  menu.fromTrigger(e);
                }}
              >
                <DotsIcon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Menu at={menu.at} onClose={menu.close} label={t('menu.actions')} items={menuFor ? items(menuFor) : []} />
      {installing ? (
        <InstallTemplateDialog accountId={accountId} template={installing} onClose={() => setInstalling(null)} />
      ) : null}
      {editing ? (
        <EditTemplateDialog accountId={accountId} template={editing} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  );
};
