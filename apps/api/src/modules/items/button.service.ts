// SPDX-License-Identifier: AGPL-3.0-only
import { actorRegion } from '../accounts/region';
import {
  AppError,
  buttonSettingsSchema,
  cellFromText,
  newId,
  popupRequired,
  popupSubitemsRule,
  renderTemplate,
  subitemsPass,
  type ButtonClick,
  type ButtonLinked,
  type TextPerson,
} from '@bines/shared';
import type { AppDeps } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, columnAllowed } from '../boards/boards.access';
import { listColumns } from '../boards/boards.repo';
import { listTeams } from '../teams/teams.service';
import { listMembers } from '../users/users.service';
import { itemCells } from './items.repo';
import { type Actor, assertAssigned, calculatorFor, itemDto, loadItem, writeCell } from './items.service';
import { plainTextDoc } from './workflow';
import { subitemsTally, writePopupSubitems } from './popup-subitems';
import { createUpdate } from '../updates/updates.service';
import { linkedPreview, runCreateLinked } from './linked-button.service';

/**
 * A button column click (03 §3.7, M8 ד11). The right to click = the right to edit the column (and the item).
 * What it does is the column's setting: set values (written like a paste, through the cell service — one batch,
 * one Ctrl+Z), open a link built from the item's values, or nothing but the event. Every click records
 * `button.clicked`, which the automations engine hears ("when the button is clicked") like any other trigger.
 */
export type ButtonResult = {
  event_id: string;
  batch_id: string;
  url: string | null;
  written: string[];
  skipped: { column_id: string; reason: string }[];
  linked: ButtonLinked | null;
};

const peopleOf = async (deps: Pick<AppDeps, 'db' | 'storage'>, a: Actor): Promise<TextPerson[]> => {
  const [members, teams] = await Promise.all([listMembers(deps, a.ctx, a.user), listTeams(deps.db, a)]);
  return [
    ...members
      .filter((m) => m.status === 'active')
      .map((m) => ({ id: m.user_id, kind: 'person' as const, name: m.name, email: m.email })),
    ...teams.map((t) => ({ id: t.id, kind: 'team' as const, name: t.name })),
  ];
};

