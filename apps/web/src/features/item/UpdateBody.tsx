// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState } from 'react';
import { renderRichDoc, type RichNode, updateImageOptions } from '@bines/shared';
import { cn } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { applyListDirs } from './rich-lists';
import { setTaskChecked } from './rich-text-logic';

/**
 * A rendered update (or reply / doc comment): the server's allowlisted HTML. Fix: * - lists and their items take the direction of their own text (markers on the right in Hebrew);
 * the product owner: "let me tick a check box in an update without opening it for editing" — whoever may tick it (`onToggle`
 * given: since anyone who may comment, not only its author) ticks its boxes right here: shown at
 *   once, saved as that one box, put back if the save fails.
 * an incoming email's images (`data-image-ref`) load from `imageSrc` (the app's address for them); one
 * that does not load leaves no broken frame; `onImage` opens one (its file in the viewer).
 */
export const UpdateBody = ({
  html,
  json,
  className,
  onToggle,
  testId,
  imageSrc,
  onImage,
}: {
  html: string;
  /** The update's ProseMirror JSON (null for plain-text updates — nothing to tick). */
  json?: Record<string, unknown> | null;
  className?: string;
  /** Saves one box (its index in document order); without it the boxes stay read-only. */
  onToggle?: (index: number, checked: boolean) => Promise<unknown>;
  testId?: string;
  /** Where an email image (`asset:<id>` / `remote:<n>`) is loaded from; without it they stay empty. */
  imageSrc?: (ref: string) => string;
  onImage?: (ref: string) => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  // What is shown while a tick is being saved (and after, until the server's copy comes back).
  const [local, setLocal] = useState<{ base: string; json: RichNode; html: string } | null>(null);
  const shown = local && local.base === html ? local : null;
  const doc = (shown?.json ?? json ?? null) as RichNode | null;
  const toggleable = !!onToggle && !!doc;
  const body = shown?.html ?? html;

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    applyListDirs(root);
    root.querySelectorAll<HTMLInputElement>('li[data-type="taskItem"] > input[type="checkbox"]').forEach((box) => {
      box.disabled = !toggleable;
      box.setAttribute('data-testid', 'update-task-box');
    });
    if (!imageSrc) return;
    root.querySelectorAll<HTMLImageElement>('img[data-image-ref]').forEach((img) => {
      const figure = img.closest('figure') ?? img;
      img.addEventListener('error', () => figure.setAttribute('hidden', ''), { once: true });
      img.setAttribute('data-testid', 'update-email-image');
      img.src = imageSrc(img.getAttribute('data-image-ref')!);
    });
  }, [body, toggleable, imageSrc]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const imageRef = (e.target as HTMLElement).getAttribute?.('data-image-ref');
    if (imageRef && onImage) {
      onImage(imageRef);
      return;
    }
    const box = e.target as HTMLElement;
    if (!toggleable || !(box instanceof HTMLInputElement) || box.type !== 'checkbox' || !onToggle || !doc) return;
    const boxes = Array.from(ref.current?.querySelectorAll('li[data-type="taskItem"] > input[type="checkbox"]') ?? []);
    const index = boxes.indexOf(box);
    const next = index >= 0 ? setTaskChecked(doc, index, box.checked) : null;
    if (!next) return;
    const before = shown;
    setLocal({ base: html, json: next, html: renderRichDoc(next, updateImageOptions).html });
    onToggle(index, box.checked).catch((err: unknown) => {
      setLocal(before);
      showToast({ message: errorMessage(err), tone: 'error' });
    });
  };

  return (
    // body_html is produced by the server from an allowlist (rich.ts / renderUpdateBody); never raw user HTML.
    <div
      ref={ref}
      className={cn('update-body rich-content', className)}
      data-testid={testId}
      data-toggle={toggleable || undefined}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
};
