// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Standalone mode: the secrets an installation needs are made on first boot and kept in `$DATA_DIR/secrets.json`
 * (mode 0600, next to the data they protect), so `docker run` needs no configuration. A variable set in the
 * environment always wins over the file. Values are never printed or logged; losing the file loses the encrypted
 * secrets (SECRET_MASTER_KEY) and signs everyone out (BETTER_AUTH_SECRET) — back it up with the data.
 */
export const GENERATED_SECRETS = {
  /** Signs sessions, extension and collab tokens, file links; derives the at-rest key of AI connection keys. */
  BETTER_AUTH_SECRET: () => randomBytes(48).toString('base64url'),
  /** Wraps each account's data key of secret columns (32 bytes, base64). */
  SECRET_MASTER_KEY: () => randomBytes(32).toString('base64'),
} as const;

export type SecretName = keyof typeof GENERATED_SECRETS;

export const secretsFile = (dataDir: string) => join(dataDir, 'secrets.json');

/**
 * Fills the missing secrets of `env` from the file, generating (and saving) the ones the file lacks too. Returns the
 * names that came from the file and the ones made now — names only.
 */
export const ensureInstanceSecrets = (dataDir: string, env: NodeJS.ProcessEnv = process.env) => {
  const file = secretsFile(dataDir);
  let stored: Partial<Record<SecretName, string>> = {};
  if (existsSync(file)) {
    try {
      stored = JSON.parse(readFileSync(file, 'utf8')) as typeof stored;
    } catch {
      throw new Error(`${file} is not valid JSON - restore it from a backup (it holds this installation's keys)`);
    }
  }
  const generated: SecretName[] = [];
  const fromFile: SecretName[] = [];
  for (const name of Object.keys(GENERATED_SECRETS) as SecretName[]) {
    if (env[name]?.trim()) continue;
    if (!stored[name]) {
      stored[name] = GENERATED_SECRETS[name]();
      generated.push(name);
    } else fromFile.push(name);
    env[name] = stored[name];
  }
  if (generated.length) {
    mkdirSync(dirname(file), { recursive: true });
    // Written whole, then moved into place: a crash never leaves half a file.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // no file (every secret came from the environment) or a filesystem without modes
  }
  return { generated, fromFile, file };
};
