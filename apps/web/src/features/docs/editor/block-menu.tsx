// SPDX-License-Identifier: AGPL-3.0-only
import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { t, msgKey } from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import { appLink, copyText } from '../../../lib/entity-menu';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { docPath } from '../doc-api';


/**
 * Fix: (product owner: "clicking the 6 dots should let me remove the block or pick from a menu", and
 * "a right click in a doc works on the board's table"): the block menu — from the drag handle's click and from a
 * right click anywhere in the doc (with cut / copy / paste and formatting on top). The doc's own menu, never the
 * browser's and never the board's.
 *
 * A block is remembered by its id (and position): while the menu is open someone else may edit the doc, so every
 * action finds the block again first.
 */
export type BlockRef = { pos: number; id: string | null; type: string };

export const blockRefAt = (node: PMNode, pos: number): BlockRef => ({
  pos,
  id: typeof node.attrs.id === 'string' && node.attrs.id ? node.attrs.id : null,
  type: node.type.name,
});

/** The block now (by id, else the same type at the same place); null when it is gone. */
export const resolveBlock = (editor: Editor, ref: BlockRef): { node: PMNode; pos: number } | null => {
  const { doc } = editor.state;
  if (ref.id) {
    let found: { node: PMNode; pos: number } | null = null;
    doc.descendants((node, pos) => {
      if (found) return false;
      if (node.attrs.id === ref.id && node.type.name === ref.type) {
        found = { node, pos };
        return false;
      }
      return true;
    });
    if (found) return found;
  }
  if (ref.pos < 0 || ref.pos >= doc.content.size) return null;
  const node = doc.nodeAt(ref.pos);
  return node && node.type.name === ref.type ? { node, pos: ref.pos } : null;
};

/** The top-level block under a point of the screen (a right click). */
export const blockAtCoords = (editor: Editor, x: number, y: number): BlockRef | null => {
  const hit = editor.view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const $pos = editor.state.doc.resolve(hit.inside >= 0 ? hit.inside : hit.pos);
  if ($pos.depth === 0) {
    const node = editor.state.doc.nodeAt(hit.inside >= 0 ? hit.inside : hit.pos);
    return node ? blockRefAt(node, hit.inside >= 0 ? hit.inside : hit.pos) : null;
  }
  return blockRefAt($pos.node(1), $pos.before(1));
};

/** The top-level block of the caret (Shift+F10 / the menu key). */
export const blockAtSelection = (editor: Editor): BlockRef | null => {
  const { $from } = editor.state.selection;
  if ($from.depth === 0) {
    const node = editor.state.doc.nodeAt($from.pos);
    return node ? blockRefAt(node, $from.pos) : null;
  }
  return blockRefAt($from.node(1), $from.before(1));
};

// ---------------------------------------------------------------- actions

export const deleteBlock = (editor: Editor, ref: BlockRef) => {
  const b = resolveBlock(editor, ref);
  if (!b) return false;
  const { tr, schema } = editor.state;
  const $pos = tr.doc.resolve(b.pos);
  // The only block of its parent: an empty paragraph stays (a doc / a cell / a column is never empty).
  if ($pos.parent.childCount === 1 && schema.nodes.paragraph) {
    tr.replaceWith(b.pos, b.pos + b.node.nodeSize, schema.nodes.paragraph.create());
  } else tr.delete(b.pos, b.pos + b.node.nodeSize);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
};

export const duplicateBlock = (editor: Editor, ref: BlockRef) => {
  const b = resolveBlock(editor, ref);
  if (!b) return false;
  // A fresh id (the ids extension gives one; the nested blocks' duplicates are renamed by it too).
  const copy = b.node.type.create({ ...b.node.attrs, id: null }, b.node.content, b.node.marks);
  const at = b.pos + b.node.nodeSize;
  const tr = editor.state.tr.insert(at, copy);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
};

/** Swaps the block with the one before (-1) or after (+1) it in its parent. */
export const moveBlock = (editor: Editor, ref: BlockRef, by: -1 | 1) => {
  const b = resolveBlock(editor, ref);
  if (!b) return false;
  const $pos = editor.state.doc.resolve(b.pos);
  const index = $pos.index();
  const other = by < 0 ? (index > 0 ? $pos.parent.child(index - 1) : null) : $pos.parent.maybeChild(index + 1);
  if (!other) return false;
  const tr = editor.state.tr.delete(b.pos, b.pos + b.node.nodeSize);
  const at = by < 0 ? b.pos - other.nodeSize : b.pos + other.nodeSize;
  tr.insert(at, b.node);
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
};

export const canMove = (editor: Editor, ref: BlockRef, by: -1 | 1) => {
  const b = resolveBlock(editor, ref);
  if (!b) return false;
  const $pos = editor.state.doc.resolve(b.pos);
  const index = $pos.index();
  return by < 0 ? index > 0 : index < $pos.parent.childCount - 1;
};

export const TURN_INTO = ['text', 'h1', 'h2', 'h3', 'bullets', 'numbers', 'tasks', 'quote', 'code', 'callout', 'toggle'] as const;
export type TurnInto = (typeof TURN_INTO)[number];

