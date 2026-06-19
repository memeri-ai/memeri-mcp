#!/usr/bin/env node
/**
 * Memeri MCP Reconnecting Proxy (STDIO <-> HTTP)
 *
 * - Exposes an MCP server over STDIO for Claude Code (Desktop/CLI).
 * - Forwards JSON-RPC requests to an upstream HTTP MCP at /mcp/:username.
 * - Detects "session_expired" and heals by re-running upstream initialize,
 *   then replays the original request exactly once.
 *
 * Env / flags:
 *   MCP_REMOTE_BASE   (required) e.g. https://memeri.ai
 *   MCP_AUTH          (required) e.g. "Bearer cb_..."
 *   MCP_USERNAME      (optional, unused) legacy — kept for backward compat
 *   MCP_CLIENT_NAME   (optional) default: "Memeri Reconnect Proxy"
 *   MCP_CLIENT_VER    (optional) default: "1.0.0"
 *   MCP_PROTOCOL_VER  (optional) default: "2024-11-05"
 *
 * Claude Code config (Desktop):
 * {
 *   "mcpServers": {
 *     "memeri": {
 *       "command": "node",
 *       "args": ["/absolute/path/tools/mcp-reconnect-proxy.js"],
 *       "env": {
 *         "MCP_REMOTE_BASE": "https://memeri.ai"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Config & helpers -------------------------------------------------------

const REMOTE_BASE = process.env.MCP_REMOTE_BASE;
const USERNAME    = process.env.MCP_USERNAME;
const AUTH        = process.env.MCP_AUTH || null;

const CLIENT_NAME = process.env.MCP_CLIENT_NAME || "Memeri Reconnect Proxy";
const CLIENT_VER  = process.env.MCP_CLIENT_VER || "1.0.0";

// Identity from console server — all available instantly at startup
const TERMINAL_ID     = process.env.MEMERI_TERMINAL_ID || '';
const MEMERI_SESSION  = process.env.MEMERI_SESSION_ID || '';
const ROADMAP_ID      = process.env.MEMERI_ROADMAP_ID || '';

console.error(`[mcp-proxy] TERMINAL=${TERMINAL_ID || 'NONE'}, SESSION=${MEMERI_SESSION || 'NONE'}, ROADMAP=${ROADMAP_ID || 'NONE'}`);

// Stable per-window instance ID. Generated once per proxy process lifecycle.
// Survives MCP reconnects since the proxy process stays alive.
// Sent as clientInfo metadata so the gateway can deduplicate agent entries.
//
// Also written to /tmp/memeri-proxy-instance-${PPID} so the PostToolUse
// telemetry hook can pick up the SAME instance ID for local tool events.
// This unifies MCP path and local-tool path under one window identifier.
import { randomUUID } from 'crypto';
import { writeFileSync, readFileSync, existsSync } from 'fs';
const CLIENT_INSTANCE_ID = randomUUID();
try {
  // Write under both PPID (Claude Code process) and a generic 'latest' file.
  // Hook scripts running in subshells can't always resolve back to the exact
  // Claude Code PPID, so the 'latest' file is the reliable fallback for
  // unifying MCP and local-tool events to one instance_id.
  const ppid = process.ppid || process.pid;
  writeFileSync(`/tmp/memeri-proxy-instance-${ppid}`, CLIENT_INSTANCE_ID, { mode: 0o600 });
  writeFileSync('/tmp/memeri-proxy-instance-latest', CLIENT_INSTANCE_ID, { mode: 0o600 });
} catch (_) { /* non-fatal */ }
// MCP protocol version (string per spec). Keep in sync with your server.
const PROTOCOL_VER = process.env.MCP_PROTOCOL_VER || "2024-11-05";

if (!REMOTE_BASE) {
  console.error(
    "[mcp-proxy] Missing required env. Set MCP_REMOTE_BASE."
  );
  process.exit(1);
}

