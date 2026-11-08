// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';

/**
 * A WCAG AA contrast audit run inside the page (no axe-core in the repo): every visible text run is measured
 * against what is really painted under it (elementsFromPoint, so a sibling overlay such as the timeline's
 * progress fill counts), at several points across the text — the worst point wins. Text needs 4.5:1 (3:1 when
 * large: ≥24px, or ≥18.66px bold); icons (svg drawn in currentColor) need 3:1. Disabled controls are exempt
 * (WCAG 1.4.3). Gradients/images under the text can't be measured and are skipped.
 *
 * Accepted exception (Fix: , product owner: "the labels' text is white, not black — accessibility follows that"): WHITE
 * text on a coloured label fill (status / dropdown labels, kanban lanes, calendar chips, label previews…, i.e. an
 * element painted with an inline `background-color` from the label's own colour) is not reported — the product
 * shows white on every label colour (`readableOn`, packages/ui avatar.tsx; only near-white custom fills
 * take dark ink). Everything else is audited as before. Pass `{ labelFills: true }` to audit those too.
 */
export type ContrastViolation = {
  text: string;
  ratio: number;
  need: number;
  fg: string;
  bg: string;
  path: string;
  kind: 'text' | 'icon' | 'placeholder';
};

export const auditContrast = (
  page: Page,
  root = 'body',
  opts: { labelFills?: boolean } = {},
): Promise<ContrastViolation[]> =>
  page.evaluate(
    ({ rootSel, labelFills }) => {
      type RGBA = [number, number, number, number];
      const parse = (c: string): RGBA | null => {
        const m = /rgba?\(([^)]+)\)/.exec(c);
        if (m) {
          const p = m[1]!
            .split(/[\s,/]+/)
            .filter(Boolean)
            .map(Number);
          return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
        }
        const s = /color\(srgb ([^)]+)\)/.exec(c);
        if (s) {
          const p = s[1]!
            .split(/[\s/]+/)
            .filter(Boolean)
            .map(Number);
          return [p[0]! * 255, p[1]! * 255, p[2]! * 255, p[3] ?? 1];
        }
        return null;
      };
      const over = (top: RGBA, under: RGBA): RGBA => {
        const a = top[3];
        return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
      };
      const lum = (c: RGBA) => {
        const ch = c.slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
      };
      const ratio = (a: RGBA, b: RGBA) => {
        const [x, y] = [lum(a), lum(b)];
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const hex = (c: RGBA) =>
        '#' +
        c
          .slice(0, 3)
          .map((v) => Math.round(v).toString(16).padStart(2, '0'))
          .join('');
      const opacityOf = (el: Element | null): number => {
        let o = 1;
        for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
        return o;
      };
      const path = (el: Element) => {
        const parts: string[] = [];
        for (let e: Element | null = el; e && parts.length < 5 && e !== document.body; e = e.parentElement) {
          const id = e.getAttribute('data-testid') ?? e.getAttribute('data-column-type');
          const cls = (e.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
          parts.unshift(`${e.tagName.toLowerCase()}${id ? `[${id}]` : ''}${cls ? '.' + cls : ''}`);
        }
        return parts.join(' > ');
      };
      /** The painted background at a point, under `el` (el's own background included). null = image/gradient, or
       *  the point is not painted by `el` at all. */
      const bgAt = (el: Element, x: number, y: number): RGBA | null => {
        const stack = document.elementsFromPoint(x, y);
        let i = stack.indexOf(el);
        let below: Element[];
        if (i >= 0) below = stack.slice(i);
        else if (getComputedStyle(el).pointerEvents !== 'none')
          return null; // clipped away (overflow) — not seen
        else {
          // pointer-events:none text: everything under the point that is not above it in the tree.
          below = stack.filter((s) => s === el || s.contains(el) || !el.contains(s));
          i = 0;
        }
        let acc: RGBA = [255, 255, 255, 1];
        for (const e of below.reverse()) {
          const cs = getComputedStyle(e);
          if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/^url\(/.test(cs.backgroundImage)) {
            if (/gradient/.test(cs.backgroundImage)) return null;
          }
          if (cs.backgroundImage && /^url\(/.test(cs.backgroundImage)) return null;
          if (e.tagName === 'IMG' || e.tagName === 'VIDEO' || e.tagName === 'CANVAS') return null;
          const c = parse(cs.backgroundColor);
          if (c && c[3] > 0) acc = over([c[0], c[1], c[2], c[3] * opacityOf(e)], acc);
        }
        return acc;
      };
      const visible = (el: Element) => {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        if (opacityOf(el) < 0.1) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
      };
      const disabled = (el: Element) =>
        !!el.closest(
          ':disabled, [aria-disabled="true"], [data-disabled], .sr-only, [inert], [aria-hidden="true"]:not(svg)',
        );

      /**
       * White text on a label fill (an inline background colour on the element or a close ancestor, or a label
       * chip / full-fill status cell painted from its inline `--tag` colour — `.label-tag`).
       */
      const onLabelFill = (el: Element, color: RGBA) => {
        if (labelFills || color[0] < 250 || color[1] < 250 || color[2] < 250) return false;
        let e: Element | null = el;
        for (let i = 0; e && i < 4; i++, e = e.parentElement) {
          const st = (e as HTMLElement).style;
          if (st?.backgroundColor || st?.getPropertyValue('--tag')) return true;
        }
        return false;
      };
      const out: ContrastViolation[] = [];
      const seen = new Set<string>();
      const push = (v: ContrastViolation) => {
        const key = `${v.kind}|${v.fg}|${v.bg}|${v.path.split(' > ').slice(-2).join('>')}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(v);
      };
      const rootEl = document.querySelector(rootSel) ?? document.body;

      // Text.
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      const byEl = new Map<Element, Text[]>();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue;
        const el = n.parentElement;
        if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TITLE'].includes(el.tagName)) continue;
        byEl.set(el, [...(byEl.get(el) ?? []), n as Text]);
      }
      for (const [el, texts] of byEl) {
        if (!visible(el) || disabled(el)) continue;
        const cs = getComputedStyle(el);
        const color = parse(cs.color);
        if (!color || onLabelFill(el, color)) continue;
        const size = parseFloat(cs.fontSize);
        const bold = Number(cs.fontWeight) >= 700;
        const own = texts
          .map((t) => t.textContent)
          .join('')
          .trim();
        // A lone symbol (★ ✓ ⋯ ✕) is an icon, not text: 3:1 like other UI graphics.
        const glyph = own.length <= 2 && /^[^\p{L}\p{N}]+$/u.test(own);
        const need = glyph || size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        let worst: { r: number; fg: RGBA; bg: RGBA } | null = null;
        for (const t of texts) {
          const range = document.createRange();
          range.selectNodeContents(t);
          for (const rect of Array.from(range.getClientRects()).slice(0, 3)) {
            if (rect.width < 2 || rect.height < 2) continue;
            const y = rect.top + rect.height / 2;
            for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
              const x = rect.left + rect.width * f;
              if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
              const hit = document.elementFromPoint(x, y);
              // Covered by something else (a popover above the row): not what the user sees here.
              if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) continue;
              const bg = bgAt(el, x, y);
              if (!bg) continue;
              const fg = over([color[0], color[1], color[2], color[3] * opacityOf(el)], bg);
              const r = ratio(fg, bg);
              if (!worst || r < worst.r) worst = { r, fg, bg };
            }
          }
        }
        if (worst && worst.r < need - 0.005)
          push({
            kind: 'text',
            text: texts
              .map((t) => t.textContent)
              .join('')
              .trim()
              .slice(0, 40),
            ratio: Math.round(worst.r * 100) / 100,
            need,
            fg: hex(worst.fg),
            bg: hex(worst.bg),
            path: path(el),
          });
      }

      // Icons drawn in currentColor (a UI component: 3:1). Decorative ones inside a text-labelled control count too —
      // they carry meaning in this UI (status icons, row actions).
      for (const svg of Array.from(rootEl.querySelectorAll('svg'))) {
        if (!visible(svg) || svg.closest(':disabled, [aria-disabled="true"], [inert]')) continue;
        const cs = getComputedStyle(svg);
        const stroke = svg.getAttribute('stroke') === 'currentColor' || svg.querySelector('[stroke="currentColor"]');
        const fill = svg.getAttribute('fill') === 'currentColor' || svg.querySelector('[fill="currentColor"]');
        if (!stroke && !fill) continue;
        const color = parse(cs.color);
        if (!color) continue;
        const r = svg.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== svg && !svg.contains(hit) && !hit.contains(svg)) continue;
        const bg = bgAt(svg, x, y);
        if (!bg) continue;
        const fg = over([color[0], color[1], color[2], color[3] * opacityOf(svg)], bg);
        const ratioV = ratio(fg, bg);
        if (ratioV < 2.995)
          push({
            kind: 'icon',
            text: svg.closest('[aria-label]')?.getAttribute('aria-label')?.slice(0, 40) ?? '(icon)',
            ratio: Math.round(ratioV * 100) / 100,
            need: 3,
            fg: hex(fg),
            bg: hex(bg),
            path: path(svg),
          });
      }

      // Placeholders of empty inputs.
      for (const input of Array.from(rootEl.querySelectorAll('input[placeholder], textarea[placeholder]'))) {
        const el = input as HTMLInputElement;
        if (el.value || !el.placeholder || !visible(el) || el.disabled) continue;
        const color = parse(getComputedStyle(el, '::placeholder').color);
        if (!color || color[3] === 0) continue; // hidden on purpose (a collapsed field shows its icon instead)
        const r = el.getBoundingClientRect();
        const bg = bgAt(el, r.left + 6, r.top + r.height / 2);
        if (!bg) continue;
        const fg = over([color[0], color[1], color[2], color[3] * opacityOf(el)], bg);
        const ratioV = ratio(fg, bg);
        if (ratioV < 4.495)
          push({
            kind: 'placeholder',
            text: el.placeholder.slice(0, 40),
            ratio: Math.round(ratioV * 100) / 100,
            need: 4.5,
            fg: hex(fg),
            bg: hex(bg),
            path: path(el),
          });
      }
      return out;
    },
    { rootSel: root, labelFills: !!opts.labelFills },
  );
