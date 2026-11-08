// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type ConsentEvidence, type IdocTotals, type PublicIdocSection } from '@bines/shared';
import type { AppDeps } from '../../types';
import { findAsset } from '../files/files.repo';
import { publicQuestions } from './idocs.questions';
import * as repo from './idocs.repo';
import type { IdocDocRow } from './idocs.repo';
import { buildDocView, type DocView } from './idocs.resolve';
import { loadDoc, themeFor } from './idocs.service';
import type { Actor } from '../items/items.service';
import { idocPdfFileName, renderIdocPdf, type IdocPdfInput, type IdocPdfSigned } from './idocs.pdf';

/**
 * The PDF of a document as it stands: one file for the client and the team — the guests' look, the
 * page's sections, choices and totals, the questions and answers. Once signed it is drawn from what was signed (the
 * signature's snapshot, the same content the SHA-256 covers), with the signature and the certificate page.
 */

type Deps = Pick<AppDeps, 'db' | 'storage'>;
/** What the PDF needs of a signature (a stored row, or the one being written). */
type SignatureLike = { evidence: unknown; sha256: string; drawing: string | null; snapshot: unknown; version: number };

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const logoOf = async (deps: Deps, doc: IdocDocRow, view: DocView): Promise<IdocPdfInput['logo']> => {
  const id = view.logoRef ? view.files.get(view.logoRef) : null;
  if (!id) return null;
  try {
    const asset = await findAsset(deps.db, doc.accountId, id);
    if (!asset?.storageKey || !/^image\/(png|jpe?g)$/i.test(asset.mime)) return null;
    const bytes = await deps.storage.get(asset.storageKey, LOGO_MAX_BYTES);
    return bytes ? { bytes: new Uint8Array(bytes), mime: asset.mime } : null;
  } catch {
    return null;
  }
};

/** What a signature adds to the PDF, from its row. */
export const signedOf = (sig: SignatureLike): IdocPdfSigned => {
  const snap = sig.snapshot as { summary?: string[]; typed_signature?: boolean };
  return {
    evidence: sig.evidence as ConsentEvidence,
    sha256: sig.sha256,
    drawing: sig.drawing,
    typed: !!snap.typed_signature,
    summary: snap.summary ?? [],
  };
};

export const docPdf = async (
  deps: Deps,
  doc: IdocDocRow,
  view: DocView,
  sig?: SignatureLike | null,
): Promise<{ bytes: Uint8Array; fileName: string; signed: boolean }> => {
  const signature =
    sig === undefined && doc.signatureId ? await repo.findSignature(deps.db, doc.accountId, doc.signatureId) : sig;
  const snap = (signature?.snapshot ?? null) as { sections?: PublicIdocSection[]; totals?: IdocTotals } | null;
  const sections = snap?.sections ?? view.publicSections;
  const totals = snap?.totals ?? view.totals;
  if (!sections.length) throw new AppError('invalid_value', 'idoc_pdf_empty');
  const bytes = await renderIdocPdf({
    docName: doc.name,
    version: signature?.version ?? doc.version,
    accountName: view.accountName,
    language: view.settings.language,
    timezone: view.timezone,
    theme: themeFor(view, 'guests'),
    sections,
    totals,
    questions: await publicQuestions(deps, doc, view),
    logo: await logoOf(deps, doc, view),
    signed: signature ? signedOf(signature) : null,
  });
  return { bytes, fileName: idocPdfFileName(doc.name, doc.version, !!signature), signed: !!signature };
};

/** A member's download (GET /idocs/{id}/pdf): anyone who may see the document. */
export const memberDocPdf = async (deps: Deps, a: Actor, id: string) => {
  const { doc } = await loadDoc(deps, a, id);
  return docPdf(deps, doc, await buildDocView(deps, a, doc));
};
