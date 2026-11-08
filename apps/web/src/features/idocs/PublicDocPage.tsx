// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import { dirOf, getLocale, type Locale, type PublicIdoc } from '@bines/shared';
import { Button, Input, Notice, SkeletonRows } from '@bines/ui';
import { LegalLinks } from '../legal/legal-links';
import {
  fetchPublicDoc,
  idocKeys,
  it,
  keepVisitorKey,
  publicIdocCalls,
  visitorKey,
  downloadPublicPdf,
  withKey,
  type KeysUnder,
} from './idocs-api';
import { DocView, type DocActions } from './render/DocView';

/** The frame of the public page: the green shell around one floating panel, mobile-first (canvas part 1). */
const Frame = ({
  lang,
  children,
  wide,
  background,
}: {
  lang: Locale;
  children: React.ReactNode;
  wide?: boolean;
  /** The document theme's frame colour (empty = the shell). */
  background?: string;
}) => (
  <div
    dir={dirOf(lang)}
    lang={lang}
    className="min-h-dvh bg-[var(--shell)] px-0 py-0 sm:px-4 sm:py-10"
    style={background ? { background } : undefined}
    data-testid="public-idoc-page"
  >
    <main
      className={`mx-auto w-full overflow-hidden bg-surface shadow-[var(--shadow-panel)] sm:rounded-[var(--radius-panel)] ${wide ? 'max-w-[860px]' : 'max-w-[520px]'}`}
    >
      {children}
    </main>
    <footer className="mx-auto mt-4 flex max-w-[860px] justify-center pb-6 text-xs text-shell-muted">
      <LegalLinks locale={lang === 'en' ? 'en' : 'he'} testId="public-idoc-legal" />
    </footer>
  </div>
);

/**
 * `/p/:token` — an interactive document, outside the app shell, no sign-in. The token names the
 * document; when the document asks for a one-time code, nothing shows before it is entered (the key then rides on
 * every call for this tab's session).
 */
export const PublicDocPage = ({ token }: { token: string }) => {
  const [key, setKey] = useState<string | null>(() => visitorKey(token));
  const query = useQuery({
    queryKey: [...idocKeys.public(token), key ?? ''],
    queryFn: () => fetchPublicDoc(token, key),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  if (query.isPending)
    return (
      <Frame lang={getLocale()}>
        <div className="p-6">
          <SkeletonRows rows={8} label="…" />
        </div>
      </Frame>
    );
  if (query.isError) {
    const status = query.error instanceof ApiError ? query.error.status : 0;
    const lang = getLocale();
    return (
      <Frame lang={lang}>
        <div className="p-6" data-testid="public-idoc-unavailable">
          <Notice tone={status === 404 ? 'warn' : 'error'}>
            {it(lang, status === 404 ? 'page.notFound' : 'page.loadError')}
          </Notice>
        </div>
      </Frame>
    );
  }
  const doc = query.data;
  if (doc.state === 'verify')
    return (
      <CodeScreen
        token={token}
        doc={doc}
        onVerified={(k) => {
          keepVisitorKey(token, k);
          setKey(k);
        }}
      />
    );
  if (doc.state === 'revoked' || doc.state === 'expired')
    return (
      <Frame lang={doc.language}>
        <div className="grid gap-3 p-6" data-testid="public-idoc-closed" data-state={doc.state}>
          {doc.title ? (
            <h1 className="font-[family-name:var(--font-display)] text-xl font-semibold text-heading">{doc.title}</h1>
          ) : null}
          <Notice tone="warn">
            {it(doc.language, doc.state === 'expired' ? 'page.expired' : 'page.revoked', { account: doc.account.name })}
          </Notice>
        </div>
      </Frame>
    );
  return <Live token={token} doc={doc} visitor={key} />;
};

const Live = ({ token, doc, visitor }: { token: string; doc: PublicIdoc; visitor: string | null }) => {
  const qc = useQueryClient();
  const calls = publicIdocCalls(token, visitor);
  const actions: DocActions = {
    select: async (section_id, row, patch) => (await calls.select({ section_id, row, ...patch })).rows,
    selectAll: async (section_id, all) => (await calls.select({ section_id, all })).rows,
    inputs: async (section_id, values) => {
      await calls.inputs({ section_id, values });
    },
    ask: async (section_id, text, name) => calls.ask({ section_id, text, ...(name ? { name } : {}) }),
    sign: async (section_id, x) => {
      const out = await calls.sign({ section_id, ...x, version: doc.version });
      void qc.invalidateQueries({ queryKey: idocKeys.public(token) });
      return out.signed;
    },
    pdf: () => downloadPublicPdf(token, visitor),
  };
  return (
    <Frame lang={doc.language} wide background={doc.theme?.background}>
      <DocView doc={doc} actions={actions} fileUrl={(u) => withKey(u, token)} />
    </Frame>
  );
};

const CodeScreen = ({
  token,
  doc,
  onVerified,
}: {
  token: string;
  doc: PublicIdoc;
  onVerified: (key: string) => void;
}) => {
  const lang = doc.language;
  const T = (k: KeysUnder<'idoc.'>, v?: Record<string, string | number>) => it(lang, k, v);
  const calls = publicIdocCalls(token, null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await calls.startCode();
      setSent(true);
    } catch (e) {
      setProblem(e instanceof ApiError && e.status === 429 ? T('code.tooMany') : T('code.sendError'));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onVerified((await calls.checkCode(code)).visitor_key);
    } catch (e) {
      setProblem(e instanceof ApiError && e.status === 429 ? T('code.tooMany') : T('code.wrong'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame lang={lang}>
      <div className="grid gap-4 p-6 sm:p-8" data-testid="public-idoc-code">
        {doc.title ? (
          <h1 className="font-[family-name:var(--font-display)] text-xl font-semibold text-heading">{doc.title}</h1>
        ) : null}
        <p className="text-sm text-fg-2">{T('code.intro', { email: doc.email_hint ?? '' })}</p>
        {!sent ? (
          <Button
            size="lg"
            busy={busy}
            onClick={() => void send()}
            data-testid="idoc-code-send"
            disabled={!doc.email_hint}
          >
            {T('code.send')}
          </Button>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <label className="grid gap-1 text-sm">
              <span className="text-xs text-muted">{T('code.label', { email: doc.email_hint ?? '' })}</span>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                dir="ltr"
                className="h-11 text-center text-lg tracking-[0.4em]"
                data-testid="idoc-code-input"
              />
            </label>
            <Button type="submit" size="lg" busy={busy} disabled={code.length < 6} data-testid="idoc-code-check">
              {T('code.open')}
            </Button>
            <button type="button" className="text-xs text-info-fg hover:underline" onClick={() => void send()}>
              {T('code.resend')}
            </button>
          </form>
        )}
        {problem ? <p className="text-sm text-danger-fg">{problem}</p> : null}
      </div>
    </Frame>
  );
};
