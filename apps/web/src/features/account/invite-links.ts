// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '@bines/shared';

/**
 * The note above new invitation links (fix8 +): send it another way; personal, single-use and valid N days
 * — N from the links themselves (the account's invitation setting), never a number fixed in the text.
 */
export const linksHint = (invited: { expires_at?: string }[]) => {
  const at = invited.find((i) => i.expires_at)?.expires_at;
  const days = at ? Math.max(1, Math.round((Date.parse(at) - Date.now()) / 86_400_000)) : null;
  return days ? t('invites.links.hint', { n: days }) : t('invite.links.hint');
};
