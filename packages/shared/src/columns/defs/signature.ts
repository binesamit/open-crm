// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { ColumnTypeDef } from '../types';

/**
 * Signature column: who signed an interactive document of the item, and when. Written only by the
 * signing endpoint (engine 'signature' — PUT /cells refuses it, duplicate / board copy / templates skip it); the
 * evidence (identity check, IP, what exactly was signed and its SHA-256, the consents) lives in `idoc_signatures`
 * and opens as a certificate from the cell. Generic: quotes, agreements, field hand-over approvals, consent forms.
 */
export const signatureSettingsSchema = z
  .object({
    /** Show the drawn signature in the cell when there is one. */
    show_drawing: z.boolean().default(true),
  })
  .loose();
export type SignatureSettings = z.infer<typeof signatureSettingsSchema>;

export const signatureValueSchema = z.object({
  signature_id: z.string().max(26),
  name: z.string().max(200),
  role: z.string().max(200).nullable().optional(),
  /** Server time (ISO). */
  at: z.string().max(40),
  /** The shared document that was signed, and its version. */
  doc_id: z.string().max(26),
  version: z.number().int(),
  has_drawing: z.boolean().optional(),
});
export type SignatureValue = z.infer<typeof signatureValueSchema>;

export const signatureColumn: ColumnTypeDef<SignatureSettings, SignatureValue> = {
  type: 'signature',
  labelHe: 'חתימה',
  category: 'advanced',
  priority: 'P2',
  storage: 'cell',
  engine: 'signature',
  readOnly: false, // written by the signing endpoint only (ownWriter), never PUT /cells
  settingsSchema: signatureSettingsSchema,
  valueSchema: signatureValueSchema,
  defaultSettings: signatureSettingsSchema.parse({}),
  toText: (v) => (v?.name ? `${v.name} · ${v.at.slice(0, 10)}` : ''),
  toNumber: (v) => (v?.signature_id ? 1 : null),
  toDate: (v) => v?.at ?? null,
  toFormula: (v) => (v?.name ? v.name : null),
  filterOperators: ['is_empty', 'is_not_empty'],
  filterModel: 'date',
  sortKey: 'date',
  aggregates: ['count'],
};
