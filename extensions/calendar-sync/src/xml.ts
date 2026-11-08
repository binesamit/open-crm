// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A small namespace-aware XML reader for WebDAV answers (multistatus): elements with their namespace URI, local
 * name, attributes and text. No DTDs, no external entities (a `<!DOCTYPE` is refused).
 */
export type XmlEl = { ns: string; name: string; attrs: Record<string, string>; children: XmlEl[]; text: string };

export const DAV = 'DAV:';
export const CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const CS = 'http://calendarserver.org/ns/';

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#')
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });

export const escapeXml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

type Open = { el: XmlEl; scope: Record<string, string>; qname: string };

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** The root element of a document (throws on malformed input). */
export const parseXml = (src: string): XmlEl => {
  const root: XmlEl = { ns: '', name: '#document', attrs: {}, children: [], text: '' };
  const stack: Open[] = [{ el: root, scope: { xml: 'http://www.w3.org/XML/1998/namespace' }, qname: '' }];
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      top().el.text += decode(src.slice(i));
      break;
    }
    if (lt > i) top().el.text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('xml: open comment');
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('xml: open CDATA');
      top().el.text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('xml: open declaration');
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) throw new Error('xml: DTDs are not accepted');
    const gt = src.indexOf('>', lt);
    if (gt < 0) throw new Error('xml: open tag');
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const qname = raw.slice(1).trim();
      const open = stack.pop();
      if (!open || open.qname !== qname || stack.length === 0) throw new Error(`xml: unexpected </${qname}>`);
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new Error('xml: bad tag');
    const qname = m[1]!;
    const attrs: Record<string, string> = {};
    const scope = { ...top().scope };
    for (const a of body.slice(qname.length).matchAll(ATTR)) {
      const value = decode(a[3] ?? a[4] ?? '');
      const k = a[1]!;
      if (k === 'xmlns') scope[''] = value;
      else if (k.startsWith('xmlns:')) scope[k.slice(6)] = value;
      else attrs[k] = value;
    }
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const el: XmlEl = {
      ns: scope[prefix] ?? '',
      name: colon < 0 ? qname : qname.slice(colon + 1),
      attrs,
      children: [],
      text: '',
    };
    top().el.children.push(el);
    if (!selfClose) stack.push({ el, scope, qname });
  }
  if (stack.length !== 1) throw new Error('xml: unclosed element');
  const doc = root.children[0];
  if (!doc) throw new Error('xml: empty document');
  return doc;
};

/** The direct children named `ns:name`. */
export const children = (el: XmlEl | undefined, ns: string, name: string) =>
  (el?.children ?? []).filter((c) => c.ns === ns && c.name === name);
export const child = (el: XmlEl | undefined, ns: string, name: string) => children(el, ns, name)[0];

/** Every descendant named `ns:name` (depth first). */
export const descendants = (el: XmlEl | undefined, ns: string, name: string): XmlEl[] => {
  const out: XmlEl[] = [];
  const walk = (e: XmlEl) => {
    for (const c of e.children) {
      if (c.ns === ns && c.name === name) out.push(c);
      walk(c);
    }
  };
  if (el) walk(el);
  return out;
};
export const descendant = (el: XmlEl | undefined, ns: string, name: string) => descendants(el, ns, name)[0];
