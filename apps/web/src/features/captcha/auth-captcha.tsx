// SPDX-License-Identifier: AGPL-3.0-only
import { type AuthCaptcha, CAPTCHA_TOKEN_HEADER, t } from '@bines/shared';
import { Notice } from '@bines/ui';
import { useAuthConfig } from '../../lib/branding';
import { useLocale } from '../../lib/locale';
import { useTurnstile } from '../forms/turnstile';

type Surface = keyof Omit<AuthCaptcha, 'site_key'>;

/**
 * Turnstile on a sign-in screen when the owner console asks for it there (GET /auth/config). The
 * token goes in the `x-captcha-token` header; a token is good for one request, so `reset` after each try.
 */
export const useAuthCaptcha = (surface: Surface) => {
  const config = useAuthConfig().data?.captcha;
  const siteKey = config?.[surface] ? config.site_key : null;
  const lang = useLocale();
  const { ref, token, failed, reset } = useTurnstile(siteKey, lang);
  const required = !!siteKey;
  return {
    required,
    /** Nothing to wait for: not asked for, solved, or the script could not load (the server then says why). */
    ready: !required || !!token || failed,
    headers: (): Record<string, string> => (token ? { [CAPTCHA_TOKEN_HEADER]: token } : {}),
    reset,
    slot: required ? (
      <>
        <div ref={ref} data-testid={`captcha-${surface}`} />
        {failed ? <Notice tone="warn">{t('captcha.loadFailed')}</Notice> : null}
      </>
    ) : null,
  };
};

/** A refusal of the check, in words (else null). */
export const captchaRefusal = (code: string | undefined) =>
  code === 'captcha_required' || code === 'captcha_failed' ? t(`captcha.error.${code}`) : null;

/** The code of a refusal from Better Auth's client (our guard answers `{ error: { code } }`). */
export const authErrorCode = (err: unknown): string | undefined => {
  const e = err as { code?: unknown; error?: { code?: unknown } } | null;
  const code = e?.error?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
};
