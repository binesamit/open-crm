// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The build of the web app this server serves ("must refresh to continue", PWA): `build.json` that the Vite build
 * writes next to the page (apps/web/vite-pwa.ts), read once when the SPA is mounted. Without it (development, the
 * API alone) the deployed commit, else 'dev' — pages never compare against 'dev'.
 */
let served: string | null = null;

export const setServedBuild = (build: string | null) => {
  served = build;
};

/** Reads dist/build.json; null when it is missing or unreadable. */
export const readWebBuild = (webDistDir: string): string | null => {
  const file = join(webDistDir, 'build.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { build?: unknown };
    return typeof parsed.build === 'string' && parsed.build.trim() ? parsed.build.trim() : null;
  } catch {
    return null;
  }
};

export const serverBuild = () => served ?? process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) ?? 'dev';
