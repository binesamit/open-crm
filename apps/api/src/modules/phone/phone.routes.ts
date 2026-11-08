// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import {
  phoneActionPrefsResponseSchema,
  sendItemSmsResultSchema,
  sendItemSmsSchema,
  setPhoneActionPrefsSchema,
  smsStatusSchema,
} from '@bines/shared';
import { currentUser, requireAccount, requireUser, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { myPhonePrefs, setMyPhonePrefs } from './prefs.service';
import { sendItemSms, smsStatus } from './sms.service';

/** Plan — phone numbers: SMS from an item, the SMS status for the dialog, my click preference. */
export const phoneRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const middleware = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/sms',
      tags: ['updates'],
      summary: "Send an SMS to the number in a phone column of the item (account's SMS provider); logged as an update",
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(sendItemSmsSchema) },
      responses: {
        200: json(sendItemSmsResultSchema, 'Sent (or, with dry_run, what would be sent)'),
        ...errors(400, 401, 403, 404, 422, 429),
      },
    }),
    async (c) => c.json(await sendItemSms(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/sms/status',
      tags: ['updates'],
      summary: 'May I send SMS here; the account SMS templates, budgets and usage',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(smsStatusSchema, 'SMS status'), ...errors(401, 403) },
    }),
    async (c) => c.json(await smsStatus(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/phone-actions',
      tags: ['me'],
      summary: 'What a click on a phone number does for me',
      middleware: [requireUser()],
      responses: { 200: json(phoneActionPrefsResponseSchema, 'Phone click preference'), ...errors(401) },
    }),
    async (c) => c.json(await myPhonePrefs(db, currentUser(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/me/phone-actions',
      tags: ['me'],
      summary: 'Set what a click on a phone number does for me (null = back to the default)',
      middleware: [requireUser()],
      request: jsonBody(setPhoneActionPrefsSchema),
      responses: { 200: json(phoneActionPrefsResponseSchema, 'Phone click preference'), ...errors(400, 401, 422) },
    }),
    async (c) => c.json(await setMyPhonePrefs(db, currentUser(c), c.req.valid('json')), 200),
  );
  return r;
};
