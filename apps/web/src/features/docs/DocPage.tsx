// SPDX-License-Identifier: AGPL-3.0-only
import { AreaBoundary } from '../../lib/error-screen';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { t, type DocDetail, type DocThread, type Me, type MessageKey, type MyAccount, msgKey } from '@bines/shared';
import { Avatar, Badge, Button, cn, Menu, MenuTrigger, Notice, scrollBehavior, SkeletonRows, type MenuEntry, useActionMenu } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDelete } from '../../lib/dialogs';
import { appLink, copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { useDeletedToast } from '../../lib/undo';
import { useMembers, type Member } from '../board/board-api';
import { useCollab, type CollabPeer, type CollabView } from './collab';
import { setPresencePrefs, usePresencePrefs, type PresencePrefs } from './presence-prefs';
import { docPath, docThreadKeys, useDoc, useDocMutations, useDocThreads, useFavoriteDocs } from './doc-api';
import { downloadDoc, printDoc } from './doc-export';
import { DocComments, type CommentDraft } from './DocComments';
import { DocShareDialog } from './DocShareDialog';
import { DocVersions } from './DocVersions';
import { GatedButton, PlanGateBanner, usePlanGate } from '../../lib/plan-gate';
import { gateMenuEntry } from '../../lib/plan-limit';
import { DocEditor } from './editor/DocEditor';
import { IconPicker } from './IconPicker';


/**
 * A doc (M8 ד1–ד3, D25): a full page in the workspace — or a side panel when it lives in an item's cell — edited
 * together live (everyone's caret and name in the text, who is here at the top, saved as you type, Yjs over
 * /api/v1/collab). Blocks, `/` and `@`, comments on blocks, versions, export and sharing. Viewers read it live;
 * owners rename, share and delete it. The F4 page anatomy of the workspace page.
 */
export const DocPage = ({
  account,
  me,
  docId,
  thread,
}: {
  account: MyAccount;
  me: Me;
  docId: string;
  /** Open the comments on this thread (a notification). */
  thread?: string;
}) => {
  const doc = useDoc(account.id, docId);
  if (doc.isPending)
    return (
      <main className="w-full px-4 py-5 md:px-6">
        <SkeletonRows rows={6} label={t('app.loading')} />
      </main>
    );
  if (!doc.data)
    return (
      <main className="w-full px-4 py-5 md:px-6" data-testid="doc-page-error">
        <Notice tone="error">{doc.error ? errorMessage(doc.error) : t('error.not_found')}</Notice>
      </main>
    );
  return (
    <main className="w-full px-4 py-5 md:px-6" data-testid="doc-page" data-doc-id={doc.data.id}>
      <DocView key={doc.data.id} account={account} me={me} doc={doc.data} thread={thread} variant="page" />
    </main>
  );
};

const KIND_TONE = { main: 'ok', private: 'violet', shareable: 'info' } as const;

export const DocView = ({
  account,
  me,
  doc,
  thread,
  variant,
}: {
  account: MyAccount;
  me: Me;
  doc: DocDetail;
  thread?: string;
  /** A full page, or the side panel of a cell doc (narrower, no own page chrome). */
  variant: 'page' | 'panel';
}) => {
  const live = useCollab(doc.collab_name);
  const presence = usePresencePrefs();
  const memberList = useMembers(account.id).data?.data;
  const members = useMemo(() => memberList ?? [], [memberList]);
  const mut = useDocMutations(account.id);
  const favorites = useFavoriteDocs(account.id);
  const deleted = useDeletedToast(account.id);
  const navigate = useNavigate();
  const menu = useActionMenu();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [history, setHistory] = useState(false);
  const [comments, setComments] = useState(!!thread);
  const [active, setActive] = useState<string | null>(thread ?? null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const threads = useDocThreads(account.id, doc.id);
  // Plan feature gate: without `docs` the editor opens read-only (the server says so) — rename
  // duplicate, share and versions stay visible but disabled with the hint, and a banner says why.
  const docsGate = usePlanGate(account.id, 'docs');
  const canManage = doc.capabilities['doc.manage'] && docsGate.allowed;
  const showManage = doc.capabilities['doc.manage'];
  const canComment = doc.capabilities['doc.comment'];
  const inCell = doc.host === 'cell';
  const favorite = favorites.isFavorite(doc.id);
  const path = docPath(account.slug, doc.id);

  // Someone else changed the comments (their presence says so): refetch them.
  const nudge = live?.commentsNudge ?? 0;
  const seenNudge = useRef(nudge);
  useEffect(() => {
    if (nudge === seenNudge.current) return;
    seenNudge.current = nudge;
    void qc.invalidateQueries({ queryKey: docThreadKeys(account.id, doc.id) });
    void qc.invalidateQueries({ queryKey: ['account', account.id, 'doc', doc.id] });
  }, [nudge, qc, account.id, doc.id]);
  const announceComments = () => live?.provider.setAwarenessField('comments', Date.now());

  const exportAs = (format: 'md' | 'html' | 'pdf') =>
    (format === 'pdf' ? printDoc(account.id, doc.id) : downloadDoc(account.id, doc, format)).catch((err: unknown) =>
      showToast({ message: errorMessage(err), tone: 'error' }),
    );

  const items: MenuEntry[] = [
    ...(!inCell
      ? [
          {
            label: t((favorite ? 'sidebar.unfavorite' : 'sidebar.favorite') as MessageKey),
            testId: 'doc-menu-favorite',
            disabled: !favorites.loaded,
            onSelect: () => favorites.toggle(doc),
          },
        ]
      : []),
    { label: t('menu.copyLink'), testId: 'doc-menu-copy-link', onSelect: () => copyText(appLink(path)) },
    gateMenuEntry(docsGate, {
      label: t('docs2.versions'),
      testId: 'doc-menu-versions',
      onSelect: () => setHistory(true),
    }),
    {
      kind: 'submenu',
      label: t('docs2.export'),
      testId: 'doc-menu-export',
      items: [
        { label: t('docs2.export.pdf'), testId: 'doc-export-pdf', onSelect: () => void exportAs('pdf') },
        { label: t('docs2.export.md'), testId: 'doc-export-md', onSelect: () => void exportAs('md') },
        { label: t('docs2.export.html'), testId: 'doc-export-html', onSelect: () => void exportAs('html') },
      ],
    },
    { kind: 'submenu', label: t('docs.presence.menu'), testId: 'doc-menu-presence', items: presenceToggles(presence) },
    ...((account.role === 'admin' || account.role === 'member') && !inCell
      ? [
          gateMenuEntry(docsGate, {
            label: t('docs.duplicate'),
            testId: 'doc-menu-duplicate',
            onSelect: () =>
              mut.duplicate.mutate(
                { id: doc.id },
                {
                  onSuccess: (copy) =>
                    void navigate({
                      to: '/a/$accountSlug/d/$docId',
                      params: { accountSlug: account.slug, docId: copy.id },
                    }),
                },
              ),
          }),
        ]
      : []),
    ...(showManage && !inCell
      ? [
          { kind: 'separator' as const },
          {
            label: t('menu.delete'),
            danger: true,
            testId: 'doc-menu-delete',
            onSelect: () =>
              void confirmDelete(doc.name).then(
                (ok) =>
                  ok &&
                  mut.remove.mutate(
                    { id: doc.id, name: doc.name },
                    {
                      onSuccess: (res) => {
                        deleted(doc.name, res);
                        void navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
                      },
                    },
                  ),
              ),
          },
        ]
      : []),
  ];

  const kindLabel = t(msgKey(`docs.kind.${doc.kind}`));
  const error = mut.update.error ?? mut.remove.error ?? mut.duplicate.error;
  const env = useMemo(
    () => ({ accountId: account.id, slug: account.slug, members, workspaceId: doc.workspace_id, docId: doc.id }),
    [account.id, account.slug, members, doc.workspace_id, doc.id],
  );
  const threadList = threads.data?.data ?? [];
  const openCount = threadList.filter((th) => !th.resolved_at).length;
  const showPanel = comments || !!draft;
  const selectThread = (th: DocThread) => {
    setActive(th.id);
    setComments(true);
    document
      .querySelector(`.doc-editor [data-id="${CSS.escape(th.block_id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  };

  return (
    <div
      className={cn(
        'mx-auto w-full',
        showPanel && variant === 'page' ? 'max-w-[1240px]' : doc.settings.full_width ? 'max-w-none' : 'max-w-[860px]',
      )}
      data-testid="doc-view"
      data-variant={variant}
    >
      <header className="flex flex-wrap items-start gap-3">
        <IconPicker
          value={doc.icon}
          disabled={!canManage}
          onChange={(icon) => mut.update.mutate({ id: doc.id, icon })}
        >
          <span
            aria-hidden
            className={cn(
              'grid shrink-0 place-items-center rounded-[14px] bg-info-soft text-info-fg',
              variant === 'panel' ? 'size-10' : 'size-12 max-md:size-10',
            )}
          >
            {doc.icon ? <span className="text-2xl">{doc.icon}</span> : <Icon name="file" size={24} />}
          </span>
        </IconPicker>
        <div className="min-w-0 flex-1 basis-64 space-y-1">
          {renaming ? (
            <TitleInput
              initial={doc.name}
              onDone={(name) => {
                setRenaming(false);
                if (name && name !== doc.name) mut.update.mutate({ id: doc.id, name });
              }}
            />
          ) : (
            <h1
              className={cn(
                'truncate font-display leading-tight font-extrabold tracking-[-0.6px] text-heading',
                variant === 'panel' ? 'text-[1.375rem]' : 'text-[1.875rem] max-md:text-2xl',
                canManage && 'cursor-text rounded-[8px] hover:bg-surface-2',
              )}
              data-testid="doc-title"
              data-tour="doc.title"
              title={canManage ? t('menu.rename') : undefined}
              onClick={canManage ? () => setRenaming(true) : undefined}
            >
              {doc.name}
            </h1>
          )}
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            {doc.cell ? (
              <Link
                to="/a/$accountSlug/b/$boardId/i/$itemId"
                params={{ accountSlug: account.slug, boardId: doc.cell.board_id, itemId: doc.cell.item_id }}
                className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                data-testid="doc-cell-item"
              >
                <Icon name="cards" size={13} />
                {t('docs2.cell.of', { item: doc.cell.item_name })}
              </Link>
            ) : account.role === 'guest' ? (
              // A guest sees only what was shared with them: "shared with you" says it plainly (round 16).
              <Badge tone="info">
                <span data-testid="doc-shared-with-you">{t('docs.sharedWithYou')}</span>
              </Badge>
            ) : (
              <Badge tone={KIND_TONE[doc.kind]}>
                <span data-testid="doc-kind" data-kind={doc.kind}>
                  {kindLabel}
                </span>
              </Badge>
            )}
            <SaveState live={live} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Presence live={live} meName={me.user.name} members={members} />
          <Button
            variant={showPanel ? 'secondary' : 'ghost'}
            onClick={() => setComments((v) => !v)}
            data-testid="doc-comments-toggle"
            aria-pressed={showPanel}
            title={t('docs2.comments')}
          >
            <Icon name="chat" size={15} />
            <span className="max-sm:hidden">{t('docs2.comments')}</span>
            {openCount ? (
              <span className="rounded-full bg-accent px-1.5 text-xs font-bold text-on-accent" data-testid="doc-comments-count">
                {openCount}
              </span>
            ) : null}
          </Button>
          {showManage && !inCell ? (
            <GatedButton
              gate={docsGate}
              upgrade={false}
              variant="secondary"
              onClick={() => setSharing(true)}
              data-testid="doc-share"
            >
              <Icon name="people" size={15} />
              <span className="max-sm:hidden">{t('docs.share')}</span>
            </GatedButton>
          ) : null}
          <div className="group">
            <MenuTrigger
              label={t('sidebar.actionsFor', { name: doc.name })}
              onClick={menu.fromTrigger}
              className="h-9 px-2 text-lg opacity-100"
            />
          </div>
          <Menu at={menu.at} onClose={menu.close} items={items} label={t('sidebar.actionsFor', { name: doc.name })} />
        </div>
      </header>

      {error ? (
        <div className="mt-3">
          <Notice tone="error">{errorMessage(error)}</Notice>
        </div>
      ) : null}

      <div
        className={cn(
          'mt-5 gap-5',
          showPanel && variant === 'page' ? 'grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start' : 'block',
        )}
      >
        <section aria-label={doc.name} className="min-w-0" data-tour="doc.editor">
          {!live ? (
            <SkeletonRows rows={6} label={t('app.loading')} />
          ) : live.failed ? (
            <div data-testid="doc-failed">
              <Notice tone="error">{t('docs.noAccess')}</Notice>
            </div>
          ) : (
            <>
              {docsGate.allowed ? null : (
                <div className="mb-3 overflow-hidden rounded-[10px]">
                  <PlanGateBanner gate={docsGate} />
                </div>
              )}
              {live.closed === 'too_large' ? (
                <div className="mb-3" data-testid="doc-too-large" role="alert">
                  <Notice tone="error">{t('docs.tooLarge')}</Notice>
                </div>
              ) : live.closed === 'too_fast' ? (
                <div className="mb-3" data-testid="doc-too-fast" role="status">
                  <Notice tone="info">{t('docs.tooFast')}</Notice>
                </div>
              ) : null}
              {live.readOnly && live.closed !== 'too_large' ? (
                <div className="mb-3" data-testid="doc-readonly">
                  <Notice tone="info">{t(msgKey(canComment ? 'docs2.readOnlyComment' : 'docs.readOnly'))}</Notice>
                </div>
              ) : null}
              {live.readOnly === null ? (
                <SkeletonRows rows={6} label={t('app.loading')} />
              ) : (
                // Round 12: a crash in the editor stays in the page body; the header and comments keep working.
                <AreaBoundary area="doc" resetKey={doc.id}>
                <DocEditor
                  live={live}
                  me={me}
                  env={env}
                  placeholder={t('docs2.placeholder')}
                  threads={threadList}
                  activeThread={active}
                  canComment={canComment}
                  onOpenThread={(id) => {
                    setActive(id);
                    setComments(true);
                  }}
                  onComment={(b) => {
                    setDraft({ block_id: b.id, quote: b.quote });
                    setComments(true);
                  }}
                />
                </AreaBoundary>
              )}
            </>
          )}
        </section>
        {showPanel ? (
          <div
            className={cn(
              variant === 'page'
                ? 'max-lg:fixed max-lg:inset-y-0 max-lg:end-0 max-lg:z-panel max-lg:w-[min(380px,100vw)] max-lg:shadow-[var(--shadow-panel)] lg:sticky lg:top-3 lg:h-[calc(100dvh-7rem)] lg:rounded-[var(--radius-lg)] lg:border lg:border-line'
                : 'mt-4 h-[60vh] rounded-[var(--radius-lg)] border border-line',
              'overflow-hidden',
            )}
          >
            <DocComments
              accountId={account.id}
              docId={doc.id}
              me={me}
              members={members}
              draft={draft ? { block_id: draft.block_id, quote: draft.quote } : null}
              active={active}
              onDraftDone={() => setDraft(null)}
              onSelect={selectThread}
              onClose={() => {
                setComments(false);
                setDraft(null);
                setActive(null);
              }}
              onChanged={announceComments}
            />
          </div>
        ) : null}
      </div>
      {sharing ? <DocShareDialog account={account} doc={doc} onClose={() => setSharing(false)} /> : null}
      {history ? (
        <DocVersions
          accountId={account.id}
          docId={doc.id}
          canEdit={doc.capabilities['doc.edit']}
          onClose={() => setHistory(false)}
        />
      ) : null}
    </div>
  );
};

/** "Saving… / Saved / Connecting…" — what happens to what I typed. */
const SaveState = ({ live }: { live: CollabView | null }) => {
  const state = !live || !live.connected ? 'connecting' : !live.synced || live.unsynced > 0 ? 'saving' : 'saved';
  const label = t(msgKey(`docs.state.${state}`));
  return (
    <span data-testid="doc-status" data-state={state} className="inline-flex items-center gap-1 text-xs">
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          state === 'saved' ? 'bg-ok' : state === 'saving' ? 'bg-accent' : 'bg-line-strong',
        )}
      />
      {label}
    </span>
  );
};

/** The live-presence switches: this person's, kept on this device. */
export const presenceToggles = (prefs: PresencePrefs): MenuEntry[] => [
  {
    label: t('docs.presence.showOthers'),
    checked: prefs.showOthers,
    keepOpen: true,
    testId: 'doc-presence-show-others',
    onSelect: () => setPresencePrefs({ showOthers: !prefs.showOthers }),
  },
  {
    label: t('docs.presence.shareMine'),
    checked: prefs.shareMine,
    keepOpen: true,
    testId: 'doc-presence-share-mine',
    onSelect: () => setPresencePrefs({ shareMine: !prefs.shareMine }),
  },
];

/** Scrolls to the block someone stands on and flashes it. */
const jumpToBlock = (block: string) => {
  const el = document.querySelector<HTMLElement>(`[data-testid="doc-editor"] [id="${CSS.escape(block)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  el.classList.remove('doc-peer-flash');
  void el.offsetWidth;
  el.classList.add('doc-peer-flash');
};

/**
 * Who else is in the doc now (their caret colour around the avatar; a dot while they type). A press opens the list:
 * each person (typing / viewing) — choosing one scrolls to where they stand — and the presence switches.
 */
const Presence = ({ live, meName, members }: { live: CollabView | null; meName: string; members: Member[] }) => {
  const menu = useActionMenu();
  const prefs = usePresencePrefs();
  const peers = live?.peers ?? [];
  if (!peers.length) return null;
  const shown = peers.slice(0, 4);
  const names = peers.map((p) => p.name).join(', ');
  const avatar = (p: CollabPeer) => members.find((m) => m.user_id === p.userId)?.avatar_url ?? null;
  const items: MenuEntry[] = [
    { kind: 'label', label: t('docs.presence.here', { count: peers.length }) },
    ...peers.map(
      (p): MenuEntry => ({
        label: `${p.name} · ${t(p.typing ? 'docs.presence.typing' : p.block ? 'docs.presence.at' : 'docs.presence.viewing')}`,
        icon: <Avatar name={p.name} url={avatar(p)} size={16} />,
        testId: 'doc-presence-person',
        disabled: !p.block,
        hint: p.block ? undefined : t('docs.presence.noBlock'),
        onSelect: () => p.block && jumpToBlock(p.block),
      }),
    ),
    { kind: 'separator' },
    ...presenceToggles(prefs),
  ];
  return (
    <>
      <button
        type="button"
        className="flex items-center -space-x-1.5 rounded-full rtl:space-x-reverse"
        data-testid="doc-presence"
        data-count={peers.length}
        aria-haspopup="menu"
        aria-label={t('docs.presence', { names, me: meName })}
        title={t('docs.presence', { names, me: meName })}
        onClick={menu.fromTrigger}
      >
        {shown.map((p) => (
          <span
            key={p.clientId}
            className="relative rounded-full ring-2"
            style={{ ['--tw-ring-color' as string]: p.color }}
            data-typing={p.typing || undefined}
          >
            <Avatar name={p.name} url={avatar(p)} size={28} />
            {p.typing ? (
              <span
                aria-hidden
                className="doc-presence-typing absolute -bottom-0.5 end-0 size-2.5 rounded-full ring-2 ring-surface"
                style={{ background: p.color }}
              />
            ) : null}
          </span>
        ))}
        {peers.length > shown.length ? (
          <span className="grid size-7 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-fg-2">
            +{peers.length - shown.length}
          </span>
        ) : null}
      </button>
      <Menu at={menu.at} onClose={menu.close} items={items} label={t('docs.presence', { names, me: meName })} />
    </>
  );
};

/** In-place title rename: Enter or blur saves, Esc cancels. */
const TitleInput = ({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) => {
  const [v, setV] = useState(initial);
  const finish = (save: boolean) => onDone(save && v.trim() ? v.trim() : null);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  return (
    <input
      autoFocus
      value={v}
      maxLength={255}
      aria-label={t('menu.rename')}
      data-testid="doc-title-input"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => finish(true)}
      className="h-11 w-full min-w-0 rounded-[10px] border border-primary bg-surface px-2 font-display text-[1.625rem] font-extrabold text-heading outline-none"
    />
  );
};
