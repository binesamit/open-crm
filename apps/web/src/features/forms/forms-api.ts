// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Form, PublicForm, PublicSubmitInput, UpdateFormInput } from '@bines/shared';
import { api } from '../../lib/api';
import { publicWebOrigin } from '../../lib/public-address';

/** Public forms (M11): the editor's form (a form view) and the public page's calls. */
export const formKeys = {
  form: (accountId: string, viewId: string) => ['account', accountId, 'form', viewId] as const,
  public: (token: string) => ['public-form', token] as const,
};

export const useForm = (accountId: string, viewId: string) =>
  useQuery({
    queryKey: formKeys.form(accountId, viewId),
    queryFn: () => api(accountId).get<Form>(`/views/${viewId}/form`),
  });

export const useFormMutations = (accountId: string, viewId: string) => {
  const qc = useQueryClient();
  const key = formKeys.form(accountId, viewId);
  const put = (form: Form) => qc.setQueryData(key, form);
  return {
    save: useMutation({
      mutationFn: (patch: UpdateFormInput) => api(accountId).patch<Form>(`/views/${viewId}/form`, patch),
      onSuccess: put,
    }),
    regenerate: useMutation({
      mutationFn: () => api(accountId).post<Form>(`/views/${viewId}/form/token`),
      onSuccess: put,
    }),
  };
};

/** The page's calls carry no account header: the token names the form (a members-only form uses the session). */
export const fetchPublicForm = (token: string) => api().get<PublicForm>(`/public/forms/${token}`);

export const submitPublicForm = (token: string, input: PublicSubmitInput) =>
  api().post<{ ok: true; message: string; redirect_url: string | null }>(`/public/forms/${token}/submit`, input);

/** presign → PUT straight to storage (bytes never pass through our API); the id goes with the answers. */
export const uploadFormFile = async (token: string, questionId: string, file: File): Promise<string> => {
  const mime = file.type || 'application/octet-stream';
  const pre = await api().post<{ upload_id: string; upload_url: string; headers: Record<string, string> }>(
    `/public/forms/${token}/uploads`,
    { question_id: questionId, name: file.name, size: file.size, mime },
  );
  const put = await fetch(pre.upload_url, { method: 'PUT', headers: pre.headers, body: file });
  if (!put.ok) throw new Error(`upload_failed_${put.status}`);
  return pre.upload_id;
};

/** The full public link of a form, on the platform's public address (M11). */
export const publicFormUrl = (token: string) => `${publicWebOrigin()}/f/${token}`;

/** The iframe snippet to embed a form on another site (works only when the form allows embedding). */
export const embedSnippet = (token: string, title: string) =>
  `<iframe src="${publicFormUrl(token)}" title="${title.replace(/"/g, '&quot;')}" width="100%" height="800" style="border:0;max-width:720px" loading="lazy"></iframe>`;
