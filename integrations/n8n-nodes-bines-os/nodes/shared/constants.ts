// SPDX-License-Identifier: MIT
/**
 * Every product-facing name lives here, so renaming the product is a one-line change (the node and credential
 * `name`s stay stable — renaming those would break saved workflows).
 */
export const PRODUCT_NAME = 'Bines OS';

/** The credential type's internal name (saved in workflows — never rename). */
export const CREDENTIAL_NAME = 'binesOsApi';

/** The REST API lives under this path of the instance URL. */
export const API_PREFIX = '/api/v1';

/** Header names of a signed delivery (06 §2.17). */
export const SIGNATURE_HEADER = 'x-bines-signature';
export const TIMESTAMP_HEADER = 'x-bines-timestamp';
export const DELIVERY_HEADER = 'x-bines-delivery';

/** Deliveries older than this are refused (replays). */
export const MAX_SIGNATURE_AGE_MS = 10 * 60 * 1000;

/**
 * Trigger events offered in the UI: the platform's webhook events (packages/shared api/webhooks.ts). `api` is the
 * platform event when the option is a narrowed form of another one (a subitem status is a subitem column change
 * filtered to status columns / one label).
 */
export const TRIGGER_EVENTS = [
  { value: 'item_created', name: 'Item Created', description: 'An item was added to the board' },
  {
    value: 'specific_column_changed',
    name: 'Column Value Changed',
    description: 'A value of the chosen column changed',
    needsColumn: true,
  },
  {
    value: 'status_changed',
    name: 'Status Changed',
    description: 'A status column changed — optionally only to one label',
    needsColumn: true,
    needsLabel: true,
  },
  { value: 'column_changed', name: 'Any Column Changed', description: 'Any value of the board changed' },
  { value: 'item_name_changed', name: 'Item Renamed', description: 'An item got a new name' },
  { value: 'update_created', name: 'Update Posted', description: 'An update (comment) was posted on an item' },
  {
    value: 'item_moved_to_specific_group',
    name: 'Item Moved to Group',
    description: 'An item moved into the chosen group',
    needsGroup: true,
  },
  { value: 'item_moved_to_group', name: 'Item Moved to Any Group', description: 'An item moved between groups' },
  { value: 'item_archived', name: 'Item Archived', description: 'An item was archived' },
  { value: 'item_deleted', name: 'Item Deleted', description: 'An item was moved to the trash' },
  { value: 'item_restored', name: 'Item Restored', description: 'An item came back from the trash or the archive' },
  {
    value: 'item_moved_to_board',
    name: 'Item Moved to This Board',
    description: 'An item moved here from another board',
  },
  { value: 'update_edited', name: 'Update Edited', description: 'An update (comment) on an item was edited' },
  { value: 'update_deleted', name: 'Update Deleted', description: 'An update (comment) on an item was deleted' },
  { value: 'file_added', name: 'File Added', description: 'A file was added to a files column or an update' },
  { value: 'group_created', name: 'Group Created', description: 'A group was added to the board' },
  { value: 'column_created', name: 'Column Created', description: 'A column was added to the board' },
  { value: 'column_type_changed', name: 'Column Type Changed', description: "A column's type was changed" },
  { value: 'subitem_created', name: 'Subitem Created', description: 'A subitem was added under an item' },
  {
    value: 'subitem_column_changed',
    name: 'Subitem Column Changed',
    description: 'A value of a subitem changed — optionally only one subitem column',
    needsSubitemColumn: true,
  },
  {
    value: 'subitem_status_changed',
    name: 'Subitem Status Changed',
    description: 'A status column of a subitem changed — optionally only one column, or only to one label',
    api: 'subitem_column_changed',
    needsColumn: true,
    needsLabel: true,
  },
  { value: 'subitem_name_changed', name: 'Subitem Renamed', description: 'A subitem got a new name' },
  { value: 'subitem_archived', name: 'Subitem Archived', description: 'A subitem was archived' },
  { value: 'subitem_deleted', name: 'Subitem Deleted', description: 'A subitem was moved to the trash' },
  {
    value: 'subitem_update_created',
    name: 'Update Posted on a Subitem',
    description: 'An update (comment) was posted on a subitem',
  },
  {
    value: 'automation_sent',
    name: 'Sent From an Automation',
    description: `A ${PRODUCT_NAME} automation ran its "send to integrations" action`,
    needsChannel: true,
  },
] as const;

export type TriggerEvent = (typeof TRIGGER_EVENTS)[number]['value'];

/** The platform event an option subscribes to. */
export const apiEventOf = (event: string): string => {
  const def = TRIGGER_EVENTS.find((e) => e.value === event) as { api?: string } | undefined;
  return def?.api ?? event;
};

/** Does this trigger option (or this node's resource) work on the sub-board's columns? */
export const isSubitemEvent = (event: string) => event.startsWith('subitem_');
