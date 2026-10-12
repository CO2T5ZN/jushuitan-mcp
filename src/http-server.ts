/**
 * HTTP transport for the MCP server — built on `node:http` only (no Express).
 *
 * Serves two transports side by side:
 *   - Streamable HTTP  → `${path}` (default `/mcp`), stateful sessions by default
 *   - HTTP + SSE       → `GET /sse` handshake, `POST /messages?sessionId=…` (legacy, 2024-11-05)
 *
 * Each session gets its own McpServer instance: `McpServer` binds a single transport,
 * while tool handlers share a process-wide docs cache, so this is cheap.
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createMcpServer } from "./server.js";

export interface HttpOptions {
  host: string;
  port: number;
  /** Base path of the Streamable HTTP endpoint. */
  path: string;
  /** Streamable HTTP: answer POSTs with `application/json` instead of opening an SSE stream. */
  jsonResponse: boolean;
  /** Streamable HTTP: one throwaway server+transport per request, no session bookkeeping. */
  stateless: boolean;
  /** Enable the deprecated `GET /sse` + `POST /messages` pair. */
  legacySse: boolean;
  /** Host allow-list (DNS-rebinding protection). `*` disables the check. */
  allowedHosts: string[];
  /** Idle timeout for streamable HTTP sessions, in ms. `0` disables reaping. */
  sessionIdleTimeoutMs: number;
  maxBodyBytes: number;
}

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3000;
export const DEFAULT_HTTP_PATH = "/mcp";
/** Reap sessions untouched for 30 minutes so long-running servers don't leak. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** Local-only by default; widen explicitly with `JUSHUITAN_MCP_ALLOWED_HOSTS`. */
export const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

export const DEFAULT_HTTP_OPTIONS: HttpOptions = {
  host: DEFAULT_HTTP_HOST,
  port: DEFAULT_HTTP_PORT,
  path: DEFAULT_HTTP_PATH,
  jsonResponse: false,
  stateless: false,
  legacySse: true,
  allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
  sessionIdleTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  maxBodyBytes: 4 * 1024 * 1024,
};

export interface HttpServerHandle {
  options: HttpOptions;
  url(path?: string): string;
  close(): Promise<void>;
}

/** Run-at-most-once guard: `transport.close()` → `onclose` → `server.close()` would otherwise recurse. */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// ---------- helpers ----------

function normalizePath(raw: string): string {
  const q = raw.indexOf("?");
  const base = q >= 0 ? raw.slice(0, q) : raw;
  const trimmed = base.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return trimmed.length ? trimmed : "/";
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Strip the port and IPv6 brackets from a host value, keeping it lower-cased. */
function hostnameOf(value: string): string {
  const lower = value.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end > 0 ? lower.slice(1, end) : lower;
  }
  return lower.split(":")[0];
}

