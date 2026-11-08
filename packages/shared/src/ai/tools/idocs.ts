// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { answer, defineTool, id } from './types';

/**
 * Interactive documents: an item shared as a live page (a quote, an agreement, an approval) made from
 * a template of sections. The same service and rights as the app: reading needs the item's board, making / sending /
 * changing the link needs edit rights on the item. Every tool answers ids and the public `url` only to people who may
 * edit the item (as the app shows it).
 */

const docSummary = answer({
  id: z.string(),
  item_id: z.string(),
  name: z.string(),
  status: z.string(),
  version: z.number(),
  url: z.string().nullable(),
});

export const listIdocTemplates = defineTool({
  name: 'list_idoc_templates',
  title: 'List document templates',
  description:
    'The interactive document templates (quote, agreement, approval…) the account has — with board_id, the ones that board may use (account-wide and its own). Use a template id with create_idoc.',
  family: 'idocs',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ board_id: id('Board').optional() }),
  output: answer({ templates: z.array(answer({ id: z.string(), name: z.string() })) }),
});

export const listItemIdocs = defineTool({
  name: 'list_item_idocs',
  title: 'List an item’s documents',
  description:
    "An item's interactive documents: status (draft, sent, viewed, signed, expired, revoked), version, when sent and to whom, views, the signature (who and when) and the client's link (`url`, only for people who may edit the item).",
  family: 'idocs',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ item_id: id('Item') }),
  output: answer({ documents: z.array(docSummary) }),
});

export const getIdoc = defineTool({
  name: 'get_idoc',
  title: 'Read a document',
  description:
    'One interactive document: its status and link, its sections (kind and title), the rows the client sees with what is chosen, the totals (one-time, VAT, recurring) and a short summary of the choices — what the client sees right now.',
  family: 'idocs',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ doc_id: id('Document') }),
  output: docSummary,
});

export const createIdoc = defineTool({
  name: 'create_idoc',
  title: 'Make a document',
  description:
    'Makes an interactive document for an item from a template (template_id from list_idoc_templates) or a built-in starter (starter: quote_agreement, service_agreement, spec_approval, selection_form, blank). It starts as a draft with its own client link; send it with send_idoc or give the `url` to the user.',
  family: 'idocs',
  scope: 'items:write',
  risk: 'write',
  input: z.object({
    item_id: id('Item'),
    template_id: id('Template').optional(),
    starter: z.enum(['quote_agreement', 'service_agreement', 'spec_approval', 'selection_form', 'blank']).optional(),
    name: z.string().trim().max(200).optional().describe('Document name (default: the template name · the item name)'),
  }),
  output: docSummary,
});

export const sendIdoc = defineTool({
  name: 'send_idoc',
  title: 'Send a document',
  description:
    "Emails the document's link to the client (the document's contact email column, or `email`) and opens the link for the document's set number of days. With no_email it is only marked as sent (the user shares the link). Sends outside the platform: always ask the user first.",
  family: 'idocs',
  scope: 'items:write',
  risk: 'sensitive',
  annotations: { openWorldHint: true },
  input: z.object({
    doc_id: id('Document'),
    email: z.email().max(320).optional().describe("Override of the contact's address"),
    no_email: z.boolean().optional().describe('Mark as sent without an email'),
  }),
  output: docSummary,
});

export const getIdocLink = defineTool({
  name: 'get_idoc_link',
  title: 'Document link',
  description:
    "The client's link of a document (to give to the user to share), whether it works now (active, expired, closed) and until when. Only for people who may edit the item.",
  family: 'idocs',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ doc_id: id('Document') }),
  output: answer({ url: z.string().nullable(), state: z.string(), expires_at: z.string().nullable() }),
});

export const setIdocLink = defineTool({
  name: 'set_idoc_link',
  title: 'Change a document link',
  description:
    'replace = a new link (the old one stops working); close = the client can no longer open the document; reopen = open a closed / expired / signed document again (a signed one gets a new version that must be signed again).',
  family: 'idocs',
  scope: 'items:write',
  risk: 'write',
  input: z.object({ doc_id: id('Document'), action: z.enum(['replace', 'close', 'reopen']) }),
  output: docSummary,
});

export const getIdocEvents = defineTool({
  name: 'get_idoc_events',
  title: 'Document log',
  description:
    "What happened to a document: created, sent, opened by the client, choices changed, details filled, questions asked, code verified, signed, reopened — with who and when. The client's questions themselves are updates on the item (list_updates).",
  family: 'idocs',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ doc_id: id('Document') }),
  output: answer({ events: z.array(answer({ kind: z.string(), at: z.string() })) }),
});

export const getIdocSignature = defineTool({
  name: 'get_idoc_signature',
  title: 'Signature certificate',
  description:
    'The evidence of a signed document (signature id from list_item_idocs / get_idoc): signer (name, role, email), how the identity was checked, server time, IP and browser, the consents ticked, what was signed (choices and totals) and the SHA-256 of the signed content.',
  family: 'idocs',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ signature_id: id('Signature') }),
  output: answer({ sha256: z.string() }),
});

export const getIdocPdf = defineTool({
  name: 'get_idoc_pdf',
  title: 'Document PDF',
  description:
    'The document as a PDF file — a short-lived download link to give to the user. Before signing: what the client sees now (current choices and totals), marked "not signed". Signed: exactly what was signed, with the signature and a certificate page.',
  family: 'idocs',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ doc_id: id('Document') }),
  output: answer({ download_url: z.string(), file_name: z.string(), signed: z.boolean() }),
});

export const IDOC_TOOLS = [
  listIdocTemplates,
  listItemIdocs,
  getIdoc,
  createIdoc,
  sendIdoc,
  getIdocLink,
  setIdocLink,
  getIdocEvents,
  getIdocSignature,
  getIdocPdf,
];
