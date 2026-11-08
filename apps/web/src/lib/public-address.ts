// SPDX-License-Identifier: AGPL-3.0-only
import type { PublicAddressInfo } from '@bines/shared';

/**
 * The platform's public address (M11) for links people copy (item links, public forms, inbound webhooks, the API
 * example): the owner console's setting, else WEB_ORIGIN — never the address this tab happens to be on, so a link
 * copied on an old domain still points at the new one. Until the server answered, the tab's own origin.
 */
let address: PublicAddressInfo | null = null;
let loading: Promise<void> | null = null;

const here = () => (typeof window === 'undefined' ? '' : window.location.origin);

/** Loads the address once (called on first use; safe to call again). */
export const loadPublicAddress = () =>
  (loading ??= (async () => {
    try {
      if (typeof fetch !== 'function') return;
      const res = await fetch('/api/v1/public/address', { credentials: 'omit' });
      if (!res.ok) return;
      const body = (await res.json()) as Partial<PublicAddressInfo>;
      if (typeof body.web === 'string' && typeof body.api === 'string') address = { web: body.web, api: body.api };
    } catch {
      // Offline or an old server: the tab's own origin is the fallback.
    }
  })());

/** The app's origin for absolute links. */
export const publicWebOrigin = () => {
  void loadPublicAddress();
  return address?.web ?? here();
};

/** The API's origin (= the app's unless the owner set another). */
export const publicApiOrigin = () => {
  void loadPublicAddress();
  return address?.api ?? here();
};
