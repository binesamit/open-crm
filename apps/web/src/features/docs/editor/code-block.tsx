// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from '@tiptap/react';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
import type {} from 'highlight.js'; // its ambient types for `highlight.js/lib/languages/*`
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { t } from '@bines/shared';
import { cn, Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';


/**
 * The doc's code block (r15): Tiptap's code block with lowlight (highlight.js) colouring, a language picker
 * (or auto-detect when none is set), a copy button, monospace and always LTR — also inside a Hebrew doc.
 * The language is the node's `language` attribute (a plain Yjs attribute, so it syncs like any other); the
 * colouring is decorations only, never stored. A curated set of languages keeps the doc chunk small.
 */
const GRAMMARS = {
  bash,
  cpp,
  csharp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  plaintext,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

export const lowlight = createLowlight(GRAMMARS);

/** The picker's list: the language id (what is stored) and its display name, in the order shown. */
export const CODE_LANGUAGES: { id: keyof typeof GRAMMARS; name: string }[] = [
  { id: 'plaintext', name: 'Plain text' },
  { id: 'bash', name: 'Bash / Shell' },
  { id: 'cpp', name: 'C / C++' },
  { id: 'csharp', name: 'C#' },
  { id: 'css', name: 'CSS' },
  { id: 'diff', name: 'Diff' },
  { id: 'go', name: 'Go' },
  { id: 'xml', name: 'HTML / XML' },
  { id: 'java', name: 'Java' },
  { id: 'javascript', name: 'JavaScript' },
  { id: 'json', name: 'JSON' },
  { id: 'kotlin', name: 'Kotlin' },
  { id: 'markdown', name: 'Markdown' },
  { id: 'php', name: 'PHP' },
  { id: 'python', name: 'Python' },
  { id: 'ruby', name: 'Ruby' },
  { id: 'rust', name: 'Rust' },
  { id: 'sql', name: 'SQL' },
  { id: 'swift', name: 'Swift' },
  { id: 'typescript', name: 'TypeScript' },
  { id: 'yaml', name: 'YAML' },
];

/** Short names an import or a Markdown fence may carry (```ts) → the picker's id. */
const ALIASES: Record<string, keyof typeof GRAMMARS> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  c: 'cpp',
  h: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  golang: 'go',
  html: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  kt: 'kotlin',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  text: 'plaintext',
  txt: 'plaintext',
};

/** A stored language (maybe an alias — `ts`, `sh`, `html`) → the picker's entry, or null (auto-detect). */
{
  const byName: Record<string, string[]> = {};
  for (const [alias, name] of Object.entries(ALIASES))
    if (!lowlight.registered(alias)) (byName[name] ??= []).push(alias);
  lowlight.registerAlias(byName);
}

export const codeLanguageOf = (raw: unknown) => {
  if (typeof raw !== 'string' || !raw) return null;
  const v = raw.toLowerCase();
  const id = ALIASES[v] ?? v;
  return CODE_LANGUAGES.find((l) => l.id === id) ?? null;
};

const CodeBlockView = ({ node, updateAttributes, editor }: ReactNodeViewProps) => {
  const menu = useActionMenu();
  const [copied, setCopied] = useState(false);
  const current = codeLanguageOf(node.attrs.language);
  const label = current ? current.name : t('docs2.code.auto');
  const pick = (language: string | null) => updateAttributes({ language });
  const items: MenuEntry[] = [
    {
      label: t('docs2.code.auto'),
      checked: !current,
      testId: 'doc-code-lang-auto',
      onSelect: () => pick(null),
    },
    { kind: 'separator' },
    ...CODE_LANGUAGES.map<MenuEntry>((l) => ({
      label: l.name,
      keywords: l.id,
      checked: current?.id === l.id,
      testId: `doc-code-lang-${l.id}`,
      onSelect: () => pick(l.id),
    })),
  ];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      showToast({ message: t('docs2.code.copied'), seconds: 2 });
    } catch {
      showToast({ message: t('docs2.code.copyFailed'), tone: 'error' });
    }
  };
  return (
    <NodeViewWrapper
      className="doc-code group/code relative my-2"
      data-testid="doc-code-block"
      data-id={node.attrs.id ?? undefined}
      data-language={current?.id ?? ''}
      dir="ltr"
    >
      <div
        contentEditable={false}
        className="doc-code-bar flex items-center justify-between gap-2 px-2 pt-1.5 text-xs text-muted"
      >
        <button
          type="button"
          disabled={!editor.isEditable}
          aria-haspopup="menu"
          aria-label={t('docs2.code.language')}
          title={editor.isEditable ? t('docs2.code.language') : undefined}
          data-testid="doc-code-lang"
          onMouseDown={(e) => e.preventDefault()}
          onClick={menu.fromTrigger}
          className="inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 font-medium enabled:hover:bg-surface enabled:hover:text-fg disabled:cursor-default"
        >
          {label}
          {editor.isEditable ? <Icon name="chevronDown" size={11} /> : null}
        </button>
        <button
          type="button"
          aria-label={t('docs2.code.copy')}
          title={t('docs2.code.copy')}
          data-testid="doc-code-copy"
          data-copied={copied || undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void copy()}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 font-medium hover:bg-surface hover:text-fg',
            copied && 'text-ok-fg',
          )}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? t('docs2.code.copied') : t('docs2.code.copy')}
        </button>
      </div>
      <pre spellCheck={false}>
        <NodeViewContent<'code'> as="code" className={current ? `language-${current.id}` : undefined} />
      </pre>
      <Menu at={menu.at} onClose={menu.close} items={items} label={t('docs2.code.language')} />
    </NodeViewWrapper>
  );
};

/** In place of StarterKit's code block (same node name and attributes — old docs keep working). */
export const DocCodeBlock = CodeBlockLowlight.extend({
  addNodeView: () => ReactNodeViewRenderer(CodeBlockView),
}).configure({
  lowlight,
  defaultLanguage: null,
  enableTabIndentation: true,
  tabSize: 2,
});
