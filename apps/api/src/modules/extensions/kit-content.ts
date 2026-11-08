// SPDX-License-Identifier: AGPL-3.0-only
import {
  getWidgetDef,
  type GridItem,
  markdownToRichDoc,
  newId,
  nextFreeRect,
  parseWidgetSettings,
  rankBetween,
  type RichNode,
  type StarterKit,
  withBlockIds,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { recordEvent } from '../activity/activity.repo';
import { insertDashboard, insertDashboardMembers, insertWidgets } from '../dashboards/dashboards.repo';
import { insertDoc, insertDocMembers } from '../docs/docs.repo';
import { lastEntityPosition } from '../docs/docs.service';
import { deriveDoc, encodeState, jsonToYdoc } from '../docs/ydoc';

/**
 * A kit's dashboards and docs (phase B), made after its boards — with the same building blocks the
 * dashboard and doc services use, since a new account's kit has no person yet (its admins own everything anyway).
 */
type Ctx = { accountId: string; actorId: string | null; requestId?: string | null };
type Place = { workspaceId: string; folders: { id: string; name: string }[]; boards: Record<string, string> };

const folderOf = (place: Place, name?: string) =>
  name ? (place.folders.find((f) => f.name === name)?.id ?? null) : null;

/** `@<template key>` → the board the kit made from it; anything else is dropped (a kit names no real board). */
const boardRefs = (refs: unknown, place: Place) =>
  Array.isArray(refs)
    ? refs.flatMap((r) =>
        typeof r === 'string' && r.startsWith('@') && place.boards[r.slice(1)] ? [place.boards[r.slice(1)]!] : [],
      )
    : [];

export const installKitDashboards = async (
  tx: Db,
  c: Ctx,
  kit: Pick<StarterKit, 'dashboards'>,
  place: Place,
  issues: string[],
): Promise<string[]> => {
  const ids: string[] = [];
  for (const d of kit.dashboards ?? []) {
    const id = newId();
    const folderId = folderOf(place, d.folder);
    const boardIds = d.boards.flatMap((k) => (place.boards[k] ? [place.boards[k]!] : []));
    await insertDashboard(tx, {
      id,
      accountId: c.accountId,
      workspaceId: place.workspaceId,
      folderId,
      position: rankBetween(await lastEntityPosition(tx, place.workspaceId, folderId), null),
      kind: 'main',
      name: d.name,
      settings: { board_ids: boardIds, filter: {} },
      createdBy: c.actorId,
      updatedBy: c.actorId,
    });
    if (c.actorId)
      await insertDashboardMembers(tx, [
        { id: newId(), dashboardId: id, accountId: c.accountId, userId: c.actorId, level: 'owner', addedBy: c.actorId },
      ]);
    const placed: GridItem[] = [];
    const rows = [];
    for (const w of d.widgets) {
      try {
        const def = getWidgetDef(w.type);
        const raw: Record<string, unknown> = {
          ...w.settings,
          ...('board_ids' in w.settings ? { board_ids: boardRefs(w.settings.board_ids, place) } : {}),
        };
        if (w.type === 'board_view') {
          const ref =
            typeof raw.board_id === 'string' && raw.board_id.startsWith('@')
              ? place.boards[raw.board_id.slice(1)]
              : null;
          raw.board_id = ref ?? null;
          raw.view_id = null;
        }
        const settings = parseWidgetSettings(w.type, raw);
        const wid = newId();
        const rect = nextFreeRect(placed, def.defaultSize);
        placed.push({ id: wid, rect });
        rows.push({
          id: wid,
          dashboardId: id,
          accountId: c.accountId,
          type: w.type,
          title: w.title,
          position: rect,
          settings,
          createdBy: c.actorId,
          updatedBy: c.actorId,
        });
      } catch {
        issues.push(`kit dashboard ${d.name}: widget ${w.type} skipped`);
      }
    }
    if (rows.length) await insertWidgets(tx, rows);
    await recordEvent(tx, {
      accountId: c.accountId,
      type: 'dashboard.created',
      actorId: c.actorId,
      requestId: c.requestId ?? null,
      after: {
        id,
        name: d.name,
        kind: 'main',
        workspace_id: place.workspaceId,
        folder_id: folderId,
        board_ids: boardIds,
        via: 'kit',
      },
      meta: { dashboard_id: id },
    });
    ids.push(id);
  }
  return ids;
};

export const installKitDocs = async (
  tx: Db,
  c: Ctx,
  kit: Pick<StarterKit, 'docs'>,
  place: Pick<Place, 'workspaceId' | 'folders'>,
  issues: string[],
): Promise<string[]> => {
  const ids: string[] = [];
  for (const doc of kit.docs ?? []) {
    let rich: RichNode;
    try {
      rich = doc.content ? (doc.content as RichNode) : markdownToRichDoc(doc.markdown ?? '');
    } catch {
      issues.push(`kit doc ${doc.name}: unreadable`);
      continue;
    }
    const ydoc = jsonToYdoc(withBlockIds(rich));
    const derived = deriveDoc(ydoc);
    const id = newId();
    const folderId = folderOf({ ...place, boards: {} }, doc.folder);
    await insertDoc(tx, {
      id,
      accountId: c.accountId,
      workspaceId: place.workspaceId,
      folderId,
      position: rankBetween(await lastEntityPosition(tx, place.workspaceId, folderId), null),
      kind: 'main',
      name: doc.name.slice(0, 255),
      ydoc: encodeState(ydoc),
      content: derived.content as Record<string, unknown>,
      textValue: derived.text,
      createdBy: c.actorId,
      updatedBy: c.actorId,
    });
    if (c.actorId)
      await insertDocMembers(tx, [
        { id: newId(), docId: id, accountId: c.accountId, userId: c.actorId, level: 'owner', addedBy: c.actorId },
      ]);
    await recordEvent(tx, {
      accountId: c.accountId,
      type: 'doc.created',
      actorId: c.actorId,
      requestId: c.requestId ?? null,
      after: { id, name: doc.name, workspace_id: place.workspaceId, folder_id: folderId, via: 'kit' },
      meta: { doc_id: id, source: 'kit' },
    });
    ids.push(id);
  }
  return ids;
};
