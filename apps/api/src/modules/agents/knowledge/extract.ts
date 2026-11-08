// SPDX-License-Identifier: AGPL-3.0-only
import { unzipSync } from 'fflate';
import { AppError, KNOWLEDGE_FILE_EXTENSIONS, KNOWLEDGE_LIMITS } from '@bines/shared';

/**
 * Text out of a knowledge file (מ9), on the server: PDF (pdf.js through `unpdf`), DOCX (the document XML inside
 * the zip), TXT and MD as UTF-8. Anything else is refused when the source is added.
 */
export type KnowledgeFileType = (typeof KNOWLEDGE_FILE_EXTENSIONS)[number];

export const knowledgeFileType = (fileName: string): KnowledgeFileType | null => {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'markdown') return 'md';
  return (KNOWLEDGE_FILE_EXTENSIONS as readonly string[]).includes(ext ?? '') ? (ext as KnowledgeFileType) : null;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? whole;
  });

/**
 * The largest document.xml unpacked (AI-RT11): a zip declares the size it unpacks to and fflate allocates exactly
 * that — a "zip bomb" (a few MB that claim gigabytes) is refused before anything is allocated. The text kept from a
 * source is capped far below this anyway (KNOWLEDGE_LIMITS.textChars).
 */
export const DOCX_MAX_XML_BYTES = 64 * 1024 * 1024;

/** word/document.xml → paragraphs (tabs and breaks kept, every other tag dropped). */
export const docxText = (buf: Uint8Array) => {
  let files: Record<string, Uint8Array>;
  let tooBig = false;
  try {
    files = unzipSync(buf, {
      filter: (f) => {
        if (f.name !== 'word/document.xml') return false;
        if (f.originalSize > DOCX_MAX_XML_BYTES) tooBig = true;
        return !tooBig;
      },
    });
  } catch {
    throw new AppError('invalid_value', 'knowledge_unreadable_file');
  }
  if (tooBig) throw new AppError('payload_too_large', 'knowledge_file_too_large');
  const xml = files['word/document.xml'];
  if (!xml) throw new AppError('invalid_value', 'knowledge_unreadable_file');
  const s = new TextDecoder().decode(xml);
  return decodeXml(
    s
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(br|cr)\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
};

export const pdfText = async (buf: Uint8Array) => {
  const { extractText, getDocumentProxy } = await import('unpdf');
  try {
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text : [text]).join('\n\n');
  } catch {
    throw new AppError('invalid_value', 'knowledge_unreadable_file');
  }
};

export const extractFileText = async (type: KnowledgeFileType, buf: Buffer) => {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  switch (type) {
    case 'pdf':
      return pdfText(bytes.slice());
    case 'docx':
      return docxText(bytes);
    default:
      return buf.toString('utf8').replace(/^\uFEFF/, '');
  }
};

/** Whitespace tidied: no runs of spaces, at most one empty line. */
export const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Passages of about `size` characters: paragraphs are kept whole while they fit, a long one is cut at a sentence
 * (or a space); each passage repeats the last `overlap` characters of the one before, so a match on a boundary is
 * not lost.
 */
export const chunkText = (
  text: string,
  size: number = KNOWLEDGE_LIMITS.chunkChars,
  overlap: number = KNOWLEDGE_LIMITS.chunkOverlap,
) => {
  const pieces: string[] = [];
  for (const para of text.split(/\n{2,}/)) {
    let rest = para.trim();
    while (rest.length > size) {
      const window = rest.slice(0, size);
      const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'), window.lastIndexOf('? '));
      const at = cut > size / 2 ? cut + 1 : window.lastIndexOf(' ') > size / 2 ? window.lastIndexOf(' ') : size;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: string[] = [];
  let current = '';
  for (const p of pieces) {
    if (current && current.length + p.length + 2 > size) {
      chunks.push(current);
      const tail = current.slice(-overlap);
      const space = tail.indexOf(' ');
      current = `${space >= 0 ? tail.slice(space + 1) : tail}\n\n${p}`;
    } else current = current ? `${current}\n\n${p}` : p;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
};

/**
 * A search text → a tsquery for the `simple` config: its words, each as a prefix, OR-ed (ranked by how many
 * match). A Hebrew word with a one-letter prefix (ו ה ב ל מ ש כ) is also looked up without it. Null = no words.
 */
export const toTsQuery = (query: string) => {
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2))].slice(
    0,
    12,
  );
  const terms = new Set<string>();
  for (const w of words) {
    terms.add(w);
    if (w.length >= 4 && /^[והבלמשכ][֐-׿]/.test(w)) terms.add(w.slice(1));
  }
  if (!terms.size) return null;
  return [...terms].map((w) => `${w}:*`).join(' | ');
};
