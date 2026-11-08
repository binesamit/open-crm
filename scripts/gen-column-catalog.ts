// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Generates docs/COLUMN-TYPES.generated.md — the catalog of every column type, read from the registry itself
 * (`packages/shared/src/columns`): settings (the zod `settingsSchema`, as JSON Schema), the value shape
 * (`valueSchema`), filter operators, sort and summary, automation support (the trigger / action registries in
 * `packages/shared/src/automations`), import hooks, and the REST / MCP calls that make a column and write a cell.
 * Names come from `packages/shared/src/i18n/{en,he}.json`; descriptions from the def's doc comment in the source.
 *
 *   pnpm docs:columns          writes the file
 *   pnpm docs:check            regenerates in memory and fails when the committed file differs (CI)
 *
 * The output is deterministic: registry order, no dates. Nothing here is hand-written per type — add a type to
 * the registry and it appears; a type that lacks a description or an i18n name is listed on stderr.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import {
  ACTIONS,
  COMPUTED_TARGET_TYPES,
  columnTypes,
  DERIVED_VALUE_KEYS,
  ownWriter,
  TRIGGERS,
  WRITES_CELL,
  type AnyColumnTypeDef,
} from '@bines/shared';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const columnsDir = join(root, 'packages/shared/src/columns');
const out = join(root, 'docs/COLUMN-TYPES.generated.md');
const check = process.argv.includes('--check');

const warnings: string[] = [];
const warn = (type: string, what: string) => warnings.push(`${type}: ${what}`);

// ---------------------------------------------------------------------------------------------------------------
// Sources beside the registry: i18n names, doc comments and field comments (best effort, from the source text)
// ---------------------------------------------------------------------------------------------------------------

const i18n = (lang: 'en' | 'he'): Record<string, string> =>
  JSON.parse(readFileSync(join(root, `packages/shared/src/i18n/${lang}.json`), 'utf8'));
const en = i18n('en');
const he = i18n('he');

/** Every .ts under packages/shared/src/columns (defs and helpers), LF line ends. */
const sources = (() => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) files.push(join(dir, e.name));
    }
  };
  walk(columnsDir);
  return files.sort().map((f) => ({ file: f, text: readFileSync(f, 'utf8').replace(/\r\n/g, '\n') }));
})();

/** A block comment's prose: `/** … *\/` → paragraphs (blank `*` lines separate them) joined by a blank line. */
const commentText = (raw: string) =>
  raw
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n\n')
    .split('\n\n')
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');

/** The first paragraph of a comment. */
const firstParagraph = (s: string) => s.split('\n\n')[0]!.trim();

/** The comment lines (`/** *\/` block or `//` lines) that end right above `index`, if any. */
const commentAbove = (text: string, index: number): string | null => {
  const before = text.slice(0, index);
  const lines = before.split('\n');
  lines.pop(); // the (partial) line the match starts on
  // `//` lines
  const slashes: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*\/\/\s?(.*)$/.exec(lines[i]!);
    if (!m) break;
    slashes.unshift(m[1]!.trim());
  }
  if (slashes.length) return slashes.join(' ').trim();
  // a block comment ending on the previous line
  const trimmed = before.replace(/\s+$/, '');
  if (!trimmed.endsWith('*/')) return null;
  const start = trimmed.lastIndexOf('/*');
  if (start < 0) return null;
  const between = before.slice(trimmed.length);
  if (/\n\s*\n/.test(between)) return null; // a blank line separates it
  return commentText(trimmed.slice(start));
};

/** Spec references ("03 §2.4", "(M8 ד10)", "(E7)") out of a sentence; `section` keeps the 03 § it names. */
const splitSpecRef = (s: string): { section: string | null; text: string } => {
  const m = /03\s*§\s*(\d+(?:\.\d+)*)/.exec(s);
  const section = m ? m[1]! : null;
  const text = s
    .replace(/\s*[—–-]?\s*\(?\b03\s*§\s*\d+(?:\.\d+)*\)?(\.?)\s*[—–-]?\s*/g, '$1 ')
    .replace(/\s+([.,;])/g, '$1')
    .replace(/^\s*[—–-]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { section, text };
};

type DefSource = { file: string; text: string; start: number; settingsExpr: string };

/** Where each def is declared (`export const xColumn: ColumnTypeDef<…> = {` … `type: '<key>'`). */
const defSources = new Map<string, DefSource>();
for (const { file, text } of sources) {
  const re = /export const (\w+Column)\s*:\s*ColumnTypeDef<[\s\S]*?>\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = text.slice(m.index, text.indexOf('\n};', m.index));
    const type = /\n\s*type:\s*'([a-z_]+)'/.exec(body)?.[1];
    if (!type) continue;
    const settings = /\n\s*settingsSchema:\s*([^\n]*)/.exec(body)?.[1]?.trim() ?? '';
    defSources.set(type, { file, text, start: m.index, settingsExpr: settings });
  }
}

