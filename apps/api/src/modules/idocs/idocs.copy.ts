// SPDX-License-Identifier: AGPL-3.0-only
import {
  effectiveSelection,
  escapeHtml,
  formatIdocMoney,
  idocRowTotal,
  idocTotalLookup,
  markdownToDocHtml,
  mergeIdocText,
  type ConsentEvidence,
  type IdocTotals,
  type PublicIdocSection,
} from '@bines/shared';
import type { DocView } from './idocs.resolve';

/**
 * The signed copy of an interactive document: one self-contained HTML file (inline styles, no scripts, no remote
 * resources) that holds exactly what was signed — every section as the client saw it, their choices and the totals —
 * followed by the certificate (signer, identity check, time, IP, consents, the SHA-256 of the signed content).
 * The files column gets the PDF (idocs.pdf.ts); this HTML copy is the fallback when the PDF cannot be made.
 */

const esc = (s: string | null | undefined) => escapeHtml(String(s ?? ''));

/** Short readable lines of what was chosen and the totals (the certificate, the email, the event log). */
export const choiceSummary = (view: Pick<DocView, 'lines' | 'totals' | 'settings'>): string[] => {
  const money = (n: number) => formatIdocMoney(n, view.totals.currency, view.settings.language);
  const out: string[] = [];
  for (const { section, rows } of view.lines) {
    if (section.totals === 'none' && section.mode === 'fixed') continue;
    const chosen = effectiveSelection(section.mode, rows);
    for (const r of rows) {
      if (!chosen.has(r.key)) continue;
      const t = idocRowTotal(r);
      const amount = [
        t.one_time ? money(t.one_time) : '',
        t.recurring ? `${money(t.recurring)}/${section.recurring_period === 'year' ? 'yr' : 'mo'}` : '',
      ]
        .filter(Boolean)
        .join(' + ');
      out.push(`✓ ${r.name}${r.qty !== null ? ` × ${r.qty}` : ''}${amount ? ` — ${amount}` : ''}`);
    }
  }
  const t = view.totals;
  if (t.grand_total || t.recurring) {
    out.push(`Σ ${money(t.grand_total)}${t.recurring ? ` + ${money(t.recurring_total)}/mo` : ''}`);
  }
  return out;
};

const textHtml = (md: string, totals: IdocTotals, language: 'he' | 'en') =>
  markdownToDocHtml(mergeIdocText(md, idocTotalLookup(totals, language))).html;

