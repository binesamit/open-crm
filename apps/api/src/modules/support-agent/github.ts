// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, SUPPORT_AGENT_BRANCH_PREFIX } from '@bines/shared';
import type { Db } from '../../db/client';
import { outboundRequest } from '../../lib/outbound';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';

/**
 * The support agent's GitHub client: one repository, a fine-grained token the owner gave, the REST
 * API through the outbound guard (public address, no redirects, a size cap). Every call is written to the
 * platform's audit log — method, path, status, the run — never the token.
 *
 * Reading: code search, a file at a ref, recent commits. Writing is the "approve development" step, behind its own
 * token and `writeCall`'s guard (see below): only a branch under `agent/`, files on such a branch, and a DRAFT pull
 * request from it — never the base branch, never a force update, never a merge.
 */
const API = 'https://api.github.com';
const MAX_BYTES = 1024 * 1024;

type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; body: string }>;

const realFetch: Fetcher = (url, init) => outboundRequest(url, { ...init, timeoutMs: 20_000, maxBytes: MAX_BYTES });
let fetcher: Fetcher = realFetch;

/** Tests swap the network for a fake GitHub; `null` restores the real one. */
export const setGithubFetchForTests = (f: Fetcher | null) => {
  fetcher = f ?? realFetch;
};

export type GithubCtx = { db: Db; repo: string; token: string; runId: string; actorId: string | null };

const audit = (c: GithubCtx, method: string, path: string, status: number) =>
  insertPlatformAudit(c.db, {
    action: 'support_agent.github',
    targetType: 'github',
    targetId: c.repo.slice(0, 64),
    actorId: c.actorId,
    payload: { run_id: c.runId, method, path: path.slice(0, 300), status },
  });

const call = async (
  c: GithubCtx,
  method: string,
  path: string,
  accept = 'application/vnd.github+json',
  body?: Record<string, unknown>,
) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(c.repo)) throw new AppError('invalid_value', 'github_repo_invalid');
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${c.token}`,
        accept,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'bines-os-support-agent',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    await audit(c, method, path, 0);
    throw new AppError('unprocessable', 'github_unreachable', { cause: String(err).slice(0, 200) });
  }
  await audit(c, method, path, res.status);
  if (res.status === 401 || res.status === 403) throw new AppError('unprocessable', 'github_forbidden');
  if (res.status === 404) throw new AppError('not_found', 'github_not_found');
  if (!res.ok) throw new AppError('unprocessable', 'github_failed', { status: res.status });
  return res.body;
};

const enc = (p: string) =>
  p
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');

/** Code search in the repository (GitHub searches its default branch). */
export const searchCode = async (c: GithubCtx, query: string, path?: string) => {
  const q = [query.replace(/\s+/g, ' ').trim(), `repo:${c.repo}`, path ? `path:${path}` : null]
    .filter(Boolean)
    .join(' ');
  const json = JSON.parse(await call(c, 'GET', `/search/code?per_page=20&q=${encodeURIComponent(q)}`)) as {
    total_count: number;
    items: { path: string; name: string }[];
  };
  return { total: json.total_count, files: json.items.map((i) => i.path) };
};

/** A file's text at a ref (a commit sha or a branch), with line numbers, from `start` to `end` (at most 400 lines). */
export const readFile = async (c: GithubCtx, path: string, ref: string | null, start = 1, end?: number) => {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const text = await call(c, 'GET', `/repos/${c.repo}/contents/${enc(path)}${q}`, 'application/vnd.github.raw+json');
  const lines = text.split('\n');
  const from = Math.max(1, start);
  const to = Math.min(lines.length, end ?? from + 199, from + 399);
  return {
    path,
    ref,
    total_lines: lines.length,
    from,
    to,
    text: lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}\t${l}`)
      .join('\n'),
  };
};

/** The latest commits (optionally touching one path) up to a ref. */
export const listCommits = async (c: GithubCtx, ref: string | null, path?: string, limit = 10) => {
  const qs = new URLSearchParams({ per_page: String(Math.min(30, limit)) });
  if (ref) qs.set('sha', ref);
  if (path) qs.set('path', path);
  const json = JSON.parse(await call(c, 'GET', `/repos/${c.repo}/commits?${qs.toString()}`)) as {
    sha: string;
    commit: { message: string; author: { date: string } | null };
  }[];
  return json.map((x) => ({
    sha: x.sha.slice(0, 12),
    date: x.commit.author?.date ?? null,
    message: x.commit.message.split('\n')[0]!.slice(0, 200),
  }));
};

// ---- writing (the "approve development" step) ----

