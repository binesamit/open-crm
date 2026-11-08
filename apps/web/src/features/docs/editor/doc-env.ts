// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';
import type { Member } from '../../board/board-api';

/**
 * What a doc's blocks need to render themselves (images, files, embeds, links): the account, its people, and
 * whether the reader may change the doc. Provided around the editor; the node views read it.
 */
export type DocEnv = {
  accountId: string;
  slug: string;
  members: Member[];
  editable: boolean;
  /** The workspace the doc is in (pickers start there). */
  workspaceId: string;
  /** The doc itself (a link to one of its blocks). */
  docId?: string;
};

export const DocEnvContext = createContext<DocEnv | null>(null);

export const useDocEnv = () => {
  const env = useContext(DocEnvContext);
  if (!env) throw new Error('DocEnvContext missing');
  return env;
};
