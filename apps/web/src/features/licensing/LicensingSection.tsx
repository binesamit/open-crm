// SPDX-License-Identifier: AGPL-3.0-only
import { type InstallGuideSection, t } from '@bines/shared';
import { Card } from '@bines/ui';
import { LicenseCard } from '../owner/LicenseCard';
import { LicensingSettingsCard } from './LicensingSettingsCard';
import { InstallationsPanel, LicenseServerCard, LicensesPanel } from './LicenseServerPanels';
import { LicenseOpsCards } from './LicenseOpsCards';

/**
 * Owner console → Licensing (docs/LICENSING.md): this installation's license and its settings, what a key means,
 * and the license server: any installation becomes one from here (a signing key), then Installations and Licenses.
 */
export const LicensingSection = ({ onGuide }: { onGuide?: (section: InstallGuideSection) => void }) => (
  <div className="space-y-4" data-testid="owner-licensing">
    <LicenseCard onGuide={onGuide} />
    <LicensingSettingsCard />
    <EditionsCard />
    <LicenseServerCard />
    <InstallationsPanel />
    <LicensesPanel />
    <LicenseOpsCards />
  </div>
);

/** Every capability is open on every installation; a key only records a provider's plan, seats and support level. */
const EditionsCard = () => (
  <Card className="space-y-1" data-testid="editions">
    <h3 className="text-sm font-semibold text-fg">{t('licensing.editions.title')}</h3>
    <p className="max-w-[640px] text-xs text-muted">{t('licensing.editions.hint')}</p>
  </Card>
);
