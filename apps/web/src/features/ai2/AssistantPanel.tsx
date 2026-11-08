// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  aiToolLabel,
  hasMessage,
  localizeToolPreview,
  type AssistantAction,
  type AssistantContext,
  type AssistantMessage,
  type AssistantRef,
  type AssistantStatus,
  t,
  msgKey,
  dynamicKey,
} from '@bines/shared';
import { Badge, Button, cn, fieldDir, Picker } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { GatedButton, usePlanGate } from '../../lib/plan-gate';
import { showToast } from '../../lib/toast';
import { ActionDescriptionView } from '../ai/ActionDescription';
import { Markdown } from '../ai/Markdown';
import { money } from './AiCell';
import {
  ai2Keys,
  createConversation,
  decideActions,
  deleteConversation,
  streamMessage,
  useAssistantStatus,
  useChatAgents,
  useConversation,
  useConversations,
} from './ai2-api';
import { AttachmentChips, type ChatFile, MessageFiles, useChatAttachments } from './ChatAttachments';
import { MessageRefs, RefChips, RefSuggestions, useRefPicker } from './ChatRefs';
import { useMyTours } from '../tours/tours-api';
import { useLaunchTour } from '../tours/TourHost';

/** Why an approved action did not run, in words (ai2.reason.* / error.*); the code itself when neither exists. */
const actionError = (code: string) =>
  hasMessage(`ai2.reason.${code}`)
    ? t(dynamicKey(`ai2.reason.${code}`))
    : hasMessage(`error.${code}`)
      ? t(dynamicKey(`error.${code}`))
      : code;

/**
 * The AI assistant panel (the planning notes "AGENTS-MCP" מ12) on a board or an item card: a chat about that context as
 * the person themselves. The answer streams; what the assistant read is listed; every change it wants to make is
 * a card with "approve" / "reject" (nothing changes before that), approved cards run together as one batch with
 * undo. Conversations are kept per person per board / item (history, delete). When AI is off the panel says so,
 * with a link to the AI settings for admins.
 */
type Ctx = { accountId: string; slug: string; boardId: string; itemId?: string; title: string };
/**
 * Where else the panel opens: with no board (an account-level conversation — e.g. about an external
 * flow on the flows screen) and with a first message ready in the box (`prefill`: the context the person asked
 * about; they edit it and send). A prefilled panel starts a new conversation.
 */
/**
 * the panel opens anywhere (the shell's launcher, quick search) — on a document or a dashboard too, or with
 * nothing (the whole account).
 */
type PanelCtx = Omit<Ctx, 'boardId'> & { boardId?: string; docId?: string; dashboardId?: string; prefill?: string };

