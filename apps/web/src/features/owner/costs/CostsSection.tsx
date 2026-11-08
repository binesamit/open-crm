// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { type DateRange, formatDate, t } from '@bines/shared';
import { Button, Calendar, Segmented } from '@bines/ui';
import { Icon } from '../../../lib/icons';
import { Popover } from '../../board/cells/Popover';
import { CostAccounts } from './CostAccounts';
import { CostPrices } from './CostPrices';
import { CostSettings } from './CostSettings';
import { CostSources } from './CostSources';
import { CostsOverview } from './CostsOverview';
import { rangeOf, type RangeKey } from './costs-api';

type Tab = 'overview' | 'sources' | 'prices' | 'accounts' | 'settings';
const TABS: Tab[] = ['overview', 'sources', 'prices', 'accounts', 'settings'];
const PRESETS: Exclude<RangeKey, 'custom'>[] = ['month', 'lastMonth', 'd30', 'd90'];

/** The period: presets, or any range from the app's own calendar (never the browser's). */
const RangeBar = ({
  range,
  preset,
  onPreset,
  onCustom,
}: {
  range: { from: string; to: string };
  preset: RangeKey;
  onPreset: (p: Exclude<RangeKey, 'custom'>) => void;
  onCustom: (r: { from: string; to: string }) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>({ from: null, to: null });
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="costs-range">
      <Segmented
        value={preset === 'custom' ? ('' as RangeKey) : preset}
        label={t('costs.range.custom')}
        onChange={(p) => onPreset(p as Exclude<RangeKey, 'custom'>)}
        options={PRESETS.map((p) => ({ value: p, label: t(`costs.range.${p}`), testId: `costs-range-${p}` }))}
      />
      <span className="relative">
        <Button
          size="sm"
          variant={preset === 'custom' ? 'accent' : 'ghost'}
          onClick={() => {
            setDraft({ from: null, to: null });
            setOpen((v) => !v);
          }}
          data-testid="costs-range-custom"
        >
          <Icon name="calendar" size={16} />
          {preset === 'custom' ? `${formatDate(range.from)} – ${formatDate(range.to)}` : t('costs.range.custom')}
        </Button>
        <Popover open={open} onClose={() => setOpen(false)} align="start" className="p-2">
          <Calendar
            mode="range"
            value={draft}
            onChange={(r) => {
              setDraft(r);
              if (r.from && r.to) {
                onCustom({ from: r.from, to: r.to });
                setOpen(false);
              }
            }}
          />
        </Popover>
      </span>
    </div>
  );
};

/**
 * Owner console → Costs: what the platform costs — the overview, the sources it is read from, the
 * unit prices, each account's share and the settings. Everything here is the owner's to set; nothing is fixed.
 */
export const CostsSection = () => {
  const [tab, setTab] = useState<Tab>('overview');
  const [preset, setPreset] = useState<RangeKey>('month');
  const [range, setRange] = useState(rangeOf('month'));
  const [priceFor, setPriceFor] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const withRange = tab === 'overview' || tab === 'accounts';
  return (
    <section className="space-y-3" data-testid="owner-costs">
      <header className="space-y-0.5">
        <h2 className="font-display text-base font-bold text-heading">{t('costs.title')}</h2>
        <p className="max-w-[720px] text-xs text-muted">{t('costs.hint')}</p>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={tab}
          label={t('costs.title')}
          onChange={setTab}
          options={TABS.map((x) => ({ value: x, label: t(`costs.tab.${x}`), testId: `costs-tab-${x}` }))}
          testId="costs-tabs"
        />
        {withRange ? (
          <RangeBar
            range={range}
            preset={preset}
            onPreset={(p) => {
              setPreset(p);
              setRange(rangeOf(p));
            }}
            onCustom={(r) => {
              setPreset('custom');
              setRange(r);
            }}
          />
        ) : null}
      </div>
      {tab === 'overview' ? (
        <CostsOverview
          from={range.from}
          to={range.to}
          onAddPrice={(metric) => {
            setPriceFor(metric);
            setTab('prices');
          }}
          onOpenSources={(add) => {
            setConnect(add);
            setTab('sources');
          }}
        />
      ) : null}
      {tab === 'sources' ? <CostSources addOpen={connect} onAddClosed={() => setConnect(false)} /> : null}
      {tab === 'prices' ? <CostPrices addFor={priceFor} onAddClosed={() => setPriceFor(null)} /> : null}
      {tab === 'accounts' ? <CostAccounts from={range.from} to={range.to} /> : null}
      {tab === 'settings' ? <CostSettings /> : null}
    </section>
  );
};
