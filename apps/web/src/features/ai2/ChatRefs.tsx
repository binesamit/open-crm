// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AssistantRef,
  type AssistantRefType,
  MAX_ASSISTANT_REFS,
  type MessageKey,
  type SearchResult,
  t,
} from '@bines/shared';
import { cn } from '@bines/ui';
import { api } from '../../lib/api';
import { Icon, type IconName } from '../../lib/icons';

/**
 * "@" in the AI chat (product owner: "choose items or boards… to be specific, from anywhere"): typing "@" and a
 * few letters in the message box lists the items, boards, documents and dashboards the person can open (the quick
 * search's own results — its access rules); choosing one puts "@name" in the text and adds it to the message as a
 * reference, so the answer gets exactly that thing as context. References show as chips (one can be taken off) and
 * on the sent message as links.
 */
const KIND_ICON: Record<AssistantRefType, IconName> = {
  item: 'table',
  board: 'board',
  doc: 'file',
  dashboard: 'dashboard',
};
const KIND_LABEL: Record<AssistantRefType, MessageKey> = {
  item: 'ai2.refs.items',
  board: 'ai2.refs.boards',
  doc: 'ai2.refs.docs',
  dashboard: 'ai2.refs.dashboards',
};

/** Per kind, at most this many suggestions. */
const PER_KIND = { item: 6, board: 4, doc: 4, dashboard: 3 } as const;

/** The "@word" being typed right before the caret (null = none): letters after an "@" at a word start. */
export const mentionAt = (text: string, caret: number): { start: number; query: string } | null => {
  const m = /(^|\s)@([^\s@]{0,40})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, query: m[2]! } : null;
};

/** The suggestions for a query, in groups: items, boards, documents, dashboards. */
export const refSuggestions = (r: SearchResult | undefined): AssistantRef[] =>
  r
    ? [
        ...r.items
          .filter((i) => !i.archived)
          .slice(0, PER_KIND.item)
          .map((i) => ({ type: 'item' as const, id: i.id, name: i.name, board_id: i.board.id, where: i.board.name })),
        ...r.boards
          .slice(0, PER_KIND.board)
          .map((b) => ({ type: 'board' as const, id: b.id, name: b.name, board_id: null })),
        ...r.docs.slice(0, PER_KIND.doc).map((d) => ({ type: 'doc' as const, id: d.id, name: d.name, board_id: null })),
        ...(r.dashboards ?? [])
          .slice(0, PER_KIND.dashboard)
          .map((d) => ({ type: 'dashboard' as const, id: d.id, name: d.name, board_id: null })),
      ]
    : [];

type Suggestion = AssistantRef & { where?: string };

/**
 * The picker's state for a message box: what is typed after "@", the suggestions, the highlighted one, and the
 * references chosen so far. `onKeyDown` takes ↑ / ↓ / Enter / Tab / Esc while the list is open (true = handled).
 */
