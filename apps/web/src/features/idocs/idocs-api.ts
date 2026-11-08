// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  t,
  type IdocCertificate,
  type IdocDoc,
  type IdocEvent,
  type IdocSection,
  type IdocSettings,
  type IdocTemplate,
  type Locale,
  type MessageKey,
  type PublicIdoc,
  type PublicIdocRow,
} from '@bines/shared';
import { api } from '../../lib/api';
import { saveResponse } from '../../lib/download';
import { publicWebOrigin } from '../../lib/public-address';

/** Interactive documents: the app's calls (templates, an item's documents) and the public page's. */

/** The keys under a prefix (`idoc.b.` → every `idoc.b.*` key without it): helpers stay checked by the compiler. */
export type KeysUnder<P extends string> = MessageKey extends infer K ? (K extends `${P}${infer R}` ? R : never) : never;
/** A `t` for one family of keys, in the app's language. */
export const keysOf =
  <P extends string>(prefix: P) =>
  (key: KeysUnder<P>, vars?: Record<string, string | number>) =>
    t(`${prefix}${key}` as MessageKey, vars);

/** The page's own words in the document's language (`idoc.*`). */
export const it = (lang: Locale, key: KeysUnder<'idoc.'>, vars?: Record<string, string | number>) =>
  t(`idoc.${key}` as MessageKey, vars, lang);

export const idocKeys = {
  templates: (accountId: string, boardId?: string) => ['account', accountId, 'idoc-templates', boardId ?? ''] as const,
  itemDocs: (accountId: string, itemId: string) => ['account', accountId, 'item', itemId, 'idocs'] as const,
  doc: (accountId: string, id: string) => ['account', accountId, 'idoc', id] as const,
  events: (accountId: string, id: string) => ['account', accountId, 'idoc', id, 'events'] as const,
  certificate: (accountId: string, id: string) => ['account', accountId, 'signature', id] as const,
  public: (token: string) => ['public-idoc', token] as const,
};

export const useIdocTemplates = (accountId: string, boardId?: string) =>
  useQuery({
    queryKey: idocKeys.templates(accountId, boardId),
    queryFn: async () =>
      (await api(accountId).get<{ data: IdocTemplate[] }>(`/idoc-templates${boardId ? `?board_id=${boardId}` : ''}`))
        .data,
  });

export const useItemDocs = (accountId: string, itemId: string) =>
  useQuery({
    queryKey: idocKeys.itemDocs(accountId, itemId),
    queryFn: async () => (await api(accountId).get<{ data: IdocDoc[] }>(`/items/${itemId}/idocs`)).data,
  });

export const useDocEvents = (accountId: string, id: string, enabled = true) =>
  useQuery({
    queryKey: idocKeys.events(accountId, id),
    queryFn: async () => (await api(accountId).get<{ data: IdocEvent[] }>(`/idocs/${id}/events`)).data,
    enabled,
  });

export const useCertificate = (accountId: string, id: string | null) =>
  useQuery({
    queryKey: idocKeys.certificate(accountId, id ?? ''),
    queryFn: () => api(accountId).get<IdocCertificate>(`/signatures/${id}`),
    enabled: !!id,
  });

/** Every change to an item's documents refreshes its list (and the document itself). */
export const useDocMutations = (accountId: string, itemId: string) => {
  const qc = useQueryClient();
  const done = (doc?: IdocDoc) => {
    void qc.invalidateQueries({ queryKey: idocKeys.itemDocs(accountId, itemId) });
    if (doc) qc.setQueryData(idocKeys.doc(accountId, doc.id), doc);
  };
  const a = api(accountId);
  return {
    create: useMutation({
      mutationFn: (input: { template_id?: string; starter?: string; name?: string }) =>
        a.post<IdocDoc>(`/items/${itemId}/idocs`, input),
      onSuccess: done,
    }),
    save: useMutation({
      mutationFn: ({
        id,
        ...patch
      }: {
        id: string;
        name?: string;
        sections?: IdocSection[];
        settings?: IdocSettings;
      }) => a.patch<IdocDoc>(`/idocs/${id}`, patch),
      onSuccess: done,
    }),
    send: useMutation({
      mutationFn: ({ id, ...input }: { id: string; email?: string; no_email?: boolean }) =>
        a.post<IdocDoc>(`/idocs/${id}/send`, input),
      onSuccess: done,
    }),
    action: useMutation({
      mutationFn: ({ id, action }: { id: string; action: 'token' | 'revoke' | 'reopen' }) =>
        a.post<IdocDoc>(`/idocs/${id}/${action}`, {}),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => a.delete<{ ok: true }>(`/idocs/${id}`),
      onSuccess: () => done(),
    }),
  };
};

