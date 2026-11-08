// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'drizzle-kit';

try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env: rely on the environment
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://bines:bines@localhost:5433/bines_os' },
  strict: true,
});
