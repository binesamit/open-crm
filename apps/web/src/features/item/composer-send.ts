// SPDX-License-Identifier: AGPL-3.0-only
import type { JSONContent } from '@tiptap/react';
import { richDocOverLimit, t, type RichNode } from '@bines/shared';

/**
 * r17reply: what stops the composer from sending this document, as the message to show — or null.
 * The same limits the server enforces (shared/rich.ts), checked first so a long paste is explained at once, with
 * the limit, instead of a refused request.
 */
export const sendBlockReason = (doc: JSONContent): string | null => {
  const over = richDocOverLimit(doc as RichNode);
  if (!over) return null;
  const vars = { limit: over.limit.toLocaleString('en-US'), length: over.length.toLocaleString('en-US') };
  return over.kind === 'text' ? t('error.update_too_long', vars) : t('error.update_too_big', vars);
};
