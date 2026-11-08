// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  helpRouteOf,
  type Me,
  type MyAccount,
  type MyTour,
  t,
  TOUR_ROUTE_PATHS,
  toursToOffer,
  tDynamic,
} from '@bines/shared';
import { showToast } from '../../lib/toast';
import { errorMessage } from '../../lib/api';
import { helpHiddenFor } from '../support/kb-page';
import { TourAuthorBar } from './TourAuthorBar';
import { TourOffer } from './TourOffer';
import { TourRunner } from './TourRunner';
import { useMyTours, useTourActions } from './tours-api';
import {
  pendingTour,
  type RunnableTour,
  runningTour,
  setPendingTour,
  startTour,
  stopTour,
  useAuthorMode,
  useRunningTour,
} from './tour-store';

/**
 * Starts a tour on its screen: here and now when this is its screen; else it opens the screen first
 * (home, automations, administration …) — or, for a screen of one board / item / doc, waits until the person opens
 * one, and says so.
 */
export const useLaunchTour = (account: Pick<MyAccount, 'slug'>) => {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return useCallback(
    (tour: RunnableTour) => {
      if (helpRouteOf(path) === tour.route) {
        setPendingTour(null);
        startTour(tour);
        return;
      }
      setPendingTour(tour.id);
      const sub = TOUR_ROUTE_PATHS[tour.route];
      if (sub !== undefined) void navigate({ to: `/a/${account.slug}${sub}` } as never);
      else showToast({ message: t('tour.pending', { screen: tDynamic(`tour.route.${tour.route}`) }) });
    },
    [account.slug, navigate, path],
  );
};

/**
 * "Show me in the app" on a practical guide (↔): starts the guide's tour when this person
 * may take it here (published, their role, tours on in the account); null otherwise (no button).
 */
export const useShowMe = (accountId: string, tourId: string | null | undefined) => {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const slug = /^\/a\/([^/]+)/.exec(path)?.[1] ?? '';
  const tours = useMyTours(accountId, !!tourId).data;
  const launch = useLaunchTour({ slug });
  const tour = tourId && tours?.enabled ? tours.tours.find((x) => x.id === tourId) : undefined;
  return tour && slug ? () => launch(tour) : null;
};

/**
 * Guided tours inside an account, mounted once beside the account's pages: offers a screen's tour
 * on the first visit (or starts it, by the tour's setting), runs the tour, records what the person did with it, picks
 * up a tour that waits for its screen, and hosts the owner console's picker / preview. Not for guests nor inside an
 * account opened by a support grant (like the help center).
 */
export const TourHost = ({ me, account }: { me: Me; account: MyAccount }) => {
  const hidden = helpHiddenFor(account);
  const tours = useMyTours(account.id, !hidden);
  const actions = useTourActions(account.id);
  const run = useRunningTour();
  const author = useAuthorMode();
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const route = helpRouteOf(path);
  /** Offers this person already answered in this page (until the list is refetched). */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const data = tours.data;

  // A tour that waited for its screen starts there.
  useEffect(() => {
    if (!data || runningTour()) return;
    const id = pendingTour();
    if (!id) return;
    const tour = data.tours.find((x) => x.id === id);
    if (!tour) setPendingTour(null);
    else if (tour.route === route) {
      setPendingTour(null);
      startTour(tour);
    }
  }, [data, route]);

  // Leaving the tour's screen ends it (seen: it is not offered again; the "?" menu runs it again).
  useEffect(() => {
    const r = runningTour();
    if (r && !r.preview && r.tour.route !== route) {
      actions.setState(r.tour.id, 'dismissed');
      stopTour();
    }
    // `actions` is a fresh object each render; the route is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  const offer: MyTour | undefined =
    data?.enabled && data.offers && !run && !author && !pendingTour()
      ? toursToOffer(data.tours, route).find((x) => !answered.has(x.id))
      : undefined;

  // A tour set to start by itself does, once (finishing or closing it records it, so it is not offered again).
  const autoStarted = useRef(new Set<string>());
  useEffect(() => {
    if (offer?.start !== 'auto' || autoStarted.current.has(offer.id)) return;
    autoStarted.current.add(offer.id);
    startTour(offer);
  }, [offer]);

  const answer = (tour: MyTour) => setAnswered((s) => new Set(s).add(tour.id));
  const end = (state: 'done' | 'dismissed') => {
    const r = runningTour();
    if (r && !r.preview) actions.setState(r.tour.id, state);
    stopTour();
  };

  if (hidden) return null;
  return (
    <>
      {author ? <TourAuthorBar author={author} /> : null}
      {run ? (
        <TourRunner
          key={`${run.tour.id}:${run.preview}`}
          run={run}
          accountId={account.id}
          onEnd={end}
          onGuide={(slug) => {
            end('done');
            void navigate({
              to: '/a/$accountSlug/help',
              params: { accountSlug: account.slug },
              search: { article: slug },
            } as never);
          }}
        />
      ) : null}
      {offer && offer.start === 'offer' && me ? (
        <TourOffer
          key={offer.id}
          tour={offer}
          onStart={() => {
            answer(offer);
            startTour(offer);
          }}
          onLater={() => {
            answer(offer);
            actions.setState(offer.id, 'dismissed');
          }}
          onNoMore={() => {
            answer(offer);
            actions.setState(offer.id, 'dismissed');
            actions
              .setOffers(false)
              .then(() => showToast({ message: t('tour.offer.noMoreSaved') }))
              .catch((e) => showToast({ message: errorMessage(e), tone: 'error' }));
          }}
        />
      ) : null}
    </>
  );
};
