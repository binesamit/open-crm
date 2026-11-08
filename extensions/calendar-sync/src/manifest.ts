// SPDX-License-Identifier: AGPL-3.0-only
/** The extension's manifest, for the origin this server is reached at (served at /manifest.json). */
export const EXTENSION_ID = 'calendar-sync';
export const VERSION = '1.0.0';

export const manifest = (publicUrl: string) => ({
  manifest_version: 1,
  id: EXTENSION_ID,
  name: 'סנכרון יומנים',
  name_en: 'Calendar sync',
  description:
    'סנכרון דו-כיווני בין לוח ליומן (Google Calendar או כל שרת CalDAV): כל משתמש מחבר את היומן שלו, ומנהל בוחר לוח ועמודות.',
  description_en:
    'Two-way sync between a board and a calendar (Google Calendar or any CalDAV server): each member connects their own calendar; an admin picks the board and columns.',
  version: VERSION,
  icon: '📅',
  publisher: { name: 'Bines OS', url: publicUrl },
  permissions: ['boards:read', 'items:write', 'webhooks', 'users:read', 'updates:write'],
  origins: [publicUrl],
  server: { lifecycle_url: `${publicUrl}/lifecycle` },
  features: [
    {
      type: 'user_settings_page',
      key: 'connect',
      name: 'היומן שלי',
      name_en: 'My calendar',
      url: `${publicUrl}/connect.html`,
    },
    {
      type: 'account_settings_page',
      key: 'admin',
      name: 'הגדרות סנכרון',
      name_en: 'Sync settings',
      url: `${publicUrl}/admin.html`,
    },
  ],
});
