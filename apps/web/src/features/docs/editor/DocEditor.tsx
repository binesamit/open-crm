// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Highlight from '@tiptap/extension-highlight';
import Mention from '@tiptap/extension-mention';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import UniqueID from '@tiptap/extension-unique-id';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { DOC_ID_BLOCKS, t, type DocThread, type Me, type MessageKey, type SearchResult, msgKey } from '@bines/shared';
import { cn, Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { promptDialog } from '../../../lib/dialogs';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { uploadFile } from '../../../lib/upload';
import { BoardPickerDialog } from '../../board/BoardPickerDialog';
import { ListDirection, ListIndent } from '../../item/rich-lists';
import { editorRootDir, TypingDirection } from '../../item/rich-dir';
import type { Member } from '../../board/board-api';
import { caretColor, type CollabView } from '../collab';
import { TailCaretFix } from './caret-fix';
import { DocPresence } from './presence';
import { DocCodeBlock } from './code-block';
import { DocEnvContext, type DocEnv } from './doc-env';
import {
  blockAtCoords,
  blockAtSelection,
  blockMenuEntries,
  blockRefAt,
  contextMenuEntries,
  type BlockMenuEnv,
  type BlockRef,
} from './block-menu';
import { ItemPickerDialog } from './ItemPickerDialog';
import { BoardEmbed, Callout, Column, Columns, DocImage, EntityLink, FileBlock, ItemEmbed } from './nodes';
import {
  filterSlash,
  runSlash,
  SlashCommand,
  type SlashHooks,
  type SlashItem,
  SLASH_ITEMS,
  SuggestList,
  suggestRender,
  type SuggestState,
} from './suggest';

/** Where the block handle sits (stable objects: a new one would re-register the handle's plugin every render). */
const HANDLE_RTL = { placement: 'right-start', strategy: 'absolute' } as const;
const HANDLE_LTR = { placement: 'left-start', strategy: 'absolute' } as const;

/** One row of the `@` list: a person (mention) or an item / board / doc (a link). */
type MentionPick =
  | { kind: 'user'; id: string; label: string; email: string; avatar: string | null }
  | { kind: 'item' | 'board' | 'doc'; id: string; label: string; sub: string; board_id?: string };

/** The block the caret is in (the nearest one with an id) — what a comment hangs on. */
export const currentBlock = (editor: Editor) => {
  const { $from, from, to } = editor.state.selection;
  const selected = editor.state.doc.textBetween(from, to, ' ').trim();
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (typeof n.attrs.id === 'string' && n.attrs.id)
      return { id: n.attrs.id as string, quote: (selected || n.textContent).slice(0, 300) };
  }
  // A block from before ids (an old doc): whoever may edit gives it one now.
  const top = $from.depth > 0 ? $from.node(1) : null;
  if (top && editor.isEditable && (DOC_ID_BLOCKS as readonly string[]).includes(top.type.name)) {
    const id = crypto.randomUUID();
    editor.view.dispatch(editor.state.tr.setNodeAttribute($from.before(1), 'id', id));
    return { id, quote: (selected || top.textContent).slice(0, 300) };
  }
  return null;
};

/**
 * The doc editor (M8 ד2): Tiptap bound to the live Yjs doc, with the doc's blocks, `/` to insert a block, `@` for
 * people (notified) and items / boards / docs (links), a drag handle on every block, images and files by paste /
 * drop / pick, a toolbar, and comment markers next to the blocks that have open threads. Read-only when the
 * server says so (viewers, commenters).
 */
