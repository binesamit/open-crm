// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { ApiError } from '@bines/sdk';
import type { IdocDoc } from '@bines/shared';
import { Button } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { downloadGet } from '../../lib/download';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { keysOf } from './idocs-api';

const P = keysOf('idoc.pdf.');

/** Why a PDF could not be made, in words (too long, busy), else the API's message. */
export const pdfErrorMessage = (e: unknown) =>
  e instanceof ApiError && e.status === 413
    ? P('tooLarge')
    : e instanceof ApiError && e.status === 429
      ? P('busy')
      : errorMessage(e);

/**
 * Downloads a document as PDF — the same file the client gets: before signing what the client sees
 * now, marked unsigned; signed, what was signed with its certificate. Members only (the account header).
 */
export const PdfButton = ({
  accountId,
  doc,
  stale,
  className,
}: {
  accountId: string;
  doc: Pick<IdocDoc, 'id' | 'name'>;
  /** The editor has unsaved changes: the PDF is of the saved version (said in the tooltip). */
  stale?: boolean;
  className?: string;
}) => {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await downloadGet(accountId, `/idocs/${doc.id}/pdf`, `${doc.name || 'document'}.pdf`);
    } catch (e) {
      showToast({ message: pdfErrorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => void go()}
      busy={busy}
      title={stale ? P('saveFirst') : undefined}
      className={className}
      data-testid="idoc-pdf"
    >
      <Icon name="download" size={14} />
      {P('download')}
    </Button>
  );
};
