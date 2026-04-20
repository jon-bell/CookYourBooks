// Transport-agnostic MCP dispatcher. Given a parsed JSON-RPC request
// object and a `RpcClient` (configured with the caller's bearer
// token), returns the JSON-RPC response object.
//
// Kept separate from the Vercel handler so unit tests can exercise
// every method + tool without running a web server.

import { TOOLS, TOOL_INDEX, type RpcClient } from './_mcp-tools.js';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'cookyourbooks-mcp', version: '0.1.0' };

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

/**
 * Handle one JSON-RPC message. Returns `null` for notifications (no id,
 * no response expected) — the HTTP layer should respond with 204/202
 * in that case.
 */
export async function dispatch(
  req: JsonRpcRequest,
  client: RpcClient,
): Promise<JsonRpcResponse | null> {
  const { method, id, params } = req;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case 'initialize': {
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Access a user\'s CookYourBooks library: read collections + recipes, search, ' +
            'create new recipes, and manage a persistent shopping list. All operations are ' +
            "scoped to the bearer token's owner; the server refuses cross-user access.",
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/progress': {
        // Spec notifications — accepted, no response body.
        return null;
      }
      case 'ping': {
        return ok(id, {});
      }
      case 'tools/list': {
        return ok(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      }
      case 'tools/call': {
        const name = (params?.name ?? '') as string;
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const tool = TOOL_INDEX[name];
        if (!tool) {
          return ok(id, {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          });
        }
        try {
          const value = await tool.run(args, client);
          return ok(id, {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            // Mirror the raw value too so clients that parse structured
            // content directly (newer MCP revs) get a typed object.
            structuredContent: value,
          });
        } catch (e) {
          return ok(id, {
            content: [{ type: 'text', text: (e as Error).message }],
            isError: true,
          });
        }
      }
      // Resources / prompts not yet implemented — advertise the empty
      // set rather than erroring so clients that probe don't choke.
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });
      default:
        if (isNotification) return null;
        return err(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    return err(id, -32603, 'Internal error', { message: (e as Error).message });
  }
}

export const MCP_META = { PROTOCOL_VERSION, SERVER_INFO };
