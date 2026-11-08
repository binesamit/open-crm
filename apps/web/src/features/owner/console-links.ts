// SPDX-License-Identifier: AGPL-3.0-only
import { useNavigate } from '@tanstack/react-router';
import type { OwnerSection } from './console-sections';
import { scrollBehavior } from '@bines/ui';

/**
 * Where a setting is fixed in the owner console — for the sign-up card's readiness list and the "first steps" card.
 * Each lives in one section of the console: the jump opens that section and scrolls to the panel.
 */
export type ConsoleTarget =
  'email' | 'captcha' | 'legal' | 'plans' | 'signup' | 'signup-plan' | 'signup-methods' | 'licensing';

/** The section, and the panels by their test id; the first one on the page wins (email: the "email is off" notice). */
const PANELS: Record<ConsoleTarget, { section: OwnerSection; ids: string[] }> = {
  email: { section: 'email', ids: ['owner-email-off', 'owner-senders'] },
  captcha: { section: 'security', ids: ['owner-captcha'] },
  legal: { section: 'legal', ids: ['owner-legal'] },
  plans: { section: 'plans', ids: ['owner-plans'] },
  signup: { section: 'signup', ids: ['signup-settings'] },
  'signup-plan': { section: 'signup', ids: ['signup-set-plan', 'signup-settings'] },
  'signup-methods': { section: 'signup', ids: ['signup-set-methods', 'signup-settings'] },
  licensing: { section: 'licensing', ids: [] },
};

export const scrollToPanel = (ids: string[]) => {
  for (const id of ids) {
    const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!el) continue;
    el.scrollIntoView?.({ behavior: scrollBehavior(), block: 'start' });
    return true;
  }
  return false;
};

/** Scroll once the section's panel has loaded: try every 100 ms, for up to 3 seconds. */
const scrollWhenShown = (ids: string[], tries = 30) => {
  if (!ids.length || scrollToPanel(ids) || tries <= 0) return;
  setTimeout(() => scrollWhenShown(ids, tries - 1), 100);
};

/** `jump(target)`: take the owner to where that setting is made. */
export const useConsoleJump = () => {
  const navigate = useNavigate();
  return (target: ConsoleTarget) => {
    const { section, ids } = PANELS[target];
    void navigate({ to: '/owner', search: { section } }).then(() => scrollWhenShown(ids));
  };
};
