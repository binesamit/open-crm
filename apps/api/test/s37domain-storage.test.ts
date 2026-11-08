// SPDX-License-Identifier: AGPL-3.0-only
import { PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/env';
import { createLogger } from '../src/lib/logger';
import { s3Storage, type memoryStorage, type S3Like } from '../src/lib/storage';
import { bucketCorsOrigins, syncBucketCors } from '../src/modules/platform/public-address';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * M11: the file bucket's CORS follows the public address — the address in effect, the previous ones and WEB_ORIGIN —
 * at boot and when the owner saves it, only when we manage the bucket (S3_SET_CORS), and never failing the save.
 */
const NEW = 'https://os.example.com';
const S3_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  WEB_ORIGIN,
  S3_ENDPOINT: 'https://s3.example.test',
  S3_BUCKET: 'files',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('the origins', () => {
  it('address in effect + previous + WEB_ORIGIN, deduplicated', () => {
    expect(bucketCorsOrigins(undefined, { WEB_ORIGIN })).toEqual([WEB_ORIGIN]);
    expect(
      bucketCorsOrigins(
        { web_origin: NEW, previous_origins: ['https://old.up.railway.app', WEB_ORIGIN] },
        { WEB_ORIGIN, BETTER_AUTH_URL: 'https://auth.example.com' },
      ),
    ).toEqual([NEW, 'https://old.up.railway.app', WEB_ORIGIN]);
  });
});

describe('S3 storage with a mocked client', () => {
  it('sends one PutBucketCors with the origins when S3_SET_CORS is on', async () => {
    const env = loadEnv({ ...S3_ENV, S3_SET_CORS: 'true' });
    const send = vi.fn(async () => ({}));
    const storage = s3Storage(env, createLogger(env), { send } as unknown as S3Like);
    expect(storage.setCorsOrigins).toBeTypeOf('function');
    await storage.setCorsOrigins!([NEW, WEB_ORIGIN]);
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = (send.mock.calls[0] as unknown[])[0] as PutBucketCorsCommand;
    expect(cmd).toBeInstanceOf(PutBucketCorsCommand);
    expect(cmd.input.Bucket).toBe('files');
    expect(cmd.input.CORSConfiguration?.CORSRules?.[0]).toMatchObject({
      AllowedOrigins: [NEW, WEB_ORIGIN],
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
    });
  });

  it('offers nothing to set when S3_SET_CORS is off (a bucket managed elsewhere, e.g. R2 via wrangler)', () => {
    const env = loadEnv({ ...S3_ENV, S3_SET_CORS: 'false' });
    const send = vi.fn(async () => ({}));
    const storage = s3Storage(env, createLogger(env), { send } as unknown as S3Like);
    expect(storage.setCorsOrigins).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('sync on save', () => {
  let t: TestContext;
  let owner: string;
  beforeAll(async () => {
    t = await createTestContext({ env: { S3_SET_CORS: 'true' } });
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  });
  afterAll(() => t.close());
  const storage = () => t.deps.storage as ReturnType<typeof memoryStorage>;

  it('saving the public address sets the bucket CORS to the new list', async () => {
    const res = await t.api(owner).patch('/platform/settings', { public_address: { web_origin: NEW } });
    expect(res.status).toBe(200);
    expect(storage().corsSets.at(-1)).toEqual([NEW, WEB_ORIGIN]);
  });

  it('other settings do not touch the bucket', async () => {
    const before = storage().corsSets.length;
    await t.api(owner).patch('/platform/settings', { product_name: 'X' });
    expect(storage().corsSets.length).toBe(before);
  });

  it('a failing bucket never fails the save (logged)', async () => {
    const s = storage();
    const original = s.setCorsOrigins;
    s.setCorsOrigins = async () => {
      throw new Error('AccessDenied');
    };
    try {
      const res = await t.api(owner).patch('/platform/settings', { public_address: { previous_origins: [] } });
      expect(res.status).toBe(200);
    } finally {
      s.setCorsOrigins = original;
    }
  });

  it('boot sync does nothing when S3_SET_CORS is off', async () => {
    const off = { ...t.deps, env: { ...t.deps.env, S3_SET_CORS: false } };
    expect(await syncBucketCors(off)).toBeNull();
    expect(await syncBucketCors(t.deps)).toEqual([NEW, WEB_ORIGIN]);
  });
});
