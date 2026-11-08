// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from '@bines/sdk';
import { downloadFrom } from '../../lib/download';

/**
 * Doc export (M8 ד3): Markdown and HTML are files the API renders (shared allowlist renderer); PDF is the same page
 * printed by the browser — loaded into a hidden frame and printed (Hebrew shaping and fonts are the browser's).
 */
const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'doc';

export const downloadDoc = (accountId: string, doc: { id: string; name: string }, format: 'md' | 'html') =>
  downloadFrom(accountId, `/docs/${doc.id}/export?format=${format}`, `${safeName(doc.name)}.${format}`);

export const printDoc = async (accountId: string, docId: string) => {
  const res = await fetch(`/api/v1/docs/${docId}/export?format=pdf`, {
    credentials: 'include',
    headers: { 'x-account-id': accountId },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: ApiError['body'] } | null;
    throw new ApiError(res.status, body?.error ?? { code: 'internal', message: res.statusText, request_id: '' });
  }
  const html = await res.text();
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('data-testid', 'doc-print-frame');
  frame.style.cssText = 'position:fixed;inset-inline-end:0;bottom:0;width:0;height:0;border:0;';
  // The page has no scripts; a sandboxed frame keeps it that way (print is allowed from the parent).
  frame.sandbox.add('allow-modals', 'allow-same-origin');
  frame.srcdoc = html;
  document.body.appendChild(frame);
  await new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  // Keep it a moment for the print dialog, then clean up.
  setTimeout(() => frame.remove(), 60_000);
};