/** The def's own doc comment, else the section banner above it (`// progress (03 §3.4) — …` in p1.ts). */
const docComment = (type: string): string | null => {
  const src = defSources.get(type);
  if (!src) return null;
  const attached = commentAbove(src.text, src.start);
  if (attached) return attached;
  const before = src.text.slice(0, src.start);
  const banners = [...before.matchAll(/^\/\/ [a-z][a-z ]*\((03 §[\d.]+)\)\s*(?:[—–-]\s*([^\n]*))?$/gm)];
  const last = banners.at(-1);
  if (last) {
    // only the banner of this def's section: no other def between it and here
    const since = before.slice(last.index!);
    if (!/export const \w+Column\s*:/.test(since)) return `${last[1]} — ${(last[2] ?? '').trim()}`;
  }
  // a module that holds one def (ai, secret, signature, time): its header comment describes the column
  const defsInFile = [...defSources.values()].filter((d) => d.file === src.file).length;
  // (an SPDX `//` line, imports and blank lines may come before the header comment)
  const header = /^(?:import[^\n]*\n|\/\/[^\n]*\n|\s*\n)*(\/\*\*[\s\S]*?\*\/)/.exec(src.text)?.[1];
  if (defsInFile === 1 && header) return commentText(header);
  return null;
};

/**
 * Field comments of every `z.object({ … })` / `.extend({ … })` block in the sources, keyed by the variable the
 * block is assigned to (or `settingsSchema` inline): `{ var → { field → comment } }`, depth-1 fields only.
 */
const fieldComments = new Map<string, Map<string, string>>();
for (const { text } of sources) {
  const re = /(?:(?:export )?const (\w+)\s*=\s*|settingsSchema:\s*)([\w.]*)(?:\s*\n\s*)?\.?(?:object|extend)\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1] ?? `inline@${m.index}`;
    const base = m[2]?.replace(/^z$/, '') || null;
    const open = m.index + m[0].length;
    let depth = 1;
    let i = open;
    for (; i < text.length && depth > 0; i++) {
      const ch = text[i];
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
      else if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch;
        i++;
        while (i < text.length && text[i] !== q) i += text[i] === '\\' ? 2 : 1;
      } else if (ch === '/' && text[i + 1] === '*') i = text.indexOf('*/', i) + 1;
      else if (ch === '/' && text[i + 1] === '/') i = text.indexOf('\n', i);
    }
    const block = text.slice(open, i - 1);
    const fields = new Map<string, string>();
    // depth-1 keys: lines of the block with exactly one more indent than the line holding `object({`
    const openerIndent = /(^|\n)([ \t]*)[^\n]*$/.exec(text.slice(0, open))?.[2]?.length ?? 0;
    const keyRe = new RegExp(`\\n {${openerIndent + 2}}(\\w+)\\s*:`, 'g');
    let k: RegExpExecArray | null;
    while ((k = keyRe.exec(block))) {
      const c = commentAbove(block, k.index + 1);
      if (c) fields.set(k[1]!, c);
    }
    if (base && fieldComments.has(base))
      for (const [f, c] of fieldComments.get(base)!) if (!fields.has(f)) fields.set(f, c);
    fieldComments.set(name, fields);
  }
}

/** The comment of a settings field of a type: its settings block, else any block of the same file naming it once. */
const fieldComment = (type: string, field: string): string | null => {
  const src = defSources.get(type);
  if (!src) return null;
  const expr = src.settingsExpr;
  const varName = /^([A-Za-z_]\w*)[,\s]*$/.exec(expr)?.[1];
  const inline = expr.startsWith('z') ? `inline@${src.text.indexOf('settingsSchema:', src.start)}` : null;
  const own = (varName && fieldComments.get(varName)) || (inline && fieldComments.get(inline)) || null;
  if (own?.has(field)) return own.get(field)!;
  // a wrapper (`z.preprocess(…, aiColumnSettingsObject)`) or a schema declared elsewhere: the one block that
  // declares the field with a comment, if exactly one does, is it.
  const candidates = [...fieldComments.values()].filter((f) => f.has(field));
  return candidates.length === 1 ? candidates[0]!.get(field)! : null;
};

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema → compact type text and example values
// ---------------------------------------------------------------------------------------------------------------

