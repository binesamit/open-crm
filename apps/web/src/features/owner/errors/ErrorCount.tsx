// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from '@bines/ui';
import type { Me } from '../../../lib/api';
import { useErrorAlerts } from './errors-api';

/** Who may see the errors hub (the `/owner` route's own check): the platform owner and support staff. */
export const seesErrorHub = (me: Me) => !!(me.user.is_platform_owner || me.user.support_role);

/**
 * The errors hub's count pill (product decision: no always-on icon in the top bar): next to the place the count
 * belongs — the console's "Errors & health" tab, its "Alerts" tab, Administration → Health. Nothing at zero.
 */
export const ErrorCount = ({ n, testId, className }: { n: number; testId?: string; className?: string }) =>
  n > 0 ? (
    <span
      data-testid={testId}
      className={cn(
        'grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[0.6875rem] font-bold text-white tabular-nums',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  ) : null;

/**
 * The unread error alerts sent to me (the console's alert rules with the "console" channel on). Only the owner and
 * support staff ask — everyone else makes no call and gets 0.
 */
export const useUnreadErrorAlerts = (me: Me) => useErrorAlerts(seesErrorHub(me)).data?.unread ?? 0;
