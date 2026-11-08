// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { t, type MessageKey, type MyAccount } from '@bines/shared';
import { Badge, Button, cn, Input, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { GatedButton, usePlanGate } from '../../lib/plan-gate';
import { boardKeys, useTree, type WorkspaceTree } from '../board/board-api';
import { useDocMutations } from '../docs/doc-api';
import { NewBoardDialog } from '../shell/NewBoardDialog';
import { useFavorites } from '../shell/use-favorites';
import { WorkspaceMembers } from './WorkspaceMembers';

/**
 * A workspace's own page (account admin plan, product decision 3): its name and description (editable
 * by its editors), who sees it (open / closed), its folders and boards as cards or a list (open, star), and
 * "new board here". Reached from the workspace's ⋯ menu in the sidebar ("דף המרחב").
 */
type Tree = WorkspaceTree & { workspace: WorkspaceTree['workspace'] & { description?: string | null } };
type TreeBoard = WorkspaceTree['boards'][number];
type TreeFolder = WorkspaceTree['folders'][number];
type Layout = 'grid' | 'list';

const DESCRIPTION_MAX = 2000;

/** The folders depth-first in tree order, each with its path ("01 · מכירות / ארכיון"). */
const orderedFolders = (folders: TreeFolder[]) => {
  const out: { folder: TreeFolder; path: string }[] = [];
  const walk = (parent: string | null, prefix: string) => {
    for (const f of folders.filter((x) => x.parent_folder_id === parent)) {
      const path = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ folder: f, path });
      walk(f.id, path);
    }
  };
  walk(null, '');
  return out;
};

/** A 5-point star (favourite boards): filled when on (in every icon style), else in the user's style — the sidebar's. */
const StarIcon = ({ on }: { on: boolean }) =>
  on ? (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M12 3.5l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L12 16.8l-5.3 2.9 1.2-5.9-4.5-4.1 6-.7z" />
    </svg>
  ) : (
    <Icon name="star" size={16} />
  );

const LockIcon = () => <Icon name="lock" size={13} />;

