// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouter } from '@tanstack/react-router';
import type { Theme } from '@bines/ui';
import { authClient } from '../../lib/auth-client';
import { api, errorMessage, type Me, type MyAccount, queryKeys } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { uploadFile } from '../../lib/upload';
import { unsubscribeThisDevice } from '../../pwa/push-client';
import { useSidebarTone, useTheme, type SidebarTone } from '../../lib/theme';

export const THEMES: Theme[] = ['light', 'dark', 'system'];

/** Profile photos: raster images only (S-14 — never SVG), as the server checks too. */
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const PHOTO_ACCEPT = PHOTO_TYPES.join(',');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Larger originals are not even decoded (a phone photo is far below this). */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const PHOTO_PX = 512;

/** Why a picked file cannot be a profile photo (an error code), or null when it can. */
export const photoProblem = (file: File): 'avatar_not_image' | 'avatar_too_big' | null =>
  !PHOTO_TYPES.includes(file.type) ? 'avatar_not_image' : file.size > MAX_SOURCE_BYTES ? 'avatar_too_big' : null;

/**
 * The photo as it is stored: cropped to its centre square and scaled down to at most 512px (WebP where the
 * browser can write it, else PNG) — a round avatar never shows a stretched or off-centre face, and a 10 MB phone
 * photo becomes a few dozen KB.
 */
export const squarePhoto = async (file: File): Promise<File> => {
  const problem = photoProblem(file);
  if (problem) throw { code: problem };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw { code: 'avatar_not_image' };
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(side, PHOTO_PX);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
  if (!blob || !PHOTO_TYPES.includes(blob.type)) return file;
  const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
  return new File([blob], `avatar.${ext}`, { type: blob.type });
};
export const SIDEBAR_TONES: SidebarTone[] = ['dark', 'light'];

/**
 * What the avatar menu and the phone "אני" screen share (N1): the theme, the account list and switch, the profile
 * photo upload / removal and sign-out.
 */
export const useProfile = (me: Me, current?: MyAccount) => {
  const [theme, chooseTheme] = useTheme();
  const [tone, chooseTone] = useSidebarTone();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accounts = useQuery({
    queryKey: queryKeys.myAccounts,
    queryFn: () => api().get<{ data: MyAccount[] }>('/me/accounts'),
  });
  const list = accounts.data?.data ?? [];

  const switchTo = async (account: MyAccount) => {
    await api().put('/me/last-account', { account_id: account.id });
    await navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
  };

  const signOut = async () => {
    // PWA: this phone stops getting push for this user (every account) before the session ends.
    await unsubscribeThisDevice();
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  // Profile photo (M1.1 #6): uploaded through the current account's file flow; the photo is the user's.
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  // `me` comes from the route context: refetch it, then re-run the loaders so the new photo shows.
  const refreshPhoto = async () => {
    await queryClient.refetchQueries({ queryKey: queryKeys.me, type: 'all' });
    await router.invalidate();
    if (current) await queryClient.invalidateQueries({ queryKey: queryKeys.members(current.id) });
  };
  const photo = useMutation({
    mutationFn: async (file: File | null) => {
      if (!current) return;
      if (!file) return api(current.id).delete('/users/me/avatar');
      const square = await squarePhoto(file);
      if (square.size > MAX_PHOTO_BYTES) throw { code: 'avatar_too_big' };
      const uploaded = await uploadFile(current.id, square);
      return api(current.id).put('/users/me/avatar', { file_id: uploaded.id });
    },
    onSuccess: refreshPhoto,
    // Started from the avatar menu (closed by then): the toast says what went wrong.
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) photo.mutate(file);
  };
  const displayName = me.user.name || me.user.email;
  /** A photo dropped on the avatar (the profile page). */
  const dropPhoto = (file: File | undefined) => {
    if (file) photo.mutate(file);
  };
  return {
    theme,
    chooseTheme,
    tone,
    chooseTone,
    list,
    switchTo,
    signOut,
    fileInput,
    onFile,
    dropPhoto,
    photo,
    displayName,
  };
};
