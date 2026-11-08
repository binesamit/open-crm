// SPDX-License-Identifier: AGPL-3.0-only
/**
 * 04 §8.1 — the builder's catalogue: sentence skeletons with blanks (missing fields), by category. Generic for
 * every account and board: blanks are filled from the board in the builder (D21).
 */
export type DraftRecipe = {
  trigger: Record<string, unknown> & { type: string };
  conditions?: unknown;
  actions: (Record<string, unknown> & { type: string })[];
};

export const TEMPLATE_CATEGORIES = [
  'status',
  'items',
  'dates',
  'people',
  'cross_board',
  'communication',
  'integrations',
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export type AutomationTemplate = { id: string; category: TemplateCategory; draft: DraftRecipe };

const tpl = (
  id: string,
  category: TemplateCategory,
  trigger: DraftRecipe['trigger'],
  ...actions: DraftRecipe['actions']
) => ({
  id,
  category,
  draft: { trigger, actions },
});

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  tpl('status_move_group', 'status', { type: 'status_changed', labels: [] }, { type: 'move_to_group' }),
  tpl(
    'status_notify',
    'status',
    { type: 'status_changed', labels: [] },
    { type: 'notify', to: '@board_owners', message: '{item.name}' },
  ),
  tpl('status_set_date', 'status', { type: 'status_changed', labels: [] }, { type: 'set_date', value: 'today' }),
  tpl('status_set_status', 'status', { type: 'status_changed', labels: [] }, { type: 'set_status' }),
  tpl('status_archive', 'status', { type: 'status_changed', labels: [] }, { type: 'archive_item' }),
  tpl('created_set_status', 'items', { type: 'item_created' }, { type: 'set_status' }),
  tpl('created_assign_creator', 'items', { type: 'item_created' }, { type: 'assign', who: '@creator', mode: 'add' }),
  tpl(
    'created_notify',
    'items',
    { type: 'item_created' },
    { type: 'notify', to: '@board_owners', message: '{item.name}' },
  ),
  tpl(
    'moved_group_notify',
    'items',
    { type: 'item_moved_to_group', group: 'any' },
    { type: 'notify', to: '@board_owners', message: '{item.name}' },
  ),
  tpl(
    'date_notify',
    'dates',
    { type: 'date_arrived', offset_days: 0, time: '09:00' },
    { type: 'notify', message: '{item.name}' },
  ),
  tpl(
    'date_before_notify',
    'dates',
    { type: 'date_arrives_before', days: 1, time: '09:00' },
    { type: 'notify', message: '{item.name}' },
  ),
  tpl('date_set_status', 'dates', { type: 'date_arrived', offset_days: 0, time: '09:00' }, { type: 'set_status' }),
  tpl(
    'daily_notify',
    'dates',
    { type: 'every_time_period', period: 'day', time: '09:00', scope: 'each_item' },
    { type: 'notify', message: '{item.name}' },
  ),
  tpl(
    'assigned_notify',
    'people',
    { type: 'person_assigned', who: 'any' },
    { type: 'notify', to: '@actor', message: '{item.name}' },
  ),
  tpl(
    'status_create_item',
    'cross_board',
    { type: 'status_changed', labels: [] },
    { type: 'create_item', name: '{item.name}' },
  ),
  tpl('status_move_board', 'cross_board', { type: 'status_changed', labels: [] }, { type: 'move_to_board' }),
  tpl('all_linked_done', 'cross_board', { type: 'connected_items_all_done' }, { type: 'set_status' }),
  tpl(
    'status_email',
    'communication',
    { type: 'status_changed', labels: [] },
    { type: 'send_email', subject: '{item.name}', body_html: '' },
  ),
  tpl('status_sms', 'communication', { type: 'status_changed', labels: [] }, { type: 'send_sms', message: '' }),
  tpl(
    'update_notify',
    'communication',
    { type: 'update_posted' },
    { type: 'notify', to: '@board_owners', message: '{item.name}' },
  ),
  tpl(
    'status_webhook',
    'integrations',
    { type: 'status_changed', labels: [] },
    { type: 'webhook', url: '', method: 'POST', payload: 'item' },
  ),
  tpl(
    'created_webhook',
    'integrations',
    { type: 'item_created' },
    { type: 'webhook', url: '', method: 'POST', payload: 'item' },
  ),
];
