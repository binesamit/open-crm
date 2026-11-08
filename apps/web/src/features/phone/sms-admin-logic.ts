// SPDX-License-Identifier: AGPL-3.0-only
/** Administration → SMS: small pure helpers (tested in sms-admin-logic.test.ts). */

/** A budget as typed: a whole number from 1 to `max`, else null (the save button stays off). */
export const parseSmsLimit = (raw: string, max: number): number | null => {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
};

/** A new template's id (`[a-zA-Z0-9_-]{1,40}`), never one already used. */
export const nextTemplateId = (used: string[]): string => {
  const taken = new Set(used);
  for (let i = used.length + 1; ; i++) {
    const id = `tpl_${i}`;
    if (!taken.has(id)) return id;
  }
};
