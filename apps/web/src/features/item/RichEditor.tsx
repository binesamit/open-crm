// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from '@tiptap/react';
import type { AnyExtension } from '@tiptap/react';
import Mention from '@tiptap/extension-mention';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { t, type MessageKey } from '@bines/shared';
import { Avatar, cn, markEscapeUsed, Menu, type MenuEntry, useActionMenu } from '@bines/ui';
import { promptDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { CaretPopup } from '../../lib/caret-popup';
import type { Member } from '../board/board-api';
import { editorRootDir } from './rich-dir';
import { richFormatExtensions, richStarterKit } from './rich-extensions';
import { firstMentionIndex, mentionDisabled, mentionItems, mentionReason, nextMentionIndex } from '../board/people';

/**
 * Rich editor for updates and replies (M1.1 #7, TipTap). It produces ProseMirror JSON; the server renders the
 * HTML through its allowlist (shared/rich.ts), so the toolbar only offers what that allowlist keeps.
 * `@` mentions account members; Ctrl/⌘+Enter submits.
 */
type MentionState = {
  items: Member[];
  index: number;
  rect: DOMRect | null;
  command: (attrs: { id: string; label: string }) => void;
};

export const useRichEditor = ({
  members,
  placeholder,
  initial,
  autoFocus,
  onSubmit,
  onFiles,
  collab,
  extensions,
  editable = true,
  contentClass = 'min-h-[4.375rem] p-3 text-sm',
}: {
  members: Member[];
  placeholder: string;
  initial?: JSONContent | null;
  autoFocus?: boolean;
  onSubmit: () => void;
  /**
   * Files pasted (Ctrl+V of a screenshot) or dropped on the editor; without it they are ignored. `pos`: where in the
   * text they landed (the caret, or the drop point).
   */
  onFiles?: (files: File[], pos: number) => void;
  /**
   * Live co-editing (M8 docs): the Collaboration + caret extensions bound to a shared Yjs doc. Content then comes
   * from it, not from `initial`, and the editor keeps no history of its own (Yjs undoes per person). Fixed for
   * the editor's life — and kept out of this file, so updates do not load Yjs.
   */
  collab?: AnyExtension[];
  /**
   * Extra nodes of one editor (the knowledge center: images, tables) — opt-in, fixed for the editor's life. Updates,
   * replies and doc comments pass none, so they keep exactly the allowlist above.
   */
  extensions?: AnyExtension[];
  /** False = read only (a doc's viewers); may change while mounted. */
  editable?: boolean;
  /** Size / padding of the editable area. */
  contentClass?: string;
}) => {
  // The extensions are built once; refs give them the latest members / submit handler.
  const membersRef = useRef(members);
  const submitRef = useRef(onSubmit);
  const filesRef = useRef(onFiles);
  const [mention, setMention] = useState<MentionState | null>(null);
  const mentionRef = useRef(mention);
  useLayoutEffect(() => {
    membersRef.current = members;
    submitRef.current = onSubmit;
    filesRef.current = onFiles;
    mentionRef.current = mention;
  });

  // The first selectable row is highlighted (an unavailable agent is listed, never picked).
  const toState = (p: SuggestionProps<Member>): MentionState => ({
    items: p.items,
    index: firstMentionIndex(p.items),
    rect: p.clientRect?.() ?? null,
    command: (attrs) => p.command(attrs),
  });

  const editor = useEditor({
    autofocus: autoFocus ? 'end' : false,
    textDirection: 'auto',
    editable,
    content: collab ? undefined : (initial ?? undefined),
    extensions: [
      richStarterKit(!!collab),
      ...(collab ?? []),
      ...(extensions ?? []),
      ...richFormatExtensions(placeholder),
      // The suggestion callbacks read the refs only while typing "@" (events), never during render; the compiler
      // can't see through Mention.configure, hence this one exception.
      // eslint-disable-next-line react-hooks/refs
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        suggestion: {
          // People and the agents that act here, then the unavailable agents greyed with their reason.
          items: ({ query }) => mentionItems(membersRef.current, query),
          command: ({ editor: ed, range, props }) => {
            ed.chain()
              .focus()
              .insertContentAt(range, [
                { type: 'mention', attrs: props },
                { type: 'text', text: ' ' },
              ])
              .run();
          },
          render: () => ({
            onStart: (p) => setMention(toState(p as SuggestionProps<Member>)),
            onUpdate: (p) => setMention(toState(p as SuggestionProps<Member>)),
            onExit: () => setMention(null),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => {
              const m = mentionRef.current;
              if (!m || !m.items.length) return false;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                setMention({ ...m, index: nextMentionIndex(m.items, m.index, event.key === 'ArrowDown' ? 1 : -1) });
                return true;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                const pick = m.items[m.index];
                // Only disabled rows: Enter picks nothing (the list stays open with the reasons).
                if (!pick || mentionDisabled(pick)) return true;
                m.command({ id: pick.user_id, label: pick.name || pick.email });
                return true;
              }
              if (event.key === 'Escape') {
                // The list used this Esc: the item card / doc panel around the editor stays (useEscapeClose).
                markEscapeUsed(event);
                setMention(null);
                return true;
              }
              return false;
            },
          }),
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: `rich-content ${contentClass} leading-[1.6] outline-none`,
        'aria-label': placeholder,
        dir: editorRootDir(),
      },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length || !filesRef.current) return false;
        filesRef.current(files, view.state.selection.to);
        return true;
      },
      handleDrop: (view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (!files.length || !filesRef.current) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        filesRef.current(files, at ?? view.state.selection.to);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          submitRef.current();
          return true;
        }
        return false;
      },
    },
  });
  // A viewer's rights may change while the doc is open (the server reconnects them read-only).
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);
  return { editor, mention };
};