type JS = Record<string, unknown>;

/** `z.preprocess(fn, schema)` is a pipe whose input side is a transform: the real shape is its output side. */
const unwrapPipe = (schema: z.ZodType): z.ZodType => {
  let s = schema as unknown as { _zod: { def: { type: string; in?: unknown; out?: unknown } } };
  for (;;) {
    const d = s._zod?.def;
    if (d?.type !== 'pipe') return s as unknown as z.ZodType;
    const inDef = (d.in as { _zod?: { def?: { type?: string } } })?._zod?.def;
    if (inDef?.type !== 'transform') return s as unknown as z.ZodType;
    s = d.out as typeof s;
  }
};

/** What an object schema does with keys it does not declare: zod strips them, `.loose()` keeps, `.strict()` refuses. */
const unknownKeys = (schema: z.ZodType): 'dropped' | 'kept' | 'refused' | null => {
  const def = (
    unwrapPipe(schema) as unknown as { _zod: { def: { type: string; catchall?: { _zod: { def: { type: string } } } } } }
  )._zod.def;
  if (def.type !== 'object') return null;
  const catchall = def.catchall?._zod.def.type;
  return !catchall ? 'dropped' : catchall === 'never' ? 'refused' : 'kept';
};

const toJsonSchema = (schema: z.ZodType): JS =>
  z.toJSONSchema(unwrapPipe(schema), { io: 'input', unrepresentable: 'any', reused: 'inline' }) as JS;

