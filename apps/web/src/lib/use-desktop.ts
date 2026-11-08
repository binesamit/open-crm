// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';

/** True from 768px up (Tailwind `md`): the desktop shell and table; below it the phone layouts. */
const DESKTOP = '(min-width: 768px)';
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};
export const useDesktop = () => useSyncExternalStore(subscribe, () => window.matchMedia(DESKTOP).matches);
