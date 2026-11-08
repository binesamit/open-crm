// SPDX-License-Identifier: AGPL-3.0-only
import type { PlanFeatureKey } from '@bines/shared';
import type { Db } from '../../db/client';
import { assertFeature } from './entitlements';

/**
 * Plan feature gates on the REST routes (plans): the creating / editing / using requests of each
 * gated feature, checked in `requireAccount` for every caller (a session, a token, an extension). Reads, and
 * DELETEs (cleaning up after a downgrade), always pass — nothing that exists is hidden or locked away; a dashboard
 * or doc made before a downgrade stays readable. Gates that depend on the body or happen outside a route live at
 * their own points (`assertFeature`): AI column type, automation actions, form views, guest invitations, token /
 * MCP use, OAuth app approval, the AI model call, agent runs, the docs editor's write access, public forms.
 */
type Gate = { feature: PlanFeatureKey; path: RegExp; except?: RegExp };

const ID = '[^/]+';
export const ROUTE_FEATURE_GATES: readonly Gate[] = [
  // ai: the assistant, agents (cancel / undo of a run stay open — they stop or revert), AI column runs.
  { feature: 'ai', path: /^\/ai\/assistant\// },
  { feature: 'ai', path: new RegExp(`^/boards/${ID}/ai-columns/${ID}/run$`) },
  { feature: 'ai', path: /^\/agents(\/|$)/, except: new RegExp(`^/agents/runs/${ID}/(cancel|undo)$`) },
  // api: making / changing API and service tokens (their use: tokenAuth, mcp.auth; approving an OAuth app is a
  // session route without an account header — oauth.service `mcpRefusal`).
  { feature: 'api', path: /^\/auth\/(tokens|service-tokens)(\/|$)/ },
  // extensions: installing (and taking a new version's permissions); installed ones keep running.
  { feature: 'extensions', path: new RegExp(`^/extensions/(preview|install|installations/${ID}/approve-update)$`) },
  // flows: external automation platforms — connections, flows, drafts, retries.
  { feature: 'flows', path: /^\/flow-connections(\/|$)/ },
  // dashboards: creating and editing (widget data stays a read).
  {
    feature: 'dashboards',
    path: new RegExp(`^/(workspaces/${ID}/dashboards|dashboards/${ID}(/.*)?|dashboard-widgets/${ID}(/.*)?)$`),
    except: new RegExp(`^/dashboards/${ID}/widgets/${ID}/data$`),
  },
  // docs: creating, editing, versions, sharing, a doc in a cell (comments and the editor's token: see docs).
  {
    feature: 'docs',
    path: new RegExp(
      `^/(workspaces/${ID}/docs|docs/${ID}(/(duplicate|members|invite|versions(/.*)?))?|items/${ID}/cells/${ID}/doc)$`,
    ),
  },
  // forms: editing a form and its link (a new form view: views.service; submissions: forms.public).
  { feature: 'forms', path: new RegExp(`^/views/${ID}/form(/token)?$`) },
];

const WRITE = new Set(['POST', 'PUT', 'PATCH']);

/** The feature a request needs (null = none). `path` without `/api/v1`. */
export const routeFeature = (method: string, path: string): PlanFeatureKey | null => {
  if (!WRITE.has(method)) return null;
  for (const g of ROUTE_FEATURE_GATES) if (g.path.test(path) && !g.except?.test(path)) return g.feature;
  return null;
};

/** requireAccount: 402 `plan_feature_unavailable` when the account's plan lacks the request's feature. */
export const assertRouteFeature = async (db: Db, accountId: string, method: string, path: string) => {
  const feature = routeFeature(method, path);
  if (feature) await assertFeature(db, accountId, feature);
};
