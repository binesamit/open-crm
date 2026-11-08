// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { formatDateTime, t, type DocThread, type Me, msgKey } from '@bines/shared';
import { Avatar, Button, cn, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import type { Member } from '../board/board-api';
import { isEditorEmpty, RichEditorView, useRichEditor } from '../item/RichEditor';
import { UpdateBody } from '../item/UpdateBody';
import { useDocThreadMutations, useDocThreads } from './doc-api';


/**
 * Comments of a doc (M8 ד3) — the panel next to the doc: threads, each on one block (its quote; a click shows the
 * block), replies, mentions (the update composer), edit / delete one's own, resolve / reopen. Open ones by default,
 * resolved ones a click away; the count is on the doc's header button and next to each block.
 */
export type CommentDraft = { block_id: string; quote: string };

export const DocComments = ({
  accountId,
  docId,
  me,
  members,
  draft,
  active,
  onDraftDone,
  onSelect,
  onClose,
  onChanged,
}: {
  accountId: string;
  docId: string;
  me: Me;
  members: Member[];
  /** A new thread being written (from the toolbar's 💬 on a block). */
  draft: CommentDraft | null;
  active: string | null;
  onDraftDone: () => void;
  onSelect: (thread: DocThread) => void;
  onClose: () => void;
  /** After any change: tell the others in the doc. */
  onChanged: () => void;
}) => {
  const threads = useDocThreads(accountId, docId);
  const mut = useDocThreadMutations(accountId, docId, onChanged);
  // Chosen by the reader, else follows the active thread (a notification may open a resolved one).
  const [chosen, setFilter] = useState<'open' | 'resolved' | null>(null);
  const [chosenFor, setChosenFor] = useState(active);
  if (chosenFor !== active) {
    setChosenFor(active);
    setFilter(null);
  }
  const activeThread = threads.data?.data.find((th) => th.id === active);
  const filter = chosen ?? (activeThread?.resolved_at ? 'resolved' : 'open');
  const list = (threads.data?.data ?? []).filter((th) => (filter === 'open' ? !th.resolved_at : !!th.resolved_at));
  const canComment = threads.data?.can_comment ?? false;
  const error = mut.create.error ?? mut.reply.error ?? mut.resolve.error ?? mut.edit.error ?? mut.remove.error;
  const activeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active, threads.data]);

  return (
    <aside
      className="flex h-full min-h-0 flex-col bg-surface"
      data-testid="doc-comments"
      aria-label={t('docs2.comments')}
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
        <Icon name="chat" size={16} className="text-muted" />
        <h2 className="flex-1 font-display text-[1rem] font-extrabold text-heading">{t('docs2.comments')}</h2>
        <button
          type="button"
          className="grid size-8 place-items-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-fg"
          aria-label={t('common.close')}
          title={t('common.close')}
          data-testid="doc-comments-close"
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="border-b border-line-soft px-3 py-2">
        <Segmented
          label={t('docs2.comments')}
          value={filter}
          onChange={setFilter}
          testId="doc-comments-filter"
          options={[
            { value: 'open', label: t('docs2.comments.open'), testId: 'doc-comments-open' },
            { value: 'resolved', label: t('docs2.comments.resolved'), testId: 'doc-comments-resolved' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {draft && canComment ? (
          <div className="rounded-[var(--radius-lg)] border border-primary bg-surface p-2.5" data-testid="doc-comment-new">
            <Quote text={draft.quote} />
            <Composer
              members={members}
              placeholder={t('docs2.comment.placeholder')}
              autoFocus
              busy={mut.create.isPending}
              testId="doc-comment-send"
              onCancel={onDraftDone}
              onSend={(body) =>
                mut.create.mutate({ ...draft, body }, { onSuccess: (th) => (onDraftDone(), onSelect(th)) })
              }
            />
          </div>
        ) : null}
        {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
        {threads.isPending ? (
          <SkeletonRows rows={3} label={t('app.loading')} />
        ) : !list.length && !draft ? (
          <p className="px-1 py-6 text-center text-sm text-muted" data-testid="doc-comments-empty">
            {t(msgKey(filter === 'open' ? 'docs2.comments.none' : 'docs2.comments.noneResolved'))}
          </p>
        ) : null}
        <ul className="space-y-3">
          {list.map((th) => (
            <li
              key={th.id}
              ref={th.id === active ? activeRef : undefined}
              data-testid="doc-thread"
              data-thread-id={th.id}
              data-block-id={th.block_id}
              data-resolved={th.resolved_at ? 'true' : 'false'}
              className={cn(
                'rounded-[var(--radius-lg)] border bg-surface p-2.5',
                th.id === active ? 'border-accent ring-3 ring-[var(--accent-soft)]' : 'border-line',
              )}
            >
              <button type="button" className="block w-full text-start" onClick={() => onSelect(th)}>
                <Quote text={th.quote} />
              </button>
              <ul className="space-y-2.5">
                {th.comments.map((c) => (
                  <CommentRow
                    key={c.id}
                    c={c}
                    members={members}
                    meId={me.user.id}
                    onEdit={(body) => mut.edit.mutate({ commentId: c.id, body })}
                    onDelete={() =>
                      void confirmDialog({
                        title: t('docs2.comment.delete'),
                        message: t('docs2.comment.deleteConfirm'),
                        confirmLabel: t('menu.delete'),
                        danger: true,
                      }).then((ok) => ok && mut.remove.mutate({ commentId: c.id }))
                    }
                  />
                ))}
              </ul>
              {canComment ? (
                <ThreadFooter
                  thread={th}
                  members={members}
                  busy={mut.reply.isPending || mut.resolve.isPending}
                  onReply={(body) => mut.reply.mutate({ threadId: th.id, body })}
                  onResolve={(resolved) => {
                    // Stay on this tab — the thread leaves it (following the active thread would jump along).
                    setFilter(filter);
                    mut.resolve.mutate({ threadId: th.id, resolved });
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
};

const Quote = ({ text }: { text: string }) =>
  text ? (
    <p
      className="mb-2 line-clamp-2 border-s-[3px] border-accent ps-2 text-xs text-fg-2"
      data-testid="doc-thread-quote"
    >
      {text}
    </p>
  ) : null;

const CommentRow = ({
  c,
  members,
  meId,
  onEdit,
  onDelete,
}: {
  c: DocThread['comments'][number];
  members: Member[];
  meId: string;
  onEdit: (body: unknown) => void;
  onDelete: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const author = members.find((m) => m.user_id === c.author?.id);
  const name = c.author?.name || author?.email || '?';
  return (
    <li data-testid="doc-comment" data-comment-id={c.id}>
      <div className="flex items-center gap-2">
        <Avatar name={name} url={author?.avatar_url} size={22} />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{name}</span>
        <span className="shrink-0 text-[0.6875rem] text-muted">{formatDateTime(c.created_at)}</span>
      </div>
      {editing ? (
        <div className="mt-1.5">
          <Composer
            members={members}
            initial={c.body}
            placeholder={t('docs2.comment.placeholder')}
            autoFocus
            testId="doc-comment-save"
            onCancel={() => setEditing(false)}
            onSend={(body) => {
              onEdit(body);
              setEditing(false);
            }}
          />
        </div>
      ) : (
        // Server-rendered through the shared allowlist (rich.ts); lists take their own text's direction.
        <UpdateBody html={c.html} className="mt-1 ps-[1.875rem] text-sm" testId="doc-comment-body" />
      )}
      {c.can_edit && !editing ? (
        <div className="mt-0.5 flex gap-2 ps-[1.875rem] text-xs">
          {c.author?.id === meId ? (
            <button type="button" className="text-muted hover:text-fg" data-testid="doc-comment-edit" onClick={() => setEditing(true)}>
              {t('item.edit')}
            </button>
          ) : null}
          <button type="button" className="text-muted hover:text-danger-fg" data-testid="doc-comment-delete" onClick={onDelete}>
            {t('menu.delete')}
          </button>
        </div>
      ) : null}
    </li>
  );
};

const ThreadFooter = ({
  thread,
  members,
  busy,
  onReply,
  onResolve,
}: {
  thread: DocThread;
  members: Member[];
  busy: boolean;
  onReply: (body: unknown) => void;
  onResolve: (resolved: boolean) => void;
}) => {
  const [replying, setReplying] = useState(false);
  if (replying)
    return (
      <div className="mt-2.5">
        <Composer
          members={members}
          placeholder={t('docs2.comment.reply')}
          autoFocus
          busy={busy}
          testId="doc-reply-send"
          onCancel={() => setReplying(false)}
          onSend={(body) => {
            onReply(body);
            setReplying(false);
          }}
        />
      </div>
    );
  return (
    <div className="mt-2.5 flex items-center gap-2">
      <Button variant="ghost" size="sm" data-testid="doc-thread-reply" onClick={() => setReplying(true)}>
        <Icon name="reply" size={14} />
        {t('docs2.comment.reply')}
      </Button>
      <span className="flex-1" />
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        data-testid={thread.resolved_at ? 'doc-thread-reopen' : 'doc-thread-resolve'}
        onClick={() => onResolve(!thread.resolved_at)}
      >
        <Icon name={thread.resolved_at ? 'restore' : 'check'} size={14} />
        {t(msgKey(thread.resolved_at ? 'docs2.comment.reopen' : 'docs2.comment.resolve'))}
      </Button>
    </div>
  );
};

/** The updates' rich editor, small: mentions (`@`), Ctrl+Enter sends. */
const Composer = ({
  members,
  placeholder,
  initial,
  autoFocus,
  busy,
  testId,
  onSend,
  onCancel,
}: {
  members: Member[];
  placeholder: string;
  initial?: unknown;
  autoFocus?: boolean;
  busy?: boolean;
  testId: string;
  onSend: (body: unknown) => void;
  onCancel: () => void;
}) => {
  const sendRef = useRef<() => void>(() => undefined);
  const { editor, mention } = useRichEditor({
    members,
    placeholder,
    initial: initial as never,
    autoFocus,
    onSubmit: () => sendRef.current(),
    contentClass: 'min-h-[3.5rem] p-2.5 text-sm',
  });
  useEffect(() => {
    sendRef.current = () => {
      if (!editor || isEditorEmpty(editor)) return;
      onSend(editor.getJSON());
    };
  });
  return (
    <RichEditorView
      editor={editor}
      mention={mention}
      members={members}
      footer={
        <div className="flex justify-end gap-2 border-t border-line-soft px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" busy={busy} data-testid={testId} onClick={() => sendRef.current()}>
            {t('docs2.comment.send')}
          </Button>
        </div>
      }
    />
  );
};
