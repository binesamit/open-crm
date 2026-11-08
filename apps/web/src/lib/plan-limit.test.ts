// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { t } from '@bines/shared';
import {
  gateMenuEntry,
  hasPlanFeature,
  planGateAttrs,
  planGateHint,
  planGateOf,
  planUpgradeMenuEntries,
} from './plan-limit';

const account = (role: 'admin' | 'member', plan_features: string[] | null) => ({ role, slug: 'acme', plan_features });

describe('plan feature gates (c)', () => {
  it('a plan that lists no features includes every feature', () => {
    expect(hasPlanFeature(account('member', null), 'ai')).toBe(true);
    expect(hasPlanFeature(undefined, 'api')).toBe(true);
    expect(planGateAttrs(planGateOf(account('admin', null), 'flows'))).toEqual({});
  });

  it('a plan that lists features is limited to them', () => {
    const a = account('member', ['docs', 'api']);
    expect(planGateOf(a, 'api').allowed).toBe(true);
    expect(planGateOf(a, 'ai').allowed).toBe(false);
  });

  it('a gated control stays visible: aria-disabled with the upgrade hint as its tooltip', () => {
    const attrs = planGateAttrs(planGateOf(account('member', ['docs']), 'guests'));
    expect(attrs['aria-disabled']).toBe(true);
    expect(attrs['data-tip']).toBeTruthy();
    expect(attrs['data-plan-gated']).toBe('guests');
  });

  it('only admins may upgrade', () => {
    expect(planGateOf(account('admin', ['docs']), 'ai')).toMatchObject({ allowed: false, admin: true, slug: 'acme' });
    expect(planGateOf(account('member', ['docs']), 'ai').admin).toBe(false);
  });
});

describe('plan gates in menus (r18gates)', () => {
  const run = () => undefined;

  it('a gated row stays listed, disabled with the hint and a test id', () => {
    const gate = planGateOf(account('member', ['docs']), 'dashboards');
    const e = gateMenuEntry(gate, { label: 'x', onSelect: run }, 'new_dashboard');
    expect(e).toMatchObject({ disabled: true, testId: 'menu-new_dashboard' });
    expect('hint' in e && e.hint).toBeTruthy();
  });

  it('a legacy plan (no list) or an empty list leaves the row enabled', () => {
    for (const features of [null, []]) {
      const e = gateMenuEntry(planGateOf(account('admin', features), 'ai'), { label: 'x', onSelect: run, testId: 't' });
      expect(e).toEqual({ label: 'x', onSelect: run, testId: 't' });
    }
  });

  it('separators, labels and rows without a gate pass through', () => {
    expect(gateMenuEntry(undefined, { label: 'x', onSelect: run })).toEqual({ label: 'x', onSelect: run });
    expect(gateMenuEntry(planGateOf(account('admin', ['docs']), 'ai'), { kind: 'separator' })).toEqual({
      kind: 'separator',
    });
  });

  it('"Upgrade" is added once, for admins, only when something is gated', () => {
    const go = vi.fn();
    const gated = planGateOf(account('admin', ['docs']), 'ai');
    const rows = planUpgradeMenuEntries([undefined, gated, planGateOf(account('admin', ['docs']), 'forms')], go);
    expect(rows).toHaveLength(2);
    const upgrade = rows[1]!;
    expect(upgrade).toMatchObject({ testId: 'plan-upgrade-ai' });
    if (!upgrade.kind || upgrade.kind === 'item') upgrade.onSelect();
    expect(go).toHaveBeenCalledWith('/a/acme/admin/plan');
    expect(planUpgradeMenuEntries([planGateOf(account('member', ['docs']), 'ai')], go)).toEqual([]);
    expect(planUpgradeMenuEntries([planGateOf(account('admin', null), 'ai')], go)).toEqual([]);
  });
});

describe('AI and the plan status (plan-lock)', () => {
  const withStatus = (plan_status: string | null) =>
    ({ role: 'admin' as const, slug: 'acme', plan_features: null, plan_status }) as never;

  it('read-only, suspended and closed stop AI whatever the plan includes — with the status hint', () => {
    for (const status of ['read_only', 'suspended', 'closed']) {
      const gate = planGateOf(withStatus(status), 'ai');
      expect(gate).toMatchObject({ allowed: false, reason: 'status' });
      expect(planGateHint(gate)).toBe(t('plan.ai.blocked' as never));
      expect(planGateAttrs(gate)['data-tip']).toBe(t('plan.ai.blocked' as never));
      const row = gateMenuEntry(gate, { label: 'Assistant', onSelect: () => undefined }, 'assistant');
      expect(row).toMatchObject({ disabled: true, hint: t('plan.ai.blocked' as never) });
    }
  });

  it('other statuses leave AI to the plan; other features ignore the status', () => {
    for (const status of [null, 'trial', 'active', 'past_due'])
      expect(planGateOf(withStatus(status), 'ai').allowed).toBe(true);
    expect(planGateOf(withStatus('read_only'), 'docs').allowed).toBe(true);
    const lacking = planGateOf(
      { role: 'member', slug: 'a', plan_features: ['docs'], plan_status: 'active' } as never,
      'ai',
    );
    expect(lacking).toMatchObject({ allowed: false, reason: 'feature' });
    expect(planGateHint(lacking)).toBe(t('plan.feature.upgradeHint' as never));
  });
});
