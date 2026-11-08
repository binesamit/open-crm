// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AiPriceRow,
  type AiPriceRule,
  AppError,
  type CreateAiPrice,
  createAiPriceSchema,
  newId,
  type UpdateAiPrice,
  updateAiPriceSchema,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps, SessionUser } from '../../types';
import {
  type AiPriceDbRow,
  deletePriceRow,
  findPriceRow,
  insertPriceRow,
  listPriceRows,
  updatePriceRow,
} from './prices.repo';

/**
 * The platform's AI price table (owner console → "AI prices"): the platform owner edits it; every model
 * call is priced from it unless the connection has its own price for the model (`price_overrides`). Read on every
 * model call, so cached briefly per database handle and dropped on every change.
 */
const CACHE_MS = 30_000;
const cache = new WeakMap<object, { at: number; rules: AiPriceRule[] }>();

const toRule = (r: AiPriceDbRow): AiPriceRule => ({
  provider: r.provider,
  model: r.model,
  input: r.input,
  output: r.output,
  cache_read: r.cacheRead,
  cache_write: r.cacheWrite,
  per_image: r.perImage ?? null,
  image_prices: r.imagePrices ?? null,
});

export const loadPriceTable = async (db: Db): Promise<AiPriceRule[]> => {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rules;
  const rules = (await listPriceRows(db)).map(toRule);
  cache.set(db, { at: Date.now(), rules });
  return rules;
};

const dto = (r: AiPriceDbRow): AiPriceRow => ({
  id: r.id,
  provider: r.provider as AiPriceRow['provider'],
  model: r.model,
  input: r.input,
  output: r.output,
  cache_read: r.cacheRead,
  cache_write: r.cacheWrite,
  per_image: r.perImage ?? null,
  image_prices: r.imagePrices ?? null,
  currency: 'USD',
  note: r.note,
  updated_at: r.updatedAt.toISOString(),
});

export const listAiPrices = async (deps: Pick<AppDeps, 'db'>) => ({ data: (await listPriceRows(deps.db)).map(dto) });

const assertFree = async (db: Db, provider: string, model: string, except?: string) => {
  const taken = (await listPriceRows(db)).find(
    (r) => r.provider === provider && r.model.toLowerCase() === model.toLowerCase() && r.id !== except,
  );
  if (taken) throw new AppError('conflict', 'ai_price_exists', { provider, model });
};

export const createAiPrice = async (
  deps: Pick<AppDeps, 'db' | 'logger'>,
  owner: SessionUser,
  raw: CreateAiPrice,
): Promise<AiPriceRow> => {
  const input = createAiPriceSchema.parse(raw);
  await assertFree(deps.db, input.provider, input.model);
  const [row] = await insertPriceRow(deps.db, {
    id: newId(),
    provider: input.provider,
    model: input.model,
    input: input.input,
    output: input.output,
    cacheRead: input.cache_read ?? null,
    cacheWrite: input.cache_write ?? null,
    perImage: input.per_image ?? null,
    imagePrices: input.image_prices && Object.keys(input.image_prices).length ? input.image_prices : null,
    note: input.note ?? null,
    updatedBy: owner.id,
  });
  if (!row) throw new AppError('conflict', 'ai_price_exists', { provider: input.provider, model: input.model });
  cache.delete(deps.db);
  deps.logger.info({ owner: owner.id, provider: row.provider, model: row.model }, 'ai price added');
  return dto(row);
};

export const updateAiPrice = async (
  deps: Pick<AppDeps, 'db' | 'logger'>,
  owner: SessionUser,
  id: string,
  raw: UpdateAiPrice,
): Promise<AiPriceRow> => {
  const input = updateAiPriceSchema.parse(raw);
  const current = await findPriceRow(deps.db, id);
  if (!current) throw new AppError('not_found', 'AI price not found');
  const provider = input.provider ?? current.provider;
  const model = input.model ?? current.model;
  if (provider !== current.provider || model !== current.model) await assertFree(deps.db, provider, model, id);
  const [row] = await updatePriceRow(deps.db, id, {
    provider,
    model,
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.cache_read !== undefined ? { cacheRead: input.cache_read } : {}),
    ...(input.cache_write !== undefined ? { cacheWrite: input.cache_write } : {}),
    ...(input.per_image !== undefined ? { perImage: input.per_image } : {}),
    ...(input.image_prices !== undefined
      ? { imagePrices: input.image_prices && Object.keys(input.image_prices).length ? input.image_prices : null }
      : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    updatedBy: owner.id,
  });
  cache.delete(deps.db);
  deps.logger.info({ owner: owner.id, id, fields: Object.keys(input) }, 'ai price updated');
  return dto(row!);
};

export const deleteAiPrice = async (deps: Pick<AppDeps, 'db' | 'logger'>, owner: SessionUser, id: string) => {
  const [row] = await deletePriceRow(deps.db, id);
  if (!row) throw new AppError('not_found', 'AI price not found');
  cache.delete(deps.db);
  deps.logger.info({ owner: owner.id, provider: row.provider, model: row.model }, 'ai price removed');
  return { ok: true as const };
};
