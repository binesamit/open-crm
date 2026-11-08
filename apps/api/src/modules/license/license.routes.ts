// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  changeLicensePlanSchema,
  emailLicenseSchema,
  heartbeatSchema,
  installationSchema,
  installationsQuerySchema,
  installLicenseSchema,
  issuedLicenseSchema,
  issueLicenseSchema,
  licenseOpsSchema,
  licenseServerStatusSchema,
  publicLicenseKeySchema,
  licenseStatusSchema,
  licensingSettingsSchema,
  publicCheckoutResultSchema,
  publicCheckoutSchema,
  publicPurchaseConfigSchema,
  updateLicenseOpsSchema,
  publicLicenseCheckResultSchema,
  publicLicenseCheckSchema,
  publicPollResultSchema,
  publicPollSchema,
  publicRegisterResultSchema,
  publicRegisterSchema,
  publicVerifyResultSchema,
  publicVerifySchema,
  registrationFormSchema,
  submitRegistrationSchema,
  updateLicensingSettingsSchema,
  CAPTCHA_TOKEN_HEADER,
} from '@bines/shared';
import { currentUser, requirePlatformOwner, requireUser } from '../../middleware/auth';
import { errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { installLicense, licenseStatus, removeLicense } from './license.service';
import {
  createSigningKey,
  keyFingerprint,
  licenseServerStatus,
  publicKeyPem,
  removeSigningKey,
} from './license-signing';
import {
  checkLicenseOnline,
  getLicensingSettings,
  pollRegistrationHere,
  registrationForm,
  resetRegistration,
  skipRegistration,
  submitRegistration,
  updateLicensingSettings,
} from './licensing.service';
import {
  changeLicensePlan,
  checkLicense,
  emailLicense,
  installationsCsv,
  issueLicense,
  listInstallationsDto,
  listLicenses,
  pollRegistration,
  publicRegistrationConfig,
  recordHeartbeat,
  registerInstallation,
  releaseInstallation,
  renewLicense,
  revokeLicense,
  signerOr404,
  signerOr503,
  verifyRegistration,
} from './license-server.service';
import { licenseOpsDto, loadLicenseOps, updateLicenseOps } from './license-ops.settings';
import { createCheckout, handlePaymentWebhook, publicPurchaseConfig } from './license-purchase.service';

/**
 * Licensing (docs/LICENSING.md). Owner console (platform owner only — 404 to anyone else): the installation's
 * license key, its licensing settings (license server, telemetry), the registration questionnaire; and, where this
 * installation is a license server, its Installations and Licenses. Public (no session): the license server's
 * registration, verification, poll, heartbeat and key-check endpoints — 404 where it is not a license server.
 */
export const licenseRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const guard = [requireUser(), requirePlatformOwner()];
  const tags = ['platform'];
  const r = new OpenAPIHono<AppEnv>();
  const status = (description: string) => json(licenseStatusSchema, description);
  const settings = (description: string) => json(licensingSettingsSchema, description);

  // ---------------------------------------------------------------- the installation's license key

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/license',
      tags,
      summary: 'The license key status: plan, seats, expiry, grace',
      middleware: guard,
      responses: { 200: status('Status'), ...errors(401, 404) },
    }),
    async (c) => c.json(await licenseStatus(db), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/platform/license',
      tags,
      summary: 'Install a license key (400 license_invalid if it is not in force here)',
      middleware: guard,
      request: jsonBody(installLicenseSchema),
      responses: { 200: status('Status'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await installLicense(db, currentUser(c), c.req.valid('json').key), 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/license',
      tags,
      summary: 'Remove the license key',
      middleware: guard,
      responses: { 200: status('Status'), ...errors(401, 404) },
    }),
    async (c) => c.json(await removeLicense(db, currentUser(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/license/check',
      tags,
      summary: 'Optional online check of the key: revoked? a renewed key? (409 when BINES_UPDATE_CHECK=false)',
      middleware: guard,
      responses: { 200: status('Status'), ...errors(401, 404, 409) },
    }),
    async (c) => c.json(await checkLicenseOnline(deps, currentUser(c)), 200),
  );

  // ---------------------------------------------------------------- licensing settings, registration

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/licensing',
      tags,
      summary: 'Licensing settings: instance id, license server, registration, telemetry (and what it sends)',
      middleware: guard,
      responses: { 200: settings('Settings'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getLicensingSettings(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/licensing',
      tags,
      summary: 'Change the license server address or the telemetry opt-in',
      middleware: guard,
      request: jsonBody(updateLicensingSettingsSchema),
      responses: { 200: settings('Settings'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updateLicensingSettings(deps, currentUser(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/registration/form',
      tags,
      summary: 'Whether registration is available here, and the license server Turnstile site key',
      middleware: guard,
      responses: { 200: json(registrationFormSchema, 'Form'), ...errors(401, 404) },
    }),
    async (c) => c.json(await registrationForm(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/registration',
      tags,
      summary: 'Send the registration questionnaire to the license server (a verification email follows)',
      middleware: guard,
      request: jsonBody(submitRegistrationSchema),
      responses: { 200: settings('Settings'), ...errors(400, 401, 404, 429) },
    }),
    async (c) => c.json(await submitRegistration(deps, currentUser(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/registration/skip',
      tags,
      summary: 'Skip the registration questionnaire (it is not asked again)',
      middleware: guard,
      responses: { 200: settings('Settings'), ...errors(401, 404) },
    }),
    async (c) => c.json(await skipRegistration(deps, currentUser(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/registration/reset',
      tags,
      summary: 'Ask the registration questionnaire again (the installed key is kept)',
      middleware: guard,
      responses: { 200: settings('Settings'), ...errors(401, 404) },
    }),
    async (c) => c.json(await resetRegistration(deps, currentUser(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/registration/poll',
      tags,
      summary: 'While pending: ask the license server for the key; installs it once the email is verified',
      middleware: guard,
      responses: {
        200: json(z.object({ settings: licensingSettingsSchema, license: licenseStatusSchema }), 'State'),
        ...errors(401, 404),
      },
    }),
    async (c) => c.json(await pollRegistrationHere(deps, currentUser(c)), 200),
  );

  // ---------------------------------------------------------------- license server: owner screens

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/license-server',
      tags,
      summary: 'Is this installation a license server (a signing key from the console or LICENSE_SIGNING_KEY)?',
      middleware: guard,
      responses: { 200: json(licenseServerStatusSchema, 'Status'), ...errors(401, 404) },
    }),
    async (c) => c.json(await licenseServerStatus(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/license-server/key',
      tags,
      summary: 'Become a license server: make an Ed25519 signing key here (409 while one is in force)',
      middleware: guard,
      responses: { 200: json(licenseServerStatusSchema, 'Status'), ...errors(401, 404, 409) },
    }),
    async (c) => c.json(await createSigningKey(deps, currentUser(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/license-server/key',
      tags,
      summary: "Remove the console's signing key (keys it signed stop verifying where they trusted it)",
      middleware: guard,
      responses: { 200: json(licenseServerStatusSchema, 'Status'), ...errors(401, 404) },
    }),
    async (c) => c.json(await removeSigningKey(deps, currentUser(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/installations',
      tags,
      summary: 'Registered installations (license server only), filtered',
      middleware: guard,
      request: { query: installationsQuerySchema },
      responses: { 200: json(z.object({ data: z.array(installationSchema) }), 'List'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listInstallationsDto(deps, c.req.valid('query')) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/installations/{id}/release',
      tags,
      summary: 'Let an installation that lost its registration secret register again (audited)',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(installationSchema, 'Released'), ...errors(401, 404) },
    }),
    async (c) => c.json(await releaseInstallation(deps, currentUser(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/installations.csv',
      tags,
      summary: 'Registered installations as CSV (same filters)',
      middleware: guard,
      request: { query: installationsQuerySchema },
      responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, ...errors(401, 404) },
    }),
    async (c) =>
      new Response(await installationsCsv(deps, c.req.valid('query')), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="installations.csv"',
        },
      }) as never,
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/licenses',
      tags,
      summary: 'Issued licenses (license server only)',
      middleware: guard,
      responses: { 200: json(z.object({ data: z.array(issuedLicenseSchema) }), 'List'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listLicenses(deps) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/licenses',
      tags,
      summary: 'Issue (sign) a license key',
      middleware: guard,
      request: jsonBody(issueLicenseSchema),
      responses: { 200: json(issuedLicenseSchema, 'Issued'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await issueLicense(deps, currentUser(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/licenses/{id}/renew',
      tags,
      summary: 'Renew a license: a new key, one more year',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(issuedLicenseSchema, 'Renewed'), ...errors(401, 404, 409) },
    }),
    async (c) => c.json(await renewLicense(deps, currentUser(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/licenses/{id}/plan',
      tags,
      summary: "Change a license's plan (a new key)",
      middleware: guard,
      request: { params: idParam, ...jsonBody(changeLicensePlanSchema) },
      responses: { 200: json(issuedLicenseSchema, 'Changed'), ...errors(400, 401, 404, 409) },
    }),
    async (c) =>
      c.json(await changeLicensePlan(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/licenses/{id}/revoke',
      tags,
      summary: 'Revoke a license (marked here; installations learn it on their online check)',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(issuedLicenseSchema, 'Revoked'), ...errors(401, 404) },
    }),
    async (c) => c.json(await revokeLicense(deps, currentUser(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/licenses/{id}/email',
      tags,
      summary: 'Email the license key (to its address, or another)',
      middleware: guard,
      request: { params: idParam, ...jsonBody(emailLicenseSchema) },
      responses: { 200: json(okSchema, 'Sent'), ...errors(400, 401, 404, 422) },
    }),
    async (c) => c.json(await emailLicense(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json').to), 200),
  );

  // ---------------------------------------------------------------- license server: public endpoints

  const pub = ['public'];
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/installations/config',
      tags: pub,
      summary: 'Public (license server): registration is available here; the Turnstile site key when it asks',
      responses: { 200: json(registrationFormSchema, 'Config'), ...errors(404) },
    }),
    async (c) => c.json(await publicRegistrationConfig(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/installations/register',
      tags: pub,
      summary: 'Public (license server): register an installation — a verification link is emailed; no key yet',
      request: jsonBody(publicRegisterSchema),
      responses: { 202: json(publicRegisterResultSchema, 'Pending verification'), ...errors(400, 404, 429) },
    }),
    async (c) =>
      c.json(
        await registerInstallation(deps, c.req.valid('json'), {
          ip: c.get('clientIp') ?? null,
          captchaToken: c.req.header(CAPTCHA_TOKEN_HEADER),
        }),
        202,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/installations/verify',
      tags: pub,
      summary: 'Public (license server): the emailed link — verifies the email and returns the Registered key',
      request: jsonBody(publicVerifySchema),
      responses: { 200: json(publicVerifyResultSchema, 'Key'), ...errors(400, 404, 429) },
    }),
    async (c) => c.json(await verifyRegistration(deps, c.req.valid('json').token, c.get('clientIp') ?? null), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/installations/status',
      tags: pub,
      summary: 'Public (license server): has the registration been verified? (its key once it has)',
      request: jsonBody(publicPollSchema),
      responses: { 200: json(publicPollResultSchema, 'Status'), ...errors(400, 404, 429) },
    }),
    async (c) => c.json(await pollRegistration(deps, c.req.valid('json'), c.get('clientIp') ?? null), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/installations/heartbeat',
      tags: pub,
      summary: 'Public (license server): an opted-in installation’s daily numbers (version, active users, boards)',
      request: jsonBody(heartbeatSchema),
      responses: { 200: json(okSchema, 'Recorded'), ...errors(400, 404, 429) },
    }),
    async (c) => c.json(await recordHeartbeat(deps, c.req.valid('json'), c.get('clientIp') ?? null), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/licenses/key',
      tags: pub,
      summary: "Public (license server): this server's public key, for the installations it issues keys to",
      responses: { 200: json(publicLicenseKeySchema, 'Key'), ...errors(404) },
    }),
    async (c) => {
      const signer = await signerOr404(deps);
      return c.json({ public_key: publicKeyPem(signer.publicKey), fingerprint: keyFingerprint(signer.publicKey) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/licenses/check',
      tags: pub,
      summary: 'Public (license server): is a key revoked, and is there a newer one for this installation?',
      request: jsonBody(publicLicenseCheckSchema),
      responses: { 200: json(publicLicenseCheckResultSchema, 'Verdict'), ...errors(400, 404, 429) },
    }),
    async (c) => c.json(await checkLicense(deps, c.req.valid('json'), c.get('clientIp') ?? null), 200),
  );

  // --------------------------------------------------------------- license operations

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/license-ops',
      tags,
      summary: 'License server: expiry reminders and the optional online purchase (secrets: only whether set)',
      middleware: guard,
      responses: { 200: json(licenseOpsSchema, 'Settings'), ...errors(401, 404) },
    }),
    async (c) => {
      await signerOr503(deps);
      return c.json(await licenseOpsDto(deps, await loadLicenseOps(deps)), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/license-ops',
      tags,
      summary: 'Change the reminders or the payment provider (422 payments_not_ready when turned on unready)',
      middleware: guard,
      request: jsonBody(updateLicenseOpsSchema),
      responses: { 200: json(licenseOpsSchema, 'Settings'), ...errors(400, 401, 404, 422) },
    }),
    async (c) => {
      await signerOr503(deps);
      return c.json(await updateLicenseOps(deps, currentUser(c), c.req.valid('json')), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/licenses/purchase',
      tags: pub,
      summary: 'Public (license server): can a license be bought here, and which editions (available: false = no)',
      responses: { 200: json(publicPurchaseConfigSchema, 'Config'), ...errors(404) },
    }),
    async (c) => c.json(await publicPurchaseConfig(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/licenses/checkout',
      tags: pub,
      summary: "Public (license server): start a purchase — the payment provider's hosted page (rate-limited)",
      request: jsonBody(publicCheckoutSchema),
      responses: { 200: json(publicCheckoutResultSchema, 'Checkout'), ...errors(400, 404, 422, 429) },
    }),
    async (c) => c.json(await createCheckout(deps, c.req.valid('json'), c.get('clientIp') ?? null), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/public/licenses/webhook/{provider}',
      tags: pub,
      summary: "Public (license server): the payment provider's webhook (signature-verified; each event once)",
      request: {
        params: z.object({
          provider: z
            .string()
            .max(40)
            .openapi({ param: { name: 'provider', in: 'path' } }),
        }),
      },
      responses: {
        200: json(z.object({ received: z.boolean(), handled: z.string() }), 'Handled'),
        ...errors(400, 401, 404),
      },
    }),
    async (c) => {
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => (headers[k] = v));
      return c.json(await handlePaymentWebhook(deps, c.req.valid('param').provider, await c.req.text(), headers), 200);
    },
  );

  return r;
};
