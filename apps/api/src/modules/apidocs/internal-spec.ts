// SPDX-License-Identifier: AGPL-3.0-only
import { requiredScope } from '../../lib/scopes';
import { addExamples, METHODS, operationIdOf, opKey, type OpenApiDoc, type Operation } from './spec';
import { DESCRIPTIONS } from './descriptions';
import { NO_TOKEN, publicScope } from './public-ops';
import { TAGS, type GuideContext } from './guide';
import { internalGuideMarkdown } from './internal-guide';

/**
 * The internal API reference: every operation the routes generate — internal ones too — for the
 * platform owner at `/api/docs/internal`. Same renderer and look as the public reference; each operation is
 * labelled Public / Internal and says who may call it. Built from `api.getOpenAPI31Document`, never served to anyone
 * but the platform owner (apidocs.routes.ts).
 */
export { INTERNAL_DOCS_PATH, INTERNAL_SPEC_PATH } from './internal-docs-path';

export type Access = {
  kind: 'owner' | 'support-console' | 'session' | 'account' | 'token' | 'none' | 'extension' | 'signed';
  text: string;
};

/** Routes the web app calls before sign-in (no `requireUser`). */
const SIGN_IN_SCREENS = [/^\/auth\/(config|forgot-password|recovery)(\/|$)/, /^\/invitations\/preview$/];

const ADMIN = /^Admins?:|\((?:account )?admins?(?: only)?\)|\badmins only\b/i;

/** Who may call an operation, from the same rules the middleware and `lib/scopes.ts` apply. */
export const accessOf = (method: string, path: string, op: Operation): Access => {
  const scoped = (op.parameters ?? []).some((p) => p.in === 'header' && p.name.toLowerCase() === 'x-account-id');
  const admin = ADMIN.test(`${op.summary ?? ''} ${op.description ?? ''}`) ? ' Account admins only.' : '';
  if (path.startsWith('/platform/support/'))
    return {
      kind: 'support-console',
      text: 'Support console: the platform owner or active support staff (agent / lead), by session; 404 to anyone else. Some actions are for leads or the owner only.',
    };
  if (path === '/platform' || path.startsWith('/platform/'))
    return { kind: 'owner', text: 'Platform owner only, by session; 404 to anyone else. API tokens are refused.' };
  if (path.startsWith('/ext/'))
    return {
      kind: 'extension',
      text: "An extension's short-lived token (frame) or its server token — not an API token.",
    };
  if (path.startsWith('/automations/triggers/'))
    return { kind: 'signed', text: "An extension server's signed call (the installation's signing secret)." };
  if (path.startsWith('/billing/webhook/'))
    return { kind: 'signed', text: "The billing provider's signed call (no session, no token)." };
  if (SIGN_IN_SCREENS.some((re) => re.test(path)))
    return {
      kind: 'none',
      text: 'No authentication: the sign-in and invitation screens call it before anyone is signed in.',
    };
  if (NO_TOKEN.some((re) => re.test(path)) || /^\/public\//.test(path))
    return { kind: 'none', text: 'No authentication.' };
  const need = requiredScope(method.toUpperCase(), path.replace(/\{[^}]+\}/g, 'x'));
  const account = scoped ? ' In an account: `X-Account-Id` (a token is bound to its account).' : '';
  if ('forbidden' in need)
    return {
      kind: 'session',
      text: `Signed-in person only (session cookie); API tokens are refused.${scoped ? ' In an account: `X-Account-Id`.' : ''}${admin}`,
    };
  const scope = need.scope === 'any' ? 'any valid API token' : `API token scope \`${need.scope}\``;
  return {
    kind: scoped ? 'account' : 'token',
    text: `Session, or ${scope}.${account}${admin}`,
  };
};

