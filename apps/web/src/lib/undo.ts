// SPDX-License-Identifier: AGPL-3.0-only
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import { type Deleted, t, UNDO_SHORTCUT_SECONDS, UNDO_TOAST_SECONDS } from '@bines/shared';
import { api, errorMessage } from './api';
import { confirmDialog } from './dialogs';
import { showToast } from './toast';

type UndoResult = { ok: true; undone: number; event_ids: string[] };

/**
 * Undo (or redo) an action by its activity event (07 §5.3). When the value changed since, the user confirms
 * "undo anyway" first. Returns the events it wrote, or null when it did not happen.
 */
const post = async (accountId: string, path: 'undo' | 'redo', eventId: string): Promise<string[] | null> => {
  const client = api(accountId);
  try {
    return (await client.post<UndoResult>(`/activity/${eventId}/${path}`, {})).event_ids;
  } catch (err) {
    if (!(err instanceof ApiError && err.body.code === 'changed_since')) {
      showToast({ message: errorMessage(err), tone: 'error' });
      return null;
    }
    const ok = await confirmDialog({
      title: t('undo.changedSince.title'),
      message: t('undo.changedSince.message'),
      confirmLabel: t('undo.anyway'),
    });
    if (!ok) return null;
    try {
      return (await client.post<UndoResult>(`/activity/${eventId}/${path}`, { force: true })).event_ids;
    } catch (again) {
      showToast({ message: errorMessage(again), tone: 'error' });
      return null;
    }
  }
};

/**
 * The last action Ctrl+Z undoes (within a minute), and the last undone one Ctrl+Shift+Z redoes. An action is
 * one or more events: edits that land together (a paste of many cells) are one action.
 */
type Action = { accountId: string; eventIds: string[]; at: number; gesture?: string };
let last: Action | null = null;
let lastUndone: Action | null = null;
const recent = (a: Action | null) => (a && Date.now() - a.at < UNDO_SHORTCUT_SECONDS * 1000 ? a : null);

/** Undoes the events of one action, newest first; true when all of them were undone. */
const undoEvents = async (qc: QueryClient, accountId: string, eventIds: string[]) => {
  const done: string[] = [];
  for (const id of [...eventIds].reverse()) {
    if (!(await post(accountId, 'undo', id))) break;
    done.push(id);
  }
  if (!done.length) return false;
  lastUndone = { accountId, eventIds: done, at: Date.now() };
  await qc.invalidateQueries();
  showToast({ message: t('undo.done') });
  return done.length === eventIds.length;
};

export const undoAction = (qc: QueryClient, accountId: string, eventId: string) => undoEvents(qc, accountId, [eventId]);

/** Ctrl+Z: undoes the last action if it is less than a minute old; once. */
export const undoLast = (qc: QueryClient) => {
  const action = recent(last);
  last = null;
  if (!action) {
    showToast({ message: t('undo.nothing'), seconds: 2 });
    return;
  }
  void undoEvents(qc, action.accountId, action.eventIds);
};

/** Ctrl+Shift+Z / Ctrl+Y: redoes what was just undone (07 §10); Ctrl+Z then undoes the redo. */
export const redoLast = async (qc: QueryClient) => {
  const action = recent(lastUndone);
  lastUndone = null;
  if (!action) {
    showToast({ message: t('redo.nothing'), seconds: 2 });
    return;
  }
  const written: string[] = [];
  for (const id of action.eventIds) {
    const ids = await post(action.accountId, 'redo', id);
    if (!ids) break;
    written.push(...ids);
  }
  if (!written.length) return;
  last = { accountId: action.accountId, eventIds: written, at: Date.now() };
  await qc.invalidateQueries();
  showToast({ message: t('redo.done') });
};

/**
 * An edit with no toast (a cell, a name): Ctrl+Z can still undo it for a minute. Writes of one gesture (a paste
 * or a cleared range share a `gesture` id) are one action.
 */
export const rememberEdit = (accountId: string, eventId: string | null | undefined, gesture?: string) => {
  if (!eventId) return;
  const now = Date.now();
  if (gesture && last?.gesture === gesture && last.accountId === accountId) {
    last = { ...last, eventIds: [...last.eventIds, eventId], at: now };
  } else last = { accountId, eventIds: [eventId], at: now, gesture };
};

/** A toast with "ביטול" for an action, which Ctrl+Z can also undo for a minute (07 §5.3). */
export const useUndoToast = (accountId: string) => {
  const qc = useQueryClient();
  return (message: string, eventId: string) => {
    last = { accountId, eventIds: [eventId], at: Date.now() };
    showToast({
      message,
      seconds: UNDO_TOAST_SECONDS,
      action: {
        label: t('undo.action'),
        run: () => {
          if (last?.eventIds.includes(eventId)) last = null;
          return undoAction(qc, accountId, eventId);
        },
      },
    });
  };
};

/** "X הועבר לסל · ביטול" after a delete-to-trash. */
export const useDeletedToast = (accountId: string) => {
  const undoToast = useUndoToast(accountId);
  return (what: string, res: Deleted) => undoToast(t('trash.toast.deleted', { what }), res.event_id);
};