export const WorkspacePage = ({ account, workspaceId }: { account: MyAccount; workspaceId: string }) => {
  const tree = useTree(account.id, workspaceId);
  const data = tree.data as Tree | undefined;
  const qc = useQueryClient();
  const favorites = useFavorites(account.id);
  const [layout, setLayout] = useState<Layout>('grid');
  const [renaming, setRenaming] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [newBoardIn, setNewBoardIn] = useState<string | null | undefined>(undefined); // undefined = closed

  const update = useMutation({
    mutationFn: (patch: { name?: string; description?: string | null; kind?: 'open' | 'closed' }) =>
      api(account.id).patch(`/workspaces/${workspaceId}`, patch),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: boardKeys.tree(account.id, workspaceId) }),
        qc.invalidateQueries({ queryKey: boardKeys.workspaces(account.id) }),
        // Closing it makes the one who closes it a member (fix6).
        qc.invalidateQueries({ queryKey: ['account', account.id, 'workspace', workspaceId] }),
      ]);
    },
  });

  if (tree.isPending)
    return (
      <main className="w-full px-4 py-5 md:px-6">
        <SkeletonRows rows={6} label={t('app.loading')} />
      </main>
    );
  if (!data)
    return (
      <main className="w-full px-4 py-5 md:px-6">
        <Notice tone="error">{tree.error ? errorMessage(tree.error) : t('error.not_found')}</Notice>
      </main>
    );

  const ws = data.workspace;
  const folders = orderedFolders(data.folders);
  const sections: { id: string | null; title: string; boards: TreeBoard[] }[] = [
    { id: null, title: t('workspace.noFolder'), boards: data.boards.filter((b) => !b.folder_id) },
    ...folders.map(({ folder, path }) => ({
      id: folder.id,
      title: path,
      boards: data.boards.filter((b) => b.folder_id === folder.id),
    })),
  ].filter((s) => s.boards.length);
  const closed = ws.kind === 'closed';

  return (
    <main className="w-full space-y-5 px-4 py-5 md:px-6" data-testid="workspace-page" data-workspace-id={ws.id}>
      <header className="flex flex-wrap items-start gap-3">
        <span
          aria-hidden
          className="grid size-12 shrink-0 place-items-center rounded-[14px] bg-accent font-display text-xl font-extrabold text-on-accent max-md:size-10 max-md:text-lg"
        >
          {ws.name.trim().charAt(0)}
        </span>
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          {renaming ? (
            <NameInput
              initial={ws.name}
              onDone={(name) => {
                setRenaming(false);
                if (name && name !== ws.name) update.mutate({ name });
              }}
            />
          ) : (
            <div className="flex min-w-0 items-center gap-1.5">
              <h1
                className="truncate font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl"
                data-testid="workspace-name"
              >
                {ws.name}
              </h1>
              {ws.can_edit ? (
                <button
                  type="button"
                  aria-label={t('workspace.rename')}
                  title={t('workspace.rename')}
                  data-testid="workspace-rename"
                  onClick={() => setRenaming(true)}
                  className="grid size-8 shrink-0 place-items-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <Icon name="edit" size={16} />
                </button>
              ) : null}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={closed ? 'violet' : 'ok'}>
              <span data-testid="workspace-kind-badge" data-kind={ws.kind} className="inline-flex items-center gap-1">
                {closed ? <LockIcon /> : null}
                {t((closed ? 'workspace.kind.closed' : 'workspace.kind.open') as MessageKey)}
              </span>
            </Badge>
            <span data-testid="workspace-counts">
              {t('workspace.boardsCount', { n: data.boards.length })} ·{' '}
              {t('workspace.foldersCount', { n: data.folders.length })}
            </span>
          </div>
        </div>
        {ws.can_create ? (
          <Button variant="accent" onClick={() => setNewBoardIn(null)} data-testid="workspace-new-board">
            <Icon name="plus" size={15} strokeWidth={2.4} />
            {t('workspace.newBoardHere')}
          </Button>
        ) : null}
      </header>

      {update.isError ? <Notice tone="error">{errorMessage(update.error)}</Notice> : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <section className="rounded-[var(--radius-lg)] border border-line bg-surface p-4" data-testid="workspace-about">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="font-display text-[1rem] leading-snug font-extrabold text-heading">
              {t('workspace.description')}
            </h2>
            {ws.can_edit && !describing ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="workspace-description-edit"
                onClick={() => setDescribing(true)}
              >
                <Icon name="edit" size={14} />
                {t((ws.description ? 'workspace.description.edit' : 'workspace.description.add') as MessageKey)}
              </Button>
            ) : null}
          </div>
          {describing ? (
            <DescriptionEditor
              initial={ws.description ?? ''}
              busy={update.isPending}
              onCancel={() => setDescribing(false)}
              onSave={(text) =>
                update.mutate({ description: text.trim() || null }, { onSuccess: () => setDescribing(false) })
              }
            />
          ) : ws.description ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg" data-testid="workspace-description">
              {ws.description}
            </p>
          ) : (
            <p className="text-sm text-muted" data-testid="workspace-description-empty">
              {t('workspace.description.none')}
            </p>
          )}
        </section>

        <section
          className="space-y-2 rounded-[var(--radius-lg)] border border-line bg-surface p-4"
          data-testid="workspace-access"
        >
          <h2 className="font-display text-[1rem] leading-snug font-extrabold text-heading">{t('workspace.access')}</h2>
          {ws.can_edit ? (
            <Segmented
              label={t('workspace.access')}
              testId="workspace-kind"
              value={ws.kind}
              onChange={(kind) => update.mutate({ kind })}
              options={[
                { value: 'open', label: t('workspace.kind.open'), testId: 'workspace-kind-open' },
                { value: 'closed', label: t('workspace.kind.closed'), testId: 'workspace-kind-closed' },
              ]}
            />
          ) : null}
          <p className="text-sm text-muted">
            {t((closed ? 'workspace.kind.closedHint' : 'workspace.kind.openHint') as MessageKey)}
          </p>
          {/* fix6: who is in it — a closed workspace is seen by its members (and admins) only. */}
          {account.role !== 'guest' ? (
            <div className="border-t border-line-soft pt-3">
              <WorkspaceMembers accountId={account.id} workspaceId={workspaceId} />
            </div>
          ) : null}
        </section>
      </div>

      <section className="space-y-3" data-testid="workspace-boards">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-[1.25rem] leading-snug font-extrabold text-heading">
            {t('workspace.boards')}
          </h2>
          {data.boards.length ? (
            <Segmented
              label={t('workspace.layout')}
              testId="workspace-layout"
              value={layout}
              onChange={setLayout}
              options={[
                { value: 'grid', label: t('workspace.layout.grid'), testId: 'workspace-layout-grid' },
                { value: 'list', label: t('workspace.layout.list'), testId: 'workspace-layout-list' },
              ]}
            />
          ) : null}
        </div>
        {!data.boards.length ? (
          <div className="rounded-[var(--radius-lg)] border border-dashed border-line-strong bg-surface-3 px-4 py-10 text-center">
            <p className="font-display text-[0.9375rem] font-bold text-heading" data-testid="workspace-empty">
              {t('workspace.empty')}
            </p>
            {ws.can_create ? (
              <Button variant="dashed" className="mt-3" onClick={() => setNewBoardIn(null)}>
                <Icon name="plus" size={14} strokeWidth={2} />
                {t('workspace.newBoardHere')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {sections.map((s) => (
          <div key={s.id ?? 'root'} data-testid="workspace-folder" data-name={s.title} className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg-2">
              <Icon name="folder" size={15} className="shrink-0 text-muted" />
              <span className="min-w-0 truncate">{s.title}</span>
              <span className="text-xs font-normal text-muted">{s.boards.length}</span>
              {ws.can_create ? (
                <button
                  type="button"
                  aria-label={`${t('workspace.newBoardHere')} — ${s.title}`}
                  title={t('workspace.newBoardHere')}
                  data-testid="workspace-folder-new-board"
                  onClick={() => setNewBoardIn(s.id)}
                  className="grid size-7 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <Icon name="plus" size={14} strokeWidth={2} />
                </button>
              ) : null}
            </div>
            <ul
              className={cn(
                layout === 'grid'
                  ? 'grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5 max-sm:grid-cols-1'
                  : 'overflow-hidden rounded-[14px] border border-line',
              )}
            >
              {s.boards.map((b) => (
                <BoardTile
                  key={b.id}
                  account={account}
                  board={b}
                  layout={layout}
                  on={favorites.isFavorite(b.id)}
                  disabled={!favorites.loaded}
                  onStar={() => favorites.toggle(b)}
                />
              ))}
            </ul>
          </div>
        ))}
      </section>

      <WorkspaceDocs account={account} tree={data} canCreate={ws.can_create} />

      {newBoardIn !== undefined ? (
        <NewBoardDialog account={account} tree={data} folderId={newBoardIn} onClose={() => setNewBoardIn(undefined)} />
      ) : null}
    </main>
  );
};

const BoardTile = ({
  account,
  board,
  layout,
  on,
  disabled,
  onStar,
}: {
  account: MyAccount;
  board: TreeBoard;
  layout: Layout;
  on: boolean;
  disabled: boolean;
  onStar: () => void;
}) => {
  const label = t((on ? 'sidebar.unfavorite' : 'sidebar.favorite') as MessageKey);
  const kindHint: ReactNode =
    board.kind === 'main' ? null : (
      <span className="inline-flex items-center gap-1 text-xs text-muted">
        {board.kind === 'private' ? <LockIcon /> : null}
        {t(`board.kind.${board.kind}.title` as MessageKey)}
      </span>
    );
  return (
    <li
      data-testid="workspace-board"
      data-name={board.name}
      className={cn(
        'group relative flex items-center gap-2.5 bg-surface',
        layout === 'grid'
          ? 'min-h-[4rem] rounded-[14px] border border-line px-3 py-2.5 hover:border-line-strong hover:shadow-sm'
          : 'border-b border-line-soft px-3 py-2 last:border-b-0 hover:bg-surface-2',
      )}
    >
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-primary-soft text-primary">
        <Icon name="board" size={16} />
      </span>
      <Link
        to="/a/$accountSlug/b/$boardId"
        params={{ accountSlug: account.slug, boardId: board.id }}
        data-testid="workspace-board-open"
        className="flex min-w-0 flex-1 flex-col after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
      >
        <span className="truncate font-semibold text-heading">{board.name}</span>
        {kindHint}
      </Link>
      <button
        type="button"
        aria-label={`${label}: ${board.name}`}
        title={label}
        aria-pressed={on}
        data-testid="workspace-board-favorite"
        disabled={disabled}
        onClick={onStar}
        className={cn(
          'relative z-[1] grid size-8 shrink-0 place-items-center rounded-[10px] hover:bg-surface-2',
          on
            ? 'text-[var(--rating)]'
            : 'text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-fg max-md:opacity-100',
        )}
      >
        <StarIcon on={on} />
      </button>
    </li>
  );
};

/** The workspace name, edited in place: Enter / blur saves, Escape cancels. */
const NameInput = ({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) => {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (save: boolean) => {
    if (done) return;
    setDone(true);
    onDone(save ? value.trim() || null : null);
  };
  return (
    <Input
      autoFocus
      maxLength={120}
      value={value}
      aria-label={t('workspace.rename')}
      data-testid="workspace-name-input"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className="max-w-md font-display text-xl font-extrabold"
    />
  );
};

const DescriptionEditor = ({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (text: string) => void;
}) => {
  const [text, setText] = useState(initial);
  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        rows={5}
        maxLength={DESCRIPTION_MAX}
        value={text}
        placeholder={t('workspace.description.placeholder')}
        aria-label={t('workspace.description')}
        data-testid="workspace-description-input"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        className="w-full resize-y rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm leading-relaxed text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel} data-testid="workspace-description-cancel">
          {t('common.cancel')}
        </Button>
        <Button size="sm" busy={busy} onClick={() => onSave(text)} data-testid="workspace-description-save">
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
};

/** The workspace's docs (M8 ד1 leftover): the ones I may open, in sidebar order, and "new doc here". */
const WorkspaceDocs = ({ account, tree, canCreate }: { account: MyAccount; tree: Tree; canCreate: boolean }) => {
  const docs = tree.entities.filter((e) => e.type === 'doc');
  const create = useDocMutations(account.id).create;
  const navigate = useNavigate();
  // Plan feature gate: without `docs` the button stays, disabled with the upgrade hint.
  const docsGate = usePlanGate(account.id, 'docs');
  const newDoc = () =>
    create.mutate(
      { workspaceId: tree.workspace.id, folder_id: null, name: t('docs.new') },
      {
        onSuccess: (doc) =>
          void navigate({ to: '/a/$accountSlug/d/$docId', params: { accountSlug: account.slug, docId: doc.id } }),
      },
    );
  if (!docs.length && !canCreate) return null;
  return (
    <section className="space-y-3" data-testid="workspace-docs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-[1.25rem] leading-snug font-extrabold text-heading">
          {t('docs2.workspace.docs')}
        </h2>
        {canCreate ? (
          <GatedButton
            gate={docsGate}
            variant="secondary"
            size="sm"
            busy={create.isPending}
            onClick={newDoc}
            data-testid="workspace-new-doc"
          >
            <Icon name="plus" size={14} strokeWidth={2.2} />
            {t('docs.new')}
          </GatedButton>
        ) : null}
      </div>
      {create.isError ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}
      {docs.length ? (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5 max-sm:grid-cols-1">
          {docs.map((d) => (
            <li
              key={d.id}
              data-testid="workspace-doc"
              data-name={d.name}
              className="relative flex min-h-[4rem] items-center gap-2.5 rounded-[14px] border border-line bg-surface px-3 py-2.5 hover:border-line-strong hover:shadow-sm"
            >
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-info-soft text-info-fg"
              >
                {d.icon ? <span className="text-base">{d.icon}</span> : <Icon name="file" size={16} />}
              </span>
              <Link
                to="/a/$accountSlug/d/$docId"
                params={{ accountSlug: account.slug, docId: d.id }}
                className="flex min-w-0 flex-1 flex-col after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              >
                <span className="truncate font-semibold text-heading">{d.name}</span>
                {d.kind !== 'main' ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted">
                    {d.kind === 'private' ? <LockIcon /> : null}
                    {t(`docs.kind.${d.kind}` as MessageKey)}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted" data-testid="workspace-docs-empty">
          {t('docs2.workspace.noDocs')}
        </p>
      )}
    </section>
  );
};
