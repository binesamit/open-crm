// SPDX-License-Identifier: AGPL-3.0-only
import { t, type CreateLinkedAction, type StatusLabel } from '@bines/shared';
import { Field, Input, Segmented, Switch } from '@bines/ui';
import { columnTypeLabel } from '../../lib/locale';
import { useAllBoards } from '../automations/automations-api';
import { useBoard, type BoardDetail, type Column } from './board-api';
import { PickerButton } from './toolbar/parts';
import { popupColumns, PopupEditor } from './workflow/popup';

/**
 * P1-03 — the settings of a "create a linked item" button: the board the item goes to, the relation
 * that links them (on either board), values copied from the clicked item, fixed values, the popup (columns of the
 * target board), when the popup opens on an existing linked item instead, and what happens after saving.
 */
export const EMPTY_LINKED: CreateLinkedAction = {
  kind: 'create_linked',
  board_id: '',
  copy: [],
  fixed: [],
  popup: { fields: [], note: 'off' },
  after: 'toast',
};

const relationTo = (c: Column, boardId: string) =>
  c.type === 'board_relation' && ((c.settings.board_ids as string[] | undefined) ?? []).includes(boardId);

const Row = ({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) => (
  <div className="flex items-center gap-1.5">
    {children}
    <button
      type="button"
      aria-label={t('common.delete')}
      className="cursor-pointer px-1 text-muted hover:text-fg"
      onClick={onRemove}
    >
      ✕
    </button>
  </div>
);
const AddLink = ({ testId, onClick, label }: { testId: string; onClick: () => void; label: string }) => (
  <button
    type="button"
    data-testid={testId}
    className="self-start text-sm text-primary hover:underline"
    onClick={onClick}
  >
    + {label}
  </button>
);

export const LinkedButtonEditor = ({
  accountId,
  board,
  action,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  action: CreateLinkedAction;
  onChange: (a: CreateLinkedAction) => void;
}) => {
  const boards = useAllBoards(accountId);
  const target = useBoard(accountId, action.board_id).data;
  const set = (patch: Partial<CreateLinkedAction>) => onChange({ ...action, ...patch });

  // The relations that link the two boards, on either side.
  const links = target
    ? [
        ...board.columns
          .filter((c) => relationTo(c, target.id))
          .map((c) => ({ on: 'source' as const, c, label: t('button.linked.linkHere', { name: c.title }) })),
        ...target.columns
          .filter((c) => relationTo(c, board.id))
          .map((c) => ({ on: 'target' as const, c, label: t('button.linked.linkThere', { name: c.title }) })),
      ]
    : [];
  const link = links.find((l) => l.on === action.link?.on && l.c.id === action.link?.column_id);
  const targetName = target?.columns.find((c) => c.type === 'name');
  // The target's columns a value may go to (not the linking relation itself).
  const writable = target
    ? popupColumns(target).filter((c) => !(action.link?.on === 'target' && c.id === action.link.column_id))
    : [];
  const sources = board.columns.filter((c) => c.type !== 'button' && c.type !== 'name');
  const statuses = target?.columns.filter((c) => c.type === 'status') ?? [];
  const reuseColumn = statuses.find((c) => c.id === action.reuse?.column_id);
  const reuseLabels = ((reuseColumn?.settings.labels as StatusLabel[] | undefined) ?? []).filter(
    (l) => !l.is_deactivated,
  );
  const titleOf = (id: string) =>
    id === 'name' ? (targetName?.title ?? t('button.linked.name')) : target?.columns.find((c) => c.id === id)?.title;

  return (
    <div className="flex flex-col gap-3" data-testid="button-linked">
      <Field label={t('button.linked.board')}>
        <PickerButton
          testId="button-linked-board"
          menuLabel={t('button.linked.board')}
          placeholder={t('button.linked.boardPick')}
          label={boards.find((b) => b.id === action.board_id)?.name}
          items={boards.map((b) => ({
            label: `${b.name} · ${b.workspace_name}`,
            checked: b.id === action.board_id,
            onSelect: () =>
              onChange({ ...EMPTY_LINKED, after: action.after, board_id: b.id, popup: { fields: [], note: 'off' } }),
          }))}
        />
      </Field>
      {target ? (
        <>
          <Field label={t('button.linked.link')} hint={links.length ? undefined : t('button.linked.noLink')}>
            <PickerButton
              testId="button-linked-link"
              menuLabel={t('button.linked.link')}
              placeholder={t('button.linked.linkPick')}
              label={link?.label}
              items={links.map((l) => ({
                label: l.label,
                checked: l === link,
                onSelect: () => set({ link: { on: l.on, column_id: l.c.id } }),
              }))}
            />
          </Field>

          <Field label={t('button.linked.copy')} hint={t('button.linked.copyHint')}>
            <div className="flex flex-col gap-1.5" data-testid="button-linked-copy">
              {action.copy.map((m, i) => (
                <Row key={i} onRemove={() => set({ copy: action.copy.filter((_, j) => j !== i) })}>
                  <PickerButton
                    className="min-w-0 flex-1"
                    testId="button-linked-copy-from"
                    menuLabel={t('button.linked.from')}
                    placeholder={t('button.linked.from')}
                    label={
                      m.from === 'name'
                        ? (board.columns.find((c) => c.type === 'name')?.title ?? t('button.linked.name'))
                        : board.columns.find((c) => c.id === m.from)?.title
                    }
                    items={[
                      {
                        label: board.columns.find((c) => c.type === 'name')?.title ?? t('button.linked.name'),
                        checked: m.from === 'name',
                        onSelect: () =>
                          set({ copy: action.copy.map((x, j) => (j === i ? { ...x, from: 'name' } : x)) }),
                      },
                      ...sources.map((c) => ({
                        label: `${c.title} · ${columnTypeLabel(c.type)}`,
                        checked: c.id === m.from,
                        onSelect: () => set({ copy: action.copy.map((x, j) => (j === i ? { ...x, from: c.id } : x)) }),
                      })),
                    ]}
                  />
                  <span className="text-muted" aria-hidden>
                    ←
                  </span>
                  <PickerButton
                    className="min-w-0 flex-1"
                    testId="button-linked-copy-to"
                    menuLabel={t('button.linked.to')}
                    placeholder={t('button.linked.to')}
                    label={titleOf(m.to)}
                    items={[
                      {
                        label: targetName?.title ?? t('button.linked.name'),
                        checked: m.to === 'name',
                        onSelect: () => set({ copy: action.copy.map((x, j) => (j === i ? { ...x, to: 'name' } : x)) }),
                      },
                      ...writable.map((c) => ({
                        label: `${c.title} · ${columnTypeLabel(c.type)}`,
                        checked: c.id === m.to,
                        onSelect: () => set({ copy: action.copy.map((x, j) => (j === i ? { ...x, to: c.id } : x)) }),
                      })),
                    ]}
                  />
                </Row>
              ))}
              {action.copy.length < 30 ? (
                <AddLink
                  testId="button-linked-copy-add"
                  label={t('button.linked.addCopy')}
                  onClick={() => set({ copy: [...action.copy, { from: 'name', to: 'name' }] })}
                />
              ) : null}
            </div>
          </Field>

          <Field label={t('button.linked.fixed')} hint={t('button.setValuesHint')}>
            <div className="flex flex-col gap-1.5" data-testid="button-linked-fixed">
              {action.fixed.map((v, i) => (
                <Row key={i} onRemove={() => set({ fixed: action.fixed.filter((_, j) => j !== i) })}>
                  <PickerButton
                    className="w-40 shrink-0"
                    testId="button-linked-fixed-column"
                    menuLabel={t('button.column')}
                    placeholder={t('button.column')}
                    label={titleOf(v.column_id)}
                    items={writable.map((c) => ({
                      label: `${c.title} · ${columnTypeLabel(c.type)}`,
                      checked: c.id === v.column_id,
                      onSelect: () =>
                        set({ fixed: action.fixed.map((x, j) => (j === i ? { ...x, column_id: c.id } : x)) }),
                    }))}
                  />
                  <Input
                    className="h-8 min-w-0 flex-1"
                    value={v.text}
                    data-testid="button-linked-fixed-text"
                    placeholder={t('button.valuePlaceholder')}
                    onChange={(e) =>
                      set({ fixed: action.fixed.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })
                    }
                  />
                </Row>
              ))}
              {action.fixed.length < 20 && writable.length ? (
                <AddLink
                  testId="button-linked-fixed-add"
                  label={t('button.addValue')}
                  onClick={() => set({ fixed: [...action.fixed, { column_id: writable[0]!.id, text: '' }] })}
                />
              ) : null}
            </div>
          </Field>

          <Field label={t('button.linked.popup')} hint={t('button.linked.popupHint')}>
            <PopupEditor
              accountId={accountId}
              board={target}
              popup={action.popup}
              onChange={(popup) => set({ popup })}
            />
          </Field>

          <Field label={t('button.linked.reuse')}>
            <div className="flex flex-col gap-1.5" data-testid="button-linked-reuse">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={!!action.reuse}
                  testId="button-linked-reuse-on"
                  disabled={!statuses.length}
                  onChange={(on) =>
                    set({
                      reuse: on && statuses[0] ? { column_id: statuses[0].id, labels: [], empty: false } : undefined,
                    })
                  }
                />
                {t('button.linked.reuseOn')}
              </label>
              {action.reuse ? (
                <div className="flex flex-col gap-1.5 ps-1">
                  <PickerButton
                    className="w-56"
                    testId="button-linked-reuse-column"
                    menuLabel={t('button.linked.reuseColumn')}
                    placeholder={t('button.linked.reuseColumn')}
                    label={reuseColumn?.title}
                    items={statuses.map((c) => ({
                      label: c.title,
                      checked: c.id === action.reuse?.column_id,
                      onSelect: () => set({ reuse: { column_id: c.id, labels: [], empty: false } }),
                    }))}
                  />
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                    {reuseLabels.map((l) => {
                      const on = action.reuse!.labels.includes(l.id);
                      return (
                        <label key={l.id} className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            className="accent-[var(--check)]"
                            data-testid="button-linked-reuse-label"
                            checked={on}
                            onChange={() =>
                              set({
                                reuse: {
                                  ...action.reuse!,
                                  labels: on
                                    ? action.reuse!.labels.filter((x) => x !== l.id)
                                    : [...action.reuse!.labels, l.id],
                                },
                              })
                            }
                          />
                          {l.label || t('button.linked.emptyLabel')}
                        </label>
                      );
                    })}
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="accent-[var(--check)]"
                        checked={action.reuse.empty}
                        onChange={() => set({ reuse: { ...action.reuse!, empty: !action.reuse!.empty } })}
                      />
                      {t('button.linked.reuseEmpty')}
                    </label>
                  </div>
                </div>
              ) : null}
            </div>
          </Field>

          <Field label={t('button.linked.after')}>
            <Segmented
              label={t('button.linked.after')}
              value={action.after}
              testId="button-linked-after"
              onChange={(after) => set({ after })}
              options={[
                { value: 'toast', label: t('button.linked.afterToast'), testId: 'button-linked-after-toast' },
                { value: 'open', label: t('button.linked.afterOpen'), testId: 'button-linked-after-open' },
              ]}
            />
          </Field>
        </>
      ) : null}
    </div>
  );
};
