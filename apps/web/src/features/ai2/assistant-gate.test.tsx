// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@bines/shared';
import { queryKeys } from '../../lib/api';
import { AssistantButton, AssistantPanel } from './AssistantPanel';

/**
 * plan-lock (product decision): in a read-only, suspended or closed account the AI assistant cannot even open — its button is
 * disabled with the reason, and the panel, whoever asks for it (a menu row, a link), closes itself unrendered.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
let qc: QueryClient;

const withStatus = (plan_status: string | null) => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(queryKeys.myAccounts, {
    data: [{ id: 'A1', slug: 'acme', name: 'Acme', role: 'admin', status: 'active', plan_features: null, plan_status }],
  });
};
const render = (node: ReturnType<typeof createElement>) =>
  act(() => {
    root!.render(createElement(QueryClientProvider, { client: qc }, node));
  });
const ctx = { accountId: 'A1', slug: 'acme', boardId: 'B1', title: 'Leads' };

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = '';
});

describe('the assistant under a blocking plan status', () => {
  for (const status of ['read_only', 'suspended', 'closed']) {
    it(`${status}: the button is disabled with the reason and opens nothing`, () => {
      withStatus(status);
      render(createElement(AssistantButton, ctx));
      const button = host.querySelector<HTMLButtonElement>('[data-testid="board-assistant"]')!;
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('data-tip')).toBe(t('plan.ai.blocked' as never));
      act(() => button.click());
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(document.body.querySelector('[data-testid="assistant-panel"]')).toBeNull();
    });

    it(`${status}: the panel asked for directly closes itself and renders nothing`, () => {
      withStatus(status);
      const onClose = vi.fn();
      render(createElement(AssistantPanel, { ...ctx, onClose }));
      expect(onClose).toHaveBeenCalled();
      expect(host.innerHTML).toBe('');
    });
  }

  it('an active account: the button is enabled', () => {
    withStatus('active');
    render(createElement(AssistantButton, ctx));
    const button = host.querySelector<HTMLButtonElement>('[data-testid="board-assistant"]')!;
    expect(button.getAttribute('aria-disabled')).toBeNull();
  });
});
