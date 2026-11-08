// SPDX-License-Identifier: AGPL-3.0-only
// The extension's own settings (chrome.storage.sync): where Bines is and which panel to open. Nothing about any
// site lives here — site rules and profiles are configured in Bines (the "Browser panel" extension's settings page).

/** { address: 'https://os.example.com', account: '<slug>', installation: '<26-char id>', sites: ['https://…'] } */
export const loadSettings = async () => {
  const s = await chrome.storage.sync.get(['address', 'account', 'installation', 'sites']);
  return {
    address: typeof s.address === 'string' ? s.address : '',
    account: typeof s.account === 'string' ? s.account : '',
    installation: typeof s.installation === 'string' ? s.installation : '',
    sites: Array.isArray(s.sites) ? s.sites.filter((x) => typeof x === 'string') : [],
  };
};

export const saveSettings = (s) => chrome.storage.sync.set(s);

/** An https origin (no path), or null. */
export const originOf = (s) => {
  try {
    const u = new URL(String(s).trim());
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
};

/**
 * The "panel address" Bines shows under the installed extension (`https://<host>/a/<account>/x/<installation>/panel`)
 * → { address, account, installation }, or null.
 */
export const parsePanelUrl = (s) => {
  const origin = originOf(s);
  if (!origin) return null;
  const m = /^\/a\/([a-z0-9-]{1,64})\/x\/([0-9A-HJKMNP-TV-Z]{26})\/panel\/?$/i.exec(new URL(String(s).trim()).pathname);
  return m ? { address: origin, account: decodeURIComponent(m[1]), installation: m[2].toUpperCase() } : null;
};

/** The panel page of Bines for these settings, or null when they are incomplete. */
export const panelUrl = (s, params = {}) => {
  const origin = originOf(s.address);
  if (!origin || !/^[a-z0-9-]{1,64}$/i.test(s.account) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(s.installation)) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v) q.set(k, v.slice(0, 500));
  const query = q.toString();
  return `${origin}/a/${encodeURIComponent(s.account)}/x/${s.installation}/panel${query ? `?${query}` : ''}`;
};
