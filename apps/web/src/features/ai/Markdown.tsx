// SPDX-License-Identifier: AGPL-3.0-only
import { type CSSProperties, Fragment, type ReactNode, useLayoutEffect, useMemo, useRef } from 'react';
import { markdownToRichDoc, type RichMark, type RichNode } from '@bines/shared';
import { cn } from '@bines/ui';
import { applyListDirs } from '../item/rich-lists';

/**
 * Text an AI wrote, shown formatted (sync-ai): the assistant's answers, an agent's answers and final text.
 *
 * Markdown → the update editor's rich JSON (`markdownToRichDoc`) → React elements here, from the same allowlist as
 * the server's renderer (rich.ts): known nodes and marks only, links http(s) / mailto with rel="noopener noreferrer".
 * No HTML string is ever injected (the AI red-team guard), so nothing in the text can become markup — a tag stays
 * visible text. It looks like a formatted update (`.rich-content`, both themes) and every block takes the direction
 * of its own text (Hebrew right, English left).
 */
const MAX_DEPTH = 24;

const safeHref = (href: unknown): string | null => {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) && h.length <= 2000 ? h : null;
};

const withMark = (m: RichMark, child: ReactNode, key: number): ReactNode => {
  switch (m.type) {
    case 'bold':
      return <strong key={key}>{child}</strong>;
    case 'italic':
      return <em key={key}>{child}</em>;
    case 'strike':
      return <s key={key}>{child}</s>;
    case 'underline':
      return <u key={key}>{child}</u>;
    case 'code':
      return <code key={key}>{child}</code>;
    case 'highlight':
      return <mark key={key}>{child}</mark>;
    case 'link': {
      const href = safeHref(m.attrs?.href);
      return href ? (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {child}
        </a>
      ) : (
        child
      );
    }
    default:
      return child;
  }
};

const align = (n: RichNode): CSSProperties | undefined => {
  const a = n.attrs?.align;
  return a === 'left' || a === 'right' || a === 'center' ? { textAlign: a } : undefined;
};

const render = (n: RichNode, key: number, depth: number): ReactNode => {
  if (depth > MAX_DEPTH) return null;
  // Each child keyed by its place, so marks / text siblings never collide.
  const kids = () => (n.content ?? []).map((c, i) => <Fragment key={i}>{render(c, i, depth + 1)}</Fragment>);
  switch (n.type) {
    case 'doc':
      return kids();
    case 'text':
      return (n.marks ?? []).reduceRight<ReactNode>((child, m, i) => withMark(m, child, i), n.text ?? '');
    case 'paragraph':
      return <p key={key}>{kids()}</p>;
    case 'heading':
      return n.attrs?.level === 3 ? <h3 key={key}>{kids()}</h3> : <h2 key={key}>{kids()}</h2>;
    case 'bulletList':
      return <ul key={key}>{kids()}</ul>;
    case 'orderedList': {
      const start = Number(n.attrs?.start);
      return (
        <ol key={key} start={Number.isInteger(start) && start > 1 ? start : undefined}>
          {kids()}
        </ol>
      );
    }
    case 'listItem':
      return <li key={key}>{kids()}</li>;
    case 'taskList':
      return (
        <ul key={key} data-type="taskList">
          {kids()}
        </ul>
      );
    case 'taskItem': {
      const checked = n.attrs?.checked === true;
      return (
        <li key={key} data-type="taskItem" data-checked={checked}>
          <input type="checkbox" disabled checked={checked} readOnly />
          <div>{kids()}</div>
        </li>
      );
    }
    case 'blockquote':
      return <blockquote key={key}>{kids()}</blockquote>;
    case 'codeBlock':
      return (
        <pre key={key}>
          <code>{kids()}</code>
        </pre>
      );
    case 'horizontalRule':
      return <hr key={key} />;
    case 'hardBreak':
      return <br key={key} />;
    case 'mention':
      return (
        <span key={key} className="mention">
          @{String(n.attrs?.label ?? '')}
        </span>
      );
    case 'table':
      return (
        <div key={key} className="rich-table">
          <table>
            <tbody>{kids()}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr key={key}>{kids()}</tr>;
    case 'tableHeader':
      return (
        <th key={key} style={align(n)}>
          {kids()}
        </th>
      );
    case 'tableCell':
      return (
        <td key={key} style={align(n)}>
          {kids()}
        </td>
      );
    default:
      // Not on the allowlist: its text only.
      return kids();
  }
};

export const Markdown = ({ text, className, testId }: { text: string; className?: string; testId?: string }) => {
  const doc = useMemo(() => markdownToRichDoc(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) applyListDirs(ref.current);
  }, [doc]);
  return (
    <div ref={ref} dir="auto" className={cn('rich-content ai-markdown text-sm', className)} data-testid={testId}>
      {render(doc, 0, 0)}
    </div>
  );
};
