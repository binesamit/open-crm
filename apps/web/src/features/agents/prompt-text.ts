// SPDX-License-Identifier: AGPL-3.0-only
/**
 * r27: a run's first message as the model got it (engine/prompt.ts `firstMessage`) — `<task>…</task>` and the
 * `<untrusted_content source="…">…</untrusted_content>` wrappers — split into parts a person reads: the task as
 * plain text, each wrapped block with its source. Only the view changes; what the model gets stays as it is.
 */
export type PromptPart = { kind: 'text'; text: string } | { kind: 'attached'; source: string; text: string };

const WRAPPERS =
  /<task>\s*([\s\S]*?)\s*<\/task>|<untrusted_content(?:\s+source="([^"]*)")?>\s*([\s\S]*?)\s*<\/untrusted_content>/g;

export const promptParts = (raw: string): PromptPart[] => {
  const parts: PromptPart[] = [];
  const pushText = (text: string) => {
    const v = text.trim();
    if (v) parts.push({ kind: 'text', text: v });
  };
  let last = 0;
  for (const m of raw.matchAll(WRAPPERS)) {
    pushText(raw.slice(last, m.index));
    if (m[1] !== undefined) pushText(m[1]);
    else if (m[3]?.trim()) parts.push({ kind: 'attached', source: m[2] ?? '', text: m[3].trim() });
    last = m.index + m[0].length;
  }
  pushText(raw.slice(last));
  return parts;
};

/** The prompt as one plain line (a run's row): the task text only, no wrapper tags. */
export const promptPlain = (raw: string) => {
  const parts = promptParts(raw);
  const texts = parts.filter((p) => p.kind === 'text');
  return (texts.length ? texts : parts).map((p) => (p.kind === 'text' ? p.text : attachedText(p))).join(' ');
};

/** An attached item (`{"item_id","name","board_id"}`) reads as its name; anything else as its text. */
export const attachedText = (part: Extract<PromptPart, { kind: 'attached' }>): string => {
  if (part.source === 'item')
    try {
      const v = JSON.parse(part.text) as { name?: unknown };
      if (typeof v.name === 'string' && v.name) return v.name;
    } catch {
      // not JSON — shown as it is
    }
  return part.text;
};
