// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';

/** `value` as it stood `ms` ago at the latest — a search box's text once typing paused. */
export const useDebounced = <T>(value: T, ms = 300) => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
};
