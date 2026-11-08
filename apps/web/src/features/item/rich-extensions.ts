// SPDX-License-Identifier: AGPL-3.0-only
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { ListDirection, ListIndent } from './rich-lists';
import { TypingDirection } from './rich-dir';

/**
 * The rich editor's formatting extensions (everything but @mentions and co-editing), on their own so a unit test
 * builds exactly the editor the app uses (r17reply: paste → document → what is sent).
 */
export const richStarterKit = (collab: boolean) =>
  StarterKit.configure({
    heading: { levels: [2, 3] },
    link: { openOnClick: false, autolink: true, defaultProtocol: 'https', protocols: ['mailto'] },
    // Shared docs: Yjs has the history (each person undoes only their own changes).
    ...(collab ? { undoRedo: false as const } : {}),
  });

export const richFormatExtensions = (placeholder: string) => [
  Highlight,
  TaskList,
  TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' } }),
  ListDirection,
  ListIndent,
  TypingDirection,
  Placeholder.configure({ placeholder }),
];
