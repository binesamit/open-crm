// SPDX-License-Identifier: AGPL-3.0-only
import { BULK_IMPORT_MAX_FILE_BYTES, type ImportTable, importCellText, parseCsv, trimTable } from '@bines/shared';

/** Why a file could not be read (shown with the `bulk.import.error.<code>` string). */
export class ImportFileError extends Error {
  constructor(readonly code: 'type' | 'size' | 'read' | 'empty') {
    super(code);
  }
}

export const IMPORT_ACCEPT = '.xlsx,.csv,.tsv,.txt';
const kindOf = (file: File) => {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'xlsx') return 'xlsx';
  if (['csv', 'tsv', 'txt'].includes(ext)) return 'csv';
  return null;
};

/**
 * CSV text: UTF-8 (with or without BOM); a file that is not valid UTF-8 is read as Windows-1255 — what Excel in
 * Hebrew saves "CSV" as.
 */
const decode = (buf: ArrayBuffer) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1255').decode(buf);
  }
};

/**
 * A spreadsheet file → its sheets as text tables, in the browser (B3): .xlsx through `read-excel-file` (MIT,
 * loaded only when a file is imported; its no-worker build — the CSP allows no inline worker code), .csv / .tsv
 * here. Empty rows and trailing empty columns are dropped; sheets with nothing in them are left out.
 */
export const readImportFile = async (file: File): Promise<ImportTable[]> => {
  const kind = kindOf(file);
  if (!kind) throw new ImportFileError('type');
  if (file.size > BULK_IMPORT_MAX_FILE_BYTES) throw new ImportFileError('size');
  let tables: ImportTable[];
  try {
    if (kind === 'csv') {
      tables = [{ name: file.name, rows: parseCsv(decode(await file.arrayBuffer())) }];
    } else {
      const { default: readXlsxFile } = await import('read-excel-file/web-worker');
      const sheets = await readXlsxFile(file);
      tables = sheets.map((s) => ({ name: s.sheet, rows: s.data.map((r) => r.map(importCellText)) }));
    }
  } catch {
    throw new ImportFileError('read');
  }
  const out = tables.map((x) => ({ ...x, rows: trimTable(x.rows) })).filter((x) => x.rows.length);
  if (!out.length) throw new ImportFileError('empty');
  return out;
};
