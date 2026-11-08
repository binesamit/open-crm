// SPDX-License-Identifier: AGPL-3.0-only
import { createAuthClient } from 'better-auth/react';
import { magicLinkClient, twoFactorClient } from 'better-auth/client/plugins';

/**
 * Better Auth lives on the same origin under /api/auth (the API serves the SPA in production; Vite proxies in dev).
 * Two-factor (M8 ד12): the login page itself shows the code step when a sign-in answers `twoFactorRedirect`.
 */
export const authClient = createAuthClient({ basePath: '/api/auth', plugins: [magicLinkClient(), twoFactorClient()] });

export const INVITE_TOKEN_HEADER = 'x-invite-token';
