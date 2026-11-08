// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, EMAIL_IMAGE_REF, inboundLimitsOf } from '@bines/shared';
import { allowPrivateOutbound, outboundDownload } from '../../lib/outbound';
import type { Actor, AppDeps } from '../../types';
import { loadSettings } from '../accounts/accounts.service';
import { loadPlatformSettings } from '../platform/platform-settings';
import { updateFileAssets } from '../files/files.repo';
import { getFile } from '../files/files.service';
import { loadItem } from '../items/items.service';
import { findUpdate } from '../updates/updates.repo';

type Deps = Pick<AppDeps, 'db' | 'storage' | 'env'>;

/** Images from the web the proxy passes on: the types a browser shows (no SVG — it can carry script). */
const REMOTE_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|avif)$/;
const TIMEOUT_MS = 10_000;

export type EmailImage = { redirect: string } | { body: Buffer; mime: string };

/**
 * GET /updates/{id}/email-images/{ref} — an image of an incoming email shown in its update, for
 * whoever may read the update's item:
 * - `asset:<id>` — an image of the body, stored as a file of the update → its short-lived link;
 * - `remote:<n>` — the message's n-th image from the web, fetched by the server (the sender never sees the reader's
 *   address or cookies; public addresses only, size-capped, images only) and never stored. Not shown while the
 *   account has "images from the web" off.
 */
export const emailImage = async (deps: Deps, a: Actor, updateId: string, ref: string): Promise<EmailImage> => {
  const notFound = () => new AppError('not_found', 'Image not found');
  if (!EMAIL_IMAGE_REF.test(ref)) throw notFound();
  const update = await findUpdate(deps.db, a.ctx.accountId, updateId);
  if (!update || update.isSecret) throw notFound();
  await loadItem(deps.db, a, update.itemId);
  const [kind, value] = ref.split(':') as ['asset' | 'remote', string];
  if (kind === 'asset') {
    const rows = await updateFileAssets(deps.db, [update.id]);
    if (!rows.some((r) => r.asset.id === value)) throw notFound();
    return { redirect: (await getFile(deps, a, value, { inline: true })).download_url };
  }
  if (!(await loadSettings(deps.db, a.ctx.accountId)).inbound_email.remote_images) throw notFound();
  const list = (update.meta as { email_images?: unknown } | null)?.email_images;
  const url = Array.isArray(list) ? list[Number(value)] : undefined;
  if (typeof url !== 'string') throw notFound();
  const file = await outboundDownload(url, {
    maxBytes: inboundLimitsOf((await loadPlatformSettings(deps.db)).email).maxRemoteImageBytes,
    timeoutMs: TIMEOUT_MS,
    // Tests and dev with the switch only (production refuses it): the sender's address is untrusted.
    allowPrivate: allowPrivateOutbound(deps.env, { inTests: false }),
  }).catch(() => {
    throw notFound();
  });
  const mime = file.mime.toLowerCase().split(';')[0]!.trim();
  if (!REMOTE_IMAGE_MIME.test(mime)) throw notFound();
  return { body: file.body, mime };
};
