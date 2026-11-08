// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from '@tanstack/react-router';
import { t, type MyAccount } from '@bines/shared';
import { Card } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { Teams } from '../account/Teams';
import { Templates } from '../account/Templates';
import { AccountNotificationDefaults } from '../notifications/NotificationSettingsPage';
import { TokensPage } from '../tokens/TokensPage';
import { AdminAudit } from './AdminAudit';
import { AdminHealth } from './AdminHealth';
import { AdminGeneral } from './AdminGeneral';
import { AdminSecurity } from './AdminSecurity';
import { AdminTidy } from './AdminTidy';
import { AdminUsage } from './AdminUsage';
import { AdminPlan } from './AdminPlan';
import { AdminAi } from '../ai/AdminAi';
import { UsersAdminPage } from './users/UsersAdminPage';
import { AdminNextStage, type AdminSection } from './AdminHub';
import { MapSettingsCard } from '../maps/MapSettingsCard';
import { ExtensionsAdmin } from '../extensions/ExtensionsAdmin';
import { FlowsPage } from '../flows/FlowsPage';
import { h2 } from './admin-parts';
import { SessionChecksCard } from './SessionChecksCard';
import { InboundEmailCard } from './InboundEmailCard';
import { AdminNavLayout } from '../shell/NavLayoutSettings';

/**
 * חיבורים: the home of API tokens (product decision, A3) — every member's and the service tokens, create / revoke — and where
 * webhooks live (per board). /settings/tokens opens here for admins.
 */
const AdminConnections = ({ account }: { account: MyAccount }) => (
  <div className="space-y-4" data-testid="admin-connections">
    <TokensPage account={account} embedded />
    <Card>
      <div className="flex flex-wrap items-center gap-3" data-testid="admin-webhooks">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-heading">
          <Icon name="link" size={18} />
        </span>
        <div className="min-w-0 flex-1 basis-60 space-y-0.5">
          <h2 className={h2}>{t('admin.connections.webhooks')}</h2>
          <p className="text-sm text-muted">{t('admin.connections.webhooksBody')}</p>
        </div>
        <Link
          to="/a/$accountSlug/automations"
          params={{ accountSlug: account.slug }}
          data-testid="admin-webhooks-automations"
          className="press inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] whitespace-nowrap text-heading hover:bg-surface-2"
        >
          <Icon name="bolt" size={14} />
          {t('admin.connections.automations')}
        </Link>
      </div>
    </Card>
    <MapSettingsCard account={account} />
    <SessionChecksCard account={account} />
    <InboundEmailCard account={account} />
  </div>
);

/** One section of the hub, by its id in the URL (`/admin/<section>`). */
export const AdminSectionPage = ({ account, section }: { account: MyAccount; section: AdminSection }) => {
  switch (section) {
    case 'general':
      return <AdminGeneral account={account} />;
    case 'users':
      return <UsersAdminPage account={account} />;
    case 'teams':
      return <Teams account={account} />;
    case 'templates':
      return <Templates account={account} />;
    case 'connections':
      return <AdminConnections account={account} />;
    case 'notifications':
      return <AccountNotificationDefaults account={account} />;
    case 'appearance':
      return <AdminNavLayout account={account} />;
    case 'security':
      return <AdminSecurity account={account} />;
    case 'flows':
      return <FlowsPage account={account} />;
    case 'extensions':
      return <ExtensionsAdmin account={account} />;
    case 'ai':
      return <AdminAi account={account} />;
    case 'usage':
      return <AdminUsage account={account} />;
    case 'plan':
      return <AdminPlan account={account} />;
    case 'tidy':
      return <AdminTidy account={account} />;
    case 'audit':
      return <AdminAudit account={account} />;
    case 'health':
      return <AdminHealth account={account} />;
    default:
      return <AdminNextStage section={section} />;
  }
};
