// SPDX-License-Identifier: AGPL-3.0-only
import { exampleFor, exampleId, textExample, type JsonSchema } from './examples';
import { guideMarkdown, TAGS, type GuideContext } from './guide';
import { DESCRIPTIONS } from './descriptions';
import { publicScope } from './public-ops';

/**
 * The public API reference document: the OpenAPI document the routes generate (the single source of truth),
 * narrowed to what an API token may call, with the guide, the resource navigation, a description, the required
 * scope and examples on every operation. Built once per process from `api.getOpenAPI31Document`.
 */

type Media = { schema?: JsonSchema; example?: unknown; examples?: unknown };
export type Operation = {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  parameters?: { name: string; in: string; schema?: JsonSchema; example?: unknown; description?: string }[];
  requestBody?: { content?: Record<string, Media> };
  responses?: Record<string, { description?: string; content?: Record<string, Media> }>;
  security?: unknown[];
  [k: string]: unknown;
};
export type OpenApiDoc = {
  openapi: string;
  info: Record<string, unknown>;
  servers?: { url: string; description?: string }[];
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, JsonSchema>; securitySchemes?: Record<string, unknown> };
  tags?: { name: string; description?: string; 'x-displayName'?: string }[];
  security?: unknown[];
  [k: string]: unknown;
};

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** `GET /items/{id}` — the key of `DESCRIPTIONS`. */
export const opKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

const scopeLine = (scope: string | null) =>
  scope === 'none'
    ? '**Authentication:** none — no API token.'
    : scope === null
      ? '**Scope:** any valid API token.'
      : `**Scope:** \`${scope}\``;

/** A readable operation id for the URL fragment and code generators: `get_items_id_updates`. */
export const operationIdOf = (method: string, path: string) =>
  `${method}_${path
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')}`;

const isSuccess = (status: string) => /^2\d\d$/.test(status);

export const addExamples = (op: Operation, schemas: Record<string, JsonSchema>) => {
  for (const [type, media] of Object.entries(op.requestBody?.content ?? {})) {
    if (media.example !== undefined || media.examples !== undefined) continue;
    if (type === 'application/json') media.example = exampleFor(media.schema, schemas);
  }
  for (const [status, res] of Object.entries(op.responses ?? {})) {
    if (!isSuccess(status)) continue;
    for (const [type, media] of Object.entries(res.content ?? {})) {
      if (media.example !== undefined || media.examples !== undefined) continue;
      const ex = type === 'application/json' ? exampleFor(media.schema, schemas) : textExample(type);
      if (ex !== undefined) media.example = ex;
    }
  }
  for (const p of op.parameters ?? []) {
    if (p.example !== undefined || p.in !== 'path') continue;
    p.example = p.name === 'columnId' ? 'status' : p.name === 'groupId' ? 'topics' : exampleId(p.name);
  }
};

/**
 * The routes' and schemas' texts cite internal design docs ("(D12)", "(06 §1.2)", "(13-FILTERS §1)", "(perf
 * review §7.1)") — useful in the code, noise for an integrator. Dropped from the public reference.
 */
const REF = String.raw`(?:D\d{1,2}|\d{2}(?:-[A-Z][A-Z-]*)?\s?§\s?[\d.]*\d|\d{2}-[A-Z][A-Z-]+|M\d+(?:\.\d+)?|S-\d+|[a-z]+ review(?: [A-Z]-?\d+| §[\d.]*\d)|round \d+|r\d+|fix ?\d+|ת\d+|מ\d+|ד\d+)`;
const REF_PAREN = new RegExp(String.raw`\s*\((?:[^()]*?[\s(,;]|)${REF}(?:[\s,;)][^()]*)?\)`, 'g');
const REF_BARE = new RegExp(String.raw`(?:\s*[—–-]\s*|\s+)(?:see\s+)?${REF}(?=[\s.,;:]|$)`, 'g');

