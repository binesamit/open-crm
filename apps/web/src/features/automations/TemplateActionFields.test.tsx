// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t, type ItemTemplateSummary } from '@bines/shared';
import type { BoardDetail } from '../board/board-api';
import { TemplateActionFields } from './TemplateActionFields';

/**
 * Item templates in automations (phase 2): the action's settings — the new item's group, each of the
 * template's questions answered from a fitting column of the trigger item (or left to its default), and the links.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const column = (id: string, type: string, title = id) => ({ id, type, title, settings: {} });
const itemColumns = [
  column('name', 'name', 'Name'),
  column('due', 'date', 'Due'),
  column('span', 'timeline', 'Span'),
  column('owner', 'people', 'Owner'),
  column('notes', 'text', 'Notes'),
  column('projects', 'board_relation', 'Projects'),
] as unknown as BoardDetail['columns'];
const target = {
  id: 'B2',
  groups: [
    { id: 'g1', title: 'Inbox' },
    { id: 'g2', title: 'Active' },
  ],
  columns: [column('client', 'board_relation', 'Client')],
} as unknown as BoardDetail;
const template = {
  id: 'TPL1',
  name: 'Onboarding',
  variables: [
    { key: 'name', label: 'Client name', type: 'text', required: true, default: null },
    { key: 'start', label: 'Start', type: 'date', required: true, default: 'today' },
    { key: 'owner', label: 'Owner', type: 'person', required: false, default: null },
  ],
} as unknown as ItemTemplateSummary;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const render = (props: Partial<Parameters<typeof TemplateActionFields>[0]> = {}) => {
  const onChange = vi.fn();
  act(() =>
    root.render(
      createElement(TemplateActionFields, {
        action: { type: 'create_item_from_template', variables: { start: 'due' } },
        template,
        itemColumns,
        target,
        boardLevel: false,
        onChange,
        ...props,
      }),
    ),
  );
  return onChange;
};
const picker = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
const menuLabels = () =>
  [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map((x) =>
    x.textContent?.replace('✓', '').trim(),
  );

describe('template action settings', () => {
  it('a question per template question; the mapped one shows its column', () => {
    render();
    expect(picker('auto-template-var-name')).toBeTruthy();
    expect(picker('auto-template-var-owner')).toBeTruthy();
    expect(picker('auto-template-var-start')!.textContent).toContain('Due');
    expect(picker('auto-template-group')!.textContent).toContain(t('auto.itemTemplate.firstGroup'));
    expect(picker('auto-template-connect')).toBeTruthy();
    expect(picker('auto-template-connect-back')).toBeTruthy();
  });

  it('a date question lists only date / timeline columns; picking one sets it, "default" removes it', () => {
    const onChange = render();
    act(() => picker('auto-template-var-start')!.click());
    const labels = menuLabels();
    expect(labels).toEqual(expect.arrayContaining([t('auto.itemTemplate.noSource'), 'Due', 'Span']));
    expect(labels).not.toContain('Notes');
    expect(labels).not.toContain('Owner');
    const span = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].find(
      (x) => x.textContent?.trim() === 'Span',
    )!;
    act(() => span.click());
    expect(onChange).toHaveBeenLastCalledWith({ variables: { start: 'span' } });
    act(() => picker('auto-template-var-start')!.click());
    const none = [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')].find(
      (x) => x.textContent?.replace('✓', '').trim() === t('auto.itemTemplate.noSource'),
    )!;
    act(() => none.click());
    expect(onChange).toHaveBeenLastCalledWith({ variables: undefined });
  });

  it('subitems: no group or links; nothing to answer from on a board-level run; no template yet', () => {
    render({ action: { type: 'add_template_subitems' }, target: null });
    expect(picker('auto-template-group')).toBeNull();
    expect(picker('auto-template-connect')).toBeNull();
    render({ boardLevel: true });
    expect(document.body.textContent).toContain(t('auto.itemTemplate.needsItem'));
    render({ template: undefined });
    expect(document.body.textContent).toContain(t('auto.itemTemplate.pickFirst'));
  });
});
