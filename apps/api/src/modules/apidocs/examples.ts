// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Example values for the public API reference, derived from the JSON Schemas the routes already declare (zod →
 * OpenAPI). Deterministic (the same schema always gives the same example), so the docs never drift from the code
 * and a schema change shows up in the next build. Field names steer the values ("email" → an address, "*_id" → an
 * id) so the examples read like real data instead of "string".
 */

export type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  minimum?: number;
  exclusiveMinimum?: number | boolean;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  pattern?: string;
  [k: string]: unknown;
};

type Components = Record<string, JsonSchema>;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID-shaped id that stays the same for the same field name (ids in examples line up across endpoints). */
export const exampleId = (seed: string): string => {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let out = '01JB';
  for (let i = 0; i < 22; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    out += CROCKFORD[h % 32];
  }
  return out;
};

const EXAMPLE_TIME = '2026-10-06T09:30:00.000Z';
const EXAMPLE_DATE = '2026-10-06';

/** A string for a field, by its format and name. */
const stringFor = (s: JsonSchema, key: string): string => {
  const k = key.toLowerCase();
  switch (s.format) {
    case 'date-time':
      return EXAMPLE_TIME;
    case 'date':
      return EXAMPLE_DATE;
    case 'email':
      return 'dana@example.com';
    case 'uri':
    case 'url':
      return k.includes('avatar') || k.includes('logo') ? 'https://example.com/logo.png' : 'https://example.com/hook';
    case 'uuid':
      return '3f1c2a9e-6b1d-4c8e-9a51-2d7f0b6e4c11';
  }
  if (k === 'column_id' || k === 'columnid') return 'status';
  if (k === 'group_id') return 'topics';
  if (k === 'id' || k.endsWith('_id') || k.endsWith('_by') || key.endsWith('Id')) return exampleId(k);
  if (k === 'position' || k === 'rank') return 'a0';
  if (k.endsWith('_ids')) return exampleId(k.slice(0, -1));
  if (k.endsWith('_at') || k.endsWith('_time') || k === 'since' || k === 'until') return EXAMPLE_TIME;
  if (k.includes('date') || k === 'day' || k === 'from' || k === 'to') return EXAMPLE_DATE;
  if (k.includes('email')) return 'dana@example.com';
  if (k.includes('url') || k === 'href' || k === 'link') return 'https://example.com/hook';
  if (k.includes('color') || k.includes('colour')) return 'forest';
  if (k === 'cursor' || k === 'next_cursor') return 'eyJvIjoxMDB9';
  if (k.includes('phone')) return '+972501234567';
  if (k === 'slug') return 'acme';
  if (k.includes('timezone') || k === 'tz') return 'Asia/Jerusalem';
  if (k === 'locale' || k === 'language') return 'en';
  if (k === 'currency') return 'USD';
  if (k === 'secret') return 'whsec_••••';
  if (k === 'token') return 'bos_pat_••••';
  if (k === 'name' || k === 'title') return 'Website redesign';
  if (k === 'body' || k === 'text' || k === 'message' || k === 'content') return 'Kick-off call is booked for Monday.';
  if (k === 'description' || k === 'note' || k === 'notes') return 'Short description.';
  if (k === 'q' || k === 'query' || k === 'search') return 'redesign';
  if (k === 'label') return 'Done';
  if (k === 'event' || k === 'type' || k === 'kind') return 'item_created';
  if (k === 'role') return 'member';
  if (k === 'status') return 'active';
  const min = s.minLength ?? 0;
  const base = 'example';
  return base.length >= min ? base : base.padEnd(min, 'x');
};

const numberFor = (s: JsonSchema): number => {
  if (typeof s.minimum === 'number' && s.minimum > 0) return s.minimum;
  if (typeof s.exclusiveMinimum === 'number') return s.exclusiveMinimum + 1;
  const n = 1;
  return typeof s.maximum === 'number' && s.maximum < n ? s.maximum : n;
};

const firstType = (t: JsonSchema['type']): string | undefined =>
  Array.isArray(t) ? (t.find((x) => x !== 'null') ?? t[0]) : t;

const MAX_DEPTH = 7;

/** Cell values keyed by column id — each value follows its column type (03-COLUMN-TYPES). */
const CELLS_EXAMPLE = { status: { index: 1 }, date: { date: '2026-10-20' }, numbers: 1200 };

/** One example value for a schema. `refs` guards recursive schemas (a filter group contains filter groups). */
export const exampleFor = (
  schema: JsonSchema | undefined,
  components: Components,
  key = '',
  depth = 0,
  refs: string[] = [],
): unknown => {
  if (!schema || depth > MAX_DEPTH) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.$ref) {
    const name = schema.$ref.replace('#/components/schemas/', '');
    if (refs.includes(name)) return null;
    return exampleFor(components[name], components, key, depth, [...refs, name]);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined && schema.default !== null) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((v) => v !== null) ?? schema.enum[0];
  if (schema.allOf?.length) {
    const parts = schema.allOf.map((p) => exampleFor(p, components, key, depth, refs));
    if (parts.every((p) => p && typeof p === 'object' && !Array.isArray(p)))
      return Object.assign({}, ...(parts as object[]));
    return parts[0];
  }
  const alt = schema.anyOf ?? schema.oneOf;
  if (alt?.length) {
    const pick = alt.find((a) => a.type !== 'null') ?? alt[0];
    return exampleFor(pick, components, key, depth, refs);
  }
  const type = firstType(schema.type) ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);
  switch (type) {
    case 'string':
      return stringFor(schema, key);
    case 'integer':
    case 'number':
      return numberFor(schema);
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      if (schema.prefixItems?.length)
        return schema.prefixItems.map((p) => exampleFor(p, components, key, depth + 1, refs));
      const one = exampleFor(schema.items, components, key.endsWith('s') ? key.slice(0, -1) : key, depth + 1, refs);
      return one === null ? [] : [one];
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, prop] of Object.entries(schema.properties ?? {})) {
        out[k] = exampleFor(prop, components, k, depth + 1, refs);
      }
      // Cells written as free values (requests): realistic ones. Cells read back keep their declared shape.
      const ap = schema.additionalProperties;
      const anyValue = ap === true || (!!ap && typeof ap === 'object' && !Object.keys(ap).length);
      if (!schema.properties && key === 'cells' && anyValue) return CELLS_EXAMPLE;
      if (!schema.properties && schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const sample = exampleFor(schema.additionalProperties, components, 'value', depth + 1, refs);
        out[key === 'cells' || key === 'values' ? 'status' : 'key'] = sample;
      }
      return out;
    }
    default:
      return {};
  }
};

/** A short sample for a text response (CSV export, event stream, Markdown, the head of a PDF) — enough to show its shape. */
export const textExample = (mediaType: string): string | undefined => {
  if (mediaType === 'text/csv') return 'id,name,status\n01JB…,Website redesign,Done\n';
  if (mediaType === 'text/event-stream')
    return 'id: 01JB…\nevent: activity\ndata: {"type":"item.created","item_id":"01JB…"}\n\n: heartbeat\n\n';
  if (mediaType === 'text/markdown') return '# Website redesign\n\nKick-off call is booked for Monday.\n';
  if (mediaType === 'text/html') return '<h1>Website redesign</h1><p>Kick-off call is booked for Monday.</p>';
  // A binary file: its first bytes, so the shape is clear.
  if (mediaType === 'application/pdf') return '%PDF-1.7 … (binary, A4 pages)';
  return undefined;
};
