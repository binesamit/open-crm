// SPDX-License-Identifier: MIT
import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';
import { API_PREFIX, CREDENTIAL_NAME, PRODUCT_NAME } from '../nodes/shared/constants';

/** Instance URL + a personal API token (Settings → API tokens). OAuth comes later. */
export class BinesOsApi implements ICredentialType {
  name = CREDENTIAL_NAME;

  displayName = `${PRODUCT_NAME} API`;

  icon = 'file:binesOs.svg' as const;

  documentationUrl = 'https://www.npmjs.com/package/n8n-nodes-bines-os';

  properties: INodeProperties[] = [
    {
      displayName: 'Instance URL',
      name: 'baseUrl',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://crm.example.com',
      description: `The address you open ${PRODUCT_NAME} at`,
    },
    {
      displayName: 'API Token',
      name: 'apiToken',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'A personal API token (bos_pat_…). Give it the scopes the workflow needs: boards:read, items:write, updates:write, webhooks (triggers), users:read, agents:run (Run AI agent).',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: { headers: { Authorization: '=Bearer {{$credentials.apiToken}}' } },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: `={{$credentials.baseUrl.trim().replace(/\\/+$/, "").replace(/\\/api\\/v1$/, "")}}${API_PREFIX}`,
      url: '/auth/me',
    },
  };
}
