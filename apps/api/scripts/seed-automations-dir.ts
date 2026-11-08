// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-account automation recipes (D21) are private data and are not in the repository: `automations:seed` and the
 * D26 one-off read them from a folder of `*.json` files (`{ automations: [...] }`, the format of the old
 * `seed/automations/`) named by `SEED_AUTOMATIONS_DIR` (or `--dir <path>`). Unset = nothing to load; nothing at
 * runtime depends on them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type SeedAutomation = {
  id: string;
  board: string;
  title?: string;
  recipe?: unknown;
  note?: string | null;
} & Record<string, unknown>;

/** The configured recipes folder (absolute), or null when none is set. */
export const seedAutomationsDir = (explicit?: string): string | null => {
  const dir = explicit?.trim() || process.env.SEED_AUTOMATIONS_DIR?.trim();
  return dir ? resolve(dir) : null;
};

/** Every recipe in the folder's `*.json` files (README.json and files without `automations` add nothing). */
export const loadSeedAutomations = (dir: string): SeedAutomation[] => {
  if (!existsSync(dir)) throw new Error(`SEED_AUTOMATIONS_DIR "${dir}" does not exist`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap(
      (f) => (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { automations?: SeedAutomation[] }).automations ?? [],
    );
};
