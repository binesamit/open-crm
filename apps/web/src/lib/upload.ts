// SPDX-License-Identifier: AGPL-3.0-only
import { isId } from '@bines/shared';
import { api } from './api';

export type UploadedFile = { id: string; name: string; size: number; mime: string };

/** presign → PUT straight to storage → complete (06 §2.14). Bytes never pass through our API. */
export const uploadFile = async (accountId: string, file: File): Promise<UploadedFile> => {
  const client = api(accountId);
  const mime = file.type || 'application/octet-stream';
  const pre = await client.post<{ file_id: string; upload_url: string; headers: Record<string, string> }>(
    '/files/presign',
    { name: file.name, size: file.size, mime },
  );
  const put = await fetch(pre.upload_url, { method: 'PUT', headers: pre.headers, body: file });
  if (!put.ok) throw new Error(`upload_failed_${put.status}`);
  return client.post<UploadedFile>(`/files/${pre.file_id}/complete`);
};

/**
 * Downloads through a short-lived signed URL (access is checked by the API on every request). The object is
 * served with Content-Disposition: attachment, so following the link downloads without leaving the page.
 * `exact`: a version by its own id — a file's id alone serves its current version.
 */
export const downloadFile = async (accountId: string, fileId: string, opts: { exact?: boolean } = {}) => {
  // S-93: ids can come from content others wrote (a doc's file block) — never a path of their choosing.
  if (!isId(fileId)) throw new Error('invalid_file_id');
  const file = await api(accountId).get<{ download_url: string }>(
    `/files/${encodeURIComponent(fileId)}${opts.exact ? '?exact=1' : ''}`,
  );
  // Only a web address is followed (never javascript: or the like).
  if (!/^https?:\/\//i.test(file.download_url)) throw new Error('invalid_download_url');
  const a = document.createElement('a');
  a.href = file.download_url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
};

export const formatSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
