// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addBusinessMinutes, type BusinessHours, businessMinutesBetween, helpdeskSettingsSchema } from '../src';

/** Support SLA business hours (stage 5). */
const hours: BusinessHours = {
  timezone: 'UTC',
  days: [0, 1, 2, 3, 4].map((day) => ({ day, start: '09:00', end: '17:00' })), // Sun–Thu
  holidays: ['2026-10-08'],
};
const at = (iso: string) => new Date(iso);

describe('addBusinessMinutes', () => {
  it('stays inside a working day', () => {
    // 2026-10-05 is a Monday.
    expect(addBusinessMinutes(at('2026-10-05T10:00:00Z'), 60, hours).toISOString()).toBe('2026-10-05T11:00:00.000Z');
  });
  it('carries over to the next working day, skipping holidays and the weekend', () => {
    // Wed 16:30 + 60 min → Thu is a holiday → Fri/Sat off → Sun 09:30.
    expect(addBusinessMinutes(at('2026-10-07T16:30:00Z'), 60, hours).toISOString()).toBe('2026-10-11T09:30:00.000Z');
  });
  it('starts at the next opening when created outside hours', () => {
    expect(addBusinessMinutes(at('2026-10-05T20:00:00Z'), 30, hours).toISOString()).toBe('2026-10-06T09:30:00.000Z');
  });
  it('runs around the clock when the policy says so, or when no hours are set', () => {
    expect(addBusinessMinutes(at('2026-10-05T20:00:00Z'), 30, hours, false).toISOString()).toBe(
      '2026-10-05T20:30:00.000Z',
    );
    expect(addBusinessMinutes(at('2026-10-05T20:00:00Z'), 30, { ...hours, days: [] }).toISOString()).toBe(
      '2026-10-05T20:30:00.000Z',
    );
  });
  it('follows the timezone', () => {
    const jlm = { ...hours, timezone: 'Asia/Jerusalem' }; // UTC+3 in October 2026
    expect(addBusinessMinutes(at('2026-10-05T05:00:00Z'), 60, jlm).toISOString()).toBe('2026-10-05T07:00:00.000Z');
  });
});

describe('businessMinutesBetween', () => {
  it('counts only working minutes', () => {
    expect(businessMinutesBetween(at('2026-10-05T16:00:00Z'), at('2026-10-06T10:00:00Z'), hours)).toBe(120);
    expect(businessMinutesBetween(at('2026-10-05T16:00:00Z'), at('2026-10-06T10:00:00Z'), hours, false)).toBe(1080);
  });
});

describe('helpdesk settings', () => {
  it('has sensible defaults for everything', () => {
    const s = helpdeskSettingsSchema.parse({});
    expect(s.access).toMatchObject({ default_mode: 'view', default_duration_hours: 4 });
    expect(s.business_hours.days).toHaveLength(5);
    expect(s.csat.enabled).toBe(true);
    expect(s.number_start).toBe(1000);
  });
});
