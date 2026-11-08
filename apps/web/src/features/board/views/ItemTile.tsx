// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { formulaHref, readDateSpan, readIds, t, type Column, type Field, type QueryEnv } from '@bines/shared';
import { Avatar, cn, Menu, MenuTrigger } from '@bines/ui';
import { LabelTag } from '../../../lib/label-color';
import { type BoardDetail, type Item, type Member, type useBoardMutations, useTags } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { linkedNames } from '../cells/linked-names';
import { RelationChips } from '../cells/RelationChips';
import { TagChip } from '../cells/TagsCell';
import { useItemMenu } from '../item-menu';
import { useOpenItem } from '../open-item';
import { openBatchMenu } from '../BatchBar';
import { SelectionContext } from '../selection';
import { safeField } from '../toolbar/filter-model';
import { Icon } from '../../../lib/icons';
import { UpdateCountPill, useUpdateCount } from './UpdateCountPill';

type Label = { id: number; label: string; color?: string };
const labelsOf = (f: Field) =>
  (f.source === 'column' && Array.isArray(f.settings.labels) ? f.settings.labels : []) as Label[];

/** A read-only value on a card: label chips in their colours, avatars for people, text for the rest. */
export const FieldValue = ({
  item,
  column,
  env,
  members,
}: {
  item: Item;
  column: Column;
  env: QueryEnv;
  members: Member[];
}) => {
  const f = safeField(column.id, env);
  const cell = item.cells[column.id];
  if (!f || !cell) return <span className="text-muted">—</span>;
  if (f.model === 'label' || f.model === 'labels') {
    const ids = readIds(item, f);
    const labels = labelsOf(f);
    return (
      <span className="flex flex-wrap gap-1">
        {ids.map((id) => {
          const l = labels.find((x) => String(x.id) === id);
          return <LabelPill key={id} label={l?.label ?? id} color={f.model === 'label' ? (l?.color ?? null) : null} />;
        })}
      </span>
    );
  }
  if (f.model === 'tags') return <TagValues ids={readIds(item, f)} text={cell.text} />;
  // linked items as chips that fit the card, then "+N" with the full list.
  if (column.type === 'board_relation' || column.type === 'dependency')
    return <RelationValue item={item} column={column} />;
  if (f.model === 'people') {
    const ids = readIds(item, f);
    const first = members.find((x) => x.user_id === ids[0]);
    // One person: avatar and name (F4 cards); several: the avatars overlap.
    if (ids.length === 1)
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={first?.name || first?.email || ids[0]!} url={first?.avatar_url} size={24} />
          <span className="truncate text-xs">{first?.name || first?.email || cell.text}</span>
        </span>
      );
    return <People ids={ids} members={members} />;
  }
  // Fix: a formula's web address is a link on cards too.
  const href =
    column.type === 'formula' ? formulaHref((cell.value as { result?: unknown })?.result, column.settings) : null;
  if (href)
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        dir="ltr"
        className="truncate text-primary underline"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {cell.text || href}
      </a>
    );
  return (
    <span className="truncate" dir="auto">
      {cell.text}
    </span>
  );
};

const RelationValue = ({ item, column }: { item: Item; column: Column }) => {
  const openItem = useOpenItem(item.board_id);
  const cell = item.cells[column.id];
  const ids = (cell?.value as { item_ids?: string[] } | null)?.item_ids ?? [];
  const names = linkedNames(ids, cell?.names, cell?.text ?? null);
  return (
    <span className="flex min-w-0 flex-1">
      <RelationChips
        chips={ids.map((id, i) => ({ id, name: names[i] ?? id }))}
        maxChars={Number(column.settings.chip_max_chars) || undefined}
        onOpen={openItem}
      />
    </span>
  );
};

/** A status-like value: the board's chip (its tint, its ink, regular weight); dropdown values are neutral. */
const LabelPill = ({ label, color }: { label: string; color: string | null }) =>
  color ? (
    <LabelTag color={color}>{label}</LabelTag>
  ) : (
    <span className="inline-flex h-6 max-w-full items-center truncate rounded-[7px] bg-surface-2 px-2.5 text-xs text-fg-2">
      {label}
    </span>
  );

const People = ({ ids, members }: { ids: string[]; members: Member[] }) => (
  <span className="flex -space-x-2 rtl:space-x-reverse">
    {ids.map((id) => {
      const m = members.find((x) => x.user_id === id);
      return (
        <Avatar
          key={id}
          name={m?.name || m?.email || id}
          url={m?.avatar_url}
          size={24}
          className="ring-2 ring-[var(--surface)]"
        />
      );
    })}
  </span>
);

