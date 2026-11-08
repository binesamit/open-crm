// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Audio and video files: played inside the app. A browser often uploads them without a type (a phone's
 * recording, `.m4a` / `.mkv` / `.opus` on Windows) — stored as `application/octet-stream`; their extension then says
 * what they are, so they still play in place instead of only downloading.
 */
export type MediaKind = 'audio' | 'video';

const VIDEO_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  '3gp': 'video/3gpp',
};

const AUDIO_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  flac: 'audio/flac',
  amr: 'audio/amr',
};

const extOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

/** Whether a stored type says nothing about the content (then the extension decides). */
const vague = (mime: string) => {
  const m = mime.trim().toLowerCase();
  return !m || m === 'application/octet-stream' || m === 'binary/octet-stream';
};

/** Audio, video, or neither — by the type, else (no useful type) by the extension. */
export const mediaKindOf = (f: { name: string; mime: string }): MediaKind | null => {
  const m = f.mime.trim().toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  // A WebM / Ogg recorded as audio only still reads as audio by its name.
  if (!vague(m) && m !== 'application/ogg') return null;
  const e = extOf(f.name);
  return VIDEO_EXT[e] ? 'video' : AUDIO_EXT[e] ? 'audio' : null;
};

/**
 * The type to serve a media file with when its stored type is vague (null: keep the stored one). Only audio /
 * video types — never anything a browser would run.
 */
export const mediaServeType = (f: { name: string; mime: string }): string | null => {
  if (!vague(f.mime) && f.mime.trim().toLowerCase() !== 'application/ogg') return null;
  const e = extOf(f.name);
  return VIDEO_EXT[e] ?? AUDIO_EXT[e] ?? null;
};

/** The playback speeds the player offers. */
export const MEDIA_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
