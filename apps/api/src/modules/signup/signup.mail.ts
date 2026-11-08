// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import type { Locale } from '@bines/shared';
import { type Hero, noticeEmail } from '@bines/server-mail';
import { users } from '../../db/schema';
import { st } from '../../lib/i18n';
import type { AppDeps } from '../../types';
import { platformMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import type { SignupRequestRow } from './signup.repo';

/**
 * Self sign-up emails (D32), in the person's language with the platform's brand (no account yet). The texts are the
 * catalog's (`signup.mail.*`). Whatever the address, the screen says the same thing — the email tells the truth
 * ("verify" / "you already have an account"), so nobody can learn from outside who is registered.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'mailer' | 'logger'>;
/** `open`: the link of someone already registered who owns no account yet. */
export type SignupMailKind = 'verify' | 'open' | 'exists' | 'pending' | 'approved' | 'rejected';

const send = async (deps: Deps, message: Parameters<AppDeps['mailer']['send']>[0], what: string) => {
  try {
    await deps.mailer.send(message);
    return true;
  } catch (err) {
    // The address is personal data: only the kind of email is logged.
    deps.logger.warn({ err, what }, 'signup email failed');
    return false;
  }
};

/** The picture of each sign-up email (objects style): the metro line, the shop sign, or a state badge. */
const signupHero = (kind: SignupMailKind, v: Record<string, string | number>, l: Locale): Hero => {
  if (kind === 'verify' || kind === 'open')
    return {
      kind: 'metro',
      stations: [
        st('mail.obj.metro.signed', v, l),
        st('mail.obj.metro.verify', v, l),
        st('mail.obj.metro.account', v, l),
      ],
      current: 1,
      here: st('mail.obj.metro.here', v, l),
    };
  if (kind === 'approved') return { kind: 'sign', word: st('mail.obj.sign.word', v, l), sub: String(v.org) };
  return {
    kind: 'state',
    tone: kind === 'rejected' ? 'no' : kind === 'exists' ? 'ok' : 'wait',
    glyph: kind === 'rejected' ? '✕' : kind === 'exists' ? '✓' : '…',
  };
};

/** One email to the person who signed up. `url` = the button (the verification link, sign-in …). */
export const mailSignup = async (
  deps: Deps,
  kind: SignupMailKind,
  r: Pick<SignupRequestRow, 'email' | 'name' | 'orgName' | 'locale'>,
  extra: { url?: string; reason?: string | null; hours?: number } = {},
) => {
  const brand = await platformMailBrand(deps, r.locale);
  const l = brand.locale;
  const v = {
    name: r.name,
    org: r.orgName,
    product: brand.product,
    hours: extra.hours ?? 0,
    email: r.email,
    reason: extra.reason ?? '',
  };
  const url = extra.url ?? (await appLink(deps, '/login'));
  const lines = [st(`signup.mail.${kind}.body`, v, l)];
  if (kind === 'exists' || kind === 'open') lines.push(st('signup.mail.exists.forgot', v, l));
  if (kind === 'rejected' && extra.reason) lines.push(st('signup.mail.rejected.reason', v, l));
  return send(
    deps,
    noticeEmail({
      to: r.email,
      brand,
      subject: st(`signup.mail.${kind}.subject`, v, l),
      title: st(`signup.mail.${kind}.title`, v, l),
      hero: signupHero(kind, v, l),
      lines,
      ...(kind === 'pending' || kind === 'rejected'
        ? {}
        : { cta: { label: st(`signup.mail.${kind}.cta`, v, l), url } }),
      reason: `${st('signup.mail.reasonLine', v, l)} ${st('signup.mail.ignore', v, l)}`,
    }),
    kind,
  );
};

/** The platform owners hear about a new account, or a request waiting for their approval (setting `notify_owner`). */
export const mailOwners = async (deps: Deps, kind: 'created' | 'approval', r: SignupRequestRow) => {
  const owners = await deps.db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.isPlatformOwner, true));
  const url = await appLink(deps, '/owner');
  for (const o of owners) {
    const brand = await platformMailBrand(deps, o.locale);
    const l = brand.locale;
    const v = { name: r.name, org: r.orgName, email: r.email, product: brand.product };
    await send(
      deps,
      noticeEmail({
        to: o.email,
        brand,
        subject: st(`signup.mail.owner.${kind}.subject`, v, l),
        title: st(`signup.mail.owner.${kind}.title`, v, l),
        lines: [st(`signup.mail.owner.${kind}.body`, v, l)],
        cta: { label: st('signup.mail.owner.cta', v, l), url },
        reason: st('signup.mail.owner.reasonLine', v, l),
      }),
      `owner_${kind}`,
    );
  }
};
