// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * P1-03 — a button that creates a linked item: the click's popup asks for columns of another board
 * saving creates an item there, linked to the clicked one, with values copied from it and fixed values — or fills
 * in the linked item its `reuse` rule finds (no duplicates). One batch, one undo.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let ws: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

// Status labels: 0 Working on it, 1 Done, 2 Stuck (the defaults) — read from the column itself.
const setup = async (n: string) => {
  const leads = (await body(await as(admin).post('/boards', { name: `Leads ${n}`, workspace_id: ws }))).id as string;
  const jobs = (await body(await as(admin).post('/boards', { name: `Jobs ${n}`, workspace_id: ws }))).id as string;
  const col = async (boardId: string, c: Json) => {
    const res = await as(admin).post(`/boards/${boardId}/columns`, c);
    expect(res.status).toBe(201);
    return body(res);
  };
  await col(leads, { id: 'address', title: 'Address', type: 'text' });
  await col(leads, { id: 'jobs', title: 'Jobs', type: 'board_relation', settings: { board_ids: [jobs] } });
  const status = await col(jobs, { id: 'job_status', title: 'Job status', type: 'status' });
  await col(jobs, { id: 'address', title: 'Address', type: 'text' });
  await col(jobs, { id: 'job_date', title: 'Date', type: 'date' });
  await col(jobs, { id: 'lead', title: 'Lead', type: 'board_relation', settings: { board_ids: [leads] } });
  const labels = (status.settings as { labels: { id: number; label: string }[] }).labels;
  return { leads, jobs, labels };
};
const button = async (boardId: string, action: Json) =>
  (
    await as(admin).post(`/boards/${boardId}/columns`, {
      id: 'schedule',
      title: 'Schedule',
      type: 'button',
      settings: { action },
    })
  ).status;
const jobsOf = async (jobs: string) => (await body(await as(admin).get(`/boards/${jobs}/items`))).data as Json[];

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(() => t.close());

describe('button: create a linked item (P1-03)', () => {
  it('creates the item on the other board, copies, fixes, links, and opens the open one again', async () => {
    const { leads, jobs, labels } = await setup('1');
    const draft = labels[0]!;
    expect(
      await button(leads, {
        kind: 'create_linked',
        board_id: jobs,
        link: { on: 'source', column_id: 'jobs' },
        copy: [{ from: 'address', to: 'address' }],
        fixed: [{ column_id: 'job_status', text: draft.label }],
        popup: { fields: [{ column_id: 'job_date', required: true }] },
        reuse: { column_id: 'job_status', labels: [draft.id] },
      }),
    ).toBe(201);
    const lead = (
      await body(
        await as(admin).post(`/boards/${leads}/items`, { name: 'Michal', cells: { address: '12 Herzl, Rehovot' } }),
      )
    ).id as string;

    // Nothing linked yet: the popup opens on a new item, with the copied and fixed values already in it.
    expect(await body(await as(admin).get(`/items/${lead}/buttons/schedule/linked`))).toEqual({
      item_id: null,
      name: 'Michal',
      cells: {
        address: { value: '12 Herzl, Rehovot', text: '12 Herzl, Rehovot' },
        job_status: { value: { index: draft.id }, text: draft.label },
      },
    });

    // A required popup field missing: nothing is created.
    const missing = await as(admin).post(`/items/${lead}/buttons/schedule`, {});
    expect(missing.status).toBe(400);
    expect((await body(missing)).error.message).toBe('popup_required');
    expect(await jobsOf(jobs)).toHaveLength(0);

    const ok = await as(admin).post(`/items/${lead}/buttons/schedule`, { cells: { job_date: { date: '2026-11-06' } } });
    expect(ok.status).toBe(200);
    const res = await body(ok);
    expect(res.linked).toMatchObject({ board_id: jobs, name: 'Michal', created: true });
    const [job] = await jobsOf(jobs);
    expect(job!.id).toBe(res.linked.item_id);
    expect(job!.cells.address.value).toBe('12 Herzl, Rehovot');
    expect(job!.cells.job_status.value).toEqual({ index: draft.id });
    expect(job!.cells.job_date.value).toMatchObject({ date: '2026-11-06' });
    expect((await body(await as(admin).get(`/items/${lead}`))).cells.jobs.value.item_ids).toEqual([job!.id]);

    // A second click finds the draft: the popup fills it in, no second job.
    expect(await body(await as(admin).get(`/items/${lead}/buttons/schedule/linked`))).toMatchObject({
      item_id: job!.id,
    });
    const again = await as(admin).post(`/items/${lead}/buttons/schedule`, {
      target_item_id: job!.id,
      cells: { job_date: { date: '2026-11-07' } },
    });
    expect(again.status).toBe(200);
    expect((await body(again)).linked).toMatchObject({ item_id: job!.id, created: false });
    const jobsNow = await jobsOf(jobs);
    expect(jobsNow).toHaveLength(1);
    expect(jobsNow[0]!.cells.job_date.value).toMatchObject({ date: '2026-11-07' });

    // Only the item `reuse` points at may be filled in.
    const other = (await body(await as(admin).post(`/boards/${jobs}/items`, { name: 'Other' }))).id as string;
    const foreign = await as(admin).post(`/items/${lead}/buttons/schedule`, {
      target_item_id: other,
      cells: { job_date: { date: '2026-11-08' } },
    });
    expect(foreign.status).toBe(409);

    // Once the job is no longer a draft, the next click creates a new one.
    expect(
      (await as(admin).patch(`/items/${job!.id}`, { cells: { job_status: { index: labels[1]!.id } } })).status,
    ).toBe(200);
    expect(await body(await as(admin).get(`/items/${lead}/buttons/schedule/linked`))).toMatchObject({ item_id: null });
  });

  it('links from the other board, refuses columns the popup does not ask for, and undoes in one batch', async () => {
    const { leads, jobs } = await setup('2');
    expect(
      await button(leads, {
        kind: 'create_linked',
        board_id: jobs,
        link: { on: 'target', column_id: 'lead' },
        popup: { fields: [{ column_id: 'job_date' }] },
        reuse: { column_id: 'job_status', labels: [], empty: true },
      }),
    ).toBe(201);
    const lead = (await body(await as(admin).post(`/boards/${leads}/items`, { name: 'Yossi' }))).id as string;

    const foreign = await as(admin).post(`/items/${lead}/buttons/schedule`, { cells: { address: 'x' } });
    expect(foreign.status).toBe(422);

    const ok = await body(await as(admin).post(`/items/${lead}/buttons/schedule`, {}));
    const job = (await jobsOf(jobs))[0]!;
    expect(job.id).toBe(ok.linked.item_id);
    expect(job.cells.lead.value.item_ids).toEqual([lead]);
    // Its status is empty, and `reuse` takes empty ones: found through the job's own relation.
    expect(await body(await as(admin).get(`/items/${lead}/buttons/schedule/linked`))).toMatchObject({
      item_id: job.id,
    });

    // One Ctrl+Z removes the created job.
    expect((await as(admin).post(`/activity/batches/${ok.batch_id}/undo`, {})).status).toBe(200);
    expect(await jobsOf(jobs)).toHaveLength(0);
  });

  it('says what is missing when the button is not set up', async () => {
    const { leads } = await setup('3');
    expect(await button(leads, { kind: 'create_linked' })).toBe(201);
    const lead = (await body(await as(admin).post(`/boards/${leads}/items`, { name: 'Dana' }))).id as string;
    const res = await as(admin).post(`/items/${lead}/buttons/schedule`, {});
    expect(res.status).toBe(400);
    expect((await body(res)).error.message).toBe('create_linked_not_set');
  });
});
