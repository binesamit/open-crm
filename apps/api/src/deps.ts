// SPDX-License-Identifier: AGPL-3.0-only
import { createAuth } from './auth/auth';
import type { Db } from './db/client';
import type { Env } from './env';
import { createMailer, mailTransport, type Mailer } from '@bines/server-mail';
import {
  type AiClientFactory,
  createAiClient,
  scriptedAnthropic,
  scriptedImage,
  scriptedModels,
} from '@bines/server-ai';
import { aiFetch } from './modules/ai/ai-fetch';
import { createSecretBox } from './lib/secrets';
import type { Logger } from './lib/logger';
import { type EventBus, nullBus } from './lib/realtime';
import { createSmsSender, type SmsSender } from './lib/sms';
import { createStorage, type FileStorage } from './lib/storage';
import { apiOrigin } from './modules/platform/public-address';
import type { AppDeps } from './types';
import { capturingMailer, capturingSms } from './modules/errors/errors.capture';
import { meteringMailer, meteringSms } from './modules/costs/meter';

export const createDeps = (p: {
  env: Env;
  logger: Logger;
  db: Db;
  mailer?: Mailer;
  sms?: SmsSender;
  storage?: FileStorage;
  bus?: EventBus;
  aiClient?: AiClientFactory;
}): AppDeps => {
  // Errors hub: a failed email / SMS is recorded (source email / sms); the senders behave as before.
  // Costs: every email sent and SMS part is counted (usage_meter).
  const mailer = meteringMailer(p.db, capturingMailer(p.db, p.mailer ?? createMailer(p.env, p.logger)));
  const auth = createAuth({ db: p.db, env: p.env, mailer, logger: p.logger });
  const sms = meteringSms(p.db, capturingSms(p.db, p.sms ?? createSmsSender(p.env, p.logger)));
  // Local-disk links are absolute on the API's public address (owner console, else WEB_ORIGIN), like S3's.
  const storage = p.storage ?? createStorage(p.env, p.logger, { origin: () => apiOrigin({ db: p.db, env: p.env }) });
  return {
    // Email off (no transport configured): sign-in screens offer no email link, the owner console says how to add SMTP.
    emailEnabled: p.mailer ? true : mailTransport(p.env) !== 'none',
    env: p.env,
    logger: p.logger,
    db: p.db,
    mailer,
    auth,
    sms,
    storage,
    bus: p.bus ?? nullBus,
    aiClient:
      p.aiClient ??
      (p.env.AI_FAKE === 'scripted' && p.env.NODE_ENV !== 'production'
        ? // Every provider plays the scripted Anthropic stand-in (no key, no network, no money).
          (conn) => ({
            ...createAiClient({ ...conn, provider: 'anthropic' }, { anthropic: scriptedAnthropic() }),
            provider: conn.provider,
            // AI images: tiny PNGs (a prompt with BLOCKED plays a safety refusal).
            generateImage: scriptedImage,
            // Each provider lists models of its own: OpenAI / Gemini pickers show theirs, not Claude's.
            ...(scriptedModels(conn.provider).length ? { listModels: async () => scriptedModels(conn.provider) } : {}),
          })
        : // OpenAI / Gemini / OpenAI-compatible go through the SSRF-guarded fetch.
          (conn) => createAiClient(conn, { fetch: aiFetch(conn.allowPrivate) })),
    secrets: createSecretBox(p.env),
  };
};