/** Whether a card has anything to show for this column (F4 hides empty fields instead of "—" rows). */
const hasValue = (item: Item, column: Column, env: QueryEnv) => {
  const f = safeField(column.id, env);
  const cell = item.cells[column.id];
  if (!f || !cell) return false;
  if (f.model === 'label' || f.model === 'labels' || f.model === 'people' || f.model === 'tags')
    return readIds(item, f).length > 0;
  return !!cell.text;
};

const TagValues = ({ ids, text }: { ids: string[]; text: string | null }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const all = useTags(accountId).data?.data;
  if (!all) return <span className="truncate">{text}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const tag = all.find((x) => x.id === id);
        return tag ? <TagChip key={id} tag={tag} /> : null;
      })}
    </span>
  );
};

type TileProps = {
  item: Item;
  fields: Column[];
  env: QueryEnv;
  members: Member[];
  boardId: string;
  compact?: boolean;
  /**
   * `cards` (default): label / value rows; `kanban`: one compact row of the first number, date and person;
   * `row`: a line of a phone list (no box of its own — the group's box draws it).
   */
  variant?: 'cards' | 'kanban' | 'row';
  className?: string;
  dragHandle?: Record<string, unknown>;
  /** With the board and its mutations the tile gets the item menu (14 §1): right click, ⋯, Shift+F10. */
  menu?: {
    board: BoardDetail;
    mutations: ReturnType<typeof useBoardMutations>;
    /** the tile's section / lane value — "add item below" creates the item with it. */
    addCells?: Record<string, unknown>;
  };
};

/** An item as a card (Kanban, Cards, Calendar): its name and the chosen fields; click opens the item card. */
export const ItemTile = (props: TileProps) =>
  props.menu ? <TileWithMenu {...props} menu={props.menu} /> : <TileBody {...props} />;

const TileWithMenu = (props: TileProps & { menu: NonNullable<TileProps['menu']> }) => {
  const { menu, entries, label, dialogs } = useItemMenu(
    props.menu.board,
    props.item,
    props.menu.mutations,
    undefined,
    undefined,
    undefined,
    props.menu.addCells,
  );
  return (
    <TileBody
      {...props}
      onContextMenu={menu.onContextMenu}
      onMenuKey={menu.onKeyDown}
      trigger={
        <>
          <MenuTrigger label={label} onClick={menu.fromTrigger} className="-me-1" />
          <Menu at={menu.at} onClose={menu.close} items={entries} label={label} />
          {dialogs}
        </>
      }
    />
  );
};

