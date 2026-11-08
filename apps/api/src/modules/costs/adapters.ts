// SPDX-License-Identifier: AGPL-3.0-only
import { and, gte, isNull, lte, sql } from 'drizzle-orm';
import { AppError, COST_ADAPTER_DEFS, type CostAdapter, type CostUnit } from '@bines/shared';
import type { Db } from '../../db/client';
import { aiConnections, aiUsage, assets, usageMeter } from '../../db/schema';
import { addDays, dayRange, daysInMonth, numberFrom, valueAtPath } from './costs.math';
import { METER, meterDay, setMeter } from './meter';

/**
 * Cost source adapters: each reads one kind of source for a range of days and returns quantities
 * (priced later from the owner's price table) or money (`amount`). An adapter knows a provider's API and nothing
 * about the installation — which project, account or bucket, and the key, come from the source's settings.
 */
export type CostRecord = {
  day: string;
  metric: string;
  service: string;
  accountRef?: string;
  quantity: number;
  unit: CostUnit;
  /** Money the source reported (direct metrics). */
  amount?: number;
  currency?: string;
};

export type CostRequest = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; body: string }>;

export type AdapterContext = {
  db: Db;
  config: Record<string, unknown>;
  secret: string | null;
  from: string;
  to: string;
  today: string;
  request: CostRequest;
};

type Collect = (ctx: AdapterContext) => Promise<CostRecord[]>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const need = (ctx: AdapterContext, key: string) => {
  const v = str(ctx.config[key]);
  if (!v) throw new AppError('invalid_value', 'cost_source_missing_field', { field: key });
  return v;
};
const needSecret = (ctx: AdapterContext) => {
  if (!ctx.secret) throw new AppError('invalid_value', 'cost_source_missing_key');
  return ctx.secret;
};

/** A provider's answer as JSON, or an error that says what the provider said (never the key). */
const callJson = async (ctx: AdapterContext, url: string, init: Parameters<CostRequest>[1]) => {
  const res = await ctx.request(url, init);
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    // not JSON — reported below
  }
  if (!res.ok || body === null)
    throw new AppError('unavailable', 'cost_source_http', { status: res.status, body: res.body.slice(0, 200) });
  return body;
};

const graphqlErrors = (body: unknown) => {
  const errors = (body as { errors?: { message?: string }[] }).errors;
  if (errors?.length)
    throw new AppError('unavailable', 'cost_source_provider', {
      message: errors
        .map((e) => e.message ?? '')
        .join('; ')
        .slice(0, 300),
    });
};

// ---------------------------------------------------------------- internal

/**
 * What the platform measures itself: AI spend (ai_usage — on the platform's own key or an account's own, as two
 * services; `ai_scope` = `platform` keeps only the first), emails, SMS parts, web searches (usage_meter), stored
 * files (today's bytes as GB-months, kept in usage_meter so past days stay) and automation runs (usage_meter).
 */
const internal: Collect = async (ctx) => {
  const { db, from, to } = ctx;
  const out: CostRecord[] = [];
  if (from <= ctx.today && ctx.today <= to) await snapshotStorage(db, ctx.today);

  const ai = await db
    .select({
      day: sql<string>`${aiUsage.day}::text`,
      accountId: aiUsage.accountId,
      own: sql<boolean>`exists (select 1 from ${aiConnections} c where c.id = ${aiUsage.connectionId} and c.account_id = ${aiUsage.accountId})`,
      calls: sql<number>`sum(${aiUsage.calls})::int`,
      cost: sql<number>`sum(${aiUsage.costUsd})`,
    })
    .from(aiUsage)
    .where(and(gte(aiUsage.day, from), lte(aiUsage.day, to)))
    .groupBy(aiUsage.day, aiUsage.accountId, sql`3`);
  const platformOnly = str(ctx.config.ai_scope) === 'platform';
  for (const r of ai) {
    if (platformOnly && r.own) continue;
    out.push({
      day: r.day,
      metric: 'ai',
      service: r.own ? 'account_key' : 'platform_key',
      accountRef: r.accountId,
      quantity: Number(r.calls),
      unit: 'call',
      amount: Number(r.cost),
      currency: 'USD',
    });
  }

  const units: Record<string, CostUnit> = {
    [METER.email]: 'email',
    [METER.smsSegments]: 'segment',
    [METER.webSearch]: 'search',
    [METER.storage]: 'gb_month',
    [METER.automationRuns]: 'run',
  };
  const metered = await db
    .select({
      day: sql<string>`${usageMeter.day}::text`,
      accountRef: usageMeter.accountRef,
      metric: usageMeter.metric,
      quantity: usageMeter.quantity,
    })
    .from(usageMeter)
    .where(and(gte(usageMeter.day, from), lte(usageMeter.day, to)));
  for (const r of metered) {
    const unit = units[r.metric];
    if (unit)
      out.push({ day: r.day, metric: r.metric, service: '', accountRef: r.accountRef, quantity: r.quantity, unit });
  }

  return out;
};