// Gateway uses /mcp endpoint directly (auth via Bearer token, not username in path)
const UPSTREAM_URL = `${REMOTE_BASE.replace(/\/+$/, "")}/mcp`;

// Small delay helper (for Retry-After, if ever needed)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NETWORK_RETRY_DELAYS_MS = [2000, 4000, 6000];

function isSessionExpiredResponse(httpStatus, json) {
  if (!json?.error) return false;

  const recoveryCode = json.error.data?.code;

  // Current gateway recovery signals:
  // - SESSION_EXPIRED: stale session cannot be reused
  // - INITIALIZE_REQUIRED: upstream expects a fresh initialize before tool calls
  if (recoveryCode === "SESSION_EXPIRED" || recoveryCode === "INITIALIZE_REQUIRED") {
    return true;
  }

  // Legacy server behavior
  const expiredByStatus = httpStatus === 404;
  const expiredByBody =
    json.error.code === -32000 &&
    json.error.data &&
    json.error.data.reason === "session_expired";

  return expiredByStatus && expiredByBody;
}

function isTransientNetworkError(err) {
  if (!err) return false;

  if (typeof err.httpStatus === "number") {
    return false;
  }

  const networkCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);

  if (err.code && networkCodes.has(err.code)) {
    return true;
  }

  const causeCode = err.cause?.code;
  if (causeCode && networkCodes.has(causeCode)) {
    return true;
  }

  return err instanceof TypeError;
}

// --- Upstream client (HTTP MCP) --------------------------------------------

class UpstreamMCP {
  constructor({ url, auth, clientName, clientVersion, protocolVersion, instanceId }) {
    this.url = url;
    this.auth = auth;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.protocolVersion = protocolVersion;
    this.instanceId = instanceId;

    this.sessionId = null;      // active session for header `mcp-session-id`
    this.capabilities = null;   // upstream server capabilities after initialize
    this._nextId = 1;           // local JSON-RPC id counter
  }