export const DocEditor = ({
  live,
  me,
  env,
  placeholder,
  threads,
  activeThread,
  onOpenThread,
  onComment,
  canComment,
}: {
  live: CollabView;
  me: Me;
  env: Omit<DocEnv, 'editable'>;
  placeholder: string;
  threads: DocThread[];
  activeThread: string | null;
  onOpenThread: (threadId: string) => void;
  onComment: (block: { id: string; quote: string }) => void;
  canComment: boolean;
}) => {
  const editable = live.readOnly === false;
  const membersRef = useRef<Member[]>(env.members);
  const [slash, setSlash] = useState<SuggestState<SlashItem> | null>(null);
  const [mention, setMention] = useState<SuggestState<MentionPick> | null>(null);
  const slashRef = useRef(slash);
  const mentionRef = useRef(mention);
  const hooksRef = useRef<SlashHooks | null>(null);
  const filesRef = useRef<(files: File[]) => void>(() => undefined);
  useLayoutEffect(() => {
    membersRef.current = env.members;
    slashRef.current = slash;
    mentionRef.current = mention;
  });

  // Built once per live session (the Yjs binding is fixed for the editor's life). The suggestion callbacks read
  // the refs only while typing (events), never during render — the compiler cannot see through `configure`.
  /* eslint-disable react-hooks/refs */
  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: 'https', protocols: ['mailto'] },
        undoRedo: false, // Yjs undoes per person
        dropcursor: { color: 'var(--accent)', width: 2 },
        codeBlock: false, // DocCodeBlock: highlighted, with a language picker and copy
      }),
      DocCodeBlock,
      Collaboration.configure({ document: live.doc }),
      CollaborationCaret.configure({
        provider: live.provider,
        // `id`: the others' presence groups one person's tabs and finds their picture.
        user: { name: me.user.name || me.user.email, color: caretColor(me.user.id), id: me.user.id },
      }),
      DocPresence.configure({ awareness: live.provider.awareness as never }),
      TailCaretFix,
      UniqueID.configure({
        types: [...DOC_ID_BLOCKS],
        attributeName: 'id',
        // Remote changes already carry their ids.
        filterTransaction: (tr) => !isChangeOrigin(tr),
      }),
      Highlight,
      TaskList,
      TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' } }),
      ListDirection,
      ListIndent,
      TypingDirection,
      Table.configure({ resizable: false, HTMLAttributes: { class: 'doc-table' } }),
      TableRow,
      TableHeader,
      TableCell,
      Details.configure({ persist: true, HTMLAttributes: { class: 'doc-details' } }),
      DetailsSummary,
      DetailsContent,
      Callout,
      Columns,
      Column,
      DocImage,
      FileBlock,
      EntityLink,
      BoardEmbed,
      ItemEmbed,
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'paragraph' ? placeholder : ''),
        showOnlyCurrent: true,
      }),
      // The suggestion callbacks read refs only while typing (events), never during render.
      Mention.configure({
        HTMLAttributes: { class: 'mention' },
        suggestion: {
          char: '@',
          items: async ({ query }): Promise<MentionPick[]> => {
            const q = query.toLowerCase();
            const people: MentionPick[] = membersRef.current
              .filter((m) => m.status === 'active' && `${m.name} ${m.email}`.toLowerCase().includes(q))
              .slice(0, 5)
              .map((m) => ({ kind: 'user', id: m.user_id, label: m.name || m.email, email: m.email, avatar: m.avatar_url }));
            if (query.trim().length < 2) return people;
            const found = await api(env.accountId)
              .get<SearchResult>(`/search?q=${encodeURIComponent(query.trim())}`)
              .catch(() => null);
            const more: MentionPick[] = [
              ...(found?.items ?? []).slice(0, 5).map((i) => ({
                kind: 'item' as const,
                id: i.id,
                label: i.name,
                sub: i.board.name,
                board_id: i.board.id,
              })),
              ...(found?.boards ?? []).slice(0, 3).map((b) => ({
                kind: 'board' as const,
                id: b.id,
                label: b.name,
                sub: b.workspace ?? '',
              })),
              ...(found?.docs ?? []).slice(0, 3).map((d) => ({
                kind: 'doc' as const,
                id: d.id,
                label: d.name,
                sub: d.workspace ?? '',
              })),
            ];
            return [...people, ...more];
          },
          command: ({ editor: ed, range, props }) => {
            const p = props as unknown as MentionPick;
            const node =
              p.kind === 'user'
                ? { type: 'mention', attrs: { id: p.id, label: p.label } }
                : { type: 'entityLink', attrs: { kind: p.kind, id: p.id, label: p.label, board_id: p.board_id ?? null } };
            ed.chain().focus().insertContentAt(range, [node, { type: 'text', text: ' ' }]).run();
          },
          render: suggestRender<MentionPick>(setMention, () => mentionRef.current) as never,
        },
      }),
      SlashCommand.configure({
        suggestion: {
          char: '/',
          items: ({ query }) => filterSlash(query),
          // Not inside code (a path or a URL is typed there).
          allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
          command: ({ editor: ed, range, props }) => runSlash(ed, range, props as SlashItem, hooksRef.current!),
          render: suggestRender<SlashItem>(setSlash, () => slashRef.current),
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.doc, live.provider],
  );
  /* eslint-enable react-hooks/refs */

  const editor = useEditor({
    extensions,
    // Made after mount, not while rendering: the caret extension writes the awareness state at once, and that
    // updates the doc page (presence) — a setState in another component during this render otherwise.
    immediatelyRender: false,
    editable,
    textDirection: 'auto',
    editorProps: {
      attributes: {
        class: 'rich-content doc-content min-h-[55vh] px-1 py-4 text-[0.9375rem] leading-[1.6] outline-none',
        'aria-label': placeholder,
        'data-testid': 'doc-editor',
        dir: editorRootDir(),
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!files.length) return false;
        filesRef.current(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        filesRef.current(files);
        return true;
      },
    },
  });
  // A reader's rights may change while the doc is open (the server reconnects them read-only).
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // ---- files: picked, pasted or dropped → uploaded → an image or a file block at the caret
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const insertFiles = async (files: File[]) => {
    if (!editor || !editable) return;
    for (const file of files) {
      try {
        const up = await uploadFile(env.accountId, file);
        const node = up.mime.startsWith('image/')
          ? { type: 'image', attrs: { asset_id: up.id, alt: up.name } }
          : { type: 'fileBlock', attrs: { asset_id: up.id, name: up.name, size: up.size, mime: up.mime } };
        editor.chain().focus().insertContent(node).run();
      } catch (err) {
        showToast({ message: errorMessage(err), tone: 'error' });
      }
    }
  };
  useLayoutEffect(() => {
    filesRef.current = (files) => void insertFiles(files);
  });

  // ---- board / item embeds: pickers
  const [picking, setPicking] = useState<'board' | 'item' | null>(null);
  useLayoutEffect(() => {
    hooksRef.current = {
      image: () => imageInput.current?.click(),
      file: () => fileInput.current?.click(),
      board: () => setPicking('board'),
      item: () => setPicking('item'),
    };
  });

  const fullEnv = useMemo<DocEnv>(() => ({ ...env, editable }), [env, editable]);
  const open = threads.filter((th) => !th.resolved_at);

  // ---- Fix: the block menu (a click on the drag handle) and the doc's own right-click menu
  const hovered = useRef<BlockRef | null>(null);
  const handleMenu = useActionMenu();
  const ctxMenu = useActionMenu();
  const [menuBlock, setMenuBlock] = useState<BlockRef | null>(null);
  const menuEnv: BlockMenuEnv = {
    editable,
    canComment,
    slug: env.slug,
    docId: env.docId,
    onComment,
  };
  const openContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (!editor) return;
    // Inside the editor only (an embed's own menus — a board view in the doc — keep theirs).
    if (!editor.view.dom.contains(e.target as Node)) return;
    const ref = blockAtCoords(editor, e.clientX, e.clientY);
    // A right click outside the selection moves the caret there (as the browser does), inside keeps it.
    const hit = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
    const { from, to } = editor.state.selection;
    if (hit && (hit.pos < from || hit.pos > to)) editor.commands.setTextSelection(hit.pos);
    setMenuBlock(ref);
    ctxMenu.onContextMenu(e);
  };
  const keyContextMenu = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!editor || (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10'))) return;
    e.preventDefault();
    e.stopPropagation();
    const at = editor.view.coordsAtPos(editor.state.selection.from);
    setMenuBlock(blockAtSelection(editor));
    ctxMenu.onContextMenu({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      clientX: at.left,
      clientY: at.bottom + 4,
    } as React.MouseEvent<HTMLElement>);
  };
  // A link to a block (`#block-<id>`): scrolled to and marked once the doc is in.
  const [linked, setLinked] = useState<string | null>(null);
  useEffect(() => {
    if (!editor) return;
    const m = /^#block-([\w-]+)$/.exec(window.location.hash);
    if (!m) return;
    const id = m[1]!;
    const find = () => {
      try {
        return editor.view.dom.querySelector(`[data-id="${CSS.escape(id)}"]`);
      } catch {
        return null;
      }
    };
    let tries = 0;
    let unmark = 0;
    const timer = window.setInterval(() => {
      const el = find();
      if (el || ++tries > 40) window.clearInterval(timer);
      if (el) {
        el.scrollIntoView({ block: 'center' });
        setLinked(id);
        unmark = window.setTimeout(() => setLinked(null), 4000);
      }
    }, 150);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(unmark);
    };
  }, [editor]);

  if (!editor) return null;
  return (
    <DocEnvContext.Provider value={fullEnv}>
      {editable ? (
        <div className="sticky top-0 z-10 bg-surface">
          <DocToolbar
            editor={editor}
            hooks={hooksRef}
            canComment={canComment}
            onComment={() => {
              const b = currentBlock(editor);
              if (b) onComment(b);
              else showToast({ message: t('docs2.comment.pickBlock') });
            }}
          />
        </div>
      ) : canComment ? (
        <div className="sticky top-0 z-10 flex justify-end border-b border-line-soft bg-surface py-1.5">
          <ToolBtn
            label={msgKey('docs2.comment.add')}
            testId="doc-tool-comment"
            onClick={() => {
              const b = currentBlock(editor);
              if (b) onComment(b);
              else showToast({ message: t('docs2.comment.pickBlock') });
            }}
          >
            <Icon name="chat" size={15} />
          </ToolBtn>
        </div>
      ) : null}
      <div className="relative" onContextMenu={openContextMenu} onKeyDown={keyContextMenu} data-testid="doc-editor-area">
        <EditorContent editor={editor} className="doc-editor pe-9" />
        <CommentMarkers editor={editor} threads={open} onOpen={onOpenThread} />
        {activeThread ? <ActiveBlockStyle blockId={threads.find((x) => x.id === activeThread)?.block_id} /> : null}
        {linked && !activeThread ? <ActiveBlockStyle blockId={linked} /> : null}
        {editable ? (
          <DragHandle
            editor={editor}
            className="doc-drag-handle"
            // At the blocks' start side: the right in Hebrew.
            computePositionConfig={document.documentElement.dir === 'ltr' ? HANDLE_LTR : HANDLE_RTL}
            onNodeChange={({ node, pos }) => {
              hovered.current = node && pos >= 0 ? blockRefAt(node, pos) : null;
            }}
          >
            <span
              role="button"
              tabIndex={-1}
              aria-haspopup="menu"
              className="grid h-6 w-4 cursor-grab place-items-center rounded-[5px] text-muted hover:bg-surface-2 active:cursor-grabbing"
              data-testid="doc-drag-handle"
              title={t('docs2.dragMenu')}
              onClick={(e) => {
                if (!hovered.current) return;
                setMenuBlock(hovered.current);
                handleMenu.fromTrigger(e);
              }}
            >
              <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
                <circle cx="2.5" cy="2.5" r="1.3" />
                <circle cx="7.5" cy="2.5" r="1.3" />
                <circle cx="2.5" cy="7" r="1.3" />
                <circle cx="7.5" cy="7" r="1.3" />
                <circle cx="2.5" cy="11.5" r="1.3" />
                <circle cx="7.5" cy="11.5" r="1.3" />
              </svg>
            </span>
          </DragHandle>
        ) : null}
      </div>
      <Menu
        at={handleMenu.at}
        onClose={handleMenu.close}
        items={menuBlock && handleMenu.at ? blockMenuEntries(editor, menuBlock, menuEnv) : []}
        label={t('docs2.blockMenu.title')}
      />
      <Menu
        at={ctxMenu.at}
        onClose={ctxMenu.close}
        items={ctxMenu.at ? contextMenuEntries(editor, menuBlock, menuEnv) : []}
        label={t('docs2.blockMenu.title')}
      />
      <SuggestList
        state={slash}
        label={t('docs2.slash.title')}
        testId="doc-slash-menu"
        host={() => editor?.view.dom}
        rows={(i) => ({
          key: i.id,
          label: t(i.label),
          icon: i.icon,
          glyph: i.glyph,
          testId: `doc-slash-${i.id}`,
        })}
        empty={t('docs2.slash.none')}
      />
      <SuggestList
        state={mention}
        label={t('editor.mention')}
        testId="doc-mention-menu"
        host={() => editor?.view.dom}
        rows={(p) =>
          p.kind === 'user'
            ? {
                key: `user:${p.id}`,
                label: p.label,
                sub: p.email,
                avatar: { name: p.label, url: p.avatar },
                testId: 'doc-mention-option',
              }
            : {
                key: `${p.kind}:${p.id}`,
                label: p.label,
                sub: `${t(msgKey(`docs2.kind.${p.kind}`))}${p.sub ? ` · ${p.sub}` : ''}`,
                icon: p.kind === 'board' ? 'board' : p.kind === 'doc' ? 'file' : 'cards',
                testId: 'doc-mention-option',
              }
        }
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="doc-image-input"
        onChange={(e) => {
          void insertFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        data-testid="doc-file-input"
        onChange={(e) => {
          void insertFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {picking === 'board' ? (
        <BoardPickerDialog
          accountId={env.accountId}
          workspaceId={env.workspaceId}
          title={t('docs2.embed.pickBoard')}
          confirmLabel={t('docs2.embed.insert')}
          onClose={() => setPicking(null)}
          onPick={async (b) => {
            editor
              .chain()
              .focus()
              .insertContent({ type: 'boardEmbed', attrs: { board_id: b.id, label: b.name } })
              .run();
          }}
        />
      ) : null}
      {picking === 'item' ? (
        <ItemPickerDialog
          accountId={env.accountId}
          onClose={() => setPicking(null)}
          onPick={(it) =>
            editor
              .chain()
              .focus()
              .insertContent({ type: 'itemEmbed', attrs: { item_id: it.id, board_id: it.board_id, label: it.name } })
              .run()
          }
        />
      ) : null}
    </DocEnvContext.Provider>
  );
};

/** The active thread's block, tinted (by its id — the editor's own DOM is never touched). */
const ActiveBlockStyle = ({ blockId }: { blockId: string | undefined }) =>
  blockId ? (
    <style>{`.doc-editor [data-id="${CSS.escape(blockId)}"]{background:var(--accent-soft);border-radius:6px;box-shadow:0 0 0 4px var(--accent-soft)}`}</style>
  ) : null;

/** 💬 + count at the end of every block with open threads; a click opens the first of them. */
const CommentMarkers = ({ editor, threads, onOpen }: { editor: Editor; threads: DocThread[]; onOpen: (id: string) => void }) => {
  const [marks, setMarks] = useState<{ blockId: string; top: number; count: number; first: string }[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const byBlock = new Map<string, DocThread[]>();
    for (const th of threads) byBlock.set(th.block_id, [...(byBlock.get(th.block_id) ?? []), th]);
    const compute = () => {
      const host = ref.current?.parentElement;
      if (!host) return;
      const base = host.getBoundingClientRect().top;
      const next: typeof marks = [];
      for (const [blockId, list] of byBlock) {
        let el: Element | null = null;
        try {
          el = editor.view.dom.querySelector(`[data-id="${CSS.escape(blockId)}"]`);
        } catch {
          return; // not mounted (yet / any more)
        }
        if (!el) continue;
        next.push({ blockId, top: el.getBoundingClientRect().top - base, count: list.length, first: list[0]!.id });
      }
      setMarks(next);
    };
    compute();
    editor.on('update', compute);
    window.addEventListener('resize', compute);
    return () => {
      editor.off('update', compute);
      window.removeEventListener('resize', compute);
    };
  }, [editor, threads]);
  return (
    <div ref={ref} aria-hidden={!marks.length}>
      {marks.map((m) => (
        <button
          key={m.blockId}
          type="button"
          style={{ top: m.top + 2 }}
          className="absolute end-0 inline-flex h-6 items-center gap-0.5 rounded-full bg-accent-soft px-1.5 text-xs font-bold text-accent-fg hover:bg-accent hover:text-on-accent"
          data-testid="doc-comment-marker"
          data-block-id={m.blockId}
          aria-label={t('docs2.comment.open', { n: m.count })}
          title={t('docs2.comment.open', { n: m.count })}
          onClick={() => onOpen(m.first)}
        >
          <Icon name="chat" size={12} />
          {m.count}
        </button>
      ))}
    </div>
  );
};

// ---------------------------------------------------------------- toolbar

const ToolBtn = ({
  label,
  active,
  onClick,
  children,
  testId,
  disabled,
}: {
  label: MessageKey;
  active?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
}) => (
  <button
    type="button"
    aria-label={t(label)}
    title={t(label)}
    aria-pressed={active}
    data-testid={testId}
    disabled={disabled}
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={cn(
      'flex h-[1.875rem] min-w-[1.875rem] shrink-0 items-center justify-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-sm disabled:opacity-40',
      active ? 'bg-primary-soft text-primary' : 'text-fg-2 enabled:hover:bg-surface-2',
    )}
  >
    {children}
  </button>
);

const Sep = () => <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />;

const DocToolbar = ({
  editor,
  hooks,
  canComment,
  onComment,
}: {
  editor: Editor;
  hooks: React.RefObject<SlashHooks | null>;
  canComment: boolean;
  onComment: () => void;
}) => {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      highlight: e.isActive('highlight'),
      link: e.isActive('link'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      table: e.isActive('table'),
    }),
  });
  const blockMenu = useActionMenu();
  const insertMenu = useActionMenu();
  const tableMenu = useActionMenu();
  const chain = () => editor.chain().focus();
  const blockLabel = s.h1 ? 'docs2.block.h1' : s.h2 ? 'docs2.block.h2' : s.h3 ? 'docs2.block.h3' : 'docs2.block.text';
  const blockItems: MenuEntry[] = (['text', 'h1', 'h2', 'h3'] as const).map((id) => {
    const item = SLASH_ITEMS.find((x) => x.id === id)!;
    return { label: t(item.label), testId: `doc-block-${id}`, onSelect: () => item.run(editor, hooks.current!) };
  });
  const insertItems: MenuEntry[] = SLASH_ITEMS.filter((x) => !['text', 'h1', 'h2', 'h3'].includes(x.id)).map((item) => ({
    label: t(item.label),
    testId: `doc-insert-${item.id}`,
    icon: item.icon ? <Icon name={item.icon} size={15} /> : <span className="w-4 text-center text-xs font-bold">{item.glyph}</span>,
    onSelect: () => item.run(editor, hooks.current!),
  }));
  const tableItems: MenuEntry[] = [
    { label: t('docs2.table.rowAfter'), testId: 'doc-table-row', onSelect: () => chain().addRowAfter().run() },
    { label: t('docs2.table.colAfter'), testId: 'doc-table-col', onSelect: () => chain().addColumnAfter().run() },
    { label: t('docs2.table.header'), onSelect: () => chain().toggleHeaderRow().run() },
    { kind: 'separator' },
    { label: t('docs2.table.rowDelete'), onSelect: () => chain().deleteRow().run() },
    { label: t('docs2.table.colDelete'), onSelect: () => chain().deleteColumn().run() },
    { label: t('docs2.table.delete'), danger: true, onSelect: () => chain().deleteTable().run() },
  ];
  const setLink = async () => {
    if (s.link) return void chain().unsetLink().run();
    const url = await promptDialog({ title: t('editor.link'), label: t('editor.linkUrl'), confirmLabel: t('common.ok') });
    if (url)
      chain()
        .extendMarkRange('link')
        .setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` })
        .run();
  };
  return (
    <div
      role="toolbar"
      aria-label={t('editor.toolbar')}
      className="flex items-center gap-0.5 overflow-x-auto border-b border-line-soft px-1 py-1.5"
      data-testid="doc-toolbar"
    >
      <ToolBtn label={msgKey('docs2.block.type')} testId="doc-tool-block" onClick={blockMenu.fromTrigger}>
        <span className="text-xs font-semibold">{t(msgKey(blockLabel))}</span>
        <Icon name="chevronDown" size={12} />
      </ToolBtn>
      <Sep />
      <ToolBtn label="editor.bold" active={s.bold} onClick={() => chain().toggleBold().run()}>
        <b>B</b>
      </ToolBtn>
      <ToolBtn label="editor.italic" active={s.italic} onClick={() => chain().toggleItalic().run()}>
        <i className="font-serif">I</i>
      </ToolBtn>
      <ToolBtn label="editor.underline" active={s.underline} onClick={() => chain().toggleUnderline().run()}>
        <u>U</u>
      </ToolBtn>
      <ToolBtn label="editor.strike" active={s.strike} onClick={() => chain().toggleStrike().run()}>
        <s>S</s>
      </ToolBtn>
      <ToolBtn label="editor.highlight" active={s.highlight} onClick={() => chain().toggleHighlight().run()}>
        <mark className="rounded-[3px] px-0.5">A</mark>
      </ToolBtn>
      <ToolBtn label={msgKey('docs2.mark.code')} active={s.code} onClick={() => chain().toggleCode().run()}>
        <span className="font-mono text-xs">{'<>'}</span>
      </ToolBtn>
      <ToolBtn label="editor.link" active={s.link} onClick={() => void setLink()}>
        <Icon name="link" size={15} />
      </ToolBtn>
      <Sep />
      <ToolBtn label="editor.bullets" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
        <span className="text-base leading-none">•</span>
      </ToolBtn>
      <ToolBtn label="editor.numbers" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
        <span className="text-xs font-semibold">1.</span>
      </ToolBtn>
      <ToolBtn label="editor.checklist" active={s.task} onClick={() => chain().toggleTaskList().run()}>
        <Icon name="check" size={15} />
      </ToolBtn>
      <Sep />
      <ToolBtn label={msgKey('docs2.insert')} testId="doc-tool-insert" onClick={insertMenu.fromTrigger}>
        <Icon name="plus" size={15} strokeWidth={2.2} />
        <span className="text-xs font-semibold">{t('docs2.insert')}</span>
      </ToolBtn>
      {s.table ? (
        <ToolBtn label={msgKey('docs2.table.menu')} testId="doc-tool-table" onClick={tableMenu.fromTrigger}>
          <Icon name="table" size={15} />
          <Icon name="chevronDown" size={12} />
        </ToolBtn>
      ) : null}
      {canComment ? (
        <>
          <Sep />
          <ToolBtn label={msgKey('docs2.comment.add')} testId="doc-tool-comment" onClick={onComment}>
            <Icon name="chat" size={15} />
          </ToolBtn>
        </>
      ) : null}
      <Menu at={blockMenu.at} onClose={blockMenu.close} items={blockItems} label={t('docs2.block.type')} />
      <Menu at={insertMenu.at} onClose={insertMenu.close} items={insertItems} label={t('docs2.insert')} />
      <Menu at={tableMenu.at} onClose={tableMenu.close} items={tableItems} label={t('docs2.table.menu')} />
    </div>
  );
};
