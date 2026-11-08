// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Build-time export of the API's OpenAPI documents (S-47): the running server serves only the public document at
 * `/api/v1/openapi.json` (the full one is for platform owners), so tooling that needs every route — an SDK
 * generator, a diff in review — reads them from here. No database is touched: the documents come from the routes.
 *   pnpm --filter @bines/api openapi:export [--out <dir>]   (default: apps/api/openapi)
 * Writes openapi.full.json (every route) and openapi.json (the public reference's document).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { memoryMailer } from '@bines/server-mail';
import { createApp, fullOpenApiDocument, MAX_REQUEST_BYTES } from '../src/app';
import { createDb } from '../src/db/client';
import { createDeps } from '../src/deps';
import { loadEnv } from '../src/env';
import { createLogger } from '../src/lib/logger';
import { nullBus } from '../src/lib/realtime';
import { memoryStorage } from '../src/lib/storage';
import { guideContext } from '../src/modules/apidocs/apidocs.routes';
import { buildPublicSpec } from '../src/modules/apidocs/spec';

const outArg = process.argv.indexOf('--out');
const out = resolve(outArg > 0 ? process.argv[outArg + 1]! : 'openapi');

const env = loadEnv({
  NODE_ENV: 'development',
  LOG_LEVEL: 'silent',
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  // Never connected to: building the documents runs no query.
  DATABASE_URL: 'postgres://export@127.0.0.1:9/none',
  BETTER_AUTH_SECRET: 'openapi-export-openapi-export-openapi-export',
  PRODUCT_NAME: process.env.PRODUCT_NAME ?? '',
});
const { db, close } = createDb(env.DATABASE_URL!);
const app = createApp(
  createDeps({ env, logger: createLogger(env), db, mailer: memoryMailer(), storage: memoryStorage(), bus: nullBus }),
);
const full = fullOpenApiDocument(app);
const pub = buildPublicSpec(structuredClone(full), guideContext(env, MAX_REQUEST_BYTES));
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'openapi.full.json'), `${JSON.stringify(full, null, 2)}\n`);
writeFileSync(join(out, 'openapi.json'), `${JSON.stringify(pub, null, 2)}\n`);
process.stdout.write(
  `openapi: ${Object.keys(full.paths).length} paths (full), ${Object.keys(pub.paths).length} public → ${out}
`,
);
await close();