  _headers(extra = {}) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...extra,
    };
    if (this.auth) headers["Authorization"] = this.auth;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    // Identity headers — console server → proxy → gateway
    headers["X-Client-Instance-Id"] = CLIENT_INSTANCE_ID;
    if (TERMINAL_ID) headers["X-Terminal-Id"] = TERMINAL_ID;
    if (MEMERI_SESSION) headers["X-Memeri-Session-Id"] = MEMERI_SESSION;
    if (ROADMAP_ID) headers["X-Memeri-Roadmap-Id"] = ROADMAP_ID;
    return headers;
  }

  _resetSession() {
    this.sessionId = null;
    this.capabilities = null;
  }

  async _retryNetworkOperation(label, fn) {
    let lastErr;

    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (!isTransientNetworkError(err) || attempt === NETWORK_RETRY_DELAYS_MS.length) {
          throw err;
        }

        const delayMs = NETWORK_RETRY_DELAYS_MS[attempt];
        console.error(
          `[mcp-proxy] ${label} network failure (${err.cause?.code || err.code || err.name || "unknown"}); retrying in ${delayMs}ms.`
        );
        this._resetSession();
        await sleep(delayMs);
      }
    }

    throw lastErr;
  }

  async _rpc(method, params) {
    const body = {
      jsonrpc: "2.0",
      id: this._nextId++,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const resp = await fetch(this.url, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    let json;
    const contentType = resp.headers.get("content-type") || "";
    try {
      if (contentType.includes("text/event-stream")) {
        // SSE response — extract JSON-RPC data from the event stream
        const text = await resp.text();
        const dataLine = text.split("\n").find(l => l.startsWith("data: "));
        if (dataLine) {
          json = JSON.parse(dataLine.slice(6));
        } else {
          throw new Error("No data line in SSE response");
        }
      } else {
        json = await resp.json();
      }
    } catch (e) {
      // If upstream returned non-JSON or empty body, surface it
      const text = await resp.text().catch(() => "");
      const err = new Error(
        `[upstream] Non-JSON response ${resp.status}: ${text.slice(0, 200)}`
      );
      err.httpStatus = resp.status;
      throw err;
    }

    // Allow caller to inspect http status + json (for session_expired checks)
    return { status: resp.status, headers: resp.headers, json };
  }

  async _handleRpcWithReconnect(method, params) {
    const execute = async () => {
      // Ensure we have a valid session before first call
      if (!this.sessionId) {
        await this.initialize();
      }

      // First try with current session
      let res = await this._rpc(method, params);

      // If upstream says session expired, heal then replay once
      if (isSessionExpiredResponse(res.status, res.json)) {
        // Optional: honor Retry-After header if present (your server sends 0)
        const retryAfter = Number(res.headers.get("retry-after") || 0);
        if (retryAfter > 0) await sleep(retryAfter * 1000);

        await this.initialize(true); // force fresh session
        res = await this._rpc(method, params);
      }

      return res;
    };

    let res;
    try {
      res = await execute();
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        throw err;
      }

      this._resetSession();
      res = await this._retryNetworkOperation(
        `${method} reconnect`,
        async () => {
          await this.initialize(true);
          return this._rpc(method, params);
        }
      );
    }

    // Now resolve / throw based on JSON-RPC result
    if (res.json.error) {
      const err = new Error(
        `[upstream] ${method} failed: ${res.json.error.message}`
      );
      err.code = res.json.error.code;
      err.data = res.json.error.data;
      err.httpStatus = res.status;
      throw err;
    }
    return res.json.result;
  }

  async initialize(force = false) {
    if (this.sessionId && !force) return;

    // New session: clear state first
    this._resetSession();

    const initParams = {
      protocolVersion: this.protocolVersion,
      capabilities: {
        // We declare minimal client-side capabilities. Upstream will advertise server capabilities.
        // Extend if you need (prompts, resources, tools, sampling, etc).
        experimental: {},
      },
      clientInfo: {
        name: this.clientName,
        version: this.clientVersion,
        instanceId: this.instanceId,
      },
    };

    // NOTE: For initialize, we must NOT send a stale session header.
    const body = {
      jsonrpc: "2.0",
      id: this._nextId++,
      method: "initialize",
      params: initParams,
    };

    const { resp, json } = await this._retryNetworkOperation(
      "initialize",
      async () => {
        const resp = await fetch(this.url, {
          method: "POST",
          headers: this._headers({ /* no mcp-session-id yet */ }),
          body: JSON.stringify(body),
        });

        let json;
        try {
          const ct = resp.headers.get("content-type") || "";
          if (ct.includes("text/event-stream")) {
            const text = await resp.text();
            const dataLine = text.split("\n").find(l => l.startsWith("data: "));
            if (dataLine) {
              json = JSON.parse(dataLine.slice(6));
            } else {
              throw new Error("No data line in SSE response");
            }
          } else {
            json = await resp.json();
          }
        } catch (e) {
          const text = await resp.text().catch(() => "");
          const err = new Error(
            `[upstream] initialize: non-JSON response ${resp.status}: ${text.slice(
              0,
              200
            )}`
          );
          err.httpStatus = resp.status;
          throw err;
        }

        return { resp, json };
      }
    );

    if (json.error) {
      const err = new Error(
        `[upstream] initialize error: ${json.error.message}`
      );
      err.code = json.error.code;
      err.data = json.error.data;
      err.httpStatus = resp.status;
      throw err;
    }

    // The upstream server sets the *new* session id in response headers, or expects client to use
    // the one it generated server-side. Your implementation stores sessionId internally and
    // expects client to echo it on subsequent calls via "mcp-session-id".
    //
    // Two patterns are common:
    // 1) Server returns the new session id in a header, e.g. "mcp-session-id".
    // 2) Server expects client to reuse the one it provided during transport creation.
    //
    // If you *also* send the session id in result.data (less common), we can detect that too.
    const newSid =
      resp.headers.get("mcp-session-id") ||
      (json.result && json.result.sessionId) ||
      null;

    if (!newSid) {
      // Fallback: allow the server to accept calls without echoing a session header
      // (but your server requires it, so we warn).
      console.warn(
        "[mcp-proxy] Warning: upstream initialize did not return a session id; subsequent calls may fail if server requires mcp-session-id header."
      );
    }

    this.sessionId = newSid;
    this.capabilities = json.result?.capabilities || {};

    // Per spec, client should send "notifications/initialized" after "initialize".
    // Send it directly so we don't require a response body from the upstream server.
    await this._retryNetworkOperation(
      "notifications/initialized",
      async () => {
        await fetch(this.url, {
          method: "POST",
          headers: this._headers(),
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {},
          }),
        });
      }
    );

    return this.capabilities;
  }

  // Public wrappers for common MCP methods we proxy 1:1
  async listTools(params) {
    return this._handleRpcWithReconnect("tools/list", params);
  }
  async callTool(params) {
    return this._handleRpcWithReconnect("tools/call", params);
  }
  async listResources(params) {
    return this._handleRpcWithReconnect("resources/list", params);
  }
  async readResource(params) {
    return this._handleRpcWithReconnect("resources/read", params);
  }
  async listPrompts(params) {
    return this._handleRpcWithReconnect("prompts/list", params);
  }
  async getPrompt(params) {
    return this._handleRpcWithReconnect("prompts/get", params);
  }
}

