// SPDX-License-Identifier: AGPL-3.0-only
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { Env } from '../env';
import type { Logger } from './logger';
import { diskStorage } from './disk-storage';

/**
 * File storage (01-ARCHITECTURE §7): S3-compatible — Cloudflare R2 in production, MinIO locally.
 * Browsers upload and download directly with short-lived presigned URLs; bytes never pass through the API.
 */
export interface FileStorage {
  presignPut(key: string, mime: string, size: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** Download link; `inline` serves it for display (avatars) instead of as an attachment. */
  presignGet(
    key: string,
    fileName: string,
    /** `contentType`: serve as this type (a media file stored without one, — `mediaServeType`). */
    opts?: { inline?: boolean; ttl?: number; contentType?: string },
  ): Promise<string>;
  head(key: string): Promise<{ size: number; mime: string } | null>;
  remove(key: string): Promise<void>;
  /** Server-side copy of an object to a new key (a file version made current again). */
  copy(from: string, to: string): Promise<void>;
  /**
   * Server-side write — only for bytes the server itself fetched (a file attached from a URL, size-capped by the
   * caller); everything a browser uploads goes through `presignPut`.
   */
  put(key: string, body: Buffer, mime: string): Promise<void>;
  /**
   * Server-side read of an object (agent knowledge files are indexed on the server, מ9); null when it does not
   * exist or is larger than `maxBytes`.
   */
  get(key: string, maxBytes: number): Promise<Buffer | null>;
  /**
   * Server-side streams for large objects the server itself builds or packs (the account export)
   * upload a local file, read an object as a stream (null = missing). Absent = fall back to `put` / `get`.
   */
  putFile?(key: string, path: string, mime: string): Promise<void>;
  getStream?(key: string): Promise<Readable | null>;
  /**
   * Sets the bucket's CORS to these browser origins (presigned PUT / GET straight from the browser). Only on an S3
   * bucket we manage (S3_SET_CORS); absent = nothing to set. Idempotent.
   */
  setCorsOrigins?(origins: string[]): Promise<void>;
}

/** The one CORS rule of the bucket: our origins may PUT / GET / HEAD with presigned URLs. */
export const bucketCorsCommand = (Bucket: string, origins: string[]) =>
  new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: origins,
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 3600,
        },
      ],
    },
  });

/** The part of an S3 client the storage uses (tests pass a fake). */
export type S3Like = Pick<S3Client, 'send'>;

/**
 * Types a browser may show in place (the file viewer) without running code: raster images, PDF, audio, video and
 * plain text. Anything else (HTML, SVG, XML, scripts …) is always served as an attachment, so an uploaded page never
 * renders from the storage origin.
 */
export const isInlineSafeMime = (mime: string) =>
  /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain)(;|$)/i.test(
    mime.trim(),
  );

const UPLOAD_TTL = 15 * 60;
const DOWNLOAD_TTL = 15 * 60;

export const s3Storage = (env: Env, logger: Logger, injected?: S3Like): FileStorage => {
  const real =
    injected ??
    new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
    });
  // Presigning needs the real client; a test's fake only answers `send`.
  const client = real as S3Client;
  // S3_PUBLIC_ENDPOINT: browsers reach the storage at another address than the server does (self-hosted MinIO next
  // to the api: http://minio:9000 inside, https://files.example.com outside). Presigned URLs sign the host, so they
  // are made by a client on the public address; everything else goes to S3_ENDPOINT.
  const presigner =
    !injected && env.S3_PUBLIC_ENDPOINT && env.S3_PUBLIC_ENDPOINT !== env.S3_ENDPOINT
      ? new S3Client({
          endpoint: env.S3_PUBLIC_ENDPOINT,
          region: env.S3_REGION,
          forcePathStyle: env.S3_FORCE_PATH_STYLE,
          credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
        })
      : client;
  const Bucket = env.S3_BUCKET!;

  // Local MinIO starts empty; production buckets are provisioned in Railway.
  if (env.NODE_ENV === 'development') {
    void client
      .send(new HeadBucketCommand({ Bucket }))
      .catch(() => client.send(new CreateBucketCommand({ Bucket })))
      .catch((err) => logger.warn({ err }, 'could not create local bucket'));
  }
  // Browsers PUT/GET directly with presigned URLs, so the bucket must allow our origins. Set at boot and whenever
  // the owner saves the public address (M11, modules/platform/public-address.ts `syncBucketCors`).
  return {
    ...(env.S3_SET_CORS
      ? {
          async setCorsOrigins(origins: string[]) {
            await client.send(bucketCorsCommand(Bucket, origins));
            logger.info({ origins }, 'bucket CORS set');
          },
        }
      : {}),
    async presignPut(key, mime, size) {
      const url = await getSignedUrl(
        presigner,
        new PutObjectCommand({ Bucket, Key: key, ContentType: mime, ContentLength: size }),
        { expiresIn: UPLOAD_TTL },
      );
      return { url, headers: { 'content-type': mime } };
    },
    presignGet(key, fileName, opts) {
      return getSignedUrl(
        presigner,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentDisposition: `${opts?.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          ...(opts?.contentType ? { ResponseContentType: opts.contentType } : {}),
        }),
        { expiresIn: opts?.ttl ?? DOWNLOAD_TTL },
      );
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: Number(res.ContentLength ?? 0), mime: res.ContentType ?? 'application/octet-stream' };
      } catch {
        return null;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async copy(from, to) {
      // CopySource is "bucket/key", URL-encoded per path segment.
      const source = `${Bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
      await client.send(new CopyObjectCommand({ Bucket, Key: to, CopySource: source }));
    },
    async put(key, body, mime) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: mime, ContentLength: body.length }),
      );
    },
    async putFile(key, path, mime) {
      const { size } = await stat(path);
      await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: createReadStream(path),
          ContentType: mime,
          ContentLength: size,
        }),
      );
    },
    async getStream(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return res.Body ? (res.Body as Readable) : null;
      } catch {
        return null;
      }
    },
    async get(key, maxBytes) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (Number(res.ContentLength ?? 0) > maxBytes || !res.Body) return null;
        const bytes = await res.Body.transformToByteArray();
        return bytes.length > maxBytes ? null : Buffer.from(bytes);
      } catch {
        return null;
      }
    },
  };
};

