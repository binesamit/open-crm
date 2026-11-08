// SPDX-License-Identifier: MIT
import type { IDataObject } from 'n8n-workflow';
import { DELIVERY_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../shared/constants';
import { verifySignature } from '../shared/signature';
import { simplifyItem } from '../shared/values';

/** What the trigger does with one incoming request: answer the challenge, refuse it, or start the workflow. */
export type DeliveryOutcome =
  | { kind: 'challenge'; response: IDataObject }
  | { kind: 'reject'; status: number; message: string }
  | { kind: 'event'; json: IDataObject };

export const handleDelivery = (input: {
  body: IDataObject;
  headers: Record<string, string | string[] | undefined>;
  /** The raw request body as received (n8n keeps it as `req.rawBody`); else the parsed body re-serialised. */
  rawBody?: string;
  secret?: string;
  verify: boolean;
  now?: number;
}): DeliveryOutcome => {
  const { body, headers } = input;
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  // The subscription handshake: echo the challenge so the platform knows this URL is ours.
  if (typeof body.challenge === 'string' && body.event === undefined) {
    return { kind: 'challenge', response: { challenge: body.challenge } };
  }
  if (input.verify && input.secret) {
    const check = verifySignature(
      input.secret,
      header(TIMESTAMP_HEADER),
      input.rawBody ?? JSON.stringify(body),
      header(SIGNATURE_HEADER),
      input.now,
    );
    if (!check.ok) return { kind: 'reject', status: 401, message: `Invalid signature (${check.reason})` };
  }
  const event = (body.event as IDataObject | undefined) ?? {};
  if (!event.type) return { kind: 'reject', status: 400, message: 'Not an event delivery' };
  const item = event.item as IDataObject | undefined;
  return {
    kind: 'event',
    json: {
      ...event,
      ...(item && typeof item === 'object' ? { item: simplifyItem(item) } : {}),
      deliveryId: header(DELIVERY_HEADER) ?? null,
    },
  };
};
