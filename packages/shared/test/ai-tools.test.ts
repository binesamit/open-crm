// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AI_TOOLS, AI_TOOL_NAMES, aiTool, TOKEN_SCOPES, toolAllowed, toolsFor } from '../src';

/** The AI tool registry (the planning notes "AGENTS-MCP" מ2): deterministic, well-formed, filtered by scopes and role. */
describe('AI tool registry', () => {
  it('is a fixed, ordered list (MCP 2026-07-28: deterministic tools/list)', () => {
    expect(AI_TOOL_NAMES).toMatchInlineSnapshot(`
      [
        "whoami",
        "search_help",
        "get_help_article",
        "show_me",
        "list_people",
        "list_workspaces",
        "search_boards",
        "get_board",
        "create_board",
        "create_group",
        "update_group",
        "create_column",
        "update_column",
        "update_item_card",
        "create_workspace",
        "create_folder",
        "move_board",
        "create_view",
        "create_dashboard",
        "list_dashboards",
        "get_dashboard",
        "add_dashboard_widget",
        "update_dashboard_widget",
        "remove_dashboard_widget",
        "update_dashboard",
        "set_dashboard_layout",
        "duplicate_dashboard_widget",
        "duplicate_dashboard",
        "delete_dashboard",
        "create_doc",
        "archive_board",
        "delete_board",
        "delete_group",
        "delete_column",
        "query_items",
        "get_item",
        "create_item",
        "update_item",
        "move_item",
        "move_item_to_board",
        "move_item_in_hierarchy",
        "archive_item",
        "delete_item",
        "list_updates",
        "create_update",
        "reply_update",
        "set_update_task",
        "reply_by_email",
        "list_files",
        "get_file_link",
        "attach_file_from_url",
        "add_file_link",
        "generate_image",
        "edit_file_image",
        "search",
        "my_work",
        "search_docs",
        "get_doc",
        "list_idoc_templates",
        "list_item_idocs",
        "get_idoc",
        "create_idoc",
        "send_idoc",
        "get_idoc_link",
        "set_idoc_link",
        "get_idoc_events",
        "get_idoc_signature",
        "get_idoc_pdf",
        "list_item_templates",
        "get_item_template",
        "create_item_template",
        "update_item_template",
        "apply_item_template",
        "delete_item_template",
        "list_automations",
        "create_automation",
        "set_automation_active",
        "test_automation",
        "automation_runs",
        "list_time_entries",
        "log_time",
        "item_activity",
        "undo",
        "flows_list",
        "flows_runs",
        "flows_draft_create",
        "flows_get",
        "flows_explain_failure",
        "flows_set_active",
        "flows_rerun",
        "flows_update_draft",
      ]
    `);
    expect(new Set(AI_TOOL_NAMES).size).toBe(AI_TOOL_NAMES.length);
  });

  it('every tool is well-formed: name, description, a known scope, hints that match its risk', () => {
    for (const t of AI_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z_]{1,40}$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.scope === 'any' || (TOKEN_SCOPES as readonly string[]).includes(t.scope)).toBe(true);
      expect(t.annotations.readOnlyHint).toBe(t.risk === 'read');
      expect(t.annotations.destructiveHint).toBe(t.risk === 'sensitive');
      // Reads never need a write scope; writes never only a read scope.
      if (t.risk !== 'read') expect(t.scope).toMatch(/write/);
    }
  });

  it('every input and output is an object JSON schema without $ref (older MCP clients) and no account_id', () => {
    for (const t of AI_TOOLS) {
      const input = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
      expect(input.type, t.name).toBe('object');
      expect(JSON.stringify(input), t.name).not.toContain('$ref');
      // The account always comes from the connection, never from the model (§8).
      expect(JSON.stringify(input), t.name).not.toContain('account_id');
      const output = z.toJSONSchema(t.output) as Record<string, unknown>;
      expect(output.type, t.name).toBe('object');
    }
  });

  it('structure, files, my work, automation runs and board moves: scope, risk and hints', () => {
    const meta = (name: string) => {
      const t = aiTool(name)!;
      return { scope: t.scope, risk: t.risk, open: t.annotations.openWorldHint };
    };
    for (const name of [
      'create_board',
      'create_group',
      'update_group',
      'create_column',
      'update_column',
      'update_item_card',
    ])
      expect(meta(name), name).toEqual({ scope: 'boards:write', risk: 'write', open: false });
    expect(meta('move_item_to_board')).toEqual({ scope: 'items:write', risk: 'sensitive', open: false });
    // building is a write; whatever removes something always waits for a person.
    for (const name of [
      'create_workspace',
      'create_folder',
      'move_board',
      'create_view',
      'create_dashboard',
      'create_doc',
    ])
      expect(meta(name), name).toEqual({ scope: 'boards:write', risk: 'write', open: false });
    // product knowledge — reads any connection may make.
    for (const name of ['search_help', 'get_help_article', 'show_me'])
      expect(meta(name), name).toEqual({ scope: 'any', risk: 'read', open: false });
    // dashboard widgets — reads and undoable writes.
    for (const name of ['list_dashboards', 'get_dashboard'])
      expect(meta(name), name).toEqual({ scope: 'boards:read', risk: 'read', open: false });
    for (const name of [
      'add_dashboard_widget',
      'update_dashboard_widget',
      'remove_dashboard_widget',
      'update_dashboard',
      'set_dashboard_layout',
      'duplicate_dashboard_widget',
      'duplicate_dashboard',
    ])
      expect(meta(name), name).toEqual({ scope: 'boards:write', risk: 'write', open: false });
    // deleting a dashboard always waits for a person.
    expect(meta('delete_dashboard')).toEqual({ scope: 'boards:write', risk: 'sensitive', open: false });
    for (const name of ['archive_board', 'delete_board', 'delete_group', 'delete_column'])
      expect(meta(name), name).toEqual({ scope: 'boards:write', risk: 'sensitive', open: false });
    // Permissions and users stay with people.
    expect(AI_TOOL_NAMES.some((n) => /permission|member|invite|role|user/.test(n))).toBe(false);
    // The URL is model-controlled: sensitive and open-world.
    expect(meta('attach_file_from_url')).toEqual({ scope: 'items:write', risk: 'sensitive', open: true });
    // AI image changes: the picture goes to an AI provider and the call costs money.
    expect(meta('edit_file_image')).toEqual({ scope: 'items:write', risk: 'sensitive', open: true });
    expect(meta('get_file_link')).toEqual({ scope: 'boards:read', risk: 'read', open: false });
    expect(meta('my_work')).toEqual({ scope: 'boards:read', risk: 'read', open: false });
    expect(meta('test_automation')).toEqual({ scope: 'automations:read', risk: 'read', open: false });
    expect(meta('automation_runs')).toEqual({ scope: 'automations:read', risk: 'read', open: false });
    const attach = aiTool('attach_file_from_url')!.input;
    expect(attach.safeParse({ item_id: 'i', column_id: 'files', url: 'ftp://x.test/a.pdf' }).success).toBe(false);
    expect(attach.safeParse({ item_id: 'i', column_id: 'files', url: 'https://x.test/a.pdf' }).success).toBe(true);
    const runs = aiTool('automation_runs')!.input;
    expect(runs.safeParse({}).success).toBe(false);
    expect(runs.safeParse({ board_id: 'b', automation_id: 'a' }).success).toBe(false);
    expect(runs.parse({ board_id: 'b' })).toMatchObject({ limit: 20, include_log: false });
    // A read-only token sees the reads among them, never the writes.
    const read = toolsFor({ scopes: ['boards:read', 'automations:read'] }).map((t) => t.name);
    expect(read).toEqual(expect.arrayContaining(['get_file_link', 'my_work', 'test_automation', 'automation_runs']));
    expect(read).not.toContain('create_board');
    const blocked = toolsFor({ scopes: ['admin'], sensitive: 'block' }).map((t) => t.name);
    expect(blocked).not.toContain('move_item_to_board');
    expect(blocked).not.toContain('attach_file_from_url');
  });

  it('list inputs are capped at 100 rows', () => {
    const q = aiTool('query_items')!;
    expect(q.input.safeParse({ board_id: 'b', limit: 101 }).success).toBe(false);
    expect(q.input.parse({ board_id: 'b' })).toMatchObject({ limit: 25, scope: 'parents' });
  });

  it('filters by token scopes, read-only roles and the sensitive policy', () => {
    const read = toolsFor({ scopes: ['boards:read'] }).map((t) => t.name);
    expect(read).toContain('query_items');
    expect(read).not.toContain('create_item');
    expect(read).not.toContain('list_updates');
    // A write scope implies its read (scopeAllows).
    expect(toolsFor({ scopes: ['items:write'] }).map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_board', 'create_item', 'delete_item']),
    );
    const viewer = toolsFor({ scopes: ['admin'], readOnly: true });
    expect(viewer.every((t) => t.risk === 'read')).toBe(true);
    expect(toolsFor({ scopes: ['admin'], sensitive: 'block' }).map((t) => t.name)).not.toContain('delete_item');
    expect(toolAllowed(aiTool('whoami')!, [])).toBe(true);
    // The order stays the registry's.
    const all = toolsFor({ scopes: ['admin'] }).map((t) => t.name);
    expect(all).toEqual(AI_TOOL_NAMES);
  });
});
