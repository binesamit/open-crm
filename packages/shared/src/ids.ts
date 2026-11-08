// SPDX-License-Identifier: AGPL-3.0-only
import { decodeTime, encodeTime, ulid } from 'ulid';

/** Primary keys are ULIDs (02-DATA-MODEL §0): 26 chars, Crockford base32, time-sortable. */
export const newId = (): string => ulid();

/** The smallest ULID of a moment: every id minted at `ms` or later sorts at or after it (a replay lower bound). */
export const idAt = (ms: number): string => `${encodeTime(ms, 10)}0000000000000000`;

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isId = (value: string): boolean => ULID_RE.test(value);

/** Creation time (ms) encoded in a ULID — e.g. how old a Last-Event-ID is. */
export const idTime = (id: string): number => decodeTime(id);
