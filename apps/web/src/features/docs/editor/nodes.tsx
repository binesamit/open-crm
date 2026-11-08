// SPDX-License-Identifier: AGPL-3.0-only
import { mergeAttributes, Node } from '@tiptap/react';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import { useQuery } from '@tanstack/react-query';
import { CALLOUT_TONES, isId, t, type CalloutTone } from '@bines/shared';
import { cn } from '@bines/ui';
import { api } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { downloadFile, formatSize } from '../../../lib/upload';
import { useDocEnv } from './doc-env';
import { BoardEmbedView, EntityLinkView, ItemEmbedView } from './embeds';


/**
 * The doc's own blocks (M8 ד2), next to Tiptap's (headings, lists, tasks, tables, quote, code, toggle):
 * callout, columns, image and file (stored as an `asset_id` — the URL is signed on demand, never saved), a link to
 * an item / board / doc, and live embeds of a board view or an item card. Their JSON is what the server's export
 * and text derivation read (shared/docs) — keep the attribute names in step.
 */
const attr = (name: string, fallback: unknown = null) => ({
  default: fallback,
  parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? fallback,
  renderHTML: (attrs: Record<string, unknown>) =>
    attrs[name] === null || attrs[name] === undefined ? {} : { [`data-${name}`]: String(attrs[name]) },
});

// ---------------------------------------------------------------- callout

const TONE_EMOJI: Record<CalloutTone, string> = { info: '💡', ok: '✅', warn: '⚠️', danger: '⛔' };
const TONE_CLASS: Record<CalloutTone, string> = {
  info: 'bg-info-soft',
  ok: 'bg-ok-soft',
  warn: 'bg-accent-soft',
  danger: 'bg-danger-soft',
};

const CalloutView = ({ node, updateAttributes, editor }: ReactNodeViewProps) => {
  const tone = (CALLOUT_TONES as readonly string[]).includes(node.attrs.tone) ? (node.attrs.tone as CalloutTone) : 'info';
  const next = CALLOUT_TONES[(CALLOUT_TONES.indexOf(tone) + 1) % CALLOUT_TONES.length]!;
  return (
    <NodeViewWrapper
      className={cn('my-2 flex gap-2.5 rounded-[var(--radius)] px-3.5 py-2.5', TONE_CLASS[tone])}
      data-testid="doc-callout"
      data-id={node.attrs.id ?? undefined}
      data-tone={tone}
    >
      <button
        type="button"
        contentEditable={false}
        disabled={!editor.isEditable}
        className="mt-0.5 h-6 shrink-0 cursor-pointer rounded-[6px] text-lg leading-none enabled:hover:bg-black/5 disabled:cursor-default"
        title={editor.isEditable ? t('docs2.callout.tone') : undefined}
        aria-label={t('docs2.callout.tone')}
        onClick={() => updateAttributes({ tone: next, emoji: TONE_EMOJI[next] })}
      >
        {node.attrs.emoji || TONE_EMOJI[tone]}
      </button>
      <NodeViewContent className="min-w-0 flex-1" />
    </NodeViewWrapper>
  );
};

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({ tone: attr('tone', 'info'), emoji: attr('emoji', '💡') }),
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0],
  addNodeView: () => ReactNodeViewRenderer(CalloutView),
});

// ---------------------------------------------------------------- columns

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="column"]' }],
  renderHTML: ({ HTMLAttributes }) =>
    ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'doc-column' }), 0],
});

/** Two or three side-by-side columns of blocks (they stack on a phone). */
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,3}',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-type="columns"]' }],
  renderHTML: ({ HTMLAttributes }) =>
    ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'doc-columns' }), 0],
});

// ---------------------------------------------------------------- image & file

/** A signed link to one of the doc's files (refreshed before it expires). */
const useFileUrl = (rawAssetId: string | null, inline: boolean) => {
  const { accountId } = useDocEnv();
  // S-41: the asset id comes from doc content — only a real id may reach the API path.
  const assetId = rawAssetId && isId(rawAssetId) ? rawAssetId : null;
  return useQuery({
    queryKey: ['account', accountId, 'file-url', assetId, inline],
    queryFn: () =>
      api(accountId).get<{ download_url: string; name: string; size: number }>(
        `/files/${encodeURIComponent(assetId ?? '')}${inline ? '?inline=1' : ''}`,
      ),
    enabled: !!assetId,
    staleTime: 4 * 60_000,
    retry: false,
  });
};

