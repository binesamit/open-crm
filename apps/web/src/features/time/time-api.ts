// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TimeEntry } from '@bines/shared';
import { api } from '../../lib/api';

/** Time tracking queries/mutations (03 §3.3). Any change refreshes boards (cell cache) and logs. */
export const timeKeys = {
  all: (accountId: string) => ['account', accountId, 'time'] as const,
  entries: (accountId: string, itemId: string) => ['account', accountId, 'time', 'entries', itemId] as const,
};

export const useTimeEntries = (accountId: string, itemId: string) =>
  useQuery({
    queryKey: timeKeys.entries(accountId, itemId),
    queryFn: () => api(accountId).get<{ data: TimeEntry[] }>(`/items/${itemId}/time/entries`),
  });

export type EntryInput = {
  column_id: string;
  started_at: string;
  ended_at?: string;
  duration_s?: number;
  note?: string;
};

export const useTimeMutations = (accountId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: timeKeys.all(accountId) });
    // Cells are caches of the entries: every board's items may show a changed total.
    await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
    await qc.invalidateQueries({ queryKey: ['account', accountId, 'item'] });
  };
  return {
    start: useMutation({
      mutationFn: (v: { itemId: string; columnId: string }) =>
        client.post<TimeEntry>(`/items/${v.itemId}/time/start`, { column_id: v.columnId }),
      onSuccess: refresh,
    }),
    stop: useMutation({
      mutationFn: (v: { itemId: string; columnId: string }) =>
        client.post<TimeEntry>(`/items/${v.itemId}/time/stop`, { column_id: v.columnId }),
      onSuccess: refresh,
    }),
    add: useMutation({
      mutationFn: (v: { itemId: string; input: EntryInput }) =>
        client.post<TimeEntry>(`/items/${v.itemId}/time/entries`, v.input),
      onSuccess: refresh,
    }),
    edit: useMutation({
      mutationFn: (v: { id: string; patch: Partial<Pick<TimeEntry, 'started_at' | 'ended_at' | 'note'>> }) =>
        client.patch<TimeEntry>(`/time/entries/${v.id}`, v.patch),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (id: string) => client.delete(`/time/entries/${id}`), onSuccess: refresh }),
  };
};

/** The current time, ticking every second while `active` (live timer counters). */
export const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
};

/** Seconds elapsed since an ISO time, never negative. */
export const since = (iso: string, now: number) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