/** Resolves `$ref` against the root schema's `$defs` / `definitions`. */
const deref = (s: JS, rootSchema: JS): JS => {
  const ref = s.$ref as string | undefined;
  if (!ref) return s;
  const path = ref.replace(/^#\//, '').split('/');
  let cur: unknown = rootSchema;
  for (const p of path) cur = (cur as JS)?.[p];
  return (cur as JS) ?? {};
};

const fmtNum = (n: unknown) => (typeof n === 'number' ? String(n) : '');

/** `string (max 30)`, `enum: a \| b`, `array<object{a, b}> (max 40)`, `object{…}`, `number (int, 1–8)` … */
const typeText = (s: JS, rootSchema: JS, depth = 0): string => {
  if (s.$ref) {
    const name = (s.$ref as string).split('/').pop()!;
    return depth > 1 ? name : typeText(deref(s, rootSchema), rootSchema, depth + 1);
  }
  // plain `|` here; the table cell escapes it once (`cell`)
  if (Array.isArray(s.enum)) return `enum: ${(s.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ')}`;
  if (s.const !== undefined) return `const ${JSON.stringify(s.const)}`;
  const variants = (s.anyOf ?? s.oneOf) as JS[] | undefined;
  if (variants) {
    const parts = variants.map((v) => typeText(v, rootSchema, depth + 1));
    if (parts.every((p) => /^const /.test(p))) return `enum: ${parts.map((p) => p.slice(6)).join(' | ')}`;
    const nonNull = parts.filter((p) => p !== 'null');
    return nonNull.length === parts.length ? parts.join(' | ') : `${nonNull.join(' | ')} | null`;
  }
  const t = Array.isArray(s.type) ? (s.type as string[]).join(' | ') : (s.type as string | undefined);
  const notes: string[] = [];
  if (t === 'string') {
    if (s.format) notes.push(String(s.format));
    if (s.pattern) notes.push(`pattern \`${String(s.pattern)}\``);
    if (s.minLength !== undefined && s.maxLength !== undefined)
      notes.push(`${fmtNum(s.minLength)}–${fmtNum(s.maxLength)} chars`);
    else if (s.maxLength !== undefined) notes.push(`max ${fmtNum(s.maxLength)}`);
    else if (s.minLength !== undefined) notes.push(`min ${fmtNum(s.minLength)}`);
    return notes.length ? `string (${notes.join(', ')})` : 'string';
  }
  if (t === 'number' || t === 'integer') {
    if (t === 'integer') notes.push('int');
    const lo = s.minimum ?? s.exclusiveMinimum;
    const hi = s.maximum ?? s.exclusiveMaximum;
    if (lo !== undefined && hi !== undefined) notes.push(`${fmtNum(lo)}–${fmtNum(hi)}`);
    else if (lo !== undefined) notes.push(`≥ ${fmtNum(lo)}`);
    else if (hi !== undefined) notes.push(`≤ ${fmtNum(hi)}`);
    return notes.length ? `number (${notes.join(', ')})` : 'number';
  }
  if (t === 'boolean' || t === 'null') return t;
  if (t === 'array') {
    const item = s.items ? typeText(s.items as JS, rootSchema, depth + 1) : 'any';
    const max = s.maxItems !== undefined ? ` (max ${fmtNum(s.maxItems)})` : '';
    return `array<${item}>${max}`;
  }
  if (t === 'object' || s.properties) {
    const props = Object.keys((s.properties as JS) ?? {});
    if (!props.length)
      return s.additionalProperties && typeof s.additionalProperties === 'object'
        ? `map<string, ${typeText(s.additionalProperties as JS, rootSchema, depth + 1)}>`
        : 'object';
    return depth > 1 ? 'object' : `object{${props.join(', ')}}`;
  }
  return 'any';
};

/** An example of a schema (deterministic; dates and times advance so ranges stay valid). */
const example = (s: JS, rootSchema: JS, key: string, counters: { date: number; time: number }, depth = 0): unknown => {
  s = deref(s, rootSchema);
  if (depth > 8) return null;
  if (s.default !== undefined && key !== 'kind') return s.default;
  if (Array.isArray(s.enum)) return (s.enum as unknown[])[0];
  if (s.const !== undefined) return s.const;
  const variants = (s.anyOf ?? s.oneOf) as JS[] | undefined;
  if (variants) {
    const first = variants.find((v) => deref(v, rootSchema).type !== 'null') ?? variants[0]!;
    return example(first, rootSchema, key, counters, depth + 1);
  }
  const t = Array.isArray(s.type) ? (s.type as string[]).find((x) => x !== 'null') : (s.type as string | undefined);
  if (t === 'string') {
    const pattern = String(s.pattern ?? '');
    const k = key.toLowerCase();
    if (s.format === 'email' || k === 'email') return 'dana@example.com';
    if (s.format === 'uri' || k === 'url') return 'https://example.com';
    if (/\\d\{4\}-\\d\{2\}-\\d\{2\}\$$/.test(pattern) || s.format === 'date')
      return `2026-03-${String(1 + 6 * counters.date++).padStart(2, '0')}`;
    if (/\[0-5\]\\d/.test(pattern) || /\\d\{2\}:\\d\{2\}/.test(pattern))
      return ['09:00', '10:30', '12:00', '13:30'][counters.time++ % 4];
    if (/^\^\\\+\[1-9\]/.test(pattern)) return '+972501234567';
    if (/0-9a-f/i.test(pattern) && /\{6\}/.test(pattern)) return '#1a2b3c';
    if (/^\^\[A-Za-z0-9-\]/.test(pattern)) return 'PRJ';
    if (/^\^\[a-z\]\[a-z0-9_\]/.test(pattern)) return 'status';
    if (s.format === 'date-time' || k === 'at' || k.endsWith('_at') || k === 'since') return '2026-03-01T09:00:00.000Z';
    if (k === 'start' || k === 'end' || k === 'date')
      return `2026-03-${String(1 + 6 * counters.date++).padStart(2, '0')}`;
    if (k.endsWith('_id') || k === 'id' || k.endsWith('_by') || k === 'by' || k === 'people' || k === 'person')
      return '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    if (k === 'timezone') return 'Asia/Jerusalem';
    if (k === 'code' || k === 'country' || k === 'country_code') return 'IL';
    if (k === 'phone') return '050-123-4567';
    if (k === 'address') return 'Rothschild Blvd 1, Tel Aviv';
    if (k === 'key') return 'PRJ-0012';
    if (k === 'color') return '#1a2b3c';
    if (k === 'name') return 'Dana Levi';
    if (k === 'text' || k === 'display_value' || k === 'label') return 'Example text';
    if (k === 'role') return 'CEO';
    if (k === 'symbol') return '₪';
    if (k === 'model') return 'gpt-4o-mini';
    return 'example';
  }
  if (t === 'integer') {
    const lo =
      typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 0;
    return Math.max(lo, key === 'index' || key === 'rating' || key === 'version' || key === 'variation' ? 1 : lo);
  }
  if (t === 'number')
    return key === 'percent'
      ? 68
      : key === 'lat'
        ? 32.0853
        : key === 'lng'
          ? 34.7818
          : key === 'cost_usd'
            ? 0.002
            : 12.5;
  if (t === 'boolean') return true;
  if (t === 'array')
    return s.items ? [example(s.items as JS, rootSchema, key.replace(/s$/, ''), counters, depth + 1)] : [];
  if (t === 'object' || s.properties) {
    const props = (s.properties as Record<string, JS>) ?? {};
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) o[k] = example(v, rootSchema, k, counters, depth + 1);
    return o;
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s: string) => `\`${s}\``;
const json = (v: unknown) => JSON.stringify(v, null, 2);
const jsonInline = (v: unknown) => JSON.stringify(v);
const list = (xs: readonly string[]) => (xs.length ? xs.map(code).join(', ') : '—');
const anchor = (key: string) => key.replace(/_/g, '-');

const FAMILY: Record<string, string> = {
  essentials: 'Essentials',
  super_useful: 'Super useful',
  relations: 'Relations',
  computed: 'Computed',
  meta: 'Meta',
  advanced: 'Advanced',
};

const ENGINE_NOTE: Record<string, string> = {
  links: 'the links live in `item_links`; the cell is a cache of them',
  mirror: 'computed on read from the linked items',
  formula: 'computed by the formula engine and stored denormalised',
  files: 'the files live in `files`; the cell is a cache written by the files endpoints',
  time: 'the truth is `time_entries`; the cell is a cache written by the time endpoints',
  vote: 'one vote per user, written through the vote endpoint',
  doc: 'a doc created in the cell through the cell-doc endpoint',
  progress: 'computed on read from status columns / subitems',
  button: 'no stored value; a click runs the column action',
  secret: 'the value is encrypted outside `cells` (secret endpoints); the cell is only a marker',
  signature: 'written by the signing flow of an interactive document; evidence in `idoc_signatures`',
};

/** A neutral sentence from what the type stores, for a def without a doc comment. */
const neutralDescription = (def: AnyColumnTypeDef, valueType: string) =>
  `A ${def.storage === 'computed' ? 'computed' : 'cell'} column whose value is ${valueType}; its text is what \`toText\` makes of it.`;

type Section = { key: string; nameEn: string; nameHe: string; md: string; family: string; storage: string };

const renderType = (def: AnyColumnTypeDef): Section => {
  const key = def.type;
  const nameEn = en[`columnType.${key}`] ?? (warn(key, 'no English name (i18n columnType.<key>)'), key);
  const nameHe = he[`columnType.${key}`] ?? (warn(key, 'no Hebrew name in he.json (using labelHe)'), def.labelHe);

  const settingsJs = toJsonSchema(def.settingsSchema);
  const valueJs = toJsonSchema(def.valueSchema);
  const counters = { date: 0, time: 0 };
  const valueExample = example(valueJs, valueJs, 'value', counters);
  const parsed = def.valueSchema.safeParse(valueExample);
  if (!parsed.success) warn(key, `value example does not pass valueSchema: ${jsonInline(valueExample)}`);
  const valueType = typeText(valueJs, valueJs);

  // description
  const raw = docComment(key);
  const spec = raw ? splitSpecRef(firstParagraph(raw)) : { section: null, text: '' };
  let description = spec.text.replace(/^[a-z]/, (c) => c.toUpperCase());
  if (!description) {
    description = neutralDescription(def, valueType);
    warn(key, 'no description (doc comment on the def is empty or only a spec reference)');
  }

  const lines: string[] = [];
  lines.push(`## ${key} — ${nameEn} / ${nameHe}`);
  lines.push('');
  const facts = [
    `**Family:** ${FAMILY[def.category] ?? def.category}`,
    `**Storage:** ${code(def.storage)}${def.engine ? ` (engine ${code(def.engine)}: ${ENGINE_NOTE[def.engine] ?? ''})` : ''}`,
    `**Read-only through the API:** ${def.readOnly ? 'yes' : 'no'}`,
    `**Priority:** ${def.priority}`,
  ];
  if (spec.section) facts.push(`**Spec:** [03-COLUMN-TYPES.md §${spec.section}](03-COLUMN-TYPES.md)`);
  lines.push(facts.join(' · '));
  lines.push('');
  lines.push(description);
  lines.push('');

  // settings
  lines.push('### Settings');
  lines.push('');
  const props = (settingsJs.properties as Record<string, JS>) ?? {};
  const required = new Set((settingsJs.required as string[]) ?? []);
  const defaults = (def.defaultSettings ?? {}) as Record<string, unknown>;
  const keys = Object.keys(props);
  const policy = unknownKeys(def.settingsSchema);
  const policyText =
    policy === 'kept'
      ? 'Unknown keys are kept as sent.'
      : policy === 'refused'
        ? 'Unknown keys are refused.'
        : 'Unknown keys are dropped.';
  if (!keys.length) {
    lines.push(policy === 'kept' ? 'No settings of its own (any keys are kept as sent).' : 'No settings.');
  } else {
    lines.push('| Field | Type | Default | Required | Notes |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const k of keys) {
      const p = props[k]!;
      const dflt = defaults[k] !== undefined ? defaults[k] : p.default;
      const note = [p.description as string | undefined, fieldComment(key, k)].filter(Boolean).join(' ');
      lines.push(
        `| ${code(k)} | ${cell(typeText(p, settingsJs))} | ${dflt === undefined ? '—' : code(cell(jsonInline(dflt)))} | ${required.has(k) ? 'yes' : 'no'} | ${cell(note)} |`,
      );
    }
    lines.push('');
    lines.push(policyText);
  }
  lines.push('');
  lines.push(
    `New column defaults: ${code(jsonInline(def.defaultSettings ?? {}))}${def.newColumnSettings ? ' — plus the account’s defaults for new columns (`newColumnSettings`).' : ''}`,
  );
  lines.push('');

  // value
  lines.push('### Value');
  lines.push('');
  // `null` through PUT /cells clears a plain cell; engine-owned cells (files, time, votes …) refuse PUT /cells.
  lines.push(`Shape: ${valueType}.${def.readOnly || ownWriter(def) ? '' : ` ${code('null')} clears the cell.`}`);
  const optional = Object.keys((valueJs.properties as JS) ?? {}).filter(
    (k) => !((valueJs.required as string[]) ?? []).includes(k),
  );
  if (optional.length) lines.push(`Optional keys: ${list(optional)}.`);
  if (def.normalize)
    lines.push(
      `Derived on every write (whatever is sent for them is replaced): ${list(DERIVED_VALUE_KEYS)}${def.normalizeSettingsKeys?.length ? ` — recomputed when settings ${list(def.normalizeSettingsKeys)} change` : ''}.`,
    );
  if (def.validate) lines.push('Value-level checks against the settings apply (`validate`).');
  lines.push('');
  lines.push('```json');
  lines.push(json(valueExample));
  lines.push('```');
  lines.push('');
  const derived: string[] = [];
  derived.push(`text ${def.localizedText ? '(in the reader’s region format)' : ''}`.trim());
  if (def.toNumber) derived.push('number');
  if (def.toDate) derived.push('date');
  if (def.toDateEnd) derived.push('date end');
  if (def.fromItem) derived.push('computed from the item row');
  lines.push(
    `Derived columns for search, sort and summaries: ${derived.join(', ')}. In a formula \`{column}\` is ${def.toFormula ? 'its own value (number / text / boolean / {start, end})' : 'its text'}.`,
  );
  lines.push('');

  // filters
  lines.push('### Filters');
  lines.push('');
  if (!def.filterOperators.length) {
    lines.push('Not filterable.');
    warn(key, 'no filter operators');
  } else lines.push(`Model ${code(def.filterModel)}; operators: ${list(def.filterOperators)}.`);
  lines.push('');

  // sort / summary
  lines.push('### Sort / Summary');
  lines.push('');
  lines.push(
    `Sort: ${def.sortKey === 'none' ? 'not sortable' : `by ${code(def.sortKey)}`}. Summaries (group footer / dashboards): ${def.aggregates.length ? list(def.aggregates) : 'none'}${def.formatNumber ? ' — shown in the column’s own number format' : ''}.`,
  );
  lines.push('');

  // automations
  lines.push('### Automations');
  lines.push('');
  const triggers = Object.values(TRIGGERS)
    .filter((t) => t.columnTypes?.includes(key))
    .map((t) => t.type);
  const changeTriggers = def.storage !== 'computed' ? ['column_changed', 'subitem_column_changed'] : [];
  const actions = Object.values(ACTIONS)
    .filter((a) => a.columnTypes?.includes(key))
    .map((a) => a.type);
  const genericWrite = !def.readOnly && def.storage === 'cell' && !ownWriter(def);
  const trig = [...triggers, ...changeTriggers];
  lines.push(`- Triggers: ${trig.length ? list(trig) : 'none'}`);
  lines.push(`- Conditions: ${def.filterOperators.length ? 'yes — the filter operators above' : 'none'}`);
  const act = [...actions];
  if (genericWrite)
    act.push(...[...WRITES_CELL].filter((a) => a !== 'set_computed' || COMPUTED_TARGET_TYPES.includes(key)));
  if (key === 'name') act.push('set_item_name');
  lines.push(
    `- Actions: ${act.length ? list([...new Set(act)]) : 'none'}${ownWriter(def) ? ' — the cell is written only by its own endpoints, so generic cell actions do not apply' : ''}`,
  );
  lines.push(
    `- Fixed values typed as text (automations, paste, bulk edit, MCP plain values): ${def.fromText ? 'yes (`fromText`)' : 'no'}`,
  );
  lines.push('');

  // import
  lines.push('### Import');
  lines.push('');
  lines.push(`- Values from text (CSV / sheet import, paste): ${def.fromText ? 'yes (`fromText`)' : 'no'}`);
  lines.push('');

  // API
  lines.push('### API');
  lines.push('');
  if (key === 'name') lines.push('Every board has exactly one name column; it cannot be created.');
  else {
    lines.push('Create (`POST /boards/{board_id}/columns`):');
    lines.push('');
    lines.push('```json');
    lines.push(json({ title: nameEn, type: key, settings: def.defaultSettings ?? {} }));
    lines.push('```');
  }
  lines.push('');
  lines.push(writeExample(def, valueExample));
  lines.push('');

  // MCP
  lines.push('### MCP');
  lines.push('');
  lines.push(mcpLine(def));
  lines.push('');

  return {
    key,
    nameEn,
    nameHe,
    md: lines.join('\n'),
    family: FAMILY[def.category] ?? def.category,
    storage: def.storage,
  };
};

const writeExample = (def: AnyColumnTypeDef, value: unknown): string => {
  const put = (v: unknown) =>
    [
      'Write a cell (`PUT /items/{item_id}/cells/{column_id}`; several at once: `PATCH /items/{item_id}` with `cells`; as text: `values`):',
      '',
      '```json',
      json({ value: v }),
      '```',
    ].join('\n');
  switch (def.type) {
    case 'name':
      return ['Write (`PATCH /items/{item_id}`):', '', '```json', json({ name: 'Item name' }), '```'].join('\n');
    case 'file':
      return [
        'Write: upload, then attach — `POST /files/presign` `{"name", "size", "mime"}` → PUT the bytes to the URL → `POST /files/{file_id}/complete` → `POST /items/{item_id}/cells/{column_id}/files`:',
        '',
        '```json',
        json({ file_ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] }),
        '```',
        '',
        'Web links in the cell: `POST /items/{item_id}/cells/{column_id}/links`. `PUT /cells` refuses this column.',
      ].join('\n');
    case 'time_tracking':
      return [
        'Write: `POST /items/{item_id}/time/start` / `POST /items/{item_id}/time/stop` `{"column_id"}`; a manual entry `POST /items/{item_id}/time/entries`:',
        '',
        '```json',
        json({ column_id: 'time', started_at: '2026-03-01T09:00:00+02:00', duration_s: 5400 }),
        '```',
        '',
        '`PUT /cells` refuses this column.',
      ].join('\n');
    case 'vote':
      return [
        'Write: `POST /items/{item_id}/cells/{column_id}/vote` (the caller’s own vote):',
        '',
        '```json',
        json({ vote: true }),
        '```',
        '',
        '`PUT /cells` refuses this column.',
      ].join('\n');
    case 'doc':
      return [
        'Write: `POST /items/{item_id}/cells/{column_id}/doc` (makes the doc in the cell):',
        '',
        '```json',
        json({ name: 'Meeting notes' }),
        '```',
        '',
        '`PUT /cells` refuses this column.',
      ].join('\n');
    case 'button':
      return [
        'Click: `POST /items/{item_id}/buttons/{column_id}` (popup values optional):',
        '',
        '```json',
        json({ cells: {}, note: '' }),
        '```',
        '',
        'There is no cell value to write.',
      ].join('\n');
    case 'secret':
      return [
        'Write: `PUT /items/{item_id}/cells/{column_id}/secret` (a fresh 2FA code when the column requires one); reveal: `POST …/secret/reveal` `{"code"}`:',
        '',
        '```json',
        json({ value: 's3cret' }),
        '```',
        '',
        '`PUT /cells` refuses this column; reads never return the value, only the marker.',
      ].join('\n');
    case 'signature':
      return 'Written only when a client signs an interactive document (`POST /public/idocs/{token}/sign`); the certificate is `GET /signatures/{signature_id}`. No direct write.';
    default:
      if (def.readOnly)
        return `Read-only: computed by the server${def.fromItem ? ' from the item row' : ''}; change its settings with \`PATCH /boards/{board_id}/columns/{column_id}\`.`;
      return put(value);
  }
};

