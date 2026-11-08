// SPDX-License-Identifier: AGPL-3.0-only
import { createDb } from './client';
import { bootstrap, firstAccountFromEnv } from './bootstrap';

/**
 * `pnpm db:seed`, and on every Railway deploy after migrate — see bootstrap.ts. The first account (only on an empty
 * system) is configured by SEED_ACCOUNT_NAME / SEED_ACCOUNT_SLUG / SEED_TEMPLATE_SET. The owner signs in with a
 * magic link or Google, becomes platform owner on first sign-in (D12), and accepts the invitation from the account
 * picker. No email is sent here.
 */
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env: rely on the environment
}

const url = process.env.DATABASE_URL;
const ownerEmail = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
if (!url || !ownerEmail) {
  console.error('seed: DATABASE_URL and SEED_ADMIN_EMAIL are required');
  process.exit(1);
}

const { db, close } = createDb(url);
try {
  const res = await bootstrap(db, {
    ownerEmail,
    templatesDir: process.env.TEMPLATES_DIR ?? '../../seed/templates',
    firstAccount: firstAccountFromEnv(),
  });
  console.warn(`seed: ${res.templates} built-in templates`);
  if (res.repairedColumns) console.warn(`seed: repaired ${res.repairedColumns} template columns`);
  if (res.createdAccount) console.warn(`seed: created the first account "${res.account?.slug}"`);
  if (res.invitedOwner) console.warn(`seed: invited the platform owner as admin of "${res.account?.slug}"`);
  console.warn('seed: done');
} finally {
  await close();
}
