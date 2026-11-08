// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import type { LicenseServerStatus, LicenseStatus, LicensingSettings, RegistrationForm } from '@bines/shared';
import { api } from '../../lib/api';

/** Licensing (docs/LICENSING.md): the owner console's query keys and reads. */
export const licensingKeys = {
  license: ['platform', 'license'] as const,
  settings: ['platform', 'licensing'] as const,
  form: ['platform', 'registration', 'form'] as const,
  server: ['platform', 'license-server'] as const,
  installations: (q: string) => ['platform', 'installations', q] as const,
  licenses: ['platform', 'licenses'] as const,
  ops: ['platform', 'license-ops'] as const,
};

export const useLicensingSettings = (enabled = true) =>
  useQuery({
    queryKey: licensingKeys.settings,
    queryFn: () => api().get<LicensingSettings>('/platform/licensing'),
    enabled,
    staleTime: 60_000,
    retry: false,
  });

export const useLicenseStatus = () =>
  useQuery({ queryKey: licensingKeys.license, queryFn: () => api().get<LicenseStatus>('/platform/license') });

export const useRegistrationForm = (enabled: boolean) =>
  useQuery({
    queryKey: licensingKeys.form,
    queryFn: () => api().get<RegistrationForm>('/platform/registration/form'),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });

export const useLicenseServer = () =>
  useQuery({
    queryKey: licensingKeys.server,
    queryFn: () => api().get<LicenseServerStatus>('/platform/license-server'),
    staleTime: 5 * 60_000,
  });

/** A file from a platform route (no account), saved under `filename`. */
export const downloadPlatformFile = async (path: string, filename: string) => {
  const res = await fetch(`/api/v1${path}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
