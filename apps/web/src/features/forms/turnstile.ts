// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';

/**
 * Cloudflare Turnstile on the public form page (D22.5): loaded only when the form has a site key, rendered
 * "interaction-only" — no floating badge; a challenge shows inside the form only when Cloudflare suspects a bot.
 */
type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

const loadTurnstile = () =>
  (loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile_missing')));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile_load_failed'));
    };
    document.head.appendChild(s);
  }));

/** The widget's container ref, its current token (null until solved), and `reset` after a failed submit. */
export const useTurnstile = (siteKey: string | null, lang: string) => {
  const ref = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let cancelled = false;
    const el = ref.current;
    loadTurnstile()
      .then((api) => {
        if (cancelled) return;
        widget.current = api.render(el, {
          sitekey: siteKey,
          appearance: 'interaction-only',
          language: lang,
          callback: (t: string) => setToken(t),
          'expired-callback': () => setToken(null),
          'error-callback': () => setToken(null),
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, lang]);
  const reset = () => {
    setToken(null);
    if (widget.current) window.turnstile?.reset(widget.current);
  };
  return { ref, token, failed, reset };
};