/** Today's stored bytes per account → GB-months for the day (a month of days sums to the month's GB-months). */
export const snapshotStorage = async (db: Db, day = meterDay()) => {
  const rows = await db
    .select({ accountId: assets.accountId, bytes: sql<number>`coalesce(sum(${assets.size}), 0)::float8` })
    .from(assets)
    .where(and(isNull(assets.deletedAt), sql`${assets.uploadStatus} = 'uploaded'`))
    .groupBy(assets.accountId);
  const perDay = 1 / daysInMonth(day);
  await setMeter(
    db,
    day,
    METER.storage,
    rows
      .filter((r) => Number(r.bytes) > 0)
      .map((r) => ({ accountRef: r.accountId, quantity: (Number(r.bytes) / 1024 ** 3) * perDay })),
  );
};

// ---------------------------------------------------------------- Railway

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
const RAILWAY_METRICS: Record<string, { metric: string; unit: CostUnit }> = {
  CPU_USAGE: { metric: 'railway.cpu', unit: 'vcpu_minute' },
  MEMORY_USAGE_GB: { metric: 'railway.memory', unit: 'gb_minute' },
  DISK_USAGE_GB: { metric: 'railway.volume', unit: 'gb_minute' },
  BACKUP_USAGE_GB: { metric: 'railway.backup', unit: 'gb_minute' },
  NETWORK_TX_GB: { metric: 'railway.egress', unit: 'gb' },
};

/**
 * Railway (public GraphQL API, an account or workspace token): per day, every service × environment of the project —
 * vCPU-minutes, memory and volume GB-minutes, egress GB.
 */
const railway: Collect = async (ctx) => {
  const project = need(ctx, 'project_id');
  const key = needSecret(ctx);
  const call = async (query: string, variables: Record<string, unknown>) => {
    const body = await callJson(ctx, RAILWAY_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, variables }),
    });
    graphqlErrors(body);
    return (body as { data: Record<string, unknown> }).data;
  };
  const names = (await call(
    'query($p:String!){project(id:$p){services{edges{node{id name}}} environments{edges{node{id name}}}}}',
    { p: project },
  )) as {
    project: {
      services: { edges: { node: { id: string; name: string } }[] };
      environments: { edges: { node: { id: string; name: string } }[] };
    } | null;
  };
  if (!names.project) throw new AppError('not_found', 'cost_source_project_not_found');
  const service = new Map(names.project.services.edges.map((e) => [e.node.id, e.node.name]));
  const env = new Map(names.project.environments.edges.map((e) => [e.node.id, e.node.name]));
  const out: CostRecord[] = [];
  for (const day of dayRange(ctx.from, ctx.to)) {
    const data = (await call(
      'query($p:String,$s:DateTime,$e:DateTime,$m:[MetricMeasurement!]){usage(projectId:$p,startDate:$s,endDate:$e,measurements:$m,groupBy:[SERVICE_ID,ENVIRONMENT_ID]){measurement value tags{serviceId environmentId}}}',
      {
        p: project,
        s: `${day}T00:00:00Z`,
        e: `${addDays(day, 1)}T00:00:00Z`,
        m: Object.keys(RAILWAY_METRICS),
      },
    )) as { usage: { measurement: string; value: number; tags: { serviceId?: string; environmentId?: string } }[] };
    for (const u of data.usage ?? []) {
      const m = RAILWAY_METRICS[u.measurement];
      if (!m || !(u.value > 0)) continue;
      const svc = service.get(u.tags.serviceId ?? '') ?? u.tags.serviceId ?? '';
      const environment = env.get(u.tags.environmentId ?? '');
      out.push({
        day,
        metric: m.metric,
        service: (environment ? `${svc} · ${environment}` : svc).slice(0, 120),
        quantity: u.value,
        unit: m.unit,
      });
    }
  }
  return merge(out);
};

// ---------------------------------------------------------------- Cloudflare R2

const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
/** R2's operation classes (developers.cloudflare.com/r2/pricing): writes and lists are class A, reads class B. */
const CLASS_A = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'LifecycleStorageTierTransition',
  'ListMultipartUploads',
  'UploadPart',
  'UploadPartCopy',
  'ListParts',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
]);
const CLASS_B = new Set([
  'HeadBucket',
  'HeadObject',
  'GetObject',
  'UsageSummary',
  'GetBucketEncryption',
  'GetBucketLocation',
  'GetBucketCors',
  'GetBucketLifecycleConfiguration',
]);

/**
 * Cloudflare R2 (GraphQL Analytics API, a token with "Account Analytics: Read"): per day and bucket, the stored
 * bytes (the day's peak, as GB-months) and the class A / class B operations. Deletes and aborts are free.
 */
