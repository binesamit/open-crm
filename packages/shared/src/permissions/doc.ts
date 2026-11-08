// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole } from './account';
import type { BoardKind } from './board';

/**
 * Doc permissions (M8 ד1, D25: "like a board"). A doc in a workspace is `main` (every member of the workspace
 * sees it), `private` (only the people / teams invited) or `shareable` (invited, guests too — D23). An invitation
 * carries a level: owner / editor / commenter / viewer. Pure, like `canBoard`: the API loads the context once and
 * asks `canDoc`. Strictest rule wins: account viewers only read, guests never manage.
 */
export const DOC_LEVELS = ['owner', 'editor', 'commenter', 'viewer'] as const;
export type DocLevel = (typeof DOC_LEVELS)[number];

export const DOC_ACTIONS = ['doc.read', 'doc.comment', 'doc.edit', 'doc.manage'] as const;
export type DocAction = (typeof DOC_ACTIONS)[number];

export type DocPermissionContext = {
  accountRole: AccountRole;
  /** The doc's workspace is visible to the actor (open, or a member of a closed one). */
  workspaceVisible: boolean;
  doc: { kind: BoardKind };
  /** The highest level the actor holds on the doc (personally or through a team); null = not invited. */
  level: DocLevel | null;
};

export type DocDecision = { ok: true; via: string } | { ok: false; reason: string; as404?: boolean };

const allow = (via: string): DocDecision => ({ ok: true, via });
const deny = (reason: string, as404 = false): DocDecision => ({ ok: false, reason, as404 });

/** What each level may do (most to least). */
const LEVEL_ACTIONS: Record<DocLevel, DocAction[]> = {
  owner: ['doc.read', 'doc.comment', 'doc.edit', 'doc.manage'],
  editor: ['doc.read', 'doc.comment', 'doc.edit'],
  commenter: ['doc.read', 'doc.comment'],
  viewer: ['doc.read'],
};

/** The more generous of two levels (a person in two teams gets the better one). */
export const higherDocLevel = (a: DocLevel | null, b: DocLevel | null): DocLevel | null =>
  a === null ? b : b === null ? a : DOC_LEVELS.indexOf(a) <= DOC_LEVELS.indexOf(b) ? a : b;

/** Whether the actor can see the doc at all — what is not seen is a 404. */
export const canAccessDoc = (ctx: DocPermissionContext): boolean => {
  if (ctx.accountRole === 'admin') return true;
  if (!ctx.workspaceVisible) return false;
  if (ctx.level) return ctx.accountRole !== 'guest' || ctx.doc.kind === 'shareable';
  if (ctx.accountRole === 'guest') return false;
  return ctx.doc.kind === 'main';
};

/**
 * The level that applies: an invitation's, else a main doc gives every member of the workspace an editor (like a
 * main board's default "edit everything") and every account viewer a viewer. Admins manage every doc.
 */
export const effectiveDocLevel = (ctx: DocPermissionContext): DocLevel | null => {
  if (!canAccessDoc(ctx)) return null;
  if (ctx.accountRole === 'admin') return 'owner';
  // Strictest wins: account viewers read only, guests never own (they may edit / comment when invited so).
  if (ctx.accountRole === 'viewer') return 'viewer';
  const level = ctx.level ?? (ctx.doc.kind === 'main' ? 'editor' : null);
  if (ctx.accountRole === 'guest' && level === 'owner') return 'editor';
  return level;
};

export const canDoc = (ctx: DocPermissionContext, action: DocAction): DocDecision => {
  const level = effectiveDocLevel(ctx);
  if (!level) return deny('doc_access', true);
  return LEVEL_ACTIONS[level].includes(action) ? allow(level) : deny('doc_level');
};

/** Map of every action → allowed, for the UI (`capabilities` in GET /docs/:id). */
export const docCapabilities = (ctx: DocPermissionContext): Record<DocAction, boolean> =>
  Object.fromEntries(DOC_ACTIONS.map((a) => [a, canDoc(ctx, a).ok])) as Record<DocAction, boolean>;
