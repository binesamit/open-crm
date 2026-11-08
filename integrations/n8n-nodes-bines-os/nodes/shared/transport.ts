// SPDX-License-Identifier: MIT
import {
  NodeApiError,
  type IDataObject,
  type IExecuteFunctions,
  type IHookFunctions,
  type IHttpRequestMethods,
  type IHttpRequestOptions,
  type ILoadOptionsFunctions,
  type JsonObject,
} from 'n8n-workflow';
import { API_PREFIX, CREDENTIAL_NAME } from './constants';

export type Ctx = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions;

/** `https://crm.example.com/` or `https://crm.example.com/api/v1` → `https://crm.example.com`. */
export const normalizeBaseUrl = (url: string): string =>
  url
    .trim()
    .replace(/\/+$/, '')
    .replace(new RegExp(`${API_PREFIX.replace(/\//g, '\\/')}$`), '');

/** One authenticated call to the REST API (`path` starts with `/`, relative to `/api/v1`). */
export async function apiRequest(
  this: Ctx,
  method: IHttpRequestMethods,
  path: string,
  body?: IDataObject | IDataObject[],
  qs?: IDataObject,
  itemIndex?: number,
): Promise<IDataObject> {
  const credentials = await this.getCredentials(CREDENTIAL_NAME);
  const options: IHttpRequestOptions = {
    method,
    url: `${normalizeBaseUrl(String(credentials.baseUrl ?? ''))}${API_PREFIX}${path}`,
    json: true,
    ...(body !== undefined ? { body } : {}),
    ...(qs && Object.keys(qs).length ? { qs } : {}),
  };
  try {
    return (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_NAME, options)) as IDataObject;
  } catch (error) {
    throw new NodeApiError(this.getNode(), error as JsonObject, itemIndex !== undefined ? { itemIndex } : {});
  }
}

/** Every page of a cursor-paged POST query (`next_cursor`), up to `max` rows (0 = no limit). */
export async function apiQueryAll(
  this: Ctx,
  path: string,
  body: IDataObject,
  max: number,
  itemIndex?: number,
): Promise<IDataObject[]> {
  const out: IDataObject[] = [];
  let cursor: string | null | undefined;
  do {
    const page: IDataObject = await apiRequest.call(
      this,
      'POST',
      path,
      { ...body, limit: max ? Math.min(500, max - out.length) : 500, ...(cursor ? { cursor } : {}) },
      undefined,
      itemIndex,
    );
    out.push(...((page.data as IDataObject[] | undefined) ?? []));
    cursor = page.next_cursor as string | null | undefined;
  } while (cursor && (!max || out.length < max));
  return max ? out.slice(0, max) : out;
}
