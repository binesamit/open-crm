// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import type {
  ErrorEnvelope,
  HelpArticleDetail,
  HelpArticleSummary,
  HelpAsset,
  HelpConsoleConfig,
  HelpImportReport,
  HelpMetrics,
} from '@bines/shared';
import { api } from '../../../lib/api';

/** Owner console → Support → Knowledge: query keys and hooks. */
export const helpConsoleKeys = {
  all: ['platform', 'help'] as const,
  config: ['platform', 'help', 'config'] as const,
  articles: (filters: Record<string, string>) => ['platform', 'help', 'articles', filters] as const,
  article: (id: string) => ['platform', 'help', 'article', id] as const,
  versions: (id: string) => ['platform', 'help', 'versions', id] as const,
  metrics: (days: number) => ['platform', 'help', 'metrics', days] as const,
  accountAi: (id: string) => ['platform', 'help', 'account-ai', id] as const,
};

export const useHelpConsoleConfig = () =>
  useQuery({
    queryKey: helpConsoleKeys.config,
    queryFn: () => api().get<HelpConsoleConfig>('/platform/support/help/config'),
  });

export const useHelpArticles = (filters: Record<string, string>) =>
  useQuery({
    queryKey: helpConsoleKeys.articles(filters),
    queryFn: () => {
      const p = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
      return api().get<{ data: HelpArticleSummary[] }>(`/platform/support/help/articles?${p.toString()}`);
    },
  });

export const useHelpArticleDetail = (id: string | null) =>
  useQuery({
    queryKey: helpConsoleKeys.article(id ?? ''),
    queryFn: () => api().get<HelpArticleDetail>(`/platform/support/help/articles/${id}`),
    enabled: !!id,
  });

/**
 * A multipart POST to the API (kb-import: images and knowledge packages travel in the request). The SDK client sends
 * JSON only; errors come back as the same `ApiError` it throws.
 */
export const postFiles = async <T>(path: string, files: File[], field = 'files'): Promise<T> => {
  const form = new FormData();
  for (const f of files) form.append(field, f, f.name);
  const res = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { accept: 'application/json' },
    body: form,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      (json as ErrorEnvelope | undefined)?.error ?? {
        code: 'unavailable',
        message: res.statusText || 'unavailable',
        request_id: '',
      },
    );
  return json as T;
};

/** An image for an article: stored on the platform (the same file once). */
export const uploadHelpImage = (file: File) => postFiles<HelpAsset>('/platform/support/help/assets', [file], 'file');

/** A knowledge package: `dryRun` previews what would change. */
export const importHelpPackage = (files: File[], dryRun: boolean) =>
  postFiles<HelpImportReport>(`/platform/support/help/import${dryRun ? '?dry_run=1' : ''}`, files);

/** Downloads every article as a package (.zip), without leaving the page. */
export const exportHelpPackage = async () => {
  const res = await fetch('/api/v1/platform/support/help/export', { credentials: 'include' });
  if (!res.ok) {
    const json = (await res.json().catch(() => undefined)) as ErrorEnvelope | undefined;
    throw new ApiError(res.status, json?.error ?? { code: 'unavailable', message: res.statusText, request_id: '' });
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'help-center.zip';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export const useHelpMetrics = (days: number) =>
  useQuery({
    queryKey: helpConsoleKeys.metrics(days),
    queryFn: () => api().get<HelpMetrics>(`/platform/support/help/metrics?days=${days}`),
  });
