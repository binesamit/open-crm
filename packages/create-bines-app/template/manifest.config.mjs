// SPDX-License-Identifier: MIT
// The extension's manifest (D27, docs/EXTENSIONS-GUIDE.md §2). The dev server serves it at /manifest.json with the
// local origin; for production, build it with your https origin (`node manifest.config.mjs https://ext.example.com`).
const WITH_SERVER = '__WITH_SERVER__' === 'true';

/**
 * @param {string} origin where the page is served from (the iframe's origin)
 * @param {string} [serverOrigin] where your server listens (lifecycle calls), when the extension has one
 */
export const manifest = (origin, serverOrigin = origin) => ({
  manifest_version: 1,
  id: '__APP_ID__',
  name: '__APP_NAME__',
  version: '0.1.0',
  description: 'A board view built with create-bines-app.',
  publisher: { name: 'You', email: 'you@example.com' },
  // Ask only for what you need: every scope is shown to the admin on the consent screen.
  permissions: ['boards:read'],
  origins: [...new Set([origin, ...(WITH_SERVER ? [serverOrigin] : [])])],
  features: [{ type: 'board_view', key: 'main', name: '__APP_NAME__', url: `${origin}/index.html` }],
  ...(WITH_SERVER ? { server: { lifecycle_url: `${serverOrigin}/lifecycle` } } : {}),
});

// `node manifest.config.mjs https://ext.example.com [https://api.ext.example.com]` prints the production manifest.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [origin, serverOrigin] = process.argv.slice(2);
  if (origin) console.warn(JSON.stringify(manifest(origin, serverOrigin ?? origin), null, 2));
}
