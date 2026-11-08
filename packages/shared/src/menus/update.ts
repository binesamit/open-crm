// SPDX-License-Identifier: AGPL-3.0-only
import { action, menu, type MenuNode, SEP } from './types';

/** Update / reply (14 §10). Authors edit; authors, board owners and admins delete. */
export type UpdateMenuCtx = {
  canReply: boolean;
  isAuthor: boolean;
  canDelete: boolean;
  /** A secret update: no "copy text" (its text is sealed; the revealed card has its own copy). */
  secret?: boolean;
};

export const updateMenu = (c: UpdateMenuCtx): MenuNode[] =>
  menu([
    c.canReply && action('reply', 'item.reply'),
    c.isAuthor && action('edit', 'item.edit'),
    !c.secret && action('copy_text', 'menu.update.copyText'),
    // s37reply: a link that opens this update's thread (a reply: scrolled to it).
    action('copy_link', 'menu.copyLink'),
    SEP,
    c.canDelete && action('delete', 'menu.delete', { danger: true }),
  ]);