const ImageView = ({ node, selected }: ReactNodeViewProps) => {
  const file = useFileUrl(node.attrs.asset_id as string | null, true);
  const alt = String(node.attrs.alt ?? '');
  return (
    <NodeViewWrapper
      className="my-2"
      data-testid="doc-image"
      data-id={node.attrs.id ?? undefined}
      data-asset-id={node.attrs.asset_id ?? undefined}
    >
      <figure
        contentEditable={false}
        className={cn(
          'inline-block max-w-full overflow-hidden rounded-[var(--radius)] border bg-surface-2',
          selected ? 'border-primary ring-3 ring-[var(--accent-soft)]' : 'border-line',
        )}
      >
        {file.data ? (
          <img src={file.data.download_url} alt={alt} className="block max-h-[560px] max-w-full object-contain" />
        ) : (
          <div className="grid h-40 w-64 place-items-center text-sm text-muted">
            {file.isError ? t('docs2.file.missing') : t('app.loading')}
          </div>
        )}
      </figure>
    </NodeViewWrapper>
  );
};

export const DocImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ asset_id: attr('asset_id'), alt: attr('alt', '') }),
  parseHTML: () => [{ tag: 'div[data-type="doc-image"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'doc-image' })],
  addNodeView: () => ReactNodeViewRenderer(ImageView),
});

const FileView = ({ node, selected }: ReactNodeViewProps) => {
  const { accountId } = useDocEnv();
  const name = String(node.attrs.name ?? '');
  const size = Number(node.attrs.size ?? 0);
  return (
    <NodeViewWrapper className="my-1.5" data-testid="doc-file" data-id={node.attrs.id ?? undefined} data-name={name}>
      <div
        contentEditable={false}
        className={cn(
          'inline-flex max-w-full items-center gap-2.5 rounded-[var(--radius)] border bg-surface px-3 py-2',
          selected ? 'border-primary' : 'border-line',
        )}
      >
        <Icon name="clip" size={16} className="shrink-0 text-muted" />
        <span className="min-w-0 truncate text-sm font-semibold text-fg">{name}</span>
        {size ? <span className="shrink-0 text-xs text-muted" dir="ltr">{formatSize(size)}</span> : null}
        <button
          type="button"
          className="grid size-7 shrink-0 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg"
          aria-label={t('docs2.file.download', { name })}
          title={t('docs2.file.download', { name })}
          onClick={() => void downloadFile(accountId, String(node.attrs.asset_id))}
        >
          <Icon name="download" size={15} />
        </button>
      </div>
    </NodeViewWrapper>
  );
};

export const FileBlock = Node.create({
  name: 'fileBlock',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({
    asset_id: attr('asset_id'),
    name: attr('name', ''),
    size: attr('size', 0),
    mime: attr('mime', ''),
  }),
  parseHTML: () => [{ tag: 'div[data-type="doc-file"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'doc-file' })],
  addNodeView: () => ReactNodeViewRenderer(FileView),
});

// ---------------------------------------------------------------- links & embeds

/** An inline link to an item, a board or a doc (inserted from `@`): opens it; "restricted" when I may not see it. */
export const EntityLink = Node.create({
  name: 'entityLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    kind: attr('kind', 'item'),
    id: attr('id'),
    board_id: attr('board_id'),
    label: attr('label', ''),
  }),
  parseHTML: () => [{ tag: 'span[data-type="entity-link"]' }],
  renderHTML: ({ HTMLAttributes, node }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-type': 'entity-link' }),
    String(node.attrs.label ?? ''),
  ],
  renderText: ({ node }) => String(node.attrs.label ?? ''),
  addNodeView: () => ReactNodeViewRenderer(EntityLinkView, { as: 'span' }),
});

/** A board (or one of its views) shown live inside the doc — read only, through the reader's own access. */
export const BoardEmbed = Node.create({
  name: 'boardEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ board_id: attr('board_id'), view_id: attr('view_id'), label: attr('label', '') }),
  parseHTML: () => [{ tag: 'div[data-type="board-embed"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'board-embed' })],
  addNodeView: () => ReactNodeViewRenderer(BoardEmbedView),
});

/** An item's card shown live inside the doc (read only). */
export const ItemEmbed = Node.create({
  name: 'itemEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({ item_id: attr('item_id'), board_id: attr('board_id'), label: attr('label', '') }),
  parseHTML: () => [{ tag: 'div[data-type="item-embed"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'item-embed' })],
  addNodeView: () => ReactNodeViewRenderer(ItemEmbedView),
});