export const useRefPicker = (accountId: string) => {
  const [refs, setRefs] = useState<AssistantRef[]>([]);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  // Esc hides the list for the "@word" as it is; typing on (a new word) shows it again.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const q = mention?.query ?? '';
  const search = useQuery({
    queryKey: ['account', accountId, 'assistant-refs', q],
    queryFn: () => api(accountId).get<SearchResult>(`/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
    staleTime: 30_000,
  });
  const open = !!mention && dismissed !== `${mention.start}:${mention.query}`;
  const list: Suggestion[] = open && q.length >= 2 ? refSuggestions(search.data) : [];
  /** After every change of the text or the caret. */
  const track = (text: string, caret: number) => {
    const next = mentionAt(text, caret);
    if (next?.start !== mention?.start || next?.query !== mention?.query) setActive(0);
    setMention(next);
    if (!next) setDismissed(null);
  };
  /** Chooses a suggestion: "@query" becomes "@name ", the reference is added; returns the new text and caret. */
  const choose = (s: Suggestion, text: string, caret: number) => {
    const at = mention ?? mentionAt(text, caret);
    if (!at) return null;
    const label = `@${s.name} `;
    const next = text.slice(0, at.start) + label + text.slice(caret);
    setRefs((x) =>
      x.some((r) => r.type === s.type && r.id === s.id) || x.length >= MAX_ASSISTANT_REFS
        ? x
        : [...x, { type: s.type, id: s.id, name: s.name, board_id: s.board_id }],
    );
    setMention(null);
    return { text: next, caret: at.start + label.length };
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, apply: (s: Suggestion) => void) => {
    if (!open) return false;
    if (e.key === 'Escape') {
      // Esc closes the list only (not the panel).
      e.preventDefault();
      e.stopPropagation();
      setDismissed(`${mention!.start}:${mention!.query}`);
      return true;
    }
    if (!list.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      apply(list[Math.min(active, list.length - 1)]!);
      return true;
    }
    return false;
  };
  return {
    refs,
    remove: (r: AssistantRef) => setRefs((x) => x.filter((y) => !(y.type === r.type && y.id === r.id))),
    take: () => {
      const out = refs;
      setRefs([]);
      return out;
    },
    restore: (back: AssistantRef[]) => setRefs(back),
    open,
    query: q,
    loading: search.isFetching,
    list,
    active,
    setActive,
    track,
    choose,
    onKeyDown,
  };
};

/** The suggestion list, above the message box. */
export const RefSuggestions = ({
  picker,
  onPick,
}: {
  picker: ReturnType<typeof useRefPicker>;
  onPick: (s: Suggestion) => void;
}) => {
  if (!picker.open) return null;
  let kind: AssistantRefType | null = null;
  return (
    <div
      role="listbox"
      aria-label={t('ai2.refs.title')}
      data-testid="assistant-ref-list"
      className="absolute inset-x-0 bottom-full mb-1.5 max-h-72 overflow-auto rounded-[12px] border border-line bg-surface p-1 shadow-[var(--shadow-pop)]"
    >
      {picker.query.length < 2 ? (
        <p className="px-2.5 py-2 text-xs text-muted">{t('ai2.refs.typeMore')}</p>
      ) : !picker.list.length ? (
        <p className="px-2.5 py-2 text-xs text-muted">
          {picker.loading ? t('ai2.refs.searching') : t('ai2.refs.none')}
        </p>
      ) : (
        picker.list.map((s, i) => {
          const head = s.type !== kind;
          kind = s.type;
          return (
            <div key={`${s.type}:${s.id}`}>
              {head ? (
                <p className="px-2.5 pt-1.5 pb-0.5 text-[0.6875rem] text-muted">{t(KIND_LABEL[s.type])}</p>
              ) : null}
              <button
                type="button"
                role="option"
                aria-selected={i === picker.active}
                data-testid="assistant-ref-option"
                data-type={s.type}
                // Keep the focus (and the caret) in the message box.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => picker.setActive(i)}
                onClick={() => onPick(s)}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-[8px] px-2.5 text-start text-[0.8125rem]',
                  i === picker.active && 'bg-surface-2',
                )}
              >
                <Icon name={KIND_ICON[s.type]} size={14} />
                <span className="min-w-0 flex-1 truncate" dir="auto">
                  {s.name}
                </span>
                {s.where ? (
                  <span className="max-w-[40%] truncate text-xs text-muted" dir="auto">
                    {s.where}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
};

/** The references of the message being written: a chip each, which can be taken off. */
export const RefChips = ({ refs, onRemove }: { refs: AssistantRef[]; onRemove: (r: AssistantRef) => void }) =>
  refs.length ? (
    <div className="flex flex-wrap gap-1.5 pb-1.5" data-testid="assistant-refs">
      {refs.map((r) => (
        <span
          key={`${r.type}:${r.id}`}
          data-testid="assistant-ref"
          data-type={r.type}
          className="inline-flex h-7 max-w-[220px] items-center gap-1 rounded-full bg-[var(--accent-soft)] ps-2.5 pe-1 text-xs text-fg"
        >
          <Icon name={KIND_ICON[r.type]} size={12} />
          <span className="truncate" dir="auto">
            {r.name}
          </span>
          <button
            type="button"
            aria-label={`${t('files.viewer.remove')}: ${r.name}`}
            title={t('files.viewer.remove')}
            data-testid="assistant-ref-remove"
            onClick={() => onRemove(r)}
            className="grid size-5 place-items-center rounded-full text-muted hover:text-danger-fg"
          >
            <Icon name="x" size={11} strokeWidth={2.4} />
          </button>
        </span>
      ))}
    </div>
  ) : null;

/** The references of a sent message, as links to what they point at. */
export const MessageRefs = ({ slug, refs }: { slug: string; refs: AssistantRef[] }) =>
  refs.length ? (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5" data-testid="assistant-message-refs">
      {refs.map((r) => {
        const cls =
          'inline-flex h-6 max-w-[220px] items-center gap-1 rounded-full border border-line bg-surface px-2 text-xs text-fg-2 hover:border-primary';
        const inner = (
          <>
            <Icon name={KIND_ICON[r.type]} size={12} />
            <span className="truncate" dir="auto">
              {r.name}
            </span>
          </>
        );
        const key = `${r.type}:${r.id}`;
        return r.type === 'item' ? (
          // An item opens on its board (its card), like quick search's results.
          <Link
            key={key}
            to="/a/$accountSlug/b/$boardId/i/$itemId"
            params={{ accountSlug: slug, boardId: r.board_id ?? '', itemId: r.id }}
            className={cls}
            data-testid="assistant-message-ref"
          >
            {inner}
          </Link>
        ) : r.type === 'board' ? (
          <Link
            key={key}
            to="/a/$accountSlug/b/$boardId"
            params={{ accountSlug: slug, boardId: r.id }}
            className={cls}
            data-testid="assistant-message-ref"
          >
            {inner}
          </Link>
        ) : r.type === 'doc' ? (
          <Link
            key={key}
            to="/a/$accountSlug/d/$docId"
            params={{ accountSlug: slug, docId: r.id }}
            className={cls}
            data-testid="assistant-message-ref"
          >
            {inner}
          </Link>
        ) : (
          <Link
            key={key}
            to="/a/$accountSlug/dash/$dashboardId"
            params={{ accountSlug: slug, dashboardId: r.id }}
            className={cls}
            data-testid="assistant-message-ref"
          >
            {inner}
          </Link>
        );
      })}
    </div>
  ) : null;
