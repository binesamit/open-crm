// SPDX-License-Identifier: AGPL-3.0-only
import { avatarSvg, type AvatarArt } from '@bines/shared';

/**
 * The profile's avatar picker: the drawings live in @bines/shared (`avatars.ts`) — the server draws
 * an agent's too. Here only what needs a browser: the avatar drawn to a PNG file for the photo upload.
 */
export { AVATAR_ANIMALS, AVATAR_BACKGROUNDS, avatarDataUrl, avatarSvg, type AvatarArt } from '@bines/shared';

/** The avatar drawn to a square PNG file (`size` px) — what the profile photo upload takes. */
export const avatarFile = async (art: AvatarArt, bg?: string, size = 512): Promise<File> => {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(art, bg, size))}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw { code: 'avatar_not_image' };
  ctx.drawImage(img, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw { code: 'avatar_not_image' };
  return new File([blob], `avatar-${art.id}.png`, { type: 'image/png' });
};