// --- STDIO MCP Server (for Claude) ------------------------------------------

const upstream = new UpstreamMCP({
  url: UPSTREAM_URL,
  auth: AUTH,
  clientName: CLIENT_NAME,
  clientVersion: CLIENT_VER,
  protocolVersion: PROTOCOL_VER,
  instanceId: CLIENT_INSTANCE_ID,
});

console.error(`[mcp-proxy] Instance ID: ${CLIENT_INSTANCE_ID}`);

// We expose a "transparent" server: it forwards tools/resources/prompts to upstream.
// Initialize is handled implicitly by upstream on first call (or explicitly if the
// Claude client sends initialize first — the SDK will take care of handshake).

const server = new Server(
  {
    name: CLIENT_NAME,
    version: CLIENT_VER,
  },
  {
    capabilities: {
      // We advertise that we support exactly what we proxy upstream.
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Tools
server.setRequestHandler(ListToolsRequestSchema, async (_req) => {
  const result = await upstream.listTools({});
  return result;
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // Single-replay guarantee is handled inside upstream._handleRpcWithReconnect
  const result = await upstream.callTool(req.params);
  return result;
});

// Resources
server.setRequestHandler(ListResourcesRequestSchema, async (_req) => {
  const result = await upstream.listResources({});
  return result;
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const result = await upstream.readResource(req.params);
  return result;
});

// Prompts (optional, if your upstream implements)
server.setRequestHandler(ListPromptsRequestSchema, async (_req) => {
  const result = await upstream.listPrompts({});
  return result;
});
server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const result = await upstream.getPrompt(req.params);
  return result;
});

// Wire up stdio transport and start
const transport = new StdioServerTransport();
await server.connect(transport);

// Helpful logging (stderr so we don't pollute stdio protocol)
server.onerror = (err) => {
  console.error("[mcp-proxy] Server error:", err);
};
process.on("unhandledRejection", (err) => {
  console.error("[mcp-proxy] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[mcp-proxy] Uncaught exception:", err);
});

// Optional: eager upstream initialize to reduce first-call latency
try {
  await upstream.initialize();
  console.error("[mcp-proxy] Upstream initialized OK.");
} catch (e) {
  console.error(
    "[mcp-proxy] Upstream initialize deferred (will auto-init on first call):",
    e?.message || e
  );
}
