// SPDX-License-Identifier: AGPL-3.0-only
import { generateKeyPairSync } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import { CLIPBOARD_SPEC_FILES, SERIAL_CLIPBOARD_SPEC_FILES } from './clipboard-specs';
import { SERIAL_SPEC_FILES } from './serial-specs';
import { API_URL, FAKE_MAIL_URL, GEO_URL, INBOUND_SECRET, MAILPIT_URL, portOf, WEB_URL } from './stack';

/** A fresh Ed25519 private key (base64 of its PEM) — the E2E API's license-server signing key for this run. */
const testSigningKey = () =>
  Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');

/**
 * Browser E2E against local dev. Needs `docker compose up -d postgres mailpit`, `pnpm db:migrate`, `pnpm db:seed`
 * (SEED_ADMIN_EMAIL from .env) — the servers below are started automatically.
 *
 * s4f-e2e:
 * - globalSetup cleans old test leftovers in the local DB first (global-setup.ts; local only; E2E_CLEANUP=0 skips).
 * - Two projects: `isolated` (specs that only touch what they create) and `serial` (account / user-level settings,
 *   account-wide counts, other accounts — serial-specs.ts), always one worker.
 * - Workers: E2E_WORKERS (default 1 — everything one after the other, as before). With more, run
 *   `pnpm e2e:parallel` (e2e/run-parallel.mjs): `isolated` on E2E_WORKERS workers, then `serial` on one, two
 *   invocations. A plain `pnpm e2e` with E2E_WORKERS > 1 makes `serial` wait for `isolated` (a project dependency —
 *   then a failure in `isolated` skips `serial`; the runner script does not have that drawback).
 */
/** Specs with their own Playwright config (their own API, web app and database) — none at the moment. */
const OWN_STACK_SPECS: string[] = [];

const WORKERS = Math.max(1, Math.floor(Number(process.env.E2E_WORKERS) || 1));
const SPLIT_RUN = process.env.E2E_SPLIT_RUN === '1';
/**
 * the stack's addresses come from stack.ts (E2E_WEB_URL, E2E_API_URL, E2E_MAILPIT_URL, E2E_GEO_URL
 * defaults = the usual dev stack). E2E_DATABASE_URL gives the API its own database. E2E_REUSE_SERVERS=0 never reuses a
 * server already listening (another session's) — the servers must start here; run-stacks.mjs sets it.
 */
