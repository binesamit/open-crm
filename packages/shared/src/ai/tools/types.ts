// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { TokenScope } from '../../api/tokens';

/**
 * One AI tool (the planning notes "AGENTS-MCP" §3.2): a pure description — name, schemas, the token scope it needs and
 * its risk. No database here (like automations/actions.ts): `apps/api/src/modules/ai/tools/runners.ts` runs each
 * tool through the ordinary services, so the MCP server and (later) agents share one implementation and one
 * permission path (`can()`, view_items, column restrictions, a token's board limit).
 */
export type ToolRisk = 'read' | 'write' | 'sensitive';
export type ToolFamily =
  | 'context'
  | 'structure'
  | 'dashboards'
  | 'items'
  | 'updates'
  | 'files'
  | 'search'
  | 'docs'
  | 'automations'
  | 'time'
  | 'activity'
  | 'flows'
  | 'idocs'
  | 'help'
  | 'item_templates';

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type AiToolDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> = {
  name: string;
  /** Short human title (English; the UI labels come from i18n by name). */
  title: string;
  /** For the model: what the tool does and when to use it. English — models follow it best. */
  description: string;
  family: ToolFamily;
  input: I;
  output: O;
  /** The token scope the tool needs (`any` = every token). */
  scope: TokenScope | 'any';
  risk: ToolRisk;
  annotations: ToolAnnotations;
};

const hints = (risk: ToolRisk, extra: Partial<ToolAnnotations> = {}): ToolAnnotations => ({
  readOnlyHint: risk === 'read',
  destructiveHint: risk === 'sensitive',
  idempotentHint: risk === 'read',
  openWorldHint: false,
  ...extra,
});

export const defineTool = <I extends z.ZodObject, O extends z.ZodType>(
  def: Omit<AiToolDef<I, O>, 'annotations'> & { annotations?: Partial<ToolAnnotations> },
): AiToolDef<I, O> => ({ ...def, annotations: hints(def.risk, def.annotations) });

// ---- shared bits of the schemas ----

/** Every list answer is capped (≤ 100 rows, §4 "דפדוף מוגבל"). */
export const MAX_TOOL_PAGE = 100;
/** A tool answer larger than this is refused with a hint to ask for less (fields, limit). */
export const MAX_TOOL_RESULT_BYTES = 200_000;

export const id = (what: string) => z.string().min(1).max(64).describe(`${what} id`);
export const limit = (def = 25) =>
  z.number().int().min(1).max(MAX_TOOL_PAGE).default(def).describe(`Max rows to return (1–${MAX_TOOL_PAGE})`);
export const cursor = z.string().max(200).optional().describe('next_cursor from the previous page');

/**
 * Cell values by column id. A value is either the column type's JSON (as `get_board` describes) or plain text
 * that is parsed for the column type ("Done", "2026-10-05", "dana@x.com", a person's name) — null clears the cell.
 */
export const cellsInput = z
  .record(z.string(), z.unknown())
  .describe(
    'Cell values keyed by column id (from get_board). Each value: the column JSON value, or plain text such as a status label, a date YYYY-MM-DD, a number, a person name or email, an hour 14:30, a week (any date in it), a country name or ISO code, an address (location), a colour #RRGGBB, a timezone or city (world clock); null clears.',
  );

export const position = z
  .union([z.enum(['top', 'bottom']), z.object({ after_id: z.string() }), z.object({ before_id: z.string() })])
  .optional()
  .describe("'top', 'bottom' or {after_id} / {before_id} of an item in the target group");

/** A loose object: the answer always carries these fields, maybe more. */
export const answer = <S extends z.ZodRawShape>(shape: S) => z.looseObject(shape);
export const okAnswer = answer({ ok: z.boolean() });
