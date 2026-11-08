// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AI_TOOLS, aiToolLabel, he, localizeToolPreview, SEARCH_KNOWLEDGE } from '../src';

/** r27: every tool the UI lists reads in the user's language, never the registry's English title. */
describe('aiToolLabel', () => {
  it('every registry tool has a Hebrew label', () => {
    for (const tool of [...AI_TOOLS.map((x) => x.name), SEARCH_KNOWLEDGE]) {
      const label = aiToolLabel(tool, 'FALLBACK', 'he');
      expect(label, tool).not.toBe('FALLBACK');
      expect(Object.values(he)).toContain(label);
    }
  });

  it('prefers the agent wording, then the assistant one, then the fallback', () => {
    expect(aiToolLabel('create_item', 'x', 'he')).toBe(he['agents.tool.create_item']);
    expect(aiToolLabel('create_board', 'x', 'he')).toBe(he['ai2.tool.create_board']);
    expect(aiToolLabel('no_such_tool', 'Fallback')).toBe('Fallback');
    expect(aiToolLabel('no_such_tool')).toBe('no_such_tool');
  });
});

describe('localizeToolPreview', () => {
  it("puts the tool's title of a stored English preview in the reader's language", () => {
    expect(localizeToolPreview('Update item: "Dana Levi" · "Leads" · Status: Won', 'he')).toBe(
      `${he['agents.tool.update_item']}: "Dana Levi" · "Leads" · Status: Won`,
    );
    expect(localizeToolPreview('Create a board', 'he')).toBe(he['ai2.tool.create_board']);
  });

  it('leaves other text unchanged', () => {
    expect(localizeToolPreview('Something else: x', 'he')).toBe('Something else: x');
  });
});
