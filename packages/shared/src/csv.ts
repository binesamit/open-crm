// SPDX-License-Identifier: AGPL-3.0-only
/** UTF-8 byte order mark: Excel reads a CSV as UTF-8 (Hebrew) only when it starts with it. */
export const CSV_BOM = String.fromCharCode(0xfeff);

/**
 * CSV / formula injection (OWASP): a text cell that starts with = + - @ (or a tab / CR) is run as a formula by
 * Excel and Sheets. Such text gets a leading apostrophe, which the spreadsheet shows as plain text. Real numbers
 * (and number-looking text such as "-5" or "+972 …") stay as they are.
 */
export const csvSafeText = (s: string) => (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d[\d\s.,]*$/.test(s) ? `'${s}` : s);

/**
 * CSV for exports (RFC 4180): fields with a comma, quote or line break are quoted, quotes doubled. Starts with
 * the BOM so Excel reads Hebrew correctly; CRLF line ends. Text that would run as a formula is neutralised.
 */
export const toCsv = (header: string[], rows: (string | number | boolean | null | undefined)[][]) => {
  const cell = (v: string | number | boolean | null | undefined) => {
    const s = v === null || v === undefined ? '' : typeof v === 'string' ? csvSafeText(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${CSV_BOM}${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
};

/** Seconds as decimal hours, two places (billing). */
export const decimalHours = (seconds: number) => Math.round((seconds / 3600) * 100) / 100;
