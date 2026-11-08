// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, newId } from '@bines/shared';
import type { AppDeps, Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { assertAiAvailable } from '../ai/ai.service';
import { generateImages, readImageForEdit } from '../ai/images.service';
import { withAiRetry } from '../ai/retry';
import {
  currentOf,
  deleteAssetRow,
  findAsset,
  insertAsset,
  markUploaded,
  maxVersionLocked,
  setAsVersion,
} from './files.repo';
import { safeName } from './files.service';
import { type FileVersionDto, loadEditableRoot, syncCellsOf, versionDto, versionOf } from './files.versions';

/**
 * "Ask the AI for a change": an image in a files cell is changed by the account's image model from
 * a short instruction ("remove the background") and the result is saved as the file's next (current) version — the
 * versions tab lists it, and "make current" on the version before undoes it. The picture sent is the version the
 * person is looking at (`version_id`), else the current one.
 *
 * Order (nothing is spent before every check passed): the file readable and the cell editable (item.update, the
 * column's edit restriction, not a viewer, not a guest) → AI on, the plan's `ai` feature, the plan's and the
 * account's budget (`assertAiAvailable`) → the account's own image connection AND model (Administration → AI →
 * images; no default model picked for it, no other connection) → the picture's type and size (as every input
 * picture) → the AI write rate (`beforeSpend`: the shared aiguard limiter) → the call. A model that cannot edit
 * pictures is refused by the adapter before any call (422 `ai_model_no_image_edit`, nothing charged). The cost lands
 * in `ai_usage` as source `image`, like every image call; the item's activity gets `file.version_added` with
 * `ai: true` and the instruction.
 */
type Deps = AppDeps;

export const AI_EDIT_INSTRUCTION_MAX = 2000;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** The file's name, its extension changed only when the new picture is of another type (photo.jpg → photo.png). */
export const editedFileName = (name: string, mime: string) => {
  const want = EXT[mime] ?? 'png';
  const m = /^(.*)\.([a-z0-9]+)$/i.exec(name);
  const ext = m?.[2]?.toLowerCase();
  if (ext === want || (want === 'jpg' && ext === 'jpeg')) return name;
  return `${m ? m[1] : name}.${want}`;
};

/** The account's image connection and model — both chosen by an admin, or 422 (never a default nobody picked). */
const accountImageModel = (ai: Awaited<ReturnType<typeof assertAiAvailable>>) => {
  if (!ai.images.connection_id) throw new AppError('unprocessable', 'ai_images_not_configured');
  if (!ai.images.model) throw new AppError('unprocessable', 'ai_image_no_model');
  return { connectionId: ai.images.connection_id, model: ai.images.model };
};

export type AiEditStatus = { available: boolean; reason: string | null };

/**
 * GET /files/{id}/ai-edit — may this person ask the AI for a change to this file now? (The viewer shows the box only
 * then.) A file they cannot read: 404, as everywhere.
 */
export const aiEditStatus = async (deps: Pick<Deps, 'db'>, a: Actor, rootId: string): Promise<AiEditStatus> => {
  const no = (reason: string): AiEditStatus => ({ available: false, reason });
  try {
    await loadEditableRoot(deps.db, a, rootId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'forbidden') return no(err.message);
    throw err;
  }
  if (a.ctx.role === 'guest') return no('ai_not_for_guests');
  try {
    accountImageModel(await assertAiAvailable(deps.db, a.ctx.accountId, 'image'));
  } catch (err) {
    if (err instanceof AppError) return no(err.message);
    throw err;
  }
  return { available: true, reason: null };
};

/**
 * POST /files/{id}/ai-edit (and the `edit_file_image` AI tool). `beforeSpend` runs after every check and right
 * before the provider call (the REST route's AI write-rate guard; the MCP server / agents guard the tool call
 * themselves). Returns the new current version.
 */
export const aiEditFile = async (
  deps: Deps,
  a: Actor,
  rootId: string,
  o: { instruction: string; versionId?: string | null },
  beforeSpend?: () => Promise<void>,
): Promise<FileVersionDto & { cost_usd: number; model: string; from_version: number }> => {
  const { db } = deps;
  const instruction = o.instruction.trim();
  if (!instruction || instruction.length > AI_EDIT_INSTRUCTION_MAX)
    throw new AppError('invalid_value', 'ai_edit_instruction_invalid');
  // 1. Rights: the file readable through a cell and the cell editable; AI spends the account's money — no guests.
  const { root, item, column } = await loadEditableRoot(db, a, rootId);
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'ai_not_for_guests');
  const src = o.versionId ? await versionOf(db, a, root, o.versionId) : await currentOf(db, root);
  // 2. AI available (status, on, plan feature, budgets) and the account's own image model.
  const { connectionId, model } = accountImageModel(await assertAiAvailable(db, a.ctx.accountId, 'image'));
  // 3. The picture: the same type / size checks as every input picture.
  const image = await readImageForEdit(deps, src);
  // 4. The AI write rate (REST), then the call (checks, usage and cost inside).
  await beforeSpend?.();
  // a busy / slow provider is tried again (backoff, its Retry-After) before the change fails.
  const made = await withAiRetry(() =>
    generateImages(deps, a.ctx.accountId, {
      prompt: instruction,
      connectionId,
      model,
      count: 1,
      images: [image],
    }),
  );
  const out = made.images[0]!;
  const name = editedFileName(src.fileName, out.mime);
  const id = newId();
  const key = `${a.ctx.accountId}/${id}/${safeName(name)}`;
  await insertAsset(db, {
    id,
    accountId: a.ctx.accountId,
    ownerId: a.user.id,
    kind: 'file',
    storageKey: key,
    fileName: name,
    mime: out.mime,
    size: out.data.length,
    uploadStatus: 'pending',
  });
  try {
    await deps.storage.put(key, Buffer.from(out.data), out.mime);
  } catch (err) {
    await deleteAssetRow(db, a.ctx.accountId, id);
    throw err;
  }
  const current = await currentOf(db, root);
  const row = await db.transaction(async (tx) => {
    const v = (await maxVersionLocked(tx, root.id)) + 1;
    await setAsVersion(tx, id, root.id, v);
    await markUploaded(tx, id, out.data.length, out.mime);
    await syncCellsOf(tx, a, root.id);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.version_added',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      before: { version_id: current.id, version: current.version },
      after: {
        file_id: root.id,
        version_id: id,
        version: v,
        name,
        ai: true,
        instruction,
        from_version: src.version,
      },
      meta: {
        column_key: column.key,
        column_type: column.type,
        ai: true,
        instruction,
        model: made.model,
        cost_usd: made.costUsd,
      },
    });
    return (await findAsset(tx, a.ctx.accountId, id))!;
  });
  return {
    ...versionDto(row, a.user.name, row.id),
    cost_usd: made.costUsd,
    model: made.model,
    from_version: src.version,
  };
};