const mcpLine = (def: AnyColumnTypeDef): string => {
  const create =
    def.type === 'name'
      ? ''
      : '`create_column` `{board_id, title, type, settings}` and `update_column` `{board_id, column_id, settings}` take the same JSON as the API above; ';
  if (def.readOnly) return `${create}cells are computed — nothing to write.`;
  if (ownWriter(def)) return `${create}\`update_item\` cannot write this cell (its own endpoints do — see API).`;
  return `${create}\`update_item\` \`{item_id, cells: {"<column_id>": <value>}}\` writes the value above${def.fromText ? ' or its plain text' : ''}.`;
};

// ---------------------------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------------------------

const sections = columnTypes.all().map(renderType);

const head: string[] = [];
head.push('# Column types — generated catalog');
head.push('');
head.push(
  'Every column type Bines OS knows, read from the registry the API, worker, web app, MCP tools and importers all run (`packages/shared/src/columns`). Settings and values are the exact zod schemas; filters, sort, summaries, automations and import hooks are what each type declares.',
);
head.push('');
head.push(
  '<!-- generated by scripts/gen-column-catalog.ts — do not edit. Regenerate: pnpm docs:columns · CI: pnpm docs:check -->',
);
head.push('');
head.push(
  '_Generated by `scripts/gen-column-catalog.ts` — do not edit by hand._ The hand-written spec (Hebrew) is [03-COLUMN-TYPES.md](03-COLUMN-TYPES.md).',
);
head.push('');
head.push('## Contents');
head.push('');
head.push('| # | Type | Name | Hebrew | Family | Storage |');
head.push('| --- | --- | --- | --- | --- | --- |');
// Each section is preceded by `<a id="<type>">`, so the links hold in every Markdown renderer.
sections.forEach((s, i) =>
  head.push(
    `| ${i + 1} | [${code(s.key)}](#${anchor(s.key)}) | ${s.nameEn} | ${s.nameHe} | ${s.family} | ${code(s.storage)} |`,
  ),
);
head.push('');
head.push('## Legend');
head.push('');
head.push(
  '- **Storage** — `cell`: a row in `cells`; `item`: on the item row itself; `computed`: produced on read or by the worker. **Engine**: the value comes from its own endpoints or an engine rather than a plain cell write.',
);
head.push(
  '- **Settings** — `columns.settings`, from the type’s zod `settingsSchema` (JSON Schema, input side). *Default* is what a new column gets (`defaultSettings`, else the schema default); *Required* means the key must be sent when settings are sent. *Notes* are the field’s source comment.',
);
head.push(
  '- **Value** — `cells.value` (`PUT /items/{id}/cells/{column}` body `{"value": …}`), from `valueSchema`; the example is generated and validated against the schema. *Derived columns* are the denormalised text / number / date the server keeps for search, sort and summaries.',
);
head.push(
  '- **Filters** — the operators views, dashboards, `items/query` and automation conditions accept; the *model* is how the query engine reads the value.',
);
head.push(
  '- **Automations** — triggers whose `column` may be this type; `column_changed` / `subitem_column_changed` hear any non-computed column; actions whose `column` may be this type (generic cell actions need a writable `cell` column).',
);
head.push(
  '- **API / MCP** — REST paths are under `/api/v1`; the MCP tools `create_column`, `update_column`, `update_item` take the same JSON.',
);
head.push('');

const body = sections.map((s) => `<a id="${anchor(s.key)}"></a>\n\n${s.md}`).join('\n');
const doc = `${head.join('\n')}\n${body}`;

const formatted = await format(doc, { ...(await resolveConfig(out)), filepath: out, parser: 'markdown' });

if (warnings.length) {
  console.warn(`gen-column-catalog: ${warnings.length} note(s) — things a type lacks in code:`);
  for (const w of warnings) console.warn(`  - ${w}`);
}

if (check) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // missing: differs
  }
  if (current !== formatted) {
    console.error(
      `docs/COLUMN-TYPES.generated.md is out of date (or missing). Run: pnpm docs:columns — and commit the result.`,
    );
    process.exit(1);
  }
  console.warn('docs/COLUMN-TYPES.generated.md is up to date.');
} else {
  writeFileSync(out, formatted);
  console.warn(`wrote ${out} (${sections.length} column types)`);
}
