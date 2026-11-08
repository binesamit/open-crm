// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const origin = z
  .string()
  .url()
  .transform((u) => new URL(u).origin);

/** The server's configuration (environment variables; the per-account settings live in the admin page). */
export const envSchema = z.object({
  /** Where this server is reached from browsers, Bines and Google (an origin: https://calendar-sync.example.com). */
  PUBLIC_URL: origin,
  /** The Bines this server works with (only its `installed` calls are believed). */
  BINES_ORIGIN: origin,
  PORT: z.coerce.number().int().min(1).max(65535).default(3990),
  /** Its own Postgres database; unset = in memory (development only: everything is lost on restart). */
  DATABASE_URL: z.string().optional(),
  /** Encrypts the stored secrets (32 bytes: `openssl rand -base64 32`). */
  CALSYNC_ENCRYPTION_KEY: z.string().min(16),
  /** The default Google OAuth client (an account admin can set their own in the settings page). */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** How often each calendar is read when no push arrives, and how often every board item is checked. */
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  RECONCILE_MINUTES: z.coerce.number().int().min(5).max(10080).default(60),
});
export type Env = z.infer<typeof envSchema>;

export const readEnv = (src: Record<string, string | undefined> = process.env): Env => {
  const r = envSchema.safeParse(Object.fromEntries(Object.entries(src).map(([k, v]) => [k, v === '' ? undefined : v])));
  if (!r.success)
    throw new Error(
      `calendar-sync: bad configuration — ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return r.data;
};

export const redirectUri = (env: Pick<Env, 'PUBLIC_URL'>) => `${env.PUBLIC_URL}/oauth/google/callback`;
