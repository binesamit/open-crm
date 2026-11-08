// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type FlowPlatform } from '@bines/shared';
import { makeAdapter } from './make';
import { n8nAdapter } from './n8n';
import type { FlowAdapter, FlowErrorReporter, FlowHttp } from './types';
import { zapierAdapter } from './zapier';

export type { FlowAdapter, FlowErrorReporter, FlowHttp } from './types';

/** Where a connection lives (`flow_connections.config`) — never secret. */
export type FlowConfig = { base_url?: string; zone?: string; team_id?: number };

/** The adapter of a connection: its platform, config and (opened) secret. A new platform = one more case here. */
export const adapterFor = (
  platform: FlowPlatform,
  config: FlowConfig,
  secret: string,
  http: FlowHttp,
  onFlowError?: FlowErrorReporter,
): FlowAdapter => {
  const report = onFlowError ? { onFlowError } : {};
  switch (platform) {
    case 'n8n':
      return n8nAdapter({ baseUrl: config.base_url ?? '', apiKey: secret, http, ...report });
    case 'make':
      return makeAdapter({ zone: config.zone ?? '', teamId: config.team_id ?? 0, apiToken: secret, http, ...report });
    case 'zapier':
      return zapierAdapter({ accessToken: secret, http, ...report });
    default:
      throw new AppError('invalid_value', 'flow_platform_unknown');
  }
};

/** The address shown for a connection (and checked against SSRF). */
export const baseUrlOf = (platform: FlowPlatform, config: FlowConfig) =>
  platform === 'n8n'
    ? (config.base_url ?? '')
    : platform === 'make'
      ? `https://${config.zone ?? ''}.make.com`
      : 'https://api.zapier.com';
