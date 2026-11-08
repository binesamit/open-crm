// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { Extension, type Editor, type Range } from '@tiptap/react';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import { t, type MessageKey, msgKey } from '@bines/shared';
import { Avatar, cn } from '@bines/ui';
import { Icon, type IconName } from '../../../lib/icons';
import { CaretPopup } from '../../../lib/caret-popup';


/**
 * The doc's two pop-up lists (M8 ד2): `/` — insert a block (headings, lists, table, callout, image…), and `@` —
 * a person (mention, notified) or an item / board / doc (a link). Both are Tiptap suggestions whose state lives
 * in React (the list renders under the caret, ↑/↓ + Enter, Esc closes), like the updates' mention list.
 */
export type SuggestRow = {
  key: string;
  label: string;
  sub?: string;
  icon?: IconName;
  glyph?: string;
  avatar?: { name: string; url?: string | null };
  testId?: string;
};

export type SuggestState<T> = {
  items: T[];
  index: number;
  rect: DOMRect | null;
  pick: (item: T) => void;
};

/** A suggestion's callbacks → React state (kept in a ref for the key handler). */
export const suggestRender = <T,>(
  set: (s: SuggestState<T> | null) => void,
  get: () => SuggestState<T> | null,
): SuggestionOptions<T>['render'] =>
  () => ({
    onStart: (p) => set({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (item) => p.command(item) }),
    onUpdate: (p) =>
      set({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, pick: (item) => p.command(item) }),
    onExit: () => set(null),
    onKeyDown: ({ event }) => {
      const s = get();
      if (!s) return false;
      if (event.key === 'Escape') {
        set(null);
        return true;
      }
      if (!s.items.length) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const n = s.items.length;
        set({ ...s, index: (s.index + (event.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        s.pick(s.items[s.index]!);
        return true;
      }
      return false;
    },
  });

/** The list under the caret (fixed, so a scrolling page never clips it). */
export const SuggestList = <T,>({
  state,
  rows,
  label,
  testId,
  empty,
  host,
}: {
  state: SuggestState<T> | null;
  /** The editor's element (its side panel bounds the list). */
  host?: () => Element | null | undefined;
  rows: (item: T) => SuggestRow;
  label: string;
  testId: string;
  empty?: ReactNode;
}) => {
  if (!state?.rect || (!state.items.length && !empty)) return null;
  // Round 12: the shared placement (flip / shift inside the screen and the side panel), in a portal.
  return (
    <CaretPopup
      rect={state.rect}
      host={host}
      label={label}
      testId={testId}
      className="max-h-[300px] w-72"
    >
      {!state.items.length ? <div className="px-2 py-1.5 text-sm text-muted">{empty}</div> : null}
      {state.items.map((item, i) => {
        const r = rows(item);
        return (
          <button
            key={r.key}
            type="button"
            role="option"
            aria-selected={i === state.index}
            data-testid={r.testId}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => state.pick(item)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-start text-sm',
              i === state.index ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2',
            )}
          >
            {r.avatar ? (
              <Avatar name={r.avatar.name} url={r.avatar.url ?? undefined} size={22} />
            ) : (
              <span className="grid size-[1.375rem] shrink-0 place-items-center rounded-[6px] border border-line-soft bg-surface-2 text-xs font-bold text-fg-2">
                {r.icon ? <Icon name={r.icon} size={13} /> : r.glyph}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{r.label}</span>
              {r.sub ? <span className="block truncate text-xs text-muted">{r.sub}</span> : null}
            </span>
          </button>
        );
      })}
    </CaretPopup>
  );
};

// ---------------------------------------------------------------- "/" — insert a block

export type SlashHooks = {
  image: () => void;
  file: () => void;
  board: () => void;
  item: () => void;
};

export type SlashItem = {
  id: string;
  label: MessageKey;
  keywords: string;
  glyph?: string;
  icon?: IconName;
  run: (editor: Editor, hooks: SlashHooks) => void;
};

const chain = (e: Editor) => e.chain().focus();

export const SLASH_ITEMS: SlashItem[] = [
  { id: 'text', label: msgKey('docs2.block.text'), keywords: 'text paragraph טקסט', glyph: 'T', run: (e) => chain(e).setParagraph().run() },
  { id: 'h1', label: msgKey('docs2.block.h1'), keywords: 'heading title h1 כותרת', glyph: 'H1', run: (e) => chain(e).setHeading({ level: 1 }).run() },
  { id: 'h2', label: msgKey('docs2.block.h2'), keywords: 'heading h2 כותרת', glyph: 'H2', run: (e) => chain(e).setHeading({ level: 2 }).run() },
  { id: 'h3', label: msgKey('docs2.block.h3'), keywords: 'heading h3 כותרת', glyph: 'H3', run: (e) => chain(e).setHeading({ level: 3 }).run() },
  { id: 'bullets', label: msgKey('docs2.block.bullets'), keywords: 'list bullet רשימה תבליטים', glyph: '•', run: (e) => chain(e).toggleBulletList().run() },
  { id: 'numbers', label: msgKey('docs2.block.numbers'), keywords: 'list numbered רשימה ממוספרת', glyph: '1.', run: (e) => chain(e).toggleOrderedList().run() },
  { id: 'tasks', label: msgKey('docs2.block.tasks'), keywords: 'todo check task checklist משימות', glyph: '☑', run: (e) => chain(e).toggleTaskList().run() },
  {
    id: 'table',
    label: msgKey('docs2.block.table'),
    keywords: 'table grid טבלה',
    icon: 'table',
    run: (e) => chain(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  { id: 'quote', label: msgKey('docs2.block.quote'), keywords: 'quote ציטוט', glyph: '❝', run: (e) => chain(e).toggleBlockquote().run() },
  { id: 'code', label: msgKey('docs2.block.code'), keywords: 'code snippet program syntax קוד', glyph: '</>', run: (e) => chain(e).toggleCodeBlock().run() },
  { id: 'divider', label: msgKey('docs2.block.divider'), keywords: 'divider rule line hr קו מפריד', glyph: '―', run: (e) => chain(e).setHorizontalRule().run() },
  {
    id: 'callout',
    label: msgKey('docs2.block.callout'),
    keywords: 'callout note info הדגשה הערה',
    glyph: '💡',
    run: (e) =>
      chain(e)
        .insertContent({ type: 'callout', attrs: { tone: 'info', emoji: '💡' }, content: [{ type: 'paragraph' }] })
        .run(),
  },
  {
    id: 'toggle',
    label: msgKey('docs2.block.toggle'),
    keywords: 'toggle details collapse מתקפל',
    glyph: '▸',
    run: (e) => chain(e).setDetails().run(),
  },
  {
    id: 'columns',
    label: msgKey('docs2.block.columns'),
    keywords: 'columns layout עמודות',
    glyph: '▥',
    run: (e) =>
      chain(e)
        .insertContent({
          type: 'columns',
          content: [
            { type: 'column', content: [{ type: 'paragraph' }] },
            { type: 'column', content: [{ type: 'paragraph' }] },
          ],
        })
        .run(),
  },
  { id: 'image', label: msgKey('docs2.block.image'), keywords: 'image picture photo תמונה', icon: 'upload', run: (_e, h) => h.image() },
  { id: 'file', label: msgKey('docs2.block.file'), keywords: 'file attachment קובץ', icon: 'clip', run: (_e, h) => h.file() },
  { id: 'board', label: msgKey('docs2.block.board'), keywords: 'board view embed לוח תצוגה', icon: 'board', run: (_e, h) => h.board() },
  { id: 'item', label: msgKey('docs2.block.item'), keywords: 'item card embed פריט כרטיס', icon: 'cards', run: (_e, h) => h.item() },
];

export const filterSlash = (query: string) => {
  const q = query.trim().toLowerCase();
  return SLASH_ITEMS.filter((i) => !q || `${t(i.label)} ${i.keywords}`.toLowerCase().includes(q));
};

const SLASH_KEY = new PluginKey('slashCommand');

/** `/` at the start of a line or after a space opens the block list. */
export const SlashCommand = Extension.create<{ suggestion: Omit<SuggestionOptions<SlashItem>, 'editor'> }>({
  name: 'slashCommand',
  addOptions: () => ({
    suggestion: {
      char: '/',
      pluginKey: SLASH_KEY,
      command: () => undefined,
    },
  }),
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, pluginKey: SLASH_KEY, ...this.options.suggestion })];
  },
});

/** Runs a slash item in place of the typed `/query`. */
export const runSlash = (editor: Editor, range: Range, item: SlashItem, hooks: SlashHooks) => {
  editor.chain().focus().deleteRange(range).run();
  item.run(editor, hooks);
};
