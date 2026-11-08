// SPDX-License-Identifier: AGPL-3.0-only
import { createDb } from './client';
import { firstAdminLink } from './bootstrap';

/**
 * `node dist/first-admin-link.js` (self-hosting, docs/SELF-HOSTING.md "First admin account"): prints a one-time
 * link for the platform owner (SEED_ADMIN_EMAIL) to set a password and enter — the way in when no email is
 * configured. Locally: `pnpm --filter @bines/api first-admin-link`. The link is a secret: it is printed, never logged.
 */
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env: rely on the environment
}

const url = process.env.DATABASE_URL;
if (!url && process.env.DATA_DIR) {
  // Standalone mode's embedded database belongs to the running server (one process may open it).
  console.error(
    'first-admin-link: this installation uses the embedded database - open the app in a browser: while no user ' +
      'exists it shows "Create the owner account". (With DATABASE_URL set, this command works as usual.)',
  );
  process.exit(1);
}
const ownerEmail = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
const origin = process.env.WEB_ORIGIN?.trim();
if (!url || !ownerEmail || !origin) {
  console.error('first-admin-link: DATABASE_URL, SEED_ADMIN_EMAIL and WEB_ORIGIN are required');
  process.exit(1);
}

const { db, close } = createDb(url);
let code = 0;
try {
  const res = await firstAdminLink(db, { ownerEmail, origin });
  switch (res.status) {
    case 'link':
      process.stdout.write(
        `Open this link to create the administrator ${ownerEmail} (valid 7 days, one use):\n\n  ${res.url}\n`,
      );
      break;
    case 'member':
      process.stdout
        .write(`${ownerEmail} is already a member of "${res.accountSlug}": sign in with your password or email link.
`);
      break;
    case 'no_account':
      console.error('first-admin-link: no account yet - run the release (migrate + seed) first');
      code = 1;
      break;
    case 'no_invitation':
      console.error(`first-admin-link: no open invitation for ${ownerEmail} - run the seed again (it re-creates it)`);
      code = 1;
      break;
  }
} finally {
  await close();
}
process.exit(code);
