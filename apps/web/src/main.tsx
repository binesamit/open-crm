// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createAppRouter } from './app/router';
import { DialogHost } from './lib/dialogs';
import { ToastHost } from './lib/toast';
import { ShortcutsHost } from './features/shell/Shortcuts';
import { applyPalette, applyTheme, installTypingDir, TooltipHost } from '@bines/ui';
import { storedPalette, storedTheme } from './lib/theme';
import { applyAppearance, applyMotion, storedAppearance } from './lib/appearance';
import { installMotion } from './lib/motion';
import { applyLocale, initialLocale, useLocale } from './lib/locale';
import { useRegionKey } from './lib/region';
import { initMonitoring, reportError } from './lib/monitoring';
import { installClientErrorBuffer, setClientErrorSender } from './lib/client-errors';
import { api } from './lib/api';
import { AppErrorBoundary } from './lib/error-screen';
import { reloadForNewVersion } from './lib/errors';
import { planLimitMutationCache } from './lib/plan-limit';
import { PwaGlobalHost } from './pwa/PwaHosts';
import { loadPublicAddress } from './lib/public-address';
import { BrandTitleHost } from './lib/branding';
import './app/styles.css';
import { StepUpHost } from './features/secrets/step-up';

// GlitchTip (roadmap ס4): on only when VITE_SENTRY_DSN was set at build time.
initMonitoring();
// Support tickets: the last errors of this tab, offered (and removable) when opening a ticket.
installClientErrorBuffer();
// Errors hub: those errors also reach support automatically (sampled, scrubbed; the owner's settings).
setClientErrorSender((body) => api().post<{ enabled: boolean; sample_rate: number }>('/client-errors', body));
// Round 12: a deploy replaced the code files this tab was started with — a page's chunk (or its CSS) fails to load.
// Reload once to the new version instead of crashing (`lib/errors.ts`); a second failure shows the error screen.
window.addEventListener('vite:preloadError', (e) => {
  if (reloadForNewVersion()) e.preventDefault();
});
applyTheme(storedTheme());
// Round 12: the colour theme (palette) — F4 unless one was chosen.
applyPalette(storedPalette());
// Round 13: the text size and table density this device last had (the user's, synced after sign-in).
applyAppearance(storedAppearance());
// r16motion: the animations setting on <html data-motion> (full / reduced / off), and the checkbox tick's pop.
applyMotion(storedAppearance().motion);
installMotion();
// Before sign-in: the language used last here, else the browser's; GET /auth/me then sets the user's (fix3).
applyLocale(initialLocale());
// rtltype: every text field starts typing on the UI's side (right in Hebrew) and turns ltr for English text.
installTypingDir();
// M11: the platform's public address for copied links (owner console), fetched once.
void loadPublicAddress();

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
    // PWA (פ2): a write without a connection fails at once — never queued to run later over someone else's change.
    mutations: { networkMode: 'always' },
  },
  // Plans: a plan limit anywhere → one friendly toast with the upgrade link (lib/plan-limit.ts).
  mutationCache: planLimitMutationCache(
    () => queryClient,
    (path) => void router.navigate({ to: path }),
  ),
});
const router = createAppRouter(queryClient);
// Route errors land on our error screen (`defaultErrorComponent`, app/router.tsx); report them too.
router.update({ ...router.options, defaultOnCatch: (error) => reportError(error, 'route') });
/** A push notification clicked while the app is open (PWA פ4): move inside the app to its item. */
const pushNavigate = (url: string) => router.history.push(url);

/**
 * A language switch re-mounts the UI (texts are read through `t` at render); queries and the route survive. So does
 * a change of the region settings (A3: date / time format, timezone, first day, weekend, currency).
 */
const App = () => {
  const locale = useLocale();
  const region = useRegionKey();
  return (
    <Fragment key={`${locale}|${region}`}>
      <RouterProvider router={router} />
      <DialogHost />
      {/* the two-factor code a request asks for (a board's delete-with-code). */}
      <StepUpHost />
      <ToastHost />
      <ShortcutsHost />
      <TooltipHost />
      <PwaGlobalHost onNavigate={pushNavigate} />
      <BrandTitleHost />
    </Fragment>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
