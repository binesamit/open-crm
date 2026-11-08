// SPDX-License-Identifier: AGPL-3.0-only
/**
 * r19small ("copy–paste into the files column — e.g. an image"): files from the clipboard (Ctrl/⌘+V)
 * or dropped on a files cell. Only real files count — a copied image or file, a screenshot; never a URL or text.
 */

/** The DOM event the table's keyboard grid sends to the active files cell with the pasted files (`detail`). */
export const FILE_PASTE_EVENT = 'bines:paste-files';
/** Marks the element of a files cell that listens for `FILE_PASTE_EVENT`. */
export const FILE_PASTE_ATTR = 'data-file-paste';

/** A browser's generic name for a pasted image (Chrome / Edge "image.png", Safari "Image.png"), or none at all. */
const GENERIC = /^(image|blob|clipboard|untitled|screenshot)?(\.[a-z0-9]+)?$/i;

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
};

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The name a pasted file gets: its own name when it has a real one (a file copied in the file manager); a pasted
 * image with a generic name or none (a screenshot) becomes "<label> 2026-10-07 14-32.png" in local time — `index`
 * (1-based) tells several images of one paste apart. `label` is the localized "Screenshot".
 */
export const pastedFileName = (file: { name: string; type: string }, now: Date, label: string, index = 1) => {
  const name = file.name.trim();
  const image = file.type.startsWith('image/');
  if (name && (!image || !GENERIC.test(name))) return name;
  const ext = EXT[file.type] ?? (/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() || (image ? 'png' : 'bin'));
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const base = image ? label : 'file';
  return `${base} ${stamp}${index > 1 ? ` (${index})` : ''}.${ext}`;
};

/** The files a paste / drop carries (`items` first — a screenshot is there only — then `files`), without repeats. */
export const transferFiles = (dt: Pick<DataTransfer, 'items' | 'files'> | null | undefined): File[] => {
  if (!dt) return [];
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  if (!out.length) out.push(...Array.from(dt.files ?? []));
  return out;
};

/** Whether a drag carries files (its contents are hidden until the drop). */
export const dragHasFiles = (dt: Pick<DataTransfer, 'types'> | null | undefined) =>
  !!dt && Array.from(dt.types ?? []).includes('Files');

/** The pasted files renamed where they need it (screenshots), as Files ready to upload. */
export const namePastedFiles = (files: File[], label: string, now = new Date()) => {
  let images = 0;
  return files.map((f) => {
    const generic = f.type.startsWith('image/') && GENERIC.test(f.name.trim());
    const name = pastedFileName(f, now, label, generic ? ++images : 1);
    return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified });
  });
};
