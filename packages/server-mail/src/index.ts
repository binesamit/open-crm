// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-only email (D15): the mail transport and the Hebrew templates, shared by the API (auth, invitations)
 * and the worker (notifications, digest). Not in `@bines/shared`, which also runs in the browser.
 */
export * from './mailer';
export * from './templates';
export { deviceOf, type Hero } from './objects';
