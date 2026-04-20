// Model Context Protocol server for CookYourBooks. Accepts JSON-RPC
// 2.0 messages over Streamable HTTP (POST /api/mcp). Auth is a bearer
// `cyb_cli_*` token — the same one users mint in Settings for the
// `cyb` CLI. Every tool call is routed through an owner-scoped
// `security definer` Postgres RPC, so the MCP surface can't reach
// outside the caller's own library.
//
// Register with Claude Desktop / Claude Code via `mcp-remote`:
//
//   {
//     "mcpServers": {
//       "cookyourbooks": {
//         "command": "npx",
//         "args": ["-y", "mcp-remote",
//                  "https://cookyourbooks.app/api/mcp",
//                  "--header", "Authorization: Bearer cyb_cli_XXXX"]
//       }
//     }
//   }

import { dispatch, type JsonRpcRequest } from './_mcp-dispatch.js';
import type { RpcClient } from './_mcp-tools.js';

export const config = { runtime: 'edge' };

function env(name: string): string | undefined {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.[name];
  return v && v.length > 0 ? v : undefined;
}

function supabaseCreds(): { url: string; anonKey: string } | undefined {
  const url = env('SUPABASE_URL') ?? env('VITE_SUPABASE_URL');
  const anonKey =
    env('SUPABASE_ANON_KEY') ??
    env('SUPABASE_PUBLISHABLE_KEY') ??
    env('VITE_SUPABASE_ANON_KEY');
  if (!url || !anonKey) return undefined;
  return { url, anonKey };
}

function extractBearer(req: Request): string | undefined {
  // Standard Authorization header takes precedence.
  const auth = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1]!.trim();
  }
  // A handful of MCP bridges forward the token as `X-Api-Key`. Accept
  // it as a convenience; the tokens are opaque either way.
  const apiKey = req.headers.get('x-api-key');
  if (apiKey) return apiKey.trim();
  return undefined;
}

function makeRpcClient(
  creds: { url: string; anonKey: string },
  rawToken: string,
): RpcClient {
  return {
    async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const body = JSON.stringify({ raw_token: rawToken, ...args });
      const resp = await fetch(`${creds.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: creds.anonKey,
          Authorization: `Bearer ${creds.anonKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        // RPC results are owner-specific; never cache.
        cache: 'no-store',
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`${fn}: HTTP ${resp.status} ${text}`);
      }
      return (await resp.json()) as T;
    },
  };
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, x-api-key, mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '86400',
};

function json(
  body: unknown,
  init: ResponseInit = {},
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function unauthorized(message: string): Response {
  return json(
    { jsonrpc: '2.0', id: null, error: { code: -32001, message } },
    {
      status: 401,
      headers: { 'www-authenticate': 'Bearer realm="cookyourbooks-mcp"' },
    },
  );
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method === 'GET') {
    // Discovery affordance for curious humans + uptime checks.
    return json({
      name: 'cookyourbooks-mcp',
      version: '0.1.0',
      protocol: 'mcp',
      transport: 'streamable-http',
      note: 'POST JSON-RPC 2.0 messages here with a Bearer cyb_cli_* token.',
    });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  const token = extractBearer(req);
  if (!token) return unauthorized('Missing Bearer token');
  if (!token.startsWith('cyb_cli_')) {
    return unauthorized('Token must be a cyb_cli_* CookYourBooks CLI token');
  }

  const creds = supabaseCreds();
  if (!creds) {
    return json(
      { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Server misconfigured' } },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 400 },
    );
  }

  const client = makeRpcClient(creds, token);

  // Batched requests are permitted by JSON-RPC; handle them uniformly.
  if (Array.isArray(body)) {
    const results = await Promise.all(
      body.map((msg) => dispatch(msg as JsonRpcRequest, client)),
    );
    const filtered = results.filter((r): r is NonNullable<typeof r> => r !== null);
    if (filtered.length === 0) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return json(filtered);
  }

  const result = await dispatch(body as JsonRpcRequest, client);
  if (result === null) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  return json(result);
}