export const AssistantButton = ({ compact, ...ctx }: Ctx & { compact?: boolean }) => {
  const [open, setOpen] = useState(false);
  // Plan feature gate: without `ai` the launcher stays, disabled with the upgrade hint.
  const aiGate = usePlanGate(ctx.accountId, 'ai');
  return (
    <>
      <GatedButton
        gate={aiGate}
        upgrade={false}
        variant={compact ? 'ghost' : 'secondary'}
        size="sm"
        data-testid={ctx.itemId ? 'item-assistant' : 'board-assistant'}
        aria-pressed={open}
        title={t('ai2.assistant.title')}
        className={compact ? 'w-9 px-0 text-violet-fg' : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="sparkle" size={15} />
        {compact ? (
          <span className="sr-only">{t('ai2.assistant.title')}</span>
        ) : (
          <span className="max-sm:sr-only">{t('ai2.assistant.button')}</span>
        )}
      </GatedButton>
      {open && aiGate.allowed ? <AssistantPanel {...ctx} onClose={() => setOpen(false)} /> : null}
    </>
  );
};

type Pending = {
  text: string;
  reads: string[];
  actions: AssistantAction[];
  user: string;
  files: ChatFile[];
  refs: AssistantRef[];
};

const SUGGESTIONS = {
  board: ['ai2.suggest.summary', 'ai2.suggest.late', 'ai2.suggest.tasks'],
  item: ['ai2.suggest.itemSummary', 'ai2.suggest.itemNext', 'ai2.suggest.itemUpdate'],
  doc: ['ai2.suggest.docSummary', 'ai2.suggest.docTasks'],
  dashboard: ['ai2.suggest.dashboardTrends', 'ai2.suggest.dashboardRisks'],
  account: ['ai2.suggest.myDay', 'ai2.suggest.findBoard'],
} as const;

/** One place per chat (the server's rule): an item, else a board, else a document, else a dashboard. */
const contextOf = (p: Pick<PanelCtx, 'boardId' | 'itemId' | 'docId' | 'dashboardId'>, agentId: string) => {
  const place: AssistantContext = p.itemId
    ? { item_id: p.itemId }
    : p.boardId
      ? { board_id: p.boardId }
      : p.docId
        ? { doc_id: p.docId }
        : p.dashboardId
          ? { dashboard_id: p.dashboardId }
          : {};
  return { ...place, ...(agentId ? { agent_id: agentId } : {}) };
};

const kindOf = (ctx: AssistantContext): keyof typeof SUGGESTIONS =>
  ctx.item_id ? 'item' : ctx.board_id ? 'board' : ctx.doc_id ? 'doc' : ctx.dashboard_id ? 'dashboard' : 'account';

/**
 * The panel never opens while the account's plan stops AI (plan-lock: read-only, suspended, closed) or lacks it —
 * whoever asks for it (a button, a menu row, a shortcut, a link): it closes itself and renders nothing.
 */
export const AssistantPanel = (props: PanelCtx & { onClose: () => void }) => {
  const aiGate = usePlanGate(props.accountId, 'ai');
  const { onClose } = props;
  useEffect(() => {
    if (!aiGate.allowed) onClose();
  }, [aiGate.allowed, onClose]);
  return aiGate.allowed ? <AssistantPanelBody {...props} /> : null;
};

const AssistantPanelBody = ({
  accountId,
  slug,
  boardId,
  itemId,
  docId,
  dashboardId,
  title,
  prefill,
  onClose,
}: PanelCtx & { onClose: () => void }) => {
  const qc = useQueryClient();
  const status = useAssistantStatus(accountId);
  // who answers — the assistant ('') or one of the account's agents the person may chat with.
  const agents = useChatAgents(accountId).data?.data ?? [];
  const [picked, setAgentId] = useState<string | null>(null);
  // Until the person picks: the assistant — or, when it is off here but an agent is not, the first agent.
  const agentId = picked ?? (status.data && !status.data.available ? (agents[0]?.id ?? '') : '');
  const agent = agents.find((x) => x.id === agentId) ?? null;
  const available = agent ? true : !!status.data?.available;
  const ctx = contextOf({ boardId, itemId, docId, dashboardId }, agent ? agentId : '');
  const list = useConversations(accountId, ctx, available);
  // Prefilled: a new conversation about what the person opened it on.
  const [chosen, setChosen] = useState<string | null | undefined>(prefill ? null : undefined);
  // Until the person picks: the latest conversation here (or a new one).
  const convId = chosen === undefined ? (list.data?.data[0]?.id ?? null) : chosen;
  const conv = useConversation(accountId, convId);
  const [draft, setDraft] = useState(prefill ?? '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [history, setHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // files pasted, dropped or chosen — uploaded at once, sent with the next message.
  const attach = useChatAttachments(accountId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Sent images keep their local preview in the bubble (no new download right after sending).
  const [sentPreviews, setSentPreviews] = useState<Record<string, string>>({});
  // "@" points at an item, a board, a document or a dashboard — exact context for the answer.
  const picker = useRefPicker(accountId);
  const input = useRef<HTMLTextAreaElement>(null);
  const messages = conv.data?.messages ?? [];

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, pending?.text, pending?.actions.length]);

  const refreshBoard = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] }),
      qc.invalidateQueries({ queryKey: ['account', accountId, 'item'] }),
    ]);

  const send = async (text: string) => {
    const body = text.trim();
    if ((!body && !attach.files.length && !picker.refs.length) || pending || attach.uploading) return;
    setDraft('');
    const files = attach.take();
    const refs = picker.take();
    setSentPreviews((x) => ({
      ...x,
      ...Object.fromEntries(files.flatMap((f) => (f.preview ? [[f.id, f.preview]] : []))),
    }));
    setPending({ text: '', reads: [], actions: [], user: body, files, refs });
    try {
      let id = convId;
      if (!id) {
        const created = await createConversation(accountId, ctx);
        id = created.id;
        // Seed the new conversation so selecting it does not start a GET: a fast answer can end while that first
        // GET is still in flight, and the refresh below would then reuse its (empty) result.
        qc.setQueryData(ai2Keys.conversation(accountId, id), { conversation: created, messages: [] });
        setChosen(id);
      }
      let failed: string | null = null;
      await streamMessage(
        accountId,
        id,
        body,
        (e) => {
          if (e.type === 'delta') setPending((p) => (p ? { ...p, text: p.text + e.text } : p));
          else if (e.type === 'read') setPending((p) => (p ? { ...p, reads: [...p.reads, e.tool] } : p));
          else if (e.type === 'action') setPending((p) => (p ? { ...p, actions: [...p.actions, e.action] } : p));
          else if (e.type === 'error') failed = e.code;
        },
        files.map((f) => f.id),
        refs.map((r) => ({ type: r.type, id: r.id })),
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: ai2Keys.conversation(accountId, id) }),
        qc.invalidateQueries({ queryKey: ['account', accountId, 'assistant', 'conversations'] }),
      ]);
      if (failed) showToast({ message: t(dynamicKey(`ai2.reason.${failed}`)), tone: 'error' });
    } catch (e) {
      setDraft(body);
      attach.restore(files);
      picker.restore(refs);
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setPending(null);
    }
  };

  const decide = async (m: AssistantMessage, approve: string[], reject: string[]) => {
    try {
      const res = await decideActions(accountId, m.id, { approve, reject });
      qc.setQueryData(ai2Keys.conversation(accountId, convId ?? ''), (old: typeof conv.data) =>
        old ? { ...old, messages: old.messages.map((x) => (x.id === m.id ? res.message : x)) } : old,
      );
      const failed = res.message.actions.filter((x) => approve.includes(x.id) && x.status === 'failed').length;
      if (res.batch_id) {
        await refreshBoard();
        const batch = res.batch_id;
        showToast({
          message: t('ai2.assistant.applied', { n: approve.length - failed }),
          action: { label: t('undo.action'), run: () => void undo(batch) },
        });
      }
      if (failed) showToast({ message: t('ai2.assistant.someFailed', { n: failed }), tone: 'error' });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    }
  };
  const undo = async (batchId: string) => {
    try {
      await api(accountId).post(`/activity/batches/${batchId}/undo`, {});
      await refreshBoard();
      showToast({ message: t('ai2.assistant.undone') });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    }
  };

  // A chosen suggestion: "@query" becomes "@name " in the text, the caret after it.
  const pickRef = (s: Parameters<typeof picker.choose>[0]) => {
    const el = input.current;
    const done = picker.choose(s, draft, el?.selectionStart ?? draft.length);
    if (!done) return;
    setDraft(done.text);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(done.caret, done.caret);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!e.nativeEvent.isComposing && picker.onKeyDown(e, pickRef)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  // A pasted screenshot / file is attached (text on the clipboard with it still pastes as usual).
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData?.files;
    if (!files?.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    void attach.add(files);
  };
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!available || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    setDragging(false);
    if (!available || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    void attach.add(e.dataTransfer.files);
  };
  const withPreview = (files: ChatFile[]) =>
    files.map((f) => (sentPreviews[f.id] ? { ...f, preview: sentPreviews[f.id] } : f));

  const panel = (
    <aside
      role="complementary"
      aria-label={t('ai2.assistant.title')}
      data-testid="assistant-panel"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
      className="anim-from-end fixed inset-y-0 end-0 z-panel flex w-[min(420px,100vw)] flex-col border-s border-line bg-surface shadow-[var(--shadow-pop)]"
    >
      {dragging ? (
        <div
          className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-[14px] border-2 border-dashed border-primary bg-[var(--accent-soft)] text-sm text-fg"
          data-testid="assistant-drop"
        >
          {t('ai2.assistant.dropHint')}
        </div>
      ) : null}
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="grid size-8 place-items-center rounded-[10px] bg-violet-soft text-violet-fg">
          <Icon name="sparkle" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          {agents.length ? (
            // chat with the assistant or with one of the account's agents.
            <Picker
              value={agentId}
              label={t('ai2.assistant.who')}
              testId="assistant-agent"
              className="h-8 max-w-[220px] font-display text-[0.9375rem] font-bold text-heading"
              options={[
                { value: '', label: t('ai2.assistant.title'), testId: 'assistant-agent-assistant' },
                ...agents.map((x) => ({
                  value: x.id,
                  label: x.name,
                  hint: x.role || undefined,
                  testId: `assistant-agent-${x.id}`,
                })),
              ]}
              onChange={(v) => {
                setAgentId(v);
                setChosen(undefined);
                setHistory(false);
              }}
            />
          ) : (
            <h2 className="font-display text-[0.9375rem] font-bold text-heading">{t('ai2.assistant.title')}</h2>
          )}
          <p className="truncate text-xs text-muted" dir="auto" data-testid="assistant-context">
            {title}
          </p>
        </div>
        {available ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="w-8 px-0"
              title={t('ai2.assistant.history')}
              aria-label={t('ai2.assistant.history')}
              aria-pressed={history}
              data-testid="assistant-history"
              onClick={() => setHistory((h) => !h)}
            >
              <Icon name="history" size={16} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-8 px-0"
              title={t('ai2.assistant.new')}
              aria-label={t('ai2.assistant.new')}
              data-testid="assistant-new"
              disabled={!!pending}
              onClick={() => {
                setChosen(null);
                setHistory(false);
              }}
            >
              <Icon name="plus" size={16} />
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="w-8 px-0"
          aria-label={t('common.close')}
          title={t('common.close')}
          data-testid="assistant-close"
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </Button>
      </header>

      {status.data && !available && !agent ? (
        <Unavailable status={status.data} slug={slug} />
      ) : history ? (
        <div className="flex-1 overflow-auto p-2" data-testid="assistant-conversations">
          {(list.data?.data ?? []).length === 0 ? (
            <p className="p-4 text-center text-sm text-muted">{t('ai2.assistant.noHistory')}</p>
          ) : null}
          {(list.data?.data ?? []).map((c) => (
            <div
              key={c.id}
              data-testid="assistant-conversation"
              className={cn(
                'group flex items-center gap-2 rounded-[10px] px-2.5 py-2 hover:bg-surface-2',
                c.id === convId && 'bg-surface-2',
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-start"
                onClick={() => {
                  setChosen(c.id);
                  setHistory(false);
                }}
              >
                <span className="block truncate text-sm font-semibold" dir="auto">
                  {c.title || t('ai2.assistant.untitled')}
                </span>
                <span className="text-xs text-muted">
                  {new Date(c.updated_at).toLocaleString()} · {money(c.cost_usd)}
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="w-8 px-0 text-muted"
                aria-label={t('common.delete')}
                title={t('common.delete')}
                data-testid="assistant-conversation-delete"
                onClick={() =>
                  void confirmDialog({
                    title: t('ai2.assistant.deleteTitle'),
                    message: t('ai2.assistant.deleteMessage'),
                    confirmLabel: t('common.delete'),
                    danger: true,
                  }).then(async (ok) => {
                    if (!ok) return;
                    await deleteConversation(accountId, c.id);
                    if (c.id === convId) setChosen(null);
                    await qc.invalidateQueries({ queryKey: ['account', accountId, 'assistant', 'conversations'] });
                  })
                }
              >
                <Icon name="trash" size={15} />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div
            ref={scroller}
            className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3"
            data-testid="assistant-messages"
          >
            {!messages.length && !pending ? (
              <div className="mt-6 flex flex-col items-center gap-3 text-center">
                <p className="text-sm text-fg-2">{t('ai2.assistant.intro')}</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {SUGGESTIONS[kindOf(ctx)].map((s) => (
                    <button
                      key={s}
                      type="button"
                      data-testid="assistant-suggestion"
                      onClick={() => void send(t(msgKey(s)))}
                      className="rounded-full border border-line px-3 py-1 text-xs text-fg-2 hover:border-primary hover:text-fg"
                    >
                      {t(msgKey(s))}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {messages.map((m) => (
              <Message
                key={m.id}
                m={m}
                accountId={accountId}
                files={withPreview(m.files ?? [])}
                slug={slug}
                busy={!!pending}
                onDecide={decide}
                onUndo={undo}
              />
            ))}
            {pending ? (
              <>
                <UserBubble
                  text={pending.user}
                  accountId={accountId}
                  files={pending.files}
                  slug={slug}
                  refs={pending.refs}
                />
                <div className="flex flex-col gap-2" data-testid="assistant-streaming">
                  <Reads reads={pending.reads} />
                  {pending.text ? (
                    <Markdown text={pending.text} testId="assistant-streaming-text" />
                  ) : (
                    <span className="flex items-center gap-2 text-xs text-muted">
                      <span className="size-3.5 animate-spin rounded-full border-2 border-[var(--line)] border-e-[var(--primary)]" />
                      {t('ai2.assistant.thinking')}
                    </span>
                  )}
                  {pending.actions.map((x) => (
                    <ActionCard key={x.id} a={x} />
                  ))}
                </div>
              </>
            ) : null}
          </div>
          <div className="border-t border-line p-3">
            <AttachmentChips files={attach.files} onRemove={attach.remove} />
            <RefChips refs={picker.refs} onRemove={picker.remove} />
            {attach.error ? (
              <p className="pb-1.5 text-xs text-danger-fg" data-testid="assistant-attach-error">
                {attach.error}
              </p>
            ) : null}
            <div className="relative flex items-end gap-2 rounded-[12px] border border-line-strong bg-surface p-1.5 focus-within:border-primary">
              <RefSuggestions picker={picker} onPick={pickRef} />
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                data-testid="assistant-file-input"
                onChange={(e) => {
                  void attach.add(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                className="w-9 px-0 text-muted"
                aria-label={t('ai2.assistant.attach')}
                title={t('ai2.assistant.attach')}
                data-testid="assistant-attach"
                busy={attach.uploading}
                onClick={() => fileInput.current?.click()}
              >
                <Icon name="clip" size={15} />
              </Button>
              <textarea
                ref={input}
                value={draft}
                rows={2}
                dir={fieldDir(draft)}
                maxLength={8000}
                data-testid="assistant-input"
                placeholder={t('ai2.assistant.placeholder')}
                onChange={(e) => {
                  setDraft(e.target.value);
                  picker.track(e.target.value, e.target.selectionStart ?? e.target.value.length);
                }}
                onSelect={(e) => picker.track(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                onBlur={() => picker.track('', 0)}
                aria-autocomplete="list"
                onKeyDown={onKey}
                onPaste={onPaste}
                className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1.5 py-1 text-sm focus:outline-none"
              />
              <Button
                size="sm"
                data-testid="assistant-send"
                aria-label={t('ai2.assistant.send')}
                title={t('ai2.assistant.send')}
                disabled={
                  (!draft.trim() && !attach.files.length && !picker.refs.length) || !!pending || attach.uploading
                }
                onClick={() => void send(draft)}
                className="w-9 px-0"
              >
                <Icon name="send" size={15} />
              </Button>
            </div>
            <p className="mt-1.5 text-[0.6875rem] text-muted">{t('ai2.assistant.footer')}</p>
          </div>
        </>
      )}
    </aside>
  );
  return createPortal(panel, document.body);
};

const Unavailable = ({ status, slug }: { status: AssistantStatus; slug: string }) => (
  <div
    className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    data-testid="assistant-unavailable"
    data-reason={status.reason}
  >
    <span className="grid size-12 place-items-center rounded-full bg-violet-soft text-violet-fg">
      <Icon name="sparkle" size={22} />
    </span>
    <p className="text-sm text-fg-2">{t(msgKey(`ai2.assistant.off.${status.reason ?? 'ai_disabled'}`))}</p>
    {status.can_configure ? (
      <Link
        to="/a/$accountSlug/admin/$section"
        params={{ accountSlug: slug, section: 'ai' }}
        className="text-sm font-semibold text-primary underline"
        data-testid="assistant-settings-link"
      >
        {t('ai2.settingsLink')}
      </Link>
    ) : (
      <p className="text-xs text-muted">{t('ai2.assistant.askAdmin')}</p>
    )}
  </div>
);

const UserBubble = ({
  text,
  accountId,
  files,
  slug,
  refs,
}: {
  text: string;
  accountId: string;
  files: ChatFile[];
  slug: string;
  refs: AssistantRef[];
}) => (
  <div className="flex flex-col items-end gap-1.5" data-testid="assistant-message" data-role="user">
    <MessageFiles accountId={accountId} files={files} />
    <MessageRefs slug={slug} refs={refs} />
    {text ? (
      <p
        className="max-w-[85%] rounded-[14px] rounded-ee-[4px] bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-on-primary [overflow-wrap:anywhere]"
        dir="auto"
      >
        {text}
      </p>
    ) : null}
  </div>
);

/** A tool's name for people (i18n), or the API's own title / name when there is none. */
const toolLabel = (tool: string, fallback: string) => aiToolLabel(tool, fallback);

/** "Show me": the guided tours the assistant offered — each runs on the person's screen. */
const ShowMeButtons = ({
  accountId,
  slug,
  tours,
}: {
  accountId: string;
  slug: string;
  tours: { id: string; title: string }[];
}) => {
  const mine = useMyTours(accountId, tours.length > 0).data;
  const launch = useLaunchTour({ slug });
  const runnable = tours.flatMap((x) => {
    const tour = mine?.enabled ? mine.tours.find((y) => y.id === x.id) : undefined;
    return tour ? [tour] : [];
  });
  if (!runnable.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="assistant-show-me">
      {runnable.map((tour) => (
        <Button key={tour.id} size="sm" variant="secondary" className="font-normal" onClick={() => launch(tour)}>
          <Icon name="play" size={12} />
          {t('ai2.showMe', { title: tour.title })}
        </Button>
      ))}
    </div>
  );
};

const Reads = ({ reads }: { reads: string[] }) =>
  reads.length ? (
    <div className="flex flex-wrap gap-1" data-testid="assistant-reads">
      {[...new Set(reads)].map((r) => (
        <Badge key={r}>
          <Icon name="search" size={12} />
          {toolLabel(r, r)}
        </Badge>
      ))}
    </div>
  ) : null;

const ActionCard = ({
  a,
  busy,
  onApprove,
  onReject,
}: {
  a: AssistantAction;
  busy?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}) => (
  <div
    className="rounded-[12px] border border-line bg-surface-2 p-2.5"
    data-testid="assistant-action"
    data-status={a.status}
    data-tool={a.tool}
  >
    <div className="flex items-center gap-2">
      <Icon name="edit" size={14} />
      <span className="flex-1 truncate text-sm font-semibold">{toolLabel(a.tool, a.title)}</span>
      <Badge
        tone={
          a.status === 'done' ? 'ok' : a.status === 'pending' ? 'warn' : a.status === 'failed' ? 'danger' : 'neutral'
        }
      >
        {t(msgKey(`ai2.action.${a.status}`))}
      </Badge>
    </div>
    {/* In words with real names; the JSON only behind "technical details" (sync-ai). */}
    <div className="mt-1" data-testid="assistant-action-preview">
      <ActionDescriptionView
        description={a.description}
        toolLabel={a.description ? toolLabel(a.tool, a.title) : localizeToolPreview(a.preview)}
        input={a.input}
        sentenceClassName="text-[0.8125rem]"
      />
    </div>
    {a.error ? (
      <p className="mt-1 text-xs text-danger-fg" data-testid="assistant-action-error" data-code={a.error}>
        {actionError(a.error)}
      </p>
    ) : null}
    {a.status === 'pending' && onApprove ? (
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" data-testid="assistant-approve" disabled={busy} onClick={onApprove}>
          {t('ai2.action.approve')}
        </Button>
        <Button size="sm" variant="ghost" data-testid="assistant-reject" disabled={busy} onClick={onReject}>
          {t('ai2.action.reject')}
        </Button>
      </div>
    ) : null}
  </div>
);

const Message = ({
  m,
  accountId,
  files,
  slug,
  busy,
  onDecide,
  onUndo,
}: {
  m: AssistantMessage;
  accountId: string;
  files: ChatFile[];
  slug: string;
  busy: boolean;
  onDecide: (m: AssistantMessage, approve: string[], reject: string[]) => Promise<void>;
  onUndo: (batchId: string) => Promise<void>;
}) => {
  const [deciding, setDeciding] = useState(false);
  if (m.role === 'user')
    return <UserBubble text={m.text} accountId={accountId} files={files} slug={slug} refs={m.refs ?? []} />;
  const pending = m.actions.filter((x) => x.status === 'pending');
  const batches = [...new Set(m.actions.flatMap((x) => (x.batch_id ? [x.batch_id] : [])))];
  const decide = async (approve: string[], reject: string[]) => {
    setDeciding(true);
    try {
      await onDecide(m, approve, reject);
    } finally {
      setDeciding(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="assistant-message" data-role="assistant">
      <Reads reads={m.reads} />
      {m.text ? <Markdown text={m.text} testId="assistant-text" /> : null}
      <ShowMeButtons accountId={accountId} slug={slug} tours={m.tours ?? []} />
      {m.error ? (
        <p className="text-xs text-danger-fg" data-testid="assistant-error">
          {t(dynamicKey(`ai2.reason.${m.error}`))}
        </p>
      ) : null}
      {m.actions.map((x) => (
        <ActionCard
          key={x.id}
          a={x}
          busy={busy || deciding}
          onApprove={() => void decide([x.id], [])}
          onReject={() => void decide([], [x.id])}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
        {pending.length > 1 ? (
          <Button
            size="sm"
            variant="secondary"
            data-testid="assistant-approve-all"
            disabled={busy || deciding}
            onClick={() =>
              void decide(
                pending.map((x) => x.id),
                [],
              )
            }
          >
            {t('ai2.action.approveAll', { n: pending.length })}
          </Button>
        ) : null}
        {batches.map((b) => (
          <Button key={b} size="sm" variant="ghost" data-testid="assistant-undo" onClick={() => void onUndo(b)}>
            <Icon name="restore" size={13} />
            {t('undo.action')}
          </Button>
        ))}
        <span className="ms-auto" data-testid="assistant-cost">
          {money(m.cost_usd)}
        </span>
      </div>
    </div>
  );
};