const TURN_GLYPH: Record<TurnInto, string> = {
  text: 'T',
  h1: 'H1',
  h2: 'H2',
  h3: 'H3',
  bullets: '•',
  numbers: '1.',
  tasks: '☑',
  quote: '❝',
  code: '</>',
  callout: '💡',
  toggle: '▸',
};

/** Blocks made of text (and lists / quotes of text) can change type; a table, an image or an embed cannot. */
const TEXTUAL = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
  'callout',
  'details',
]);
export const canTurn = (ref: BlockRef) => TEXTUAL.has(ref.type);

/** The block's kind as a "turn into" id (to mark the current one). */
const currentKind = (node: PMNode): TurnInto | null => {
  switch (node.type.name) {
    case 'paragraph':
      return 'text';
    case 'heading':
      return node.attrs.level === 1 ? 'h1' : node.attrs.level === 2 ? 'h2' : 'h3';
    case 'bulletList':
      return 'bullets';
    case 'orderedList':
      return 'numbers';
    case 'taskList':
      return 'tasks';
    case 'blockquote':
      return 'quote';
    case 'codeBlock':
      return 'code';
    case 'callout':
      return 'callout';
    case 'details':
      return 'toggle';
    default:
      return null;
  }
};

/** Turns a block into another kind: its text is kept (a list becomes lines, lines become a list…). */
export const turnInto = (editor: Editor, ref: BlockRef, to: TurnInto) => {
  const b = resolveBlock(editor, ref);
  if (!b || !canTurn(ref)) return false;
  const from = b.pos + 1;
  const end = b.pos + b.node.nodeSize - 1;
  const select = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setSelection(TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(end)));
      return true;
    });
  // Out of every wrapper first (a list, a quote, a callout), then into the new kind.
  if (b.node.type.name === 'callout') select.lift('callout');
  if (b.node.type.name === 'details') select.unsetDetails();
  const c = select.clearNodes();
  switch (to) {
    case 'text':
      return c.setParagraph().run();
    case 'h1':
    case 'h2':
    case 'h3':
      return c.setHeading({ level: Number(to.slice(1)) as 1 | 2 | 3 }).run();
    case 'bullets':
      return c.toggleBulletList().run();
    case 'numbers':
      return c.toggleOrderedList().run();
    case 'tasks':
      return c.toggleTaskList().run();
    case 'quote':
      return c.setBlockquote().run();
    case 'code':
      return c.setCodeBlock().run();
    case 'callout':
      return c.wrapIn('callout', { tone: 'info', emoji: '💡' }).run();
    case 'toggle':
      return c.setDetails().run();
  }
};

/** Gives an old block (from before ids) its id, so a link or a comment can point at it. */
const ensureId = (editor: Editor, ref: BlockRef): string | null => {
  const b = resolveBlock(editor, ref);
  if (!b) return null;
  if (typeof b.node.attrs.id === 'string' && b.node.attrs.id) return b.node.attrs.id;
  if (!editor.isEditable || !('id' in b.node.attrs)) return null;
  const id = crypto.randomUUID();
  editor.view.dispatch(editor.state.tr.setNodeAttribute(b.pos, 'id', id));
  return id;
};

/** `…/d/<doc>#block-<id>` — the doc page scrolls to that block and marks it. */
export const blockLink = (slug: string, docId: string, blockId: string) =>
  appLink(`${docPath(slug, docId)}#block-${blockId}`);

// ---------------------------------------------------------------- the menus

const glyph = (g: string) => (
  <span aria-hidden className="w-4 text-center text-xs font-bold text-muted">
    {g}
  </span>
);

export type BlockMenuEnv = {
  editable: boolean;
  canComment: boolean;
  slug: string;
  docId: string | undefined;
  onComment: (block: { id: string; quote: string }) => void;
};

