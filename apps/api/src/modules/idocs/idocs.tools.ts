// SPDX-License-Identifier: AGPL-3.0-only
import { effectiveSelection, idocRowTotal, type IdocDoc } from '@bines/shared';
import type { ToolRunner } from '../ai/tools/runners';
import { choiceSummary } from './idocs.copy';
import { memberDocPdf } from './idocs.export';
import { buildDocView } from './idocs.resolve';
import * as svc from './idocs.service';

/**
 * The interactive-document tools of the AI registry (MCP, the assistant, agents): thin runners over
 * the same service the app and the REST API use, so every check is the same (the item's board to read, edit rights on
 * the item to make / send / change the link, the token's scopes before the call).
 */

const summary = (d: IdocDoc) => ({
  id: d.id,
  item_id: d.item_id,
  name: d.name,
  status: d.status,
  version: d.version,
  url: d.url,
  expires_at: d.expires_at,
  sent_at: d.sent_at,
  sent_to: d.sent_to,
  view_count: d.view_count,
  last_viewed_at: d.last_viewed_at,
  signature: d.signature,
  template_id: d.template_id,
});

const IDOC_PDF_LINK_TTL_S = 600;

const linkState = (d: IdocDoc) => (d.status === 'revoked' ? 'closed' : d.status === 'expired' ? 'expired' : 'active');

export const IDOC_TOOL_RUNNERS: Record<string, ToolRunner> = {
  list_idoc_templates: async (c, input: { board_id?: string }) => ({
    templates: (await svc.listTemplates(c.deps, c.actor, input.board_id)).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      board_id: t.board_id,
      sections: t.sections.length,
    })),
  }),

  list_item_idocs: async (c, input: { item_id: string }) => ({
    documents: (await svc.listItemDocs(c.deps, c.actor, input.item_id)).map(summary),
  }),

  get_idoc: async (c, input: { doc_id: string }) => {
    const dto = await svc.getDoc(c.deps, c.actor, input.doc_id);
    const { doc } = await svc.loadDoc(c.deps, c.actor, input.doc_id);
    const view = await buildDocView(c.deps, c.actor, doc);
    return {
      ...summary(dto),
      sections: view.publicSections.map((s) => ({
        id: s.id,
        kind: s.kind,
        title: 'title' in s && typeof s.title === 'string' ? s.title : '',
      })),
      rows: view.lines.map(({ section, rows }) => {
        const chosen = effectiveSelection(section.mode, rows);
        return {
          section: section.title,
          mode: section.mode,
          rows: rows.map((r) => ({
            name: r.name,
            chosen: chosen.has(r.key),
            quantity: r.qty,
            ...idocRowTotal(r),
          })),
        };
      }),
      totals: {
        currency: view.totals.currency,
        one_time: view.totals.one_time,
        discount: view.totals.discount,
        vat: view.totals.vat,
        grand_total: view.totals.grand_total,
        recurring: view.totals.recurring,
        recurring_total: view.totals.recurring_total,
      },
      summary: choiceSummary(view),
    };
  },

  create_idoc: async (c, input: { item_id: string; template_id?: string; starter?: string; name?: string }) =>
    summary(
      await svc.createDoc(c.deps, c.actor, input.item_id, {
        ...(input.template_id ? { template_id: input.template_id } : {}),
        ...(input.starter ? { starter: input.starter } : {}),
        ...(input.name ? { name: input.name } : {}),
      }),
    ),

  send_idoc: async (c, input: { doc_id: string; email?: string; no_email?: boolean }) =>
    summary(
      await svc.sendDoc(c.deps, c.actor, input.doc_id, {
        ...(input.email ? { email: input.email } : {}),
        ...(input.no_email ? { no_email: true } : {}),
      }),
    ),

  get_idoc_link: async (c, input: { doc_id: string }) => {
    const d = await svc.getDoc(c.deps, c.actor, input.doc_id);
    return { url: d.url, state: linkState(d), expires_at: d.expires_at };
  },

  set_idoc_link: async (c, input: { doc_id: string; action: 'replace' | 'close' | 'reopen' }) =>
    summary(
      input.action === 'replace'
        ? await svc.replaceToken(c.deps, c.actor, input.doc_id)
        : input.action === 'close'
          ? await svc.revokeDoc(c.deps, c.actor, input.doc_id)
          : await svc.reopenDoc(c.deps, c.actor, input.doc_id),
    ),

  get_idoc_events: async (c, input: { doc_id: string }) => ({
    events: (await svc.listDocEvents(c.deps, c.actor, input.doc_id)).map((e) => ({
      kind: e.kind,
      at: e.at,
      who: e.who,
      detail: e.detail,
    })),
  }),

  get_idoc_signature: async (c, input: { signature_id: string }) => {
    const cert = await svc.certificate(c.deps, c.actor, input.signature_id);
    // The drawing is SVG path data — of no use to a model; the rest is the evidence.
    const { drawing: _d, ...rest } = cert;
    return { ...rest, has_drawing: !!cert.drawing };
  },

  // A model cannot read the bytes: the PDF is kept under one key per document (each call replaces it) and handed
  // over as a short-lived link.
  get_idoc_pdf: async (c, input: { doc_id: string }) => {
    const pdf = await memberDocPdf(c.deps, c.actor, input.doc_id);
    const key = `${c.actor.ctx.accountId}/idoc-pdf/${input.doc_id}.pdf`;
    await c.deps.storage.put(key, Buffer.from(pdf.bytes), 'application/pdf');
    return {
      download_url: await c.deps.storage.presignGet(key, pdf.fileName, { ttl: IDOC_PDF_LINK_TTL_S }),
      file_name: pdf.fileName,
      signed: pdf.signed,
      expires_in_seconds: IDOC_PDF_LINK_TTL_S,
    };
  },
};
