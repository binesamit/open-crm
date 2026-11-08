// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env';
import { createLogger } from '../src/lib/logger';
import { s3Storage } from '../src/lib/storage';
import { spaCsp } from '../src/middleware/security-headers';

/**
 * Self-hosting (open-source ק3): MinIO next to the api is reached at http://minio:9000 by the server and at another
 * address by browsers. S3_PUBLIC_ENDPOINT makes the presigned URLs (and the CSP) use the browser's address.
 */
const S3_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  S3_ENDPOINT: 'http://minio:9000',
  S3_BUCKET: 'files',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_SET_CORS: 'false',
};

describe('S3_PUBLIC_ENDPOINT', () => {
  it('presigned URLs point at the public address when set', async () => {
    const env = loadEnv({ ...S3_ENV, S3_PUBLIC_ENDPOINT: 'https://files.example.org' });
    const storage = s3Storage(env, createLogger(env));
    const put = await storage.presignPut('a/b.pdf', 'application/pdf', 10);
    expect(new URL(put.url).origin).toBe('https://files.example.org');
    const get = await storage.presignGet('a/b.pdf', 'b.pdf');
    expect(new URL(get).origin).toBe('https://files.example.org');
  });

  it('unset = S3_ENDPOINT, as before', async () => {
    const env = loadEnv(S3_ENV);
    const storage = s3Storage(env, createLogger(env));
    const put = await storage.presignPut('a/b.pdf', 'application/pdf', 10);
    expect(new URL(put.url).origin).toBe('http://minio:9000');
  });

  it('the SPA CSP allows the public address, not the internal one', () => {
    const csp = spaCsp({
      NODE_ENV: 'production',
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'https://files.example.org',
    });
    expect(csp).toContain('https://files.example.org');
    expect(csp).not.toContain('minio:9000');
  });
});