export const useTemplateMutations = (accountId: string) => {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['account', accountId, 'idoc-templates'] });
  const a = api(accountId);
  return {
    create: useMutation({
      mutationFn: (input: {
        name: string;
        board_id?: string | null;
        starter?: string;
        from_template_id?: string;
        from_doc_id?: string;
      }) => a.post<IdocTemplate>('/idoc-templates', input),
      onSuccess: done,
    }),
    save: useMutation({
      mutationFn: ({
        id,
        ...patch
      }: {
        id: string;
        name?: string;
        board_id?: string | null;
        sections?: IdocSection[];
        settings?: IdocSettings;
      }) => a.patch<IdocTemplate>(`/idoc-templates/${id}`, patch),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => a.delete<{ ok: true }>(`/idoc-templates/${id}`),
      onSuccess: done,
    }),
  };
};

export const previewDoc = (
  accountId: string,
  id: string,
  draft: { sections: IdocSection[]; settings: IdocSettings; audience?: 'guests' | 'members' },
) => api(accountId).post<PublicIdoc>(`/idocs/${id}/preview`, draft);

// ——— the public page ———

const keyStore = (token: string) => `idoc-key:${token}`;
/** The visitor key after a one-time code (kept for the tab's session only). */
export const visitorKey = (token: string): string | null => {
  try {
    return sessionStorage.getItem(keyStore(token));
  } catch {
    return null;
  }
};
export const keepVisitorKey = (token: string, key: string) => {
  try {
    sessionStorage.setItem(keyStore(token), key);
  } catch {
    // private mode: the key lives only in memory for this page
  }
};
const headers = (token: string, key?: string | null): Record<string, string> => {
  const k = key ?? visitorKey(token);
  return k ? { 'x-idoc-key': k } : {};
};

export const fetchPublicDoc = (token: string, key?: string | null) =>
  api().get<PublicIdoc>(`/public/idocs/${token}`, headers(token, key));
export const publicIdocCalls = (token: string, key: string | null) => {
  const h = headers(token, key);
  return {
    select: (input: { section_id: string; row?: string; selected?: boolean; qty?: number; all?: boolean }) =>
      api().post<{ section_id: string; rows: PublicIdocRow[] }>(`/public/idocs/${token}/select`, input, h),
    inputs: (input: { section_id: string; values: Record<string, string | number | boolean | null> }) =>
      api().post<{ ok: true }>(`/public/idocs/${token}/inputs`, input, h),
    ask: (input: { section_id: string | null; text: string; name?: string; parent_id?: string }) =>
      api().post<PublicIdoc>(`/public/idocs/${token}/questions`, input, h),
    sign: (input: {
      section_id: string;
      name: string;
      role?: string;
      consents: string[];
      drawing?: string;
      typed?: boolean;
      version: number;
    }) =>
      api().post<{ signed: { name: string; role: string | null; at: string }; sha256: string }>(
        `/public/idocs/${token}/sign`,
        input,
        h,
      ),
    startCode: () => api().post<{ email_hint: string }>(`/public/idocs/${token}/verify`, undefined, h),
    checkCode: (code: string) =>
      api().post<{ visitor_key: string; expires_at: string }>(`/public/idocs/${token}/verify/check`, { code }, h),
  };
};

/** The client's PDF download (the visitor key as a header), saved under the API's file name. */
export const downloadPublicPdf = async (token: string, key: string | null) =>
  saveResponse(await fetch(`/api/v1/public/idocs/${token}/pdf`, { headers: headers(token, key) }), 'document.pdf');

/** A file link of the page, with the visitor key when there is one (images cannot send headers). */
export const withKey = (url: string, token: string) => {
  const k = visitorKey(token);
  return k ? `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(k)}` : url;
};

export const publicDocUrl = (token: string) => `${publicWebOrigin()}/p/${token}`;