/** A branch the agent may create / write: `agent/…`, simple characters, never the base branch. */
export const assertAgentBranch = (branch: string, base: string) => {
  if (
    !branch.startsWith(SUPPORT_AGENT_BRANCH_PREFIX) ||
    !/^agent\/[a-z0-9][a-z0-9._-]{0,80}$/.test(branch) ||
    branch.includes('..') ||
    branch === base
  )
    throw new AppError('forbidden', 'github_branch_not_allowed');
};

/** Paths the agent never writes: CI (it could leak secrets), secrets and keys, local tooling. */
const BLOCKED_PATH = /(^|\/)\.github\/|(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx)$|(^|\/)\.claude\/|(^|\/)\.git\//i;
export const assertWritablePath = (path: string) => {
  if (!path || path.startsWith('/') || path.includes('..') || BLOCKED_PATH.test(path))
    throw new AppError('forbidden', 'github_path_not_allowed');
};

export type GithubWriteCtx = GithubCtx & {
  /** The branch pull requests go to (and that is never written). */
  base: string;
  /** The kill switch, read before every write: off = refused. */
  assertOn: () => Promise<void>;
};

/**
 * The only way to write. An allowlist of three endpoints, each body checked: create `refs/heads/agent/…` (POST —
 * GitHub's create never moves an existing ref, so no force), put a file on an `agent/…` branch, open a DRAFT pull
 * request from an `agent/…` branch to the base. Anything else — a PATCH of a ref, a merge, another repository — is
 * refused before it leaves.
 */
const writeCall = async (c: GithubWriteCtx, method: 'POST' | 'PUT', path: string, body: Record<string, unknown>) => {
  await c.assertOn();
  const repo = `/repos/${c.repo}`;
  if (method === 'POST' && path === `${repo}/git/refs`) {
    const ref = String(body.ref ?? '');
    if (!ref.startsWith('refs/heads/')) throw new AppError('forbidden', 'github_write_not_allowed');
    assertAgentBranch(ref.slice('refs/heads/'.length), c.base);
    if ('force' in body) throw new AppError('forbidden', 'github_write_not_allowed');
  } else if (method === 'PUT' && path.startsWith(`${repo}/contents/`)) {
    assertAgentBranch(String(body.branch ?? ''), c.base);
  } else if (method === 'POST' && path === `${repo}/pulls`) {
    if (body.draft !== true || body.base !== c.base) throw new AppError('forbidden', 'github_write_not_allowed');
    assertAgentBranch(String(body.head ?? ''), c.base);
  } else throw new AppError('forbidden', 'github_write_not_allowed');
  return call(c, method, path, 'application/vnd.github+json', body);
};

/** The sha a branch points at. */
export const branchSha = async (c: GithubCtx, branch: string) =>
  (JSON.parse(await call(c, 'GET', `/repos/${c.repo}/git/ref/heads/${enc(branch)}`)) as { object: { sha: string } })
    .object.sha;

/** Creates `agent/…` at `sha` (refused for any other name). */
export const createAgentBranch = (c: GithubWriteCtx, branch: string, sha: string) =>
  writeCall(c, 'POST', `/repos/${c.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });

/** A file's text and blob sha on a branch (null = not there yet). */
export const fileOnBranch = async (c: GithubCtx, path: string, branch: string) => {
  try {
    const json = JSON.parse(
      await call(c, 'GET', `/repos/${c.repo}/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`),
    ) as { sha: string; content?: string; encoding?: string };
    const text = json.encoding === 'base64' && json.content ? Buffer.from(json.content, 'base64').toString('utf8') : '';
    return { sha: json.sha, text };
  } catch (err) {
    if (err instanceof AppError && err.message === 'github_not_found') return null;
    throw err;
  }
};

/** Writes a whole file on an `agent/…` branch (a commit). */
export const putAgentFile = async (
  c: GithubWriteCtx,
  branch: string,
  path: string,
  text: string,
  message: string,
  sha: string | null,
) => {
  assertWritablePath(path);
  return writeCall(c, 'PUT', `/repos/${c.repo}/contents/${enc(path)}`, {
    message: message.slice(0, 200),
    content: Buffer.from(text, 'utf8').toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
};

/** Opens a DRAFT pull request from `agent/…` to the base. */
export const openDraftPr = async (c: GithubWriteCtx, branch: string, title: string, body: string) =>
  JSON.parse(
    await writeCall(c, 'POST', `/repos/${c.repo}/pulls`, {
      title: title.slice(0, 200),
      body: body.slice(0, 60_000),
      head: branch,
      base: c.base,
      draft: true,
    }),
  ) as { html_url: string; number: number };
