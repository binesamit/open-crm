// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The names of a relation / dependency cell's linked items, aligned with `item_ids` (bug fix b). The cell
 * DTO's `names` is the truth — an item name may itself contain ", ". Splitting `text` is only a fallback for older
 * payloads without `names`. A missing name falls back to the id.
 */
export const linkedNames = (ids: string[], names: string[] | undefined, text: string | null): string[] => {
  const src = names ?? (text ?? '').split(', ');
  return ids.map((id, i) => src[i] || id);
};