export const ToolButton = ({
  label,
  active,
  onClick,
  children,
  testId,
}: {
  label: MessageKey;
  active?: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  testId?: string;
}) => (
  <button
    type="button"
    aria-label={t(label)}
    title={t(label)}
    aria-pressed={active}
    data-testid={testId}
    onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
    onClick={onClick}
    className={cn(
      'flex size-[1.875rem] shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-sm hover:bg-surface-2',
      active ? 'bg-primary-soft text-primary' : 'text-fg-2',
    )}
  >
    {children}
  </button>
);

/** The canvas's 15px stroke icons for text formatting (plain lines in every icon style; icons.tsx has none). */
export const ToolIcon = ({ children }: { children: ReactNode }) => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

const EMOJI = ['😀', '😂', '😍', '👍', '🙏', '🎉', '🔥', '✅', '❤️', '😮', '😢', '👀'];

/** A glyph at the start of a "more" menu row. */
const glyph = (text: ReactNode) => (
  <span aria-hidden className="w-4 shrink-0 text-center text-xs font-semibold text-muted">
    {text}
  </span>
);

/**
 * N18: six tools on the bar (bold, italic, bullets, link, @mention, emoji) as on the canvas; everything else the
 * server's allowlist keeps (underline, strike, highlight, headings, numbered / check lists, quote, code, rule) is in
 * "more", so nothing is lost. TipTap's keyboard shortcuts (Ctrl+B/I/U, Ctrl+Shift+7/8/9…) work as before.
 */
