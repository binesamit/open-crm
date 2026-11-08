// SPDX-License-Identifier: AGPL-3.0-only
import { ClearSearchButton } from '@bines/ui';

/**
 * Fix: — the "X" of a search input that is not a `SearchField`, pinned to the input's end edge. Put it next
 * to the input inside a `relative` wrapper and give the input end padding (`pe-7`). Shown only while there is text.
 */
export const SearchClear = ({ value, onClear, testId }: { value: string; onClear: () => void; testId?: string }) => (
  <span className="pointer-events-none absolute inset-y-0 end-1.5 flex items-center [&>button]:pointer-events-auto">
    <ClearSearchButton value={value} onClear={onClear} testId={testId} />
  </span>
);
