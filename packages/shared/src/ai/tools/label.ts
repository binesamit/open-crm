// SPDX-License-Identifier: AGPL-3.0-only
import { hasMessage, t, type Locale } from '../../i18n';

/**
 * r27: a tool's name for people — the agent editor's wording (`agents.tool.<name>`), else the assistant's
 * (`ai2.tool.<name>`), and only when neither exists the registry's English title (`fallback`) or the raw name.
 */
export const aiToolLabel = (name: string, fallback?: string, locale?: Locale): string => {
  for (const key of [`agents.tool.${name}`, `ai2.tool.${name}`])
    if (hasMessage(key)) return locale ? t(key, undefined, locale) : t(key);
  return fallback || name;
};
