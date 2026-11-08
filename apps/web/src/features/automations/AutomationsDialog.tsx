// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useMemo, useState } from 'react';
import {
  exactTime,
  recipeText,
  relativeTime,
  t,
  type Automation,
  type DraftRecipe,
  type SentenceBoard,
} from '@bines/shared';
import { Badge, Button, Dialog, Menu, Notice, Segmented, SkeletonRows, useActionMenu, type MenuEntry } from '@bines/ui';
import { Glyph, Icon } from '../../lib/icons';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { BoardAccountContext } from '../board/board-context';
import { useMembers, type BoardDetail } from '../board/board-api';
import type { FilterCtx } from '../board/toolbar/FilterPanel';
import { useAllBoards, useAutomationMutations, useAutomations } from './automations-api';
import { Builder, draftOf } from './Builder';
import { blankDraft } from './recipe-draft';
import { TemplatePicker } from './TemplatePicker';
import { RunsDialog } from './RunsDialog';
import { SaveTemplateDialog } from './AutomationTemplatesLibrary';
import { useAutomationTemplates } from './templates-api';
import { TestDialog } from './TestDialog';
import { WebhooksPanel } from './WebhooksPanel';
import { copyText } from '../../lib/entity-menu';
import { publicApiOrigin } from '../../lib/public-address';