/** The owner console is one tag of ~100 operations: split by area (`platform · accounts`, `platform · support` …). */
const tagOf = (path: string, tags: string[] | undefined): string[] => {
  const m = /^\/platform\/([^/{]+)/.exec(path);
  if (m) return [`platform · ${m[1]}`];
  return tags?.length ? tags : ['other'];
};

const PUBLIC_BADGE = { name: 'Public', position: 'before', color: '#1f7a4d' };
const INTERNAL_BADGE = { name: 'Internal', position: 'before', color: '#b5541c' };

export const buildInternalSpec = (full: OpenApiDoc, ctx: GuideContext): OpenApiDoc => {
  const doc = structuredClone(full);
  const schemas = doc.components?.schemas ?? {};
  const usedTags = new Set<string>();
  let total = 0;
  let internal = 0;

  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = ops[method];
      if (!op) continue;
      total++;
      const isPublic = publicScope(method, path) !== false;
      if (!isPublic) internal++;
      const access = accessOf(method, path, op);
      // The route's own summary stays the title (the public wording is its own voice); the public description is
      // used when the route has none.
      const words = DESCRIPTIONS[opKey(method, path)];
      if (!op.summary?.trim() && words?.[0]) op.summary = words[0];
      const text = op.description?.trim() || (isPublic ? words?.[1]?.trim() : '') || '';
      const head = `**${isPublic ? 'Public' : 'Internal'}** · \`${method.toUpperCase()} /api/v1${path}\``;
      op.description = [head, text, `**Access:** ${access.text}`].filter(Boolean).join('\n\n');
      op.operationId ??= operationIdOf(method, path);
      op['x-visibility'] = isPublic ? 'public' : 'internal';
      op['x-access'] = access.kind;
      op['x-badges'] = [isPublic ? PUBLIC_BADGE : INTERNAL_BADGE];
      op.tags = tagOf(path, op.tags);
      op.security =
        access.kind === 'none' || access.kind === 'extension' || access.kind === 'signed'
          ? []
          : access.kind === 'owner' || access.kind === 'support-console' || access.kind === 'session'
            ? [{ session: [] }]
            : [{ session: [] }, { apiToken: [] }];
      addExamples(op, schemas);
      for (const t of op.tags) usedTags.add(t);
    }
  }

  // Navigation: the public resource groups first, then the owner console areas, then every other internal module.
  const known = new Map(TAGS.flatMap((g) => g.tags.map((t) => [t.name, t] as const)));
  const platformTags = [...usedTags].filter((t) => t.startsWith('platform · ')).sort();
  const groups = [
    ...TAGS.map((g) => ({ name: g.group, tags: g.tags.map((t) => t.name).filter((t) => usedTags.has(t)) })),
    { name: 'Owner console (internal)', tags: platformTags },
    {
      name: 'Other modules',
      tags: [...usedTags].filter((t) => !known.has(t) && !t.startsWith('platform · ')).sort(),
    },
  ].filter((g) => g.tags.length);
  doc.tags = groups.flatMap((g) =>
    g.tags.map((name) => {
      const k = known.get(name);
      return k ? { name, 'x-displayName': k.title, description: k.description } : { name };
    }),
  );
  doc['x-tagGroups'] = groups;

  doc.info = {
    title: `${ctx.productName} internal API — subject to change`,
    version: String(full.info.version ?? 'v1'),
    description: internalGuideMarkdown(ctx, { total, internal }),
  };
  doc.servers = [{ url: ctx.apiBase, description: ctx.productName }];
  doc.security = [{ session: [] }, { apiToken: [] }];
  const comps = (doc.components ??= {});
  comps.securitySchemes = {
    ...(comps.securitySchemes ?? {}),
    session: {
      type: 'apiKey',
      in: 'cookie',
      name: 'bos.session_token',
      description: 'The web app session (Better Auth). Sent by the browser; see "Sign-in (Better Auth)".',
    },
    apiToken: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'API token',
      description: 'A personal or service API token — only on public operations and token-allowed routes.',
    },
  };
  return doc;
};
