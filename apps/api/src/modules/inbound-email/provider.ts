// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import { allowPrivateOutbound, outboundDownload } from '../../lib/outbound';

/**
 * The mail provider's side of incoming email (Resend's receiving API): the webhook carries only metadata, so the
 * message and its attachments are fetched here. Tests replace the whole client — no test ever reaches the provider.
 */
export type ReceivedEmail = {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  message_id: string | null;
  headers: Record<string, string>;
  /** SPF / DKIM / DMARC results (null = not given: treated as not authenticated). */
  authentication: { spf?: string; dkim?: string; dmarc?: string } | null;
  /** A short-lived link to the original message (.eml) — kept when the message is too long to show whole. */
  raw_url?: string | null;
};
export type ReceivedAttachment = {
  id: string;
  filename: string | null;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
  size: number;
  download_url: string;
};
export type InboundProvider = {
  getEmail(id: string): Promise<ReceivedEmail>;
  listAttachments(id: string): Promise<ReceivedAttachment[]>;
  download(url: string, maxBytes: number): Promise<Buffer>;
};

const API = 'https://api.resend.com';
const TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Resend's receiving API with `apiKey` (a key that may read received mail); `base`: another address for it (a
 * compatible provider, the E2E stand-in); `allowPrivate`: downloads may reach local addresses (tests / dev only).
 */
export const resendProvider = (
  apiKey: string,
  { base = API, allowPrivate = false }: { base?: string; allowPrivate?: boolean } = {},
): InboundProvider => {
  const get = async (path: string): Promise<Json> => {
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // A failure is retried by the job (graphile's attempts); the message stays queued until then.
    if (!res.ok) throw new Error(`resend_receiving_${res.status}`);
    return (await res.json()) as Json;
  };
  return {
    async getEmail(id) {
      // `cid`: the body's images stay `cid:` references to the attachments (stored as files), not inlined data.
      const j = await get(`/emails/receiving/${encodeURIComponent(id)}?html_format=cid`);
      const raw = j.raw && typeof j.raw === 'object' ? (j.raw as Json) : null;
      const headers = (j.headers && typeof j.headers === 'object' ? j.headers : {}) as Record<string, unknown>;
      const auth = j.authentication && typeof j.authentication === 'object' ? (j.authentication as Json) : null;
      return {
        id,
        from: str(j.from) ?? '',
        to: strings(j.to),
        subject: str(j.subject),
        text: str(j.text),
        html: str(j.html),
        message_id: str(j.message_id),
        headers: Object.fromEntries(
          Object.entries(headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k.toLowerCase(), v]] : [])),
        ),
        authentication: auth
          ? { spf: str(auth.spf) ?? undefined, dkim: str(auth.dkim) ?? undefined, dmarc: str(auth.dmarc) ?? undefined }
          : null,
        raw_url: str(raw?.download_url),
      };
    },
    async listAttachments(id) {
      const j = await get(`/emails/receiving/${encodeURIComponent(id)}/attachments`);
      const rows = Array.isArray(j.data) ? (j.data as Json[]) : [];
      return rows.flatMap((a) => {
        const url = str(a.download_url);
        const aid = str(a.id);
        if (!url || !aid) return [];
        return [
          {
            id: aid,
            filename: str(a.filename),
            content_type: (str(a.content_type) ?? 'application/octet-stream').toLowerCase().split(';')[0]!.trim(),
            content_disposition: str(a.content_disposition),
            content_id: str(a.content_id),
            size: typeof a.size === 'number' ? a.size : 0,
            download_url: url,
          },
        ];
      });
    },
    async download(url, maxBytes) {
      // The provider's signed link: still SSRF-guarded (public addresses only) and capped like any download.
      const file = await outboundDownload(url, { maxBytes, timeoutMs: 30_000, allowPrivate }).catch((err: unknown) => {
        if (err instanceof AppError) throw err;
        throw new AppError('invalid_value', 'attachment_unreachable');
      });
      return file.body;
    },
  };
};

let override: InboundProvider | null = null;
/** Tests: a fake provider (null = back to the real one). */
export const setInboundProviderForTests = (p: InboundProvider | null) => {
  override = p;
};
/** The provider for this environment, or null when no key is configured (the message then fails, and is retried). */
export const inboundProvider = (env: {
  RESEND_INBOUND_API_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_API_BASE?: string;
  NODE_ENV?: string;
  OUTBOUND_ALLOW_PRIVATE?: string;
}) =>
  override ??
  (env.RESEND_INBOUND_API_KEY || env.RESEND_API_KEY
    ? resendProvider((env.RESEND_INBOUND_API_KEY || env.RESEND_API_KEY)!, {
        base: env.RESEND_API_BASE || API,
        allowPrivate: allowPrivateOutbound(env, { inTests: false }),
      })
    : null);