const sectionHtml = (s: PublicIdocSection, view: DocView): string => {
  const money = (n: number | null) =>
    n === null ? '' : formatIdocMoney(n, view.totals.currency, view.settings.language);
  const title = 'title' in s && s.title ? `<h2>${esc(s.title as string)}</h2>` : '';
  switch (s.kind) {
    case 'header':
      return `<header><h1>${esc(s.title)}</h1>${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ''}<dl>${(
        s.data.fields ?? []
      )
        .map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`)
        .join('')}</dl></header>`;
    case 'text':
      return `<section>${title}<div class="grid">${textHtml(s.body, view.totals, view.settings.language)}${
        s.body2 ? `<div>${textHtml(s.body2, view.totals, view.settings.language)}</div>` : ''
      }</div></section>`;
    case 'fields':
      return `<section>${title}<dl>${(s.data.fields ?? []).map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`).join('')}</dl></section>`;
    case 'lines': {
      const rows = s.data.rows ?? [];
      const chosen = effectiveSelection(s.mode, rows);
      return `<section>${title}<table><tbody>${rows
        .filter((r) => s.show_unselected || chosen.has(r.key))
        .map((r) => {
          const t = idocRowTotal(r);
          return `<tr class="${chosen.has(r.key) ? 'on' : 'off'}"><td>${chosen.has(r.key) ? '☑' : '☐'}</td><td>${esc(r.name)}${
            r.description ? `<div class="d">${esc(r.description)}</div>` : ''
          }${r.qty !== null ? `<div class="d">${esc(r.unit)} × ${r.qty}</div>` : ''}</td><td class="n">${s.show_prices ? esc(money(t.one_time || null)) : ''}</td><td class="n">${
            s.show_prices && t.recurring ? esc(money(t.recurring)) : ''
          }</td></tr>`;
        })
        .join('')}</tbody></table></section>`;
    }
    case 'table':
      return `<section>${title}<table>${s.columns.length ? `<thead><tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${s.rows
        .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></section>`;
    case 'summary': {
      const t = view.totals;
      const row = (label: string, value: string, cls = '') =>
        `<tr class="${cls}"><td>${esc(label)}</td><td class="n">${esc(value)}</td></tr>`;
      const he = view.settings.language === 'he';
      if (!s.show_totals)
        return `<section>${title}<table class="sum"><tbody>${t.schedule
          .map((p) => row(`${p.label} (${p.percent}%)`, money(p.amount)))
          .join('')}</tbody></table></section>`;
      return `<section>${title}<table class="sum"><tbody>${[
        t.discount ? row(s.discount?.label || (he ? 'הנחה' : 'Discount'), `− ${money(t.discount)}`) : '',
        s.show_vat ? row(he ? 'לפני מע"מ' : 'Before VAT', money(t.subtotal)) : '',
        s.show_vat ? row(`${he ? 'מע"מ' : 'VAT'} ${t.vat_percent}%`, money(t.vat)) : '',
        row(he ? 'סה"כ' : 'Total', money(t.grand_total), 'tot'),
        s.show_recurring && t.recurring ? row(he ? 'חוזר' : 'Recurring', money(t.recurring_total)) : '',
        s.show_third_party && (t.third_party_one_time || t.third_party_recurring)
          ? row(
              he ? 'צד שלישי' : 'Third party',
              [money(t.third_party_one_time || null), money(t.third_party_recurring || null)]
                .filter(Boolean)
                .join(' + '),
            )
          : '',
        ...t.schedule.map((p) => row(`${p.label} (${p.percent}%)`, money(p.amount))),
      ].join('')}</tbody></table></section>`;
    }
    case 'inputs':
      return `<section>${title}<dl>${(s.data.inputs ?? [])
        .map(
          (i) =>
            `<div><dt>${esc(i.label)}</dt><dd>${esc(i.kind === 'checkbox' ? (i.value ? '☑' : '☐') : String(i.value ?? ''))}</dd></div>`,
        )
        .join('')}</dl></section>`;
    case 'faq':
      return `<section>${title}${s.items.map((f) => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('')}</section>`;
    case 'timeline':
      return `<section>${title}<table><tbody>${(s.data.dated ?? [])
        .map((d) => `<tr><td>${esc(d.name)}</td><td>${esc([d.start, d.end].filter(Boolean).join(' – '))}</td></tr>`)
        .join('')}</tbody></table></section>`;
    case 'media':
      return (s.data.files ?? []).length
        ? `<section>${title}<ul>${(s.data.files ?? []).map((f) => `<li>${esc(f.name)}</li>`).join('')}</ul></section>`
        : '';
    case 'divider':
      return s.style === 'page_break' ? '<div style="page-break-after:always"></div>' : '<hr>';
    default:
      return '';
  }
};

export const signedCopyHtml = (x: {
  view: DocView;
  docName: string;
  version: number;
  evidence: ConsentEvidence;
  sha256: string;
  drawing: string | null;
  summary: string[];
}) => {
  const he = x.view.settings.language === 'he';
  const L = he
    ? {
        cert: 'תעודת חתימה',
        signer: 'חותם',
        verified: 'זהות אומתה',
        at: 'מועד (שעון שרת)',
        ip: 'מקור',
        what: 'מה נחתם',
        hash: 'טביעת מסמך',
        consents: 'הסכמות',
      }
    : {
        cert: 'Signature certificate',
        signer: 'Signer',
        verified: 'Identity check',
        at: 'Time (server)',
        ip: 'Source',
        what: 'What was signed',
        hash: 'Document fingerprint',
        consents: 'Consents',
      };
  const e = x.evidence;
  const body = x.view.publicSections.map((s) => sectionHtml(s, x.view)).join('');
  const drawing = x.drawing
    ? `<svg viewBox="0 0 400 120" width="260" height="78" aria-hidden="true"><path d="${esc(x.drawing)}" fill="none" stroke="#13221f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : '';
  const cert = `<section class="cert"><h2>${L.cert}</h2>${drawing}<dl>
<div><dt>${L.signer}</dt><dd>${esc([e.signer.name, e.signer.role].filter(Boolean).join(' · '))}${e.signer.email ? ` &lt;${esc(e.signer.email)}&gt;` : ''}</dd></div>
<div><dt>${L.verified}</dt><dd>${esc(e.verified_by)}</dd></div>
<div><dt>${L.at}</dt><dd dir="ltr">${esc(e.at)}</dd></div>
<div><dt>${L.ip}</dt><dd dir="ltr">${esc(e.ip ?? '')} · ${esc(e.user_agent ?? '')}</dd></div>
<div><dt>${L.what}</dt><dd>${esc(x.docName)} · v${x.version}<br>${x.summary.map(esc).join('<br>')}</dd></div>
<div><dt>${L.consents}</dt><dd>${e.consents.map((c) => `${c.checked ? '☑' : '☐'} ${esc(c.text)}`).join('<br>')}</dd></div>
<div><dt>${L.hash}</dt><dd dir="ltr"><code>SHA-256 ${esc(x.sha256)}</code></dd></div>
</dl></section>`;
  return `<!doctype html><html lang="${he ? 'he' : 'en'}" dir="${he ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(x.docName)}</title>
<style>
body{font:15px/1.6 system-ui,'Segoe UI',Arial,sans-serif;color:#13221f;max-width:820px;margin:32px auto;padding:0 20px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px;color:#0d3b35}h3{font-size:15px;margin:14px 0 4px}
.sub{color:#5d756f;margin:0 0 12px}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 18px;margin:8px 0}
dt{font-size:12px;color:#5d756f}dd{margin:0}table{width:100%;border-collapse:collapse;margin:6px 0}td,th{padding:7px 6px;border-bottom:1px solid #e3ece9;text-align:start;vertical-align:top}
.n{text-align:end;white-space:nowrap}.d{font-size:13px;color:#5d756f}tr.off td{color:#8aa39c}.sum .tot td{font-weight:600;border-top:2px solid #0d3b35}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.cert{border:1px solid #d5e2de;border-radius:12px;padding:6px 18px 14px;margin-top:36px;page-break-inside:avoid}
.cert dl{grid-template-columns:1fr}code{font-size:12px;word-break:break-all}hr{border:0;border-top:1px solid #e3ece9;margin:20px 0}
</style></head><body>${body}${cert}</body></html>`;
};