const REUSE = process.env.E2E_REUSE_SERVERS !== '0';
/** The API's settings for this stack — only those a run changed: a plain `pnpm e2e` keeps reading the repo's .env. */
const stackApiEnv: Record<string, string> = {
  ...(process.env.E2E_WEB_URL ? { WEB_ORIGIN: WEB_URL, BETTER_AUTH_URL: WEB_URL } : {}),
  ...(process.env.E2E_API_URL ? { API_PORT: portOf(API_URL) } : {}),
  ...(process.env.E2E_MAILPIT_URL ? { MAILPIT_URL } : {}),
  ...(process.env.E2E_DATABASE_URL ? { DATABASE_URL: process.env.E2E_DATABASE_URL } : {}),
};
/** E2E_CLIPBOARD=skip leaves out the specs on the machine's clipboard, `only` runs just them (clipboard-specs.ts). */
const CLIPBOARD = process.env.E2E_CLIPBOARD;
const skipClipboard = CLIPBOARD === 'skip' ? [CLIPBOARD_SPEC_FILES] : [];

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: WORKERS,
  globalSetup: './global-setup.ts',
  projects: [
    {
      name: 'isolated',
      ...(CLIPBOARD === 'only' ? { testMatch: CLIPBOARD_SPEC_FILES } : {}),
      testIgnore: [SERIAL_SPEC_FILES, ...OWN_STACK_SPECS, ...skipClipboard],
    },
    {
      name: 'serial',
      testMatch: CLIPBOARD === 'only' ? SERIAL_CLIPBOARD_SPEC_FILES : SERIAL_SPEC_FILES,
      testIgnore: skipClipboard,
      workers: 1,
      ...(WORKERS > 1 && !SPLIT_RUN ? { dependencies: ['isolated'] } : {}),
    },
  ],
  // reducedMotion (r16motion): the app's animations default to "by device" = reduced — fades only, no exit ghosts —
  // so no test waits on (or meets a copy of) a closing dialog / menu. r16motion.spec.ts picks "full" itself.
  use: { baseURL: WEB_URL, locale: 'he-IL', screenshot: 'only-on-failure', reducedMotion: 'reduce' },
  webServer: [
    {
      // Stand-in geocoder, address completion + blank map style (fake-geo.mjs): no E2E run calls Nominatim, Photon
      // or the tile provider.
      command: 'node fake-geo.mjs',
      env: { FAKE_GEO_PORT: portOf(GEO_URL) },
      url: `${GEO_URL}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // Stand-in mail provider (fake-mail-provider.mjs): the received messages, their attachments and
      // a message's images from the web — so a spec delivers an email without Resend.
      command: 'node fake-mail-provider.mjs',
      env: { FAKE_MAIL_PORT: portOf(FAKE_MAIL_URL) },
      url: `${FAKE_MAIL_URL}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'pnpm --filter @bines/api exec tsx src/index.ts',
      // Test-only: AI calls answer from the scripted stand-in (agents.spec.ts) — no key, no spend.
      // The suite invites ~100 teammates and registers OAuth apps from one address: the per-hour limits (S-12,
      // 06 §1.10 — covered by apps/api/test/security-limits.test.ts) would refuse them half way through a run.
      env: {
        AI_FAKE: process.env.AI_FAKE ?? 'scripted',
        // Webhooks, extensions and flows call local test servers (audit 2026-10-10 #7: an explicit switch now).
        OUTBOUND_ALLOW_PRIVATE: process.env.OUTBOUND_ALLOW_PRIVATE ?? '1',
        INVITE_EMAILS_PER_HOUR: process.env.INVITE_EMAILS_PER_HOUR ?? '0',
        OAUTH_REGISTER_PER_HOUR: process.env.OAUTH_REGISTER_PER_HOUR ?? '0',
        GEOCODER_URL: process.env.GEOCODER_URL ?? GEO_URL,
        GEOCODER_MIN_INTERVAL_MS: '0',
        PHOTON_URL: process.env.PHOTON_URL ?? GEO_URL,
        PHOTON_MIN_INTERVAL_MS: '0',
        MAP_STYLE_URL: process.env.MAP_STYLE_URL ?? `${GEO_URL}/style.json`,
        // licensing.spec.ts: the API is its own license server, with a throwaway signing key made for this run
        // (outside production the server trusts its own key). Never a real key.
        LICENSE_SIGNING_KEY: process.env.E2E_LICENSE_SIGNING_KEY ?? testSigningKey(),
        // Incoming email (inbound-email-html.spec.ts): the stand-in provider and this run's webhook secret.
        RESEND_API_BASE: process.env.RESEND_API_BASE ?? FAKE_MAIL_URL,
        RESEND_INBOUND_API_KEY: process.env.RESEND_INBOUND_API_KEY ?? 'e2e-stand-in',
        RESEND_INBOUND_SECRET: INBOUND_SECRET,
        ...stackApiEnv,
      },
      url: `${API_URL}/api/v1/health`,
      reuseExistingServer: REUSE,
      timeout: 180_000,
    },
    {
      command: 'pnpm --filter @bines/web dev',
      // The dev server's port and the API it proxies to (apps/web/vite.config.ts).
      env: { BINES_DEV_WEB_PORT: portOf(WEB_URL), BINES_DEV_API: API_URL },
      url: WEB_URL,
      reuseExistingServer: REUSE,
      timeout: 180_000,
    },
  ],
});
