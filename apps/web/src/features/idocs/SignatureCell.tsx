// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t, type MessageKey, type SignatureValue } from '@bines/shared';
import { Dialog, SkeletonRows } from '@bines/ui';
import type { CellProps } from '../board/cells';
import { keysOf, useCertificate, type KeysUnder } from './idocs-api';

/**
 * Signature column: who signed an interactive document of the item and when — written only by
 * signing. A click opens the certificate (canvas part 4b): signer, identity check, time, source, what was signed,
 * the content fingerprint, the consents and the log.
 */
const C = keysOf('idoc.cert.');

export const SignatureCell = ({ value, accountId }: CellProps) => {
  const v = value as SignatureValue | null;
  const [open, setOpen] = useState(false);
  if (!v?.signature_id) return <div className="h-full w-full" data-testid="signature-cell-empty" />;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        data-testid="signature-cell"
        className="flex h-full w-full min-w-0 items-center px-2"
      >
        <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok-fg">
          <span aria-hidden>✍</span>
          <span className="truncate">
            {v.name} · {new Date(v.at).toLocaleDateString()}
          </span>
        </span>
      </button>
      {open ? (
        <CertificateDialog accountId={accountId} signatureId={v.signature_id} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
};

const CertRow = ({ k, children }: { k: KeysUnder<'idoc.cert.'>; children: React.ReactNode }) => (
  <div className="grid grid-cols-[8.5rem_1fr] gap-3 border-b border-line py-1.5 text-sm last:border-b-0">
    <span className="text-xs text-muted">{C(k)}</span>
    <span className="min-w-0 break-words">{children}</span>
  </div>
);

export const CertificateDialog = ({
  accountId,
  signatureId,
  onClose,
}: {
  accountId: string;
  signatureId: string;
  onClose: () => void;
}) => {
  const cert = useCertificate(accountId, signatureId);
  const c = cert.data;
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
  return (
    <Dialog open onClose={onClose} title={C('title')} subtitle={c?.doc_name}>
      {!c ? (
        <SkeletonRows rows={6} label="…" />
      ) : (
        <div className="grid gap-3" data-testid="signature-certificate">
          {c.drawing ? (
            <svg viewBox="0 0 400 120" className="h-20 w-60 text-heading" aria-label={C('drawing')}>
              <path
                d={c.drawing}
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
          <div>
            <CertRow k="signer">
              {[c.evidence.signer.name, c.evidence.signer.role].filter(Boolean).join(' · ')}
              {c.evidence.signer.email ? (
                <span className="block text-xs text-muted" dir="ltr">
                  {c.evidence.signer.email}
                </span>
              ) : null}
            </CertRow>
            <CertRow k="verified">{C(`by.${c.evidence.verified_by}`)}</CertRow>
            <CertRow k="at">{when(c.evidence.at)}</CertRow>
            <CertRow k="source">
              <span dir="ltr">{c.evidence.ip ?? '—'}</span>
              {c.evidence.user_agent ? (
                <span className="block truncate text-xs text-muted" dir="ltr">
                  {c.evidence.user_agent}
                </span>
              ) : null}
            </CertRow>
            <CertRow k="what">
              v{c.version}
              {c.summary.map((l, i) => (
                <span key={i} className="block text-xs text-fg-2">
                  {l}
                </span>
              ))}
            </CertRow>
            <CertRow k="consents">
              {c.evidence.consents.map((x) => (
                <span key={x.key} className="block text-xs">
                  {x.checked ? '☑' : '☐'} {x.text}
                </span>
              ))}
            </CertRow>
            <CertRow k="hash">
              <code className="text-[0.7rem] break-all text-fg-2" dir="ltr">
                SHA-256 {c.sha256}
              </code>
            </CertRow>
          </div>
          <details>
            <summary className="cursor-pointer text-xs text-info-fg">{C('log')}</summary>
            <ol className="mt-2 grid gap-1 text-xs">
              {c.events.map((e) => (
                <li key={e.id} className="grid grid-cols-[8.5rem_1fr] gap-3">
                  <span className="text-muted tabular-nums">{when(e.at)}</span>
                  <span>
                    {t(`idoc.event.k.${e.kind}` as MessageKey, { who: e.who || t('idoc.client') })}
                    {e.detail ? ` · ${e.detail}` : ''}
                  </span>
                </li>
              ))}
            </ol>
          </details>
          <p className="text-[0.7rem] text-muted">{C('legal')}</p>
        </div>
      )}
    </Dialog>
  );
};