const cloudflareR2: Collect = async (ctx) => {
  const account = need(ctx, 'account_id');
  const bucket = str(ctx.config.bucket);
  const key = needSecret(ctx);
  const out: CostRecord[] = [];
  const filter = bucket ? ', bucketName: $bucket' : '';
  const query = `query($a:string!,$s:Time,$e:Time${bucket ? ',$bucket:string' : ''}){viewer{accounts(filter:{accountTag:$a}){
    storage: r2StorageAdaptiveGroups(limit:10000, filter:{datetime_geq:$s, datetime_leq:$e${filter}}){max{payloadSize metadataSize} dimensions{bucketName}}
    ops: r2OperationsAdaptiveGroups(limit:10000, filter:{datetime_geq:$s, datetime_leq:$e${filter}}){sum{requests} dimensions{actionType bucketName}}}}}`;
  for (const day of dayRange(ctx.from, ctx.to)) {
    const body = await callJson(ctx, CF_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        query,
        variables: { a: account, s: `${day}T00:00:00Z`, e: `${day}T23:59:59Z`, ...(bucket ? { bucket } : {}) },
      }),
    });
    graphqlErrors(body);
    const acc = (
      body as {
        data?: {
          viewer?: {
            accounts?: {
              storage?: { max: { payloadSize?: number; metadataSize?: number }; dimensions: { bucketName?: string } }[];
              ops?: { sum: { requests?: number }; dimensions: { actionType?: string; bucketName?: string } }[];
            }[];
          };
        };
      }
    ).data?.viewer?.accounts?.[0];
    const perDay = 1 / daysInMonth(day);
    for (const s of acc?.storage ?? []) {
      const bytes = (s.max.payloadSize ?? 0) + (s.max.metadataSize ?? 0);
      if (bytes > 0)
        out.push({
          day,
          metric: 'r2.storage',
          service: s.dimensions.bucketName ?? bucket,
          quantity: (bytes / 1024 ** 3) * perDay,
          unit: 'gb_month',
        });
    }
    for (const o of acc?.ops ?? []) {
      const action = o.dimensions.actionType ?? '';
      const metric = CLASS_A.has(action) ? 'r2.class_a' : CLASS_B.has(action) ? 'r2.class_b' : null;
      if (metric && (o.sum.requests ?? 0) > 0)
        out.push({
          day,
          metric,
          service: o.dimensions.bucketName ?? bucket,
          quantity: o.sum.requests ?? 0,
          unit: 'operation',
        });
    }
  }
  return merge(out);
};

// ---------------------------------------------------------------- any JSON API

/**
 * Any provider with a JSON API: the amount at `amount_path` of the answer, read today only — either the month so
 * far (`month_to_date`: today's cost is what grew since the days before) or today's cost (`day`).
 */
const httpJson: Collect = async (ctx) => {
  const url = need(ctx, 'url');
  const path = need(ctx, 'amount_path');
  const currency = need(ctx, 'currency').toUpperCase();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (ctx.secret)
    headers[str(ctx.config.auth_header) || 'Authorization'] = `${str(ctx.config.auth_prefix)}${ctx.secret}`;
  const body = await callJson(ctx, url, { method: 'GET', headers });
  const value = numberFrom(valueAtPath(body, path));
  if (value === null) throw new AppError('invalid_value', 'cost_source_amount_missing', { path });
  return [
    {
      day: ctx.today,
      metric: 'http_json',
      service: '',
      quantity: 1,
      unit: 'amount',
      amount: value,
      currency,
    },
  ];
};

/** A month-to-date amount → today's share: the amount less what the month's earlier days already hold. */
export const monthToDateShare = (amount: number, earlierThisMonth: number) => Math.max(0, amount - earlierThisMonth);

// ---------------------------------------------------------------- a fixed fee

/** A fixed fee (a plan, a domain): the amount per month or year, spread evenly over its days. */
const recurring: Collect = async (ctx) => {
  const amount = numberFrom(ctx.config.amount);
  if (amount === null || amount < 0)
    throw new AppError('invalid_value', 'cost_source_missing_field', { field: 'amount' });
  const currency = need(ctx, 'currency').toUpperCase();
  const yearly = str(ctx.config.period) === 'year';
  const starts = str(ctx.config.starts_on);
  const ends = str(ctx.config.ends_on);
  const out: CostRecord[] = [];
  for (const day of dayRange(ctx.from, ctx.to)) {
    if ((starts && day < starts) || (ends && day > ends)) continue;
    const year = Number(day.slice(0, 4));
    const days = yearly ? (new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1 ? 366 : 365) : daysInMonth(day);
    out.push({ day, metric: 'recurring', service: '', quantity: 1, unit: 'day', amount: amount / days, currency });
  }
  return out;
};

/** One record per day × metric × service × account (a provider may answer in pieces). */
const merge = (records: CostRecord[]) => {
  const map = new Map<string, CostRecord>();
  for (const r of records) {
    const k = `${r.day}|${r.metric}|${r.service}|${r.accountRef ?? ''}`;
    const prev = map.get(k);
    if (prev) {
      prev.quantity += r.quantity;
      if (r.amount !== undefined) prev.amount = (prev.amount ?? 0) + r.amount;
    } else map.set(k, { ...r });
  }
  return [...map.values()];
};

export const ADAPTERS: Record<CostAdapter, Collect> = {
  internal,
  railway,
  cloudflare_r2: cloudflareR2,
  http_json: httpJson,
  recurring,
};

/** Whether a source's adapter can read days before today again. */
export const canBackfill = (adapter: CostAdapter) => COST_ADAPTER_DEFS[adapter].backfill;