/** delete · duplicate · turn into · copy link · move up / down · comment. */
export const blockMenuEntries = (editor: Editor, ref: BlockRef, env: BlockMenuEnv): MenuEntry[] => {
  const b = resolveBlock(editor, ref);
  if (!b) return [];
  const out: MenuEntry[] = [];
  if (env.editable && canTurn(ref)) {
    const now = currentKind(b.node);
    out.push({
      kind: 'submenu',
      label: t('docs2.blockMenu.turnInto'),
      testId: 'doc-block-turn',
      icon: glyph('T'),
      items: TURN_INTO.map((id) => ({
        label: t(msgKey(`docs2.block.${id === 'text' ? 'text' : id}`)),
        testId: `doc-block-turn-${id}`,
        icon: glyph(TURN_GLYPH[id]),
        checked: now === id,
        onSelect: () => void turnInto(editor, ref, id),
      })),
    });
  }
  if (env.editable)
    out.push({
      label: t('menu.duplicate'),
      testId: 'doc-block-duplicate',
      icon: <Icon name="duplicate" size={15} />,
      onSelect: () => void duplicateBlock(editor, ref),
    });
  if (env.docId) {
    const docId = env.docId;
    out.push({
      label: t('docs2.blockMenu.copyLink'),
      testId: 'doc-block-link',
      icon: <Icon name="link" size={15} />,
      onSelect: () => {
        const id = ensureId(editor, ref);
        if (id) copyText(blockLink(env.slug, docId, id));
        else showToast({ message: t('error.generic'), tone: 'error' });
      },
    });
  }
  if (env.editable) {
    out.push(
      {
        label: t('docs2.blockMenu.moveUp'),
        testId: 'doc-block-up',
        icon: glyph('↑'),
        disabled: !canMove(editor, ref, -1),
        onSelect: () => void moveBlock(editor, ref, -1),
      },
      {
        label: t('docs2.blockMenu.moveDown'),
        testId: 'doc-block-down',
        icon: glyph('↓'),
        disabled: !canMove(editor, ref, 1),
        onSelect: () => void moveBlock(editor, ref, 1),
      },
    );
  }
  if (env.canComment)
    out.push({
      label: t('docs2.comment.add'),
      testId: 'doc-block-comment',
      icon: <Icon name="chat" size={15} />,
      onSelect: () => {
        const id = ensureId(editor, ref);
        const now = resolveBlock(editor, ref);
        if (id && now) env.onComment({ id, quote: now.node.textContent.slice(0, 300) });
        else showToast({ message: t('docs2.comment.pickBlock') });
      },
    });
  if (env.editable)
    out.push(
      { kind: 'separator' },
      {
        label: t('docs2.blockMenu.delete'),
        testId: 'doc-block-delete',
        danger: true,
        icon: <Icon name="trash" size={15} />,
        onSelect: () => void deleteBlock(editor, ref),
      },
    );
  return out;
};

/** Cut / copy / paste through the editor (the browser's own commands act on its selection). */
const clipboard = async (editor: Editor, action: 'cut' | 'copy' | 'paste') => {
  editor.commands.focus();
  if (action !== 'paste') {
    if (!document.execCommand(action)) showToast({ message: t(msgKey(`docs2.ctx.${action}Blocked`)) });
    return;
  }
  try {
    const items = (await navigator.clipboard.read?.()) ?? [];
    for (const item of items) {
      if (item.types.includes('text/html')) {
        editor.view.pasteHTML(await (await item.getType('text/html')).text());
        return;
      }
      if (item.types.includes('text/plain')) {
        editor.view.pasteText(await (await item.getType('text/plain')).text());
        return;
      }
    }
    const text = await navigator.clipboard.readText();
    if (text) editor.view.pasteText(text);
  } catch {
    showToast({ message: t('docs2.ctx.pasteBlocked') });
  }
};

/**
 * A right click in the doc: cut / copy / paste, the text's format (when something is selected), then the block's
 * own menu.
 */
export const contextMenuEntries = (editor: Editor, ref: BlockRef | null, env: BlockMenuEnv): MenuEntry[] => {
  const hasText = !editor.state.selection.empty;
  const chain = () => editor.chain().focus();
  const out: MenuEntry[] = [];
  if (env.editable)
    out.push({
      label: t('docs2.ctx.cut'),
      testId: 'doc-ctx-cut',
      icon: glyph('✂'),
      shortcut: 'Ctrl+X',
      disabled: !hasText,
      onSelect: () => void clipboard(editor, 'cut'),
    });
  out.push({
    label: t('docs2.ctx.copy'),
    testId: 'doc-ctx-copy',
    icon: <Icon name="copy" size={15} />,
    shortcut: 'Ctrl+C',
    disabled: !hasText,
    onSelect: () => void clipboard(editor, 'copy'),
  });
  if (env.editable) {
    out.push({
      label: t('docs2.ctx.paste'),
      testId: 'doc-ctx-paste',
      icon: <Icon name="clip" size={15} />,
      shortcut: 'Ctrl+V',
      onSelect: () => void clipboard(editor, 'paste'),
    });
    if (hasText)
      out.push({
        kind: 'submenu',
        label: t('docs2.ctx.format'),
        testId: 'doc-ctx-format',
        icon: glyph('A'),
        items: [
          { label: t('editor.bold'), shortcut: 'Ctrl+B', checked: editor.isActive('bold'), testId: 'doc-ctx-bold', onSelect: () => void chain().toggleBold().run() },
          { label: t('editor.italic'), shortcut: 'Ctrl+I', checked: editor.isActive('italic'), onSelect: () => void chain().toggleItalic().run() },
          { label: t('editor.underline'), shortcut: 'Ctrl+U', checked: editor.isActive('underline'), onSelect: () => void chain().toggleUnderline().run() },
          { label: t('editor.strike'), checked: editor.isActive('strike'), onSelect: () => void chain().toggleStrike().run() },
          { label: t('editor.highlight'), checked: editor.isActive('highlight'), onSelect: () => void chain().toggleHighlight().run() },
          { label: t('docs2.mark.code'), checked: editor.isActive('code'), onSelect: () => void chain().toggleCode().run() },
        ],
      });
  }
  const block = ref ? blockMenuEntries(editor, ref, env) : [];
  if (block.length) out.push({ kind: 'separator' }, ...block);
  return out;
};