const Toolbar = ({ editor, tools }: { editor: Editor; tools?: ReactNode }) => {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      code: e.isActive('codeBlock'),
      link: e.isActive('link'),
      highlight: e.isActive('highlight'),
    }),
  });
  const [emoji, setEmoji] = useState(false);
  const more = useActionMenu();
  const chain = () => editor.chain().focus();
  const setLink = async () => {
    if (s.link) return void chain().unsetLink().run();
    const url = await promptDialog({
      title: t('editor.link'),
      label: t('editor.linkUrl'),
      confirmLabel: t('common.ok'),
    });
    if (url)
      chain()
        .extendMarkRange('link')
        .setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` })
        .run();
  };
  /** A "more" row; an active format shows ✓ at the end of its name (the row stays a plain menuitem). */
  const item = (
    label: MessageKey,
    icon: ReactNode,
    run: () => void,
    active: boolean,
    shortcut?: string,
  ): MenuEntry => ({
    label: active ? `${t(label)} ✓` : t(label),
    icon: glyph(icon),
    shortcut,
    onSelect: run,
  });
  const moreItems: MenuEntry[] = [
    item('editor.underline', <u>U</u>, () => chain().toggleUnderline().run(), s.underline, 'Ctrl+U'),
    item('editor.strike', <s>S</s>, () => chain().toggleStrike().run(), s.strike),
    item('editor.highlight', <mark className="px-0.5">A</mark>, () => chain().toggleHighlight().run(), s.highlight),
    { kind: 'separator' },
    item('editor.h2', 'H2', () => chain().toggleHeading({ level: 2 }).run(), s.h2),
    item('editor.h3', 'H3', () => chain().toggleHeading({ level: 3 }).run(), s.h3),
    { kind: 'separator' },
    item('editor.numbers', '1.', () => chain().toggleOrderedList().run(), s.ordered),
    item('editor.checklist', '☑', () => chain().toggleTaskList().run(), s.task),
    item('editor.quote', '❝', () => chain().toggleBlockquote().run(), s.quote),
    item('editor.code', '</>', () => chain().toggleCodeBlock().run(), s.code),
    item('editor.divider', '―', () => chain().setHorizontalRule().run(), false),
  ];
  const moreActive = s.underline || s.strike || s.highlight || s.h2 || s.h3 || s.ordered || s.task || s.quote || s.code;
  return (
    <div
      role="toolbar"
      aria-label={t('editor.toolbar')}
      className="relative flex items-center gap-0.5 border-b border-line-soft px-2 py-1.5"
    >
      <ToolButton label="editor.bold" active={s.bold} onClick={() => chain().toggleBold().run()}>
        <ToolIcon>
          <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />
        </ToolIcon>
      </ToolButton>
      <ToolButton label="editor.italic" active={s.italic} onClick={() => chain().toggleItalic().run()}>
        <ToolIcon>
          <path d="M14 5h-4M14 19h-4M14 5l-4 14" />
        </ToolIcon>
      </ToolButton>
      <ToolButton label="editor.bullets" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
        <ToolIcon>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="4.5" cy="6" r="1" />
          <circle cx="4.5" cy="12" r="1" />
          <circle cx="4.5" cy="18" r="1" />
        </ToolIcon>
      </ToolButton>
      <ToolButton label="editor.link" active={s.link} onClick={() => void setLink()}>
        <Icon name="link" size={15} />
      </ToolButton>
      <ToolButton label="editor.mention" onClick={() => chain().insertContent('@').run()}>
        <ToolIcon>
          <circle cx="12" cy="12" r="4" />
          <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" />
        </ToolIcon>
      </ToolButton>
      <ToolButton label="editor.emoji" active={emoji} onClick={() => setEmoji((v) => !v)}>
        <Icon name="smile" size={15} />
      </ToolButton>
      <ToolButton label={'editor.more' as MessageKey} active={moreActive} testId="rich-more" onClick={more.fromTrigger}>
        <ToolIcon>
          <circle cx="5" cy="12" r="1.3" />
          <circle cx="12" cy="12" r="1.3" />
          <circle cx="19" cy="12" r="1.3" />
        </ToolIcon>
      </ToolButton>
      <Menu at={more.at} onClose={more.close} items={moreItems} label={t('editor.more')} />
      {tools}
      {emoji ? (
        <div className="absolute end-1 top-full z-20 mt-1 grid grid-cols-6 gap-0.5 rounded-[var(--radius)] border border-line bg-surface p-1 shadow-[var(--shadow-pop)]">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => {
                chain().insertContent(e).run();
                setEmoji(false);
              }}
              className="size-8 rounded-[var(--radius-sm)] text-lg hover:bg-surface-2"
            >
              {e}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** Toolbar + content + the @mention list (fixed under the caret). */
export const RichEditorView = ({
  editor,
  mention,
  members,
  footer,
  readOnly,
  className,
  sticky,
  tools,
  collapsed,
  lead,
}: {
  editor: Editor | null;
  mention: MentionState | null;
  members: Member[];
  /** A bottom row inside the box (the composer's attach / send buttons). */
  footer?: ReactNode;
  /** No toolbar (a doc's viewers). */
  readOnly?: boolean;
  /** Replaces the framed box (a doc page is a page, not a field). */
  className?: string;
  /** The toolbar stays at the top while scrolling a long doc. */
  sticky?: boolean;
  /** Extra toolbar buttons of one editor (the knowledge center's image button). */
  tools?: ReactNode;
  /** A closed one-line box (an idle, empty composer): no toolbar and no footer; `lead` sits before the text. */
  collapsed?: boolean;
  lead?: ReactNode;
}) => {
  if (!editor) return null;
  return (
    <div
      className={
        collapsed
          ? 'flex min-h-[2.625rem] cursor-text items-center gap-2.5 rounded-[var(--radius-lg)] border border-line bg-surface-3 px-3 [&_.ProseMirror]:min-h-0 [&_.ProseMirror]:px-0 [&_.ProseMirror]:py-2'
          : (className ??
            'rounded-[var(--radius-lg)] border border-line bg-surface transition-shadow focus-within:border-heading focus-within:ring-3 focus-within:ring-[var(--accent-soft)]')
      }
      data-testid="rich-editor"
      data-readonly={readOnly ? 'true' : undefined}
      data-collapsed={collapsed ? 'true' : undefined}
      onMouseDown={
        collapsed
          ? (e) => {
              // The whole closed box opens the composer, not only its text line.
              if (e.target === editor.view.dom || editor.view.dom.contains(e.target as Node)) return;
              e.preventDefault();
              editor.commands.focus();
            }
          : undefined
      }
    >
      {collapsed && lead ? <span className="flex shrink-0">{lead}</span> : null}
      {readOnly || collapsed ? null : sticky ? (
        <div className="sticky top-0 z-10 bg-surface">
          <Toolbar editor={editor} tools={tools} />
        </div>
      ) : (
        <Toolbar editor={editor} tools={tools} />
      )}
      <EditorContent editor={editor} className={collapsed ? 'min-w-0 flex-1' : undefined} />
      {collapsed ? null : footer}
      {mention && mention.items.length && mention.rect ? (
        // Round 12: placed by the shared rule — it opened off the screen's edge in RTL (reported with a screenshot).
        <CaretPopup
          rect={mention.rect}
          host={() => editor.view.dom}
          label={t('editor.mention')}
          testId="mention-list"
          className="w-60"
        >
          {mention.items.map((m, i) => {
            const off = mentionDisabled(m);
            const reason = off ? t(`agents.mention.unavailable.${mentionReason(m)}` as MessageKey) : undefined;
            return (
              <button
                key={m.user_id}
                type="button"
                role="option"
                aria-selected={!off && i === mention.index}
                aria-disabled={off || undefined}
                data-testid={m.agent ? `mention-agent-${m.agent.id}` : undefined}
                data-disabled={off ? 'true' : undefined}
                data-reason={off ? mentionReason(m) : undefined}
                data-tip={reason}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (!off) mention.command({ id: m.user_id, label: m.name || m.email });
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-start text-sm',
                  off
                    ? 'cursor-default opacity-50'
                    : i === mention.index
                      ? 'bg-primary-soft text-primary'
                      : 'hover:bg-surface-2',
                )}
              >
                <Avatar
                  name={m.name || m.email}
                  url={members.find((x) => x.user_id === m.user_id)?.avatar_url}
                  size={20}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.name || m.email}</span>
                  {reason ? <span className="block truncate text-xs text-muted">{reason}</span> : null}
                </span>
                {m.agent ? (
                  <span
                    className="ms-auto shrink-0 rounded-full bg-violet-soft px-1.5 text-[0.6875rem] font-semibold text-violet-fg"
                    data-testid="mention-agent"
                  >
                    {t('agents.digitalWorker')}
                  </span>
                ) : null}
              </button>
            );
          })}
        </CaretPopup>
      ) : null}
    </div>
  );
};

/** True when nothing was typed (an empty paragraph). */
export const isEditorEmpty = (editor: Editor | null) => !editor || editor.isEmpty;
