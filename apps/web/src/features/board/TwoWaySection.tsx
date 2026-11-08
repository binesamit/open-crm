// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { t } from '@bines/shared';
import { Button, Card, Field, Input, Notice, Segmented, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { type BoardDetail, boardKeys, type Column, useBoard } from './board-api';
import { PickerButton } from './toolbar/parts';

type RelationSettings = { board_ids?: string[]; two_way?: boolean; reflection_column_id?: string };
const settingsOf = (c: Column) => c.settings as RelationSettings;
const single = (c: Column) => (settingsOf(c).board_ids?.length === 1 ? settingsOf(c).board_ids![0]! : null);

/**
 * Two-way switch of a relation column (03 §2.16): on a column that links to exactly one board, pairs it with a
 * relation column on that board — a new one (titled after this board) or an existing one that links back — so a
 * link on either side shows on the other. Saves at once (it touches the other board), apart from the dialog's
 * save button. `dirty`: the board selection above was changed and not saved yet.
 */
export const TwoWaySection = ({
  accountId,
  board,
  column: initial,
  dirty,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  dirty: boolean;
}) => {
  const qc = useQueryClient();
  // The board's fresh copy: the pair changes here, without closing the dialog.
  const column = useBoard(accountId, board.id).data?.columns.find((c) => c.id === initial.id) ?? initial;
  const s = settingsOf(column);
  const targetId = single(column);
  const target = useBoard(accountId, targetId ?? '').data;
  const [on, setOn] = useState(!!s.two_way);
  const [mode, setMode] = useState<'create' | 'existing'>('create');
  const [title, setTitle] = useState(board.name);
  const [existing, setExisting] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const partner = s.two_way ? target?.columns.find((c) => c.id === s.reflection_column_id) : undefined;
  // Relation columns there that link back here alone and are not paired with another column.
  const candidates =
    target?.columns.filter(
      (c) =>
        c.type === 'board_relation' &&
        !(target.id === board.id && c.id === column.id) &&
        single(c) === board.id &&
        !(settingsOf(c).two_way && settingsOf(c).reflection_column_id !== column.id),
    ) ?? [];

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(accountId).put(`/boards/${board.id}/columns/${column.id}/two-way`, body);
      for (const id of new Set([board.id, targetId ?? board.id]))
        await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, id) });
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (next: boolean) => {
    if (next) return setOn(true); // the partner is chosen below, then "enable"
    if (s.two_way && !(await send({ enabled: false }))) return;
    setOn(false);
  };

  const unavailable = !targetId || dirty;
  return (
    <Card soft className="flex flex-col gap-3">
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-sm font-semibold">{t('relation.twoWay.title')}</span>
          <span className="text-xs text-muted">{t('relation.twoWay.hint')}</span>
        </span>
        <Switch
          checked={on}
          disabled={busy || (unavailable && !s.two_way)}
          onChange={(v) => void toggle(v)}
          label={t('relation.twoWay.title')}
          testId="relation-two-way-switch"
        />
      </label>
      {unavailable && !s.two_way ? (
        <p className="text-xs text-muted">{t(dirty ? 'relation.twoWay.saveFirst' : 'relation.twoWay.oneBoard')}</p>
      ) : null}

      {s.two_way ? (
        <p className="text-xs" data-testid="relation-two-way-partner">
          {partner
            ? t('relation.twoWay.linkedWith', { column: partner.title, board: target?.name ?? '' })
            : t('relation.twoWay.partnerMissing')}
        </p>
      ) : null}
      {s.two_way ? <p className="text-xs text-muted">{t('relation.twoWay.boardLocked')}</p> : null}

      {on && !s.two_way && !unavailable ? (
        <div className="flex flex-col gap-3">
          <Segmented
            value={mode}
            label={t('relation.twoWay.partner')}
            onChange={setMode}
            testId="relation-two-way-mode"
            options={[
              { value: 'create', label: t('relation.twoWay.create') },
              { value: 'existing', label: t('relation.twoWay.existing') },
            ]}
          />
          {mode === 'create' ? (
            <Field label={t('relation.twoWay.newTitle', { board: target?.name ?? '' })}>
              <Input
                value={title}
                maxLength={255}
                data-testid="relation-two-way-title"
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
          ) : candidates.length ? (
            <Field label={t('relation.twoWay.pick', { board: target?.name ?? '' })}>
              <PickerButton
                testId="relation-two-way-existing"
                menuLabel={t('relation.twoWay.pick', { board: target?.name ?? '' })}
                placeholder={t('relation.twoWay.pickPlaceholder')}
                label={candidates.find((c) => c.id === existing)?.title}
                items={candidates.map((c) => ({
                  label: c.title,
                  checked: c.id === existing,
                  onSelect: () => setExisting(c.id),
                }))}
              />
            </Field>
          ) : (
            <p className="text-xs text-muted">{t('relation.twoWay.noCandidates', { board: target?.name ?? '' })}</p>
          )}
          <p className="text-xs text-muted">{t('relation.twoWay.backfill')}</p>
          <div>
            <Button
              size="sm"
              busy={busy}
              data-testid="relation-two-way-enable"
              disabled={mode === 'create' ? !title.trim() : !existing}
              onClick={() =>
                void send(
                  mode === 'create'
                    ? { enabled: true, partner_title: title.trim() }
                    : { enabled: true, partner_column_id: existing },
                )
              }
            >
              {t('relation.twoWay.enable')}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Card>
  );
};