export const scrubRefs = (text: string): string =>
  text
    .replace(REF_PAREN, '')
    .replace(REF_BARE, '')
    .replace(/\s+([,;:])/g, '$1')
    .replace(/\s+\.(?=\s|$)/g, '.')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const scrubTree = (v: unknown): void => {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) return v.forEach(scrubTree);
  const o = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) {
    if ((k === 'description' || k === 'summary') && typeof x === 'string') o[k] = scrubRefs(x);
    else scrubTree(x);
  }
};

/** Only the schemas the public operations use (internal ones would otherwise show under "Models"). */
const reachableSchemas = (paths: OpenApiDoc['paths'], all: Record<string, JsonSchema>) => {
  const seen = new Set<string>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string' && x.startsWith('#/components/schemas/')) {
        const name = x.slice('#/components/schemas/'.length);
        if (!seen.has(name)) {
          seen.add(name);
          walk(all[name]);
        }
      } else walk(x);
    }
  };
  walk(paths);
  return Object.fromEntries(Object.entries(all).filter(([name]) => seen.has(name)));
};

export type BuildOptions = GuideContext;

export const buildPublicSpec = (full: OpenApiDoc, ctx: BuildOptions): OpenApiDoc => {
  const doc = structuredClone(full);
  const schemas = doc.components?.schemas ?? {};
  const paths: OpenApiDoc['paths'] = {};
  const usedTags = new Set<string>();

  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = ops[method];
      if (!op) continue;
      const scope = publicScope(method, path);
      if (scope === false) continue;
      const words = DESCRIPTIONS[opKey(method, path)];
      if (words?.[0]) op.summary = words[0];
      const text = op.description?.trim() || words?.[1]?.trim() || '';
      op.description = text ? `${text}\n\n${scopeLine(scope)}` : scopeLine(scope);
      op.operationId ??= operationIdOf(method, path);
      op['x-required-scope'] = scope;
      if (scope === 'none') op.security = [];
      addExamples(op, schemas);
      for (const t of op.tags ?? []) usedTags.add(t);
      (paths[path] ??= {})[method] = op;
    }
  }
  doc.paths = paths;
  if (doc.components?.schemas) doc.components.schemas = reachableSchemas(paths, doc.components.schemas);
  scrubTree(doc.paths);
  scrubTree(doc.components?.schemas);

  // Navigation: the resource groups, in order; any tag not listed still shows (under "More").
  const known = new Set(TAGS.flatMap((g) => g.tags.map((t) => t.name)));
  doc.tags = TAGS.flatMap((g) =>
    g.tags
      .filter((t) => usedTags.has(t.name))
      .map((t) => ({ name: t.name, 'x-displayName': t.title, description: t.description })),
  );
  const extra = [...usedTags].filter((t) => !known.has(t)).sort();
  doc.tags.push(...extra.map((name) => ({ name })));
  doc['x-tagGroups'] = [
    ...TAGS.map((g) => ({ name: g.group, tags: g.tags.map((t) => t.name).filter((t) => usedTags.has(t)) })).filter(
      (g) => g.tags.length,
    ),
    ...(extra.length ? [{ name: 'More', tags: extra }] : []),
  ];

  doc.info = {
    title: `${ctx.productName} API`,
    version: String(full.info.version ?? 'v1'),
    description: guideMarkdown(ctx),
  };
  doc.servers = [{ url: ctx.apiBase, description: ctx.productName }];
  doc.security = [{ apiToken: [] }];
  const schemes = (doc.components ??= {}).securitySchemes ?? {};
  doc.components.securitySchemes = {
    ...schemes,
    apiToken: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'API token',
      description: `An API token from ${ctx.productName}: profile menu → API tokens. See Authentication.`,
    },
  };
  return doc;
};

/** Public operations of a built document, for tests and the docs check. */
export const operationsOf = (doc: OpenApiDoc) =>
  Object.entries(doc.paths).flatMap(([path, ops]) =>
    METHODS.filter((m) => ops[m]).map((m) => ({ method: m, path, op: ops[m]! })),
  );
