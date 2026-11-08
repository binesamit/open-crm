// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';

/** URL-safe random secret (invitation links, …). Only its hash is stored (CLAUDE.md rule 10). */
export const newSecretToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