const TileBody = ({
  item,
  fields,
  env,
  members,
  boardId,
  compact,
  variant = 'cards',
  className,
  dragHandle,
  onContextMenu,
  onMenuKey,
  trigger,
}: TileProps & {
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
  onMenuKey?: (e: KeyboardEvent<HTMLElement>) => void;
  trigger?: ReactNode;
}) => {
  const open = useOpenItem(boardId);
  // Kanban and Cards select like the table (07 §6): the check box, Ctrl+click, Shift+click for a range.
  const selection = useContext(SelectionContext);
  const selected = !!selection?.has(item.id);
  const shown = compact ? [] : fields.filter((c) => hasValue(item, c, env));
  const row = variant === 'row';
  // N4: kanban cards show it in their bottom line (before the person, F4); cards and rows next to the name.
  const updates = useUpdateCount(boardId, item.id);
  const pill = <UpdateCountPill boardId={boardId} itemId={item.id} count={updates} />;
  const pillInGlance = variant === 'kanban';
  return (
    <div
      role="link"
      tabIndex={0}
      onClick={(e) => {
        if (selection && (e.ctrlKey || e.metaKey || e.shiftKey)) selection.toggle(item.id, e.shiftKey);
        else open(item.id);
      }}
      onContextMenu={(e) => (selected && (selection?.ids.length ?? 0) > 1 ? openBatchMenu(e) : onContextMenu?.(e))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(item.id);
        else onMenuKey?.(e);
      }}
      className={cn(
        'group flex min-w-0 max-w-full cursor-pointer flex-col p-3 text-sm',
        row
          ? 'gap-2 border-b border-line-soft bg-surface last:border-b-0 hover:bg-surface-3'
          : 'rounded-[12px] border border-line bg-surface shadow-[0_1px_2px_rgba(13,59,53,0.06)] hover:border-line-strong',
        variant === 'kanban' && 'gap-2.5',
        variant === 'cards' && 'gap-3',
        selected && (row ? 'bg-info-soft hover:bg-info-soft' : 'border-heading bg-info-soft ring-1 ring-heading'),
        className,
      )}
      data-testid="item-tile"
      data-item-name={item.name}
      data-item-id={item.id}
      data-selected={selected || undefined}
      {...dragHandle}
    >
      <div className="flex items-start gap-1.5">
        <div
          // A long name wraps — long words break too — and never runs out of the card (fix1).
          data-testid="tile-name"
          className={cn(
            'min-w-0 flex-1 [overflow-wrap:anywhere] break-words whitespace-normal',
            variant === 'cards'
              ? 'font-display text-[0.9375rem] leading-snug font-bold text-heading'
              : 'font-normal text-fg',
          )}
        >
          {/*: a name computed from columns — the small ƒ (the card / table explain which columns). */}
          {item.name_computed ? (
            <span
              data-testid="tile-computed"
              data-tip={t('name.computed.short')}
              title={t('name.computed.short')}
              className="me-1 font-serif font-normal text-muted italic"
            >
              ƒ
            </span>
          ) : null}
          {item.name}
        </div>
        {pillInGlance ? null : <span className="flex h-6 items-center">{pill}</span>}
        {trigger}
        {/* F4: the check box sits at the card's end and is always there — a phone list's rows too (prod
            : select items on a phone like on the desktop; the batch bar follows), with a finger-sized target. */}
        {selection ? (
          <input
            type="checkbox"
            data-testid="tile-select"
            aria-label={t('select.item', { name: item.name })}
            checked={selected}
            onChange={() => undefined}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              selection.toggle(item.id, e.shiftKey);
            }}
            className={cn(
              'mt-0.5 shrink-0 cursor-pointer accent-[var(--check)]',
              row ? 'size-5 max-md:m-[-0.625rem] max-md:box-content max-md:p-2.5' : 'size-[0.9375rem]',
            )}
          />
        ) : null}
      </div>
      {!shown.length ? (
        pillInGlance && updates > 0 ? (
          <div className="flex items-center justify-end">{pill}</div>
        ) : null
      ) : variant === 'cards' ? (
        <dl className="flex flex-col gap-2">
          {shown.map((c) => (
            <div key={c.id} className="flex min-h-6 items-center justify-between gap-3">
              <dt className="shrink-0 truncate text-xs text-muted">{c.title}</dt>
              <dd className="flex min-w-0 justify-end">
                <FieldValue item={item} column={c} env={env} members={members} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <Glance
          item={item}
          fields={shown}
          env={env}
          members={members}
          withStatus={row}
          pill={pillInGlance && updates > 0 ? pill : null}
        />
      )}
    </div>
  );
};

/**
 * The compact line of a Kanban card or a phone row (F4): status (phone rows) and date at the start — a past date
 * in red on phones — and the number (bold) and person at the end. Other chosen fields follow as small values.
 */
const Glance = ({
  item,
  fields,
  env,
  members,
  withStatus,
  pill,
}: {
  item: Item;
  fields: Column[];
  env: QueryEnv;
  members: Member[];
  withStatus: boolean;
  /** N4: the update-count pill, at the end before the person (kanban). */
  pill?: ReactNode;
}) => {
  const fieldOf = (c: Column) => safeField(c.id, env);
  const pick = (test: (f: Field) => boolean) =>
    fields.find((c) => {
      const f = fieldOf(c);
      return !!f && test(f);
    });
  const status = withStatus ? pick((f) => f.model === 'label') : undefined;
  const date = pick((f) => f.model === 'date');
  const num = pick((f) => f.model === 'number');
  const person = pick((f) => f.model === 'people');
  const used = new Set([status?.id, date?.id, num?.id, person?.id]);
  const rest = fields.filter((c) => !used.has(c.id));
  const dateField = date ? fieldOf(date) : null;
  const span = dateField ? readDateSpan(item, dateField, env.timezone) : null;
  const late = withStatus && !!span?.to && span.to < env.today;
  const personField = person ? fieldOf(person) : null;
  return (
    <>
      {rest.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {rest.map((c) => (
            <span key={c.id} className="flex min-w-0 max-w-full text-xs text-fg-2">
              <FieldValue item={item} column={c} env={env} members={members} />
            </span>
          ))}
        </div>
      ) : null}
      {status || date || num || person || pill ? (
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {status ? <FieldValue item={item} column={status} env={env} members={members} /> : null}
            {num && !withStatus ? <NumberValue item={item} column={num} /> : null}
            {date ? (
              <span
                className={cn(
                  'flex items-center gap-1 truncate text-xs',
                  late ? 'font-normal text-danger-fg' : 'text-muted',
                )}
                dir="auto"
              >
                {withStatus ? null : <Icon name="calendar" size={13} />}
                {item.cells[date.id]?.text}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {num && withStatus ? <NumberValue item={item} column={num} /> : null}
            {pill}
            {person && personField ? <People ids={readIds(item, personField)} members={members} /> : null}
          </span>
        </div>
      ) : null}
    </>
  );
};

const NumberValue = ({ item, column }: { item: Item; column: Column }) => (
  <span className="text-xs font-normal text-heading tabular-nums" dir="ltr">
    {item.cells[column.id]?.text}
  </span>
);