export const clickButton = async (
  deps: Pick<AppDeps, 'db' | 'storage'>,
  a: Actor,
  itemId: string,
  columnKey: string,
  answers: ButtonClick = {},
): Promise<ButtonResult> => {
  const people = await peopleOf(deps, a);
  // A fixed value "date HH:MM" is wall-clock in the account's zone (audit 2026-10-10 A1).
  const region = await actorRegion(deps.db, a);
  return deps.db.transaction(async (tx) => {
    const { item, access } = await loadItem(tx, a, itemId);
    const columns = await listColumns(tx, item.boardId);
    const column = columns.find((c) => c.key === columnKey && c.type === 'button');
    if (!column || !columnAllowed(access, column.restrictedView)) throw new AppError('not_found', 'Column not found');
    assertBoard(access, 'item.update');
    if (!columnAllowed(access, column.restrictedEdit))
      throw new AppError('forbidden', `column_restricted:${column.key}`);
    assertAssigned(access, a.user, item, await itemCells(tx, item.id), columns);
    const s = buttonSettingsSchema.parse(column.settings ?? {});
    const batchId = newId();
    const written: string[] = [];
    const skipped: ButtonResult['skipped'] = [];
    let url: string | null = null;
    let linked: ButtonLinked | null = null;

    // The item's values for templates (`{item.<column>}`), as the reader sees them.
    const calc = await calculatorFor(tx, a, [item.id]);
    // S-36: only columns the clicker may see — the URL comes back to them.
    const dto = itemDto(
      calc,
      item,
      columns.filter((c) => columnAllowed(access, c.restrictedView)),
    );
    const lookup = (encode: boolean) => (path: string) => {
      const [root, key] = path.split('.', 2);
      let v: string | undefined;
      if (root === 'item')
        v = key === 'name' ? item.name : key === 'id' ? item.id : key ? (dto.cells[key]?.text ?? '') : undefined;
      else if (path === 'board.id') v = item.boardId;
      return v === undefined ? undefined : encode ? encodeURIComponent(v) : v;
    };

    if (s.action.kind === 'set_values') {
      for (const v of s.action.values) {
        const target = columns.find((c) => c.key === v.column_id);
        if (!target || target.id === column.id) {
          skipped.push({ column_id: v.column_id, reason: 'column_not_found' });
          continue;
        }
        const text = renderTemplate(v.text, lookup(false)).text;
        const value = text.trim() ? cellFromText(target.type, text, target.settings, people, { region }) : null;
        if (value === undefined) {
          skipped.push({ column_id: v.column_id, reason: 'invalid_value' });
          continue;
        }
        try {
          await writeCell(tx, a, access, item, target, value, batchId, { button: column.key });
          written.push(target.key);
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          skipped.push({ column_id: v.column_id, reason: err.code });
        }
      }
    } else if (s.action.kind === 'popup') {
      // phase 2: the popup's answers — only its own columns — then its required ones must have a value.
      const popup = s.action.popup;
      const allowed = new Set(popup.fields.map((f) => f.column_id));
      for (const [key, value] of Object.entries(answers.cells ?? {})) {
        const target = columns.find((c) => c.key === key);
        if (!allowed.has(key) || !target || target.id === column.id)
          throw new AppError('invalid_value', `popup_field_unknown:${key}`);
        await writeCell(tx, a, access, item, target, value ?? null, batchId, { button: column.key });
        written.push(target.key);
      }
      // its subitems section — only its own sub-board columns — then its subitems rule.
      if (answers.subitems && !popup.subitems) throw new AppError('invalid_value', 'popup_field_unknown:subitems');
      const subFields = new Set(['name', ...(popup.subitems?.fields ?? []).map((f) => f.column_id)]);
      await writePopupSubitems(tx, a, access, item, answers.subitems, batchId, subFields);
      const subRule = popupSubitemsRule(popup);
      if (subRule) {
        const tally = await subitemsTally(tx, a, item, subRule);
        if (!subitemsPass(subRule, tally))
          throw new AppError('validation_failed', 'popup_subitems', {
            min: subRule.min,
            have: tally.complete,
            incomplete: tally.incomplete,
            all: !!subRule.all,
          });
      }
      const now = await itemCells(tx, item.id);
      const missing = popupRequired(popup).filter((key) => {
        const target = columns.find((c) => c.key === key);
        return !!target && !now.some((c) => c.columnId === target.id && c.value !== null);
      });
      if (missing.length)
        throw new AppError('validation_failed', 'popup_required', {
          columns: missing.map((k) => ({ id: k, title: columns.find((c) => c.key === k)?.title ?? k })),
        });
      if (popup.note === 'required' && !answers.note) throw new AppError('validation_failed', 'popup_note_required');
      if (answers.note && (popup.note ?? 'off') !== 'off')
        await createUpdate(tx, a, item.id, { doc: plainTextDoc(answers.note) });
    } else if (s.action.kind === 'create_linked') {
      linked = await runCreateLinked(tx, a, {
        item,
        access,
        columns,
        buttonKey: column.key,
        act: s.action,
        answers,
        batchId,
        people,
        region,
      });
      written.push(...(linked.created ? [] : Object.keys(answers.cells ?? {})));
    } else if (s.action.kind === 'open_url') {
      const rendered = renderTemplate(s.action.url, lookup(true)).text.trim();
      url = /^https?:\/\//i.test(rendered) ? rendered : null;
    }

    const eventId = await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'button.clicked',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      batchId,
      meta: { column_key: column.key, column_type: 'button', action: s.action.kind },
    });
    return { event_id: eventId, batch_id: batchId, url, written, skipped, linked };
  });
};

/**
 * P1-03: before a "create a linked item" button opens its popup — the linked item it should fill in (its `reuse`
 * rule: e.g. the lead's job still in draft), or null for a new one with the values it starts with. Same rights as
 * the click.
 */
export const linkedForButton = async (
  deps: Pick<AppDeps, 'db' | 'storage'>,
  a: Actor,
  itemId: string,
  columnKey: string,
): Promise<{
  item_id: string | null;
  name: string;
  cells: Record<string, { value: unknown; text: string | null; names?: string[] }>;
}> => {
  const { item, access } = await loadItem(deps.db, a, itemId);
  const columns = await listColumns(deps.db, item.boardId);
  const column = columns.find((c) => c.key === columnKey && c.type === 'button');
  if (!column || !columnAllowed(access, column.restrictedView)) throw new AppError('not_found', 'Column not found');
  const s = buttonSettingsSchema.parse(column.settings ?? {});
  if (s.action.kind !== 'create_linked') return { item_id: null, name: item.name, cells: {} };
  const [people, region] = await Promise.all([peopleOf(deps, a), actorRegion(deps.db, a)]);
  const preview = await linkedPreview(deps.db, a, { item, access, columns, act: s.action, people, region });
  return { ...preview, name: item.name };
};