/** DNS-rebinding guard: rejects foreign Host/Origin headers unless explicitly allowed. */
function assertAllowedOrigin(req: IncomingMessage, allowed: string[]): void {
  if (allowed.includes("*")) return;
  const allowedList = allowed.map(hostnameOf);
  const hostHeader = header(req, "host");
  if (hostHeader) {
    const host = hostnameOf(hostHeader);
    if (!allowedList.includes(host)) {
      throw new HttpError(403, `Host 不在白名单内：${hostHeader}（用 JUSHUITAN_MCP_ALLOWED_HOSTS 放开）`);
    }
  }
  const origin = header(req, "origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      throw new HttpError(403, "非法 Origin 头");
    }
    if (!allowedList.includes(originHost)) {
      throw new HttpError(403, `Origin 不在白名单内：${origin}（用 JUSHUITAN_MCP_ALLOWED_HOSTS 放开）`);
    }
  }
}

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = header(req, "origin");
  res.setHeader("Access-Control-Allow-Origin", origin ? origin : "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new HttpError(413, `请求体超过 ${maxBytes} 字节`);
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function isInitializeRequest(body: unknown): boolean {
  const list = Array.isArray(body) ? body : [body];
  return list.some((m) => (m as { method?: string } | undefined)?.method === "initialize");
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded) {
    try {
      res.end();
    } catch {
      /* already closed */
    }
    return;
  }
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

// ---------- server ----------

export async function startHttpServer(partial: Partial<HttpOptions> = {}): Promise<HttpServerHandle> {
  const options: HttpOptions = { ...DEFAULT_HTTP_OPTIONS, ...partial };

  /** Streamable HTTP sessions: sessionId → { transport, mcp } */
  const streamableSessions = new Map<string, { transport: StreamableHTTPServerTransport; mcp: McpServer }>();
  /** Legacy SSE sessions: sessionId → transport */
  const sseSessions = new Map<string, { transport: SSEServerTransport; mcp: McpServer }>();

  const basePath = normalizePath(options.path);
  const ssePath = "/sse";
  const messagesPath = "/messages";
  const healthPaths = new Set(["/health", "/healthz"]);

  const lastSeen = new Map<string, number>();
  const touch = (id: string) => lastSeen.set(id, Date.now());

  let idleTimer: ReturnType<typeof setInterval> | undefined;
  if (options.sessionIdleTimeoutMs > 0) {
    idleTimer = setInterval(() => {
      const cutoff = Date.now() - options.sessionIdleTimeoutMs;
      for (const [id, seen] of [...lastSeen]) {
        if (seen > cutoff) continue;
        const session = streamableSessions.get(id);
        if (session) {
          void session.transport.close().catch(() => {});
          void session.mcp.close().catch(() => {});
          streamableSessions.delete(id);
          log(`idle session reaped: ${id}`);
        }
        lastSeen.delete(id);
      }
    }, 60_000);
    idleTimer.unref();
  }

  function newStreamableSession(idGenerator: (() => string) | undefined) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: idGenerator,
      enableJsonResponse: options.jsonResponse,
      onsessioninitialized: (sessionId) => {
        touch(sessionId);
        log(`session initialized: ${sessionId}`);
      },
      onsessionclosed: (sessionId) => {
        streamableSessions.delete(sessionId);
        lastSeen.delete(sessionId);
        log(`session closed: ${sessionId}`);
      },
    });
    return transport;
  }

  async function handleStreamable(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    const sessionId = header(req, "mcp-session-id");

    if (options.stateless) {
      // No session state: every request gets a fresh transport+server pair.
      if (method !== "POST") throw new HttpError(405, "stateless 模式只支持 POST");
      if (sessionId) throw new HttpError(400, "stateless 模式不使用 Mcp-Session-Id");
      const mcp = createMcpServer();
      const transport = newStreamableSession(undefined);
      const cleanup = once(() => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      });
      res.on("close", cleanup);
      try {
        await mcp.connect(transport);
        const body = await readJsonBody(req, options.maxBodyBytes);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        // Nothing was written yet → drop the throwaway session now; otherwise wait for res to close.
        if (!res.headersSent) cleanup();
        throw err;
      }
      return;
    }

    if (method === "POST") {
      const body = await readJsonBody(req, options.maxBodyBytes);
      if (sessionId) {
        const existing = streamableSessions.get(sessionId);
        if (!existing) throw new HttpError(404, `未知的 session：${sessionId}`);
        touch(sessionId);
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (!isInitializeRequest(body)) {
        throw new HttpError(400, "缺少 Mcp-Session-Id：请先对该端点发送 initialize 请求建立会话");
      }
      const mcp = createMcpServer();
      const transport = newStreamableSession(() => randomUUID());
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) streamableSessions.delete(id);
      };
      transport.onerror = (err) => log(`streamable http error: ${err?.message ?? err}`);
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          await transport.close().catch(() => {});
          await mcp.close().catch(() => {});
        }
        throw err;
      }
      const newId = transport.sessionId;
      if (newId) streamableSessions.set(newId, { transport, mcp });
      return;
    }

    if (method === "GET") {
      if (!sessionId) throw new HttpError(400, "缺少 Mcp-Session-Id");
      const existing = streamableSessions.get(sessionId);
      if (!existing) throw new HttpError(404, `未知的 session：${sessionId}`);
      touch(sessionId);
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (method === "DELETE") {
      if (!sessionId) throw new HttpError(400, "缺少 Mcp-Session-Id");
      const existing = streamableSessions.get(sessionId);
      if (!existing) throw new HttpError(404, `未知的 session：${sessionId}`);
      await existing.transport.close().catch(() => {});
      await existing.mcp.close().catch(() => {});
      streamableSessions.delete(sessionId);
      lastSeen.delete(sessionId);
      res.writeHead(204).end();
      return;
    }

    throw new HttpError(405, `不支持的方法：${method}`);
  }

  async function handleLegacySse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";

    if (normalizePath(req.url ?? "") === ssePath) {
      if (method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      if (method !== "GET") throw new HttpError(405, "/sse 只支持 GET");

      const transport = new SSEServerTransport(messagesPath, res);
      const mcp = createMcpServer();
      sseSessions.set(transport.sessionId, { transport, mcp });
      const cleanup = once(() => {
        sseSessions.delete(transport.sessionId);
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      });
      transport.onclose = cleanup;
      transport.onerror = (err) => log(`sse error: ${err?.message ?? err}`);
      res.on("close", cleanup);
      await mcp.connect(transport);
      log(`sse session opened: ${transport.sessionId}`);
      return;
    }

    if (normalizePath(req.url ?? "") === messagesPath) {
      if (method !== "POST") throw new HttpError(405, "/messages 只支持 POST");
      const sessionId = new URL(req.url ?? "", "http://localhost").searchParams.get("sessionId");
      if (!sessionId) throw new HttpError(400, "缺少 sessionId 查询参数");
      const existing = sseSessions.get(sessionId);
      if (!existing) throw new HttpError(404, `未知的 SSE session：${sessionId}`);
      const body = await readJsonBody(req, options.maxBodyBytes);
      await existing.transport.handlePostMessage(req, res, body);
      return;
    }

    throw new HttpError(404, "Not Found");
  }

  const httpServer = createHttpServer((req, res) => {
    const path = normalizePath(req.url ?? "/");
    setCorsHeaders(req, res);

    void (async () => {
      try {
        assertAllowedOrigin(req, options.allowedHosts);
        if (path === basePath) {
          await handleStreamable(req, res);
          return;
        }
        if (options.legacySse && (path === ssePath || path === messagesPath)) {
          await handleLegacySse(req, res);
          return;
        }
        if (healthPaths.has(path)) {
          sendJson(res, 200, {
            status: "ok",
            server: "jushuitan-mcp",
            transport: ["streamable-http", ...(options.legacySse ? ["sse"] : [])],
            sessions: { streamableHttp: streamableSessions.size, sse: sseSessions.size },
            endpoints: {
              streamableHttp: basePath,
              ...(options.legacySse ? { sse: ssePath, messages: `${messagesPath}?sessionId=<id>` } : {}),
            },
          });
          return;
        }
        const legacy = options.legacySse ? `、${ssePath}、${messagesPath}?sessionId=<id>` : "";
        throw new HttpError(404, `Not Found。可用端点：${basePath}${legacy}、/health`);
      } catch (err) {
        if (err instanceof HttpError) {
          sendError(res, err.status, err.message);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        log(`unhandled error: ${message}`);
        sendError(res, 500, "Internal Server Error");
      }
    })();
  });

  // Long-lived SSE streams must not be killed by Node's default timeouts.
  httpServer.keepAliveTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const displayHost = options.host.includes(":") && !options.host.startsWith("[") ? `[${options.host}]` : options.host;
  log(`HTTP MCP server listening on http://${displayHost}:${options.port}${basePath}`);
  if (options.legacySse) log(`legacy SSE endpoint: GET http://${displayHost}:${options.port}${ssePath}`);
  log(`health check: http://${displayHost}:${options.port}/health`);

  return {
    options,
    url(p = basePath) {
      return `http://${displayHost}:${options.port}${p}`;
    },
    async close() {
      for (const s of [...streamableSessions.values()]) {
        await s.transport.close().catch(() => {});
        await s.mcp.close().catch(() => {});
      }
      streamableSessions.clear();
      for (const s of [...sseSessions.values()]) {
        await s.transport.close().catch(() => {});
        await s.mcp.close().catch(() => {});
      }
      sseSessions.clear();
      lastSeen.clear();
      if (idleTimer) clearInterval(idleTimer);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function log(message: string): void {
  process.stderr.write(`[jushuitan-mcp] ${message}\n`);
}
