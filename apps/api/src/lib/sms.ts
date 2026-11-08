// SPDX-License-Identifier: AGPL-3.0-only
import type { Env } from '../env';
import type { Logger } from './logger';

/**
 * SMS via TextMe (my.textme.co.il).
 * Used by notifications (SLA breaches, portal requests) as they land; Israeli mobiles only for now.
 */
export type SmsMessage = {
  to: string;
  text: string;
  /** The sender id shown on the phone: the account's, else the platform's (`smsSenderId`); else TEXTME_SENDER_ID. */
  senderId?: string | null;
  /** The account sending (its SMS parts are counted on it); absent = the platform. */
  accountId?: string | null;
};
export type SmsResult = { id: string | null };

export interface SmsSender {
  send(message: SmsMessage): Promise<SmsResult>;
  /** false = no provider keys in this environment (every send fails); GET /sms/status reports it. */
  readonly configured?: boolean;
  /** Can this provider deliver to the number (E.164 or as typed)? TextMe: Israeli mobiles only. */
  accepts?(phone: string): boolean;
}

const TEXTME_URL = 'https://my.textme.co.il/api';
const MAX_LENGTH = 1005; // TextMe limit

/** 05XXXXXXXX from 05…, 5…, 972…, +972… (spaces/dashes ignored); null when not an Israeli mobile. */
export const normalizeIsraeliMobile = (phone: string): string | null => {
  let digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+972')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  if (digits.length === 9 && digits.startsWith('5')) digits = `0${digits}`;
  return /^05\d{8}$/.test(digits) ? digits : null;
};

const TEXTME_STATUS: Record<number, string> = {
  1: 'xml_parse_error',
  3: 'auth_failed',
  4: 'no_credit',
  7: 'no_balance',
  9: 'invalid_phone',
  12: 'insufficient_funds',
  999: 'unknown_error',
};

/** Thrown when no SMS sender id is set anywhere (account, platform, TEXTME_SENDER_ID). */
export const SMS_SENDER_NOT_CONFIGURED = 'sms: sender_not_configured';

export const textmeSender = (
  cfg: { apiKey: string; username: string; senderId: string | undefined },
  logger?: Logger,
): SmsSender => ({
  configured: true,
  accepts: (phone) => normalizeIsraeliMobile(phone) !== null,
  async send({ to, text, senderId }) {
    const phone = normalizeIsraeliMobile(to);
    if (!phone) throw new Error('sms: invalid_phone');
    // No brand in code (ANSWERS 6א.8): the sender is a setting (account → platform → env), never a default name.
    const source = senderId?.trim() || cfg.senderId?.trim();
    if (!source) {
      // Loud, not silent: every SMS fails until the owner (or the account) sets a sender id.
      logger?.error(
        { to: phone },
        'sms not sent: no SMS sender id - set it in the owner console (Platform settings -> SMS sender), ' +
          "in the account's Administration -> Messaging, or TEXTME_SENDER_ID",
      );
      throw new Error(SMS_SENDER_NOT_CONFIGURED);
    }
    const res = await fetch(TEXTME_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        sms: {
          user: { username: cfg.username },
          source,
          destinations: { phone: [{ _: phone }] },
          message: text.slice(0, MAX_LENGTH),
        },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: number | string;
      shipment_id?: string;
      message_id?: string;
    };
    const status = body.status === undefined ? -1 : Number(body.status);
    if (!res.ok || status !== 0) throw new Error(`sms: textme ${TEXTME_STATUS[status] ?? `status_${status}`}`);
    return { id: body.shipment_id ?? body.message_id ?? null };
  },
});

const unconfiguredSender = (logger: Logger): SmsSender => ({
  configured: false,
  accepts: (phone) => normalizeIsraeliMobile(phone) !== null,
  async send({ to }) {
    logger.error({ to }, 'sms not sent: set TEXTME_API_KEY and TEXTME_USERNAME');
    throw new Error('sms_not_configured');
  },
});

/** The test transport: records what was sent; accepts what TextMe accepts; `failNext` makes the next send throw. */
export const memorySms = () => {
  const sent: SmsMessage[] = [];
  const state = { failNext: null as string | null };
  return {
    sent,
    state,
    configured: true,
    accepts: (phone: string) => normalizeIsraeliMobile(phone) !== null,
    async send(message: SmsMessage) {
      if (state.failNext) {
        const error = state.failNext;
        state.failNext = null;
        throw new Error(error);
      }
      sent.push(message);
      return { id: `mem-${sent.length}` };
    },
  } satisfies SmsSender & { sent: SmsMessage[]; state: { failNext: string | null } };
};

export const createSmsSender = (env: Env, logger: Logger): SmsSender =>
  env.TEXTME_API_KEY && env.TEXTME_USERNAME
    ? textmeSender(
        { apiKey: env.TEXTME_API_KEY, username: env.TEXTME_USERNAME, senderId: env.TEXTME_SENDER_ID },
        logger,
      )
    : unconfiguredSender(logger);