/** A switch (role=switch) — the automations list's on/off. */
const Switch = ({
  on,
  onToggle,
  label,
  disabled,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  disabled?: boolean;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={on}
    aria-label={label}
    disabled={disabled}
    onClick={onToggle}
    data-testid="automation-toggle"
    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-ok' : 'bg-[var(--switch-off)]'}`}
  >
    <span
      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[inset-inline-start] ${on ? 'start-[1.125rem]' : 'start-0.5'}`}
    />
  </button>
);

/** "Last run: 2 hours ago" (N17) — the exact time in the title. */
export const LastRun = ({ iso, now }: { iso: string | null; now: number }) =>
  iso ? (
    <time dateTime={iso} title={exactTime(iso)}>
      {relativeTime(iso, now)}
    </time>
  ) : (
    <>{t('auto.list.never')}</>
  );

/** The ⋯ icon (three dots). */
export const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="5" cy="12" r="1.3" />
    <circle cx="12" cy="12" r="1.3" />
    <circle cx="19" cy="12" r="1.3" />
  </svg>
);

/** On / off (a power sign) for the ⋯ menu's enable / disable. */
export const PowerIcon = () => (
  <Glyph
    parts={[
      ['o*', <path d="M12 3v9" />],
      ['o', <path d="M6.3 7.3a8 8 0 1 0 11.4 0" />],
    ]}
  />
);

export const AutomationsDialog = ({
  board,
  filterCtx,
  onClose,
}: {
  board: BoardDetail;
  filterCtx: FilterCtx;
  onClose: () => void;
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const list = useAutomations(accountId, board.id);
  const membersData = useMembers(accountId).data;
  const members = useMemo(() => membersData?.data ?? [], [membersData]);
  const boards = useAllBoards(accountId);
  const m = useAutomationMutations(accountId, board.id);
  const canManage = !!board.capabilities['automation.manage'];
  const canWebhooks = !!board.capabilities['webhook.manage'];
  const [tab, setTab] = useState<'manage' | 'create' | 'webhooks'>('manage');
  const [editing, setEditing] = useState<{ draft: DraftRecipe; existing?: Automation } | null>(null);
  const [testing, setTesting] = useState<Automation | null>(null);
  const [history, setHistory] = useState<Automation | null>(null);
  // Phones: a row's actions sit behind its ⋯ (the sentence keeps the width).
  const rowMenu = useActionMenu();
  const [menuFor, setMenuFor] = useState<Automation | null>(null);
  // Account automation templates: "save as template" (admins; members when the account allows it).
  const [savingTemplate, setSavingTemplate] = useState<Automation | null>(null);
  const canSaveTemplates = !!useAutomationTemplates(accountId, canManage).data?.can_manage;
  const [now] = useState(() => Date.now());

  const sb: SentenceBoard = useMemo(
    () => ({
      columns: board.columns.map((c) => ({ key: c.id, title: c.title, type: c.type })),
      groups: board.groups,
      boardName: (id) => boards.find((b) => b.id === id)?.name,
      personName: (id) => members.find((x) => x.user_id === id)?.name,
    }),
    [board, boards, members],
  );
  const rows = list.data?.data ?? [];

  const toggle = (a: Automation) =>
    m.toggle.mutate(
      { id: a.id, on: !a.is_active },
      { onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }) },
    );
  const remove = async (a: Automation) => {
    if (
      !(await confirmDialog({
        title: t('auto.list.delete_title'),
        message: a.title,
        danger: true,
        confirmLabel: t('common.delete'),
      }))
    )
      return;
    m.remove.mutate(a.id, { onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }) });
  };
  // A copy starts switched off, so the same work never runs twice before it is changed.
  const duplicate = (a: Automation) =>
    m.create.mutate(
      { title: t('auto.list.copy_title', { title: a.title }), recipe: a.recipe, is_active: false },
      {
        onSuccess: () => showToast({ message: t('auto.list.duplicated', { title: a.title }) }),
        onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
      },
    );
  /** The row's ⋯ (N12): every action on one automation; on phones the only way in. */
  const menuItems = (a: Automation): MenuEntry[] => [
    ...(a.can_manage
      ? [
          {
            label: t('auto.list.edit'),
            icon: <Icon name="edit" />,
            onSelect: () => setEditing({ draft: draftOf(a), existing: a }),
          },
          { label: t('auto.list.test'), icon: <Icon name="play" />, onSelect: () => setTesting(a) },
        ]
      : []),
    { label: t('auto.list.history'), icon: <Icon name="history" />, onSelect: () => setHistory(a) },
    ...(canSaveTemplates
      ? [
          {
            label: t('autoTpl.save_as'),
            icon: <Icon name="duplicate" />,
            testId: 'auto-save-template',
            onSelect: () => setSavingTemplate(a),
          },
        ]
      : []),
    ...(canManage
      ? [{ label: t('menu.duplicate'), icon: <Icon name="duplicate" />, onSelect: () => duplicate(a) }]
      : []),
    ...(a.can_manage
      ? [
          {
            label: a.is_active ? t('auto.list.disable') : t('auto.list.enable'),
            icon: <PowerIcon />,
            onSelect: () => toggle(a),
          },
          { kind: 'separator' as const },
          { label: t('common.delete'), icon: <Icon name="trash" />, danger: true, onSelect: () => void remove(a) },
        ]
      : []),
  ];

  return (
    <>
      {/* While the builder is open it stands alone (one dialog on screen); the center comes back when it closes. */}
      <Dialog
        open={!editing}
        onClose={onClose}
        title={t('auto.title', { board: board.name })}
        className="max-w-[920px]"
      >
        <div className="flex flex-col gap-3.5" data-testid="automations-dialog">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <Segmented
              label={t('auto.title', { board: board.name })}
              value={tab}
              onChange={setTab}
              options={(['manage', 'create', 'webhooks'] as const)
                .filter((k) => !((k === 'create' && !canManage) || (k === 'webhooks' && !canWebhooks)))
                .map((k) => ({ value: k, label: t(`auto.tab.${k}`), testId: `auto-tab-${k}` }))}
            />
            {canManage && tab === 'manage' ? (
              <Button
                variant="accent"
                onClick={() => setTab('create')}
                data-testid="auto-create"
                data-tour="automations.new"
              >
                <Icon name="plus" size={15} />
                {t('auto.list.create')}
              </Button>
            ) : null}
          </div>

          {tab === 'webhooks' ? (
            <WebhooksPanel board={board} />
          ) : tab === 'manage' ? (
            list.isLoading ? (
              <SkeletonRows rows={4} label={t('app.loading')} />
            ) : list.isError ? (
              <Notice tone="error">{errorMessage(list.error)}</Notice>
            ) : !rows.length ? (
              <div className="space-y-3 py-6 text-center">
                <p className="text-muted">{t('auto.list.empty')}</p>
                {canManage ? (
                  <Button onClick={() => setTab('create')} data-testid="auto-empty-create" data-tour="automations.new">
                    {t('auto.list.create')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <ul className="overflow-hidden rounded-[14px] border border-line" data-tour="automations.list">
                {[...rows]
                  // Broken ones float to the top (04 §8.2).
                  .sort((x, y) => Number(!!y.deactivated_reason) - Number(!!x.deactivated_reason))
                  .map((a) => (
                    <li
                      key={a.id}
                      className="flex items-start gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
                      data-testid="automation-row"
                      data-title={a.title}
                    >
                      <span className="mt-0.5 flex">
                        <Switch
                          on={a.is_active}
                          label={t('auto.list.toggle', { title: a.title })}
                          disabled={!a.can_manage || m.toggle.isPending}
                          onToggle={() => toggle(a)}
                        />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <p className="font-bold text-fg" data-testid="automation-sentence">
                          {recipeText(a.recipe, sb)}
                        </p>
                        {a.title !== recipeText(a.recipe, sb) ? <p className="text-xs text-muted">{a.title}</p> : null}
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                          {a.deactivated_reason ? (
                            <Badge tone="warn" data-testid="automation-broken">
                              {a.deactivated_reason === 'owner_review'
                                ? t('auto.list.owner_review')
                                : t('auto.list.needs_fixing')}
                            </Badge>
                          ) : null}
                          <span>
                            {t('auto.list.last_run')}: <LastRun iso={a.last_run_at} now={now} />
                          </span>
                          <span aria-hidden>·</span>
                          <span>{t('auto.list.runs', { n: a.run_count })}</span>
                          {a.last_error_at ? <Badge tone="danger">{t('auto.list.had_errors')}</Badge> : null}
                        </div>
                        {a.recipe.trigger.type === 'webhook_in' ? (
                          <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="automation-inbound">
                            <span className="text-muted">{t('auto.inbound.url')}:</span>
                            <code
                              dir="ltr"
                              className="break-all"
                            >{`${publicApiOrigin()}/api/v1/hooks/in/${a.id}`}</code>
                            <button
                              type="button"
                              className="underline"
                              onClick={() => copyText(`${publicApiOrigin()}/api/v1/hooks/in/${a.id}`)}
                            >
                              {t('tokens.copy')}
                            </button>
                            {a.can_manage && !(a.recipe.trigger as { secret?: string }).secret ? (
                              <span title={t('auto.inbound.no_secret_hint')} data-testid="automation-inbound-no-secret">
                                <Badge tone="warn">{t('auto.inbound.no_secret')}</Badge>
                              </span>
                            ) : null}
                          </p>
                        ) : null}
                        {a.note ? (
                          <p className="whitespace-pre-wrap text-xs text-muted" data-testid="automation-note">
                            {a.note}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1 max-md:hidden">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setHistory(a)}
                          data-testid="automation-history"
                        >
                          {t('auto.list.history')}
                        </Button>
                        {a.can_manage ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setTesting(a)}
                              data-testid="automation-test"
                            >
                              {t('auto.list.test')}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => setEditing({ draft: draftOf(a), existing: a })}
                              data-testid="automation-edit"
                            >
                              {t('auto.list.edit')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={t('common.delete')}
                              title={t('common.delete')}
                              className="w-8 px-0 text-muted hover:text-danger-fg"
                              onClick={() => void remove(a)}
                              data-testid="automation-delete"
                            >
                              <Icon name="trash" size={15} />
                            </Button>
                          </>
                        ) : null}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-haspopup="menu"
                        aria-label={t('menu.actions')}
                        title={t('menu.actions')}
                        className="w-8 shrink-0 px-0 text-muted"
                        data-testid="auto-row-menu"
                        onClick={(e) => {
                          setMenuFor(a);
                          rowMenu.fromTrigger(e);
                        }}
                      >
                        <DotsIcon />
                      </Button>
                    </li>
                  ))}
              </ul>
            )
          ) : (
            <TemplatePicker
              sb={sb}
              onCustom={() => setEditing({ draft: blankDraft() })}
              onPick={(x) => setEditing({ draft: structuredClone(x.draft) })}
            />
          )}
        </div>
      </Dialog>
      <Menu
        at={rowMenu.at}
        onClose={rowMenu.close}
        label={t('menu.actions')}
        items={menuFor ? menuItems(menuFor) : []}
      />
      {editing ? (
        <Builder
          board={board}
          members={members}
          filterCtx={filterCtx}
          initial={editing.draft}
          existing={editing.existing}
          onClose={() => {
            setEditing(null);
            setTab('manage');
          }}
        />
      ) : null}
      {testing ? <TestDialog board={board} automation={testing} onClose={() => setTesting(null)} /> : null}
      {history ? <RunsDialog automation={history} onClose={() => setHistory(null)} /> : null}
      {savingTemplate ? (
        <SaveTemplateDialog accountId={accountId} automation={savingTemplate} onClose={() => setSavingTemplate(null)} />
      ) : null}
    </>
  );
};

/** The board header button: the number of active automations, opens the center. */
export const AutomationsButton = ({ board, filterCtx }: { board: BoardDetail; filterCtx: FilterCtx }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const readable = !!board.capabilities['automation.read'];
  const list = useAutomations(accountId, board.id, readable);
  const [open, setOpen] = useState(false);
  if (!readable) return null;
  const active = (list.data?.data ?? []).filter((a) => a.is_active).length;
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        data-testid="board-automations"
        data-tour="board.automations"
        onClick={() => setOpen(true)}
      >
        <Icon name="bolt" size={15} />
        <span className="max-sm:sr-only">{t('auto.button')}</span>
        {active ? (
          <span
            className="rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-fg-2"
            data-testid="board-automations-count"
          >
            {active}
          </span>
        ) : null}
      </Button>
      {open ? <AutomationsDialog board={board} filterCtx={filterCtx} onClose={() => setOpen(false)} /> : null}
    </>
  );
};