/** Tests: objects "exist" once markUploaded() is called. */
export const memoryStorage = () => {
  const objects = new Map<string, { size: number; mime: string; body?: Buffer }>();
  /** Every CORS list set on the bucket (M11). */
  const corsSets: string[][] = [];
  return {
    objects,
    markUploaded: (key: string, size: number, mime: string, body?: Buffer) => objects.set(key, { size, mime, body }),
    async presignPut(key: string, mime: string) {
      return { url: `https://storage.test/${key}?upload`, headers: { 'content-type': mime } };
    },
    async presignGet(key: string) {
      return `https://storage.test/${key}?download`;
    },
    async head(key: string) {
      return objects.get(key) ?? null;
    },
    async remove(key: string) {
      objects.delete(key);
    },
    async copy(from: string, to: string) {
      const o = objects.get(from);
      if (!o) throw new Error('NoSuchKey');
      objects.set(to, { ...o });
    },
    async put(key: string, body: Buffer, mime: string) {
      objects.set(key, { size: body.length, mime, body });
    },
    async get(key: string, maxBytes: number) {
      const o = objects.get(key);
      return o?.body && o.body.length <= maxBytes ? o.body : null;
    },
    async putFile(key: string, path: string, mime: string) {
      const body = await readFile(path);
      objects.set(key, { size: body.length, mime, body });
    },
    async getStream(key: string) {
      const o = objects.get(key);
      return o?.body ? Readable.from([o.body]) : null;
    },
    corsSets,
    async setCorsOrigins(origins: string[]) {
      corsSets.push(origins);
    },
  } satisfies FileStorage & Record<string, unknown>;
};

const STORAGE_NOT_CONFIGURED = 'storage_not_configured';

const unconfigured = (): FileStorage => {
  const fail = async (): Promise<never> => {
    throw new Error(STORAGE_NOT_CONFIGURED);
  };
  return { presignPut: fail, presignGet: fail, head: fail, remove: fail, copy: fail, put: fail, get: fail };
};

/**
 * A link that only SHOWS a picture (a person's photo, a logo, a form's cover, a help image): null while the
 * installation has no file storage, so one picture never fails the list or page around it — GET /users with one
 * member's photo answered 500 and the @mention list stayed empty. A file someone asked to download still fails loudly.
 */
export const imageLink = async (storage: FileStorage, ...args: Parameters<FileStorage['presignGet']>) => {
  try {
    return await storage.presignGet(...args);
  } catch (err) {
    if (err instanceof Error && err.message === STORAGE_NOT_CONFIGURED) return null;
    throw err;
  }
};

export const s3Configured = (env: Env) =>
  !!(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);

/**
 * S3 when configured; else the local disk when FILES_DIR is set (standalone mode sets it to `$DATA_DIR/files`) — its
 * links are absolute on the API's public address (`origin`); else nothing (uploads answer storage_not_configured).
 */
export const createStorage = (env: Env, logger: Logger, opts: { origin?: () => Promise<string> } = {}): FileStorage =>
  s3Configured(env)
    ? s3Storage(env, logger)
    : env.FILES_DIR
      ? diskStorage({
          root: env.FILES_DIR,
          secret: env.BETTER_AUTH_SECRET ?? DEV_SECRET,
          origin: opts.origin ?? (async () => env.WEB_ORIGIN),
        })
      : unconfigured();

/** Outside production only (env.ts requires BETTER_AUTH_SECRET there): the same fallback as Better Auth's. */
const DEV_SECRET = 'dev-only-secret-change-me-dev-only-secret';
