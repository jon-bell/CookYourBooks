import { describe, expect, it } from 'vitest';
import { dispatch, MCP_META } from './_mcp-dispatch.js';
import type { RpcClient } from './_mcp-tools.js';

// A canned RpcClient that records every call and replies from a map.
function fakeClient(
  replies: Record<string, unknown> = {},
  failOn: string[] = [],
): { client: RpcClient; calls: Array<{ fn: string; args: Record<string, unknown> }> } {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ fn, args });
        if (failOn.includes(fn)) throw new Error(`boom from ${fn}`);
        return (replies[fn] as T) ?? (null as unknown as T);
      },
    },
  };
}

describe('MCP dispatch', () => {
  it('initialize returns protocolVersion + tools capability', async () => {
    const { client } = fakeClient();
    const out = await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      client,
    );
    expect(out).not.toBeNull();
    expect(out!.result).toMatchObject({
      protocolVersion: MCP_META.PROTOCOL_VERSION,
      serverInfo: { name: 'cookyourbooks-mcp' },
      capabilities: { tools: { listChanged: false } },
    });
  });

  it('notifications/initialized is accepted with no response body', async () => {
    const { client } = fakeClient();
    const out = await dispatch(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      client,
    );
    expect(out).toBeNull();
  });

  it('unknown method returns a JSON-RPC -32601 error', async () => {
    const { client } = fakeClient();
    const out = await dispatch(
      { jsonrpc: '2.0', id: 9, method: 'nonsense' },
      client,
    );
    expect(out!.error?.code).toBe(-32601);
  });

  it('tools/list advertises every tool with an inputSchema', async () => {
    const { client } = fakeClient();
    const out = await dispatch(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      client,
    );
    const tools = (out!.result as { tools: Array<{ name: string; inputSchema: unknown }> })
      .tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_shopping_item',
        'check_shopping_item',
        'clear_shopping_list',
        'create_recipe',
        'get_collection',
        'get_recipe',
        'list_collections',
        'list_shopping_items',
        'remove_shopping_item',
        'search_recipes',
      ].sort(),
    );
    for (const t of tools) {
      expect((t.inputSchema as { type: string }).type).toBe('object');
    }
  });

  it('tools/call list_collections passes no args and reshapes the library', async () => {
    const { client, calls } = fakeClient({
      cli_export_library: {
        collections: [
          {
            id: 'c1',
            title: 'Bakery',
            source_type: 'PERSONAL',
            is_public: false,
            recipes: [{ id: 'r1' }, { id: 'r2' }],
          },
        ],
      },
    });
    const out = await dispatch(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_collections', arguments: {} },
      },
      client,
    );
    expect(calls[0]).toEqual({ fn: 'cli_export_library', args: {} });
    const result = out!.result as {
      content: Array<{ text: string }>;
      structuredContent: Array<Record<string, unknown>>;
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual([
      {
        id: 'c1',
        title: 'Bakery',
        source_type: 'PERSONAL',
        author: null,
        isbn: null,
        publisher: null,
        publication_year: null,
        is_public: false,
        recipe_count: 2,
      },
    ]);
  });

  it('tools/call add_shopping_item forwards name, nulls optional fields', async () => {
    const { client, calls } = fakeClient({
      cli_add_shopping: { id: 'new-id', name: 'eggs', checked: false },
    });
    await dispatch(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'add_shopping_item', arguments: { name: 'eggs' } },
      },
      client,
    );
    expect(calls[0]).toEqual({
      fn: 'cli_add_shopping',
      args: { name: 'eggs', quantity_text: null, note: null, recipe_id: null },
    });
  });

  it('tools/call check_shopping_item enforces a boolean flag', async () => {
    const { client } = fakeClient({ cli_check_shopping: true });
    const bad = await dispatch(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'check_shopping_item', arguments: { item_id: 'x' } },
      },
      client,
    );
    expect((bad!.result as { isError?: boolean }).isError).toBe(true);

    const good = await dispatch(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'check_shopping_item',
          arguments: { item_id: 'x', checked: true },
        },
      },
      client,
    );
    expect((good!.result as { isError?: boolean }).isError).toBeFalsy();
  });

  it('tools/call unknown tool returns an isError payload, not a protocol error', async () => {
    const { client } = fakeClient();
    const out = await dispatch(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'does_not_exist', arguments: {} },
      },
      client,
    );
    // JSON-RPC wise the call "succeeded" — the error lives inside `result`
    // per the MCP tools/call contract so the client shows it to the model.
    expect(out!.error).toBeUndefined();
    expect((out!.result as { isError?: boolean }).isError).toBe(true);
  });

  it('tools/call surfaces RPC failures as isError content', async () => {
    const { client } = fakeClient({}, ['cli_get_recipe']);
    const out = await dispatch(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'get_recipe', arguments: { recipe_id: 'x' } },
      },
      client,
    );
    const result = out!.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/boom from cli_get_recipe/);
  });
});
