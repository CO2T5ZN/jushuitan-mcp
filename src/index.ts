#!/usr/bin/env node
/**
 * Entry point.
 *
 * - `node dist/index.js`                    → stdio transport (default, unchanged behaviour)
 * - `node dist/index.js --transport=http`   → Streamable HTTP at `/mcp` (+ legacy SSE at `/sse`)
 *
 * HTTP options come from CLI flags first, then environment variables, then built-in defaults.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  startHttpServer,
  type HttpOptions,
} from "./http-server.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const USAGE = `${SERVER_NAME} ${SERVER_VERSION} — 聚水潭开放平台 API 文档 MCP Server

用法:
  jushuitan-mcp                     以 stdio 方式启动（默认，供 MCP 客户端 spawn）
  jushuitan-mcp --transport=http    以 HTTP 方式启动（Streamable HTTP + 旧版 SSE）

HTTP 参数:
  --host=<host>               监听地址，默认 ${DEFAULT_HTTP_HOST}（环境变量 HOST）
  --port=<port>               监听端口，默认 ${DEFAULT_HTTP_PORT}（环境变量 PORT）
  --path=<path>               Streamable HTTP 端点路径，默认 ${DEFAULT_HTTP_PATH}（JUSHUITAN_MCP_HTTP_PATH）
  --stateless                 无状态模式：每个请求新建会话，不保留 Mcp-Session-Id（JUSHUITAN_MCP_STATELESS）
  --json-response             Streamable HTTP 用普通 JSON 响应代替 SSE 流（JUSHUITAN_MCP_JSON_RESPONSE）
  --no-sse                    关闭旧版 GET /sse + POST /messages 端点（JUSHUITAN_MCP_LEGACY_SSE=0）
  --session-timeout=<分钟>    会话空闲回收时间，默认 30 分钟；0 = 不回收（JUSHUITAN_MCP_SESSION_TIMEOUT_MINUTES）
  --allowed-hosts=<a,b,..>    Host/Origin 白名单，DNS 防重绑；'*' 表示不校验（JUSHUITAN_MCP_ALLOWED_HOSTS）

其它:
  -h, --help                  打印本帮助
  -V, --version               打印版本号

环境变量 JUSHUITAN_MCP_TRANSPORT 也可取值 stdio/http。`;

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function envPort(): number | undefined {
  const raw = process.env.PORT;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envAllowedHosts(): string[] | undefined {
  const raw = process.env.JUSHUITAN_MCP_ALLOWED_HOSTS;
  if (!raw || !raw.trim()) return undefined;
  return raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/** Build HTTP options from env defaults, then apply CLI overrides. */
function httpOptionsFromEnv(): Partial<HttpOptions> {
  return {
    host: process.env.HOST ?? process.env.JUSHUITAN_MCP_HOST ?? DEFAULT_HTTP_HOST,
    port: envPort() ?? Number(process.env.JUSHUITAN_MCP_PORT ?? DEFAULT_HTTP_PORT),
    path: process.env.JUSHUITAN_MCP_HTTP_PATH ?? DEFAULT_HTTP_PATH,
    jsonResponse: truthy(process.env.JUSHUITAN_MCP_JSON_RESPONSE),
    stateless: truthy(process.env.JUSHUITAN_MCP_STATELESS),
    legacySse: process.env.JUSHUITAN_MCP_LEGACY_SSE === undefined ? true : truthy(process.env.JUSHUITAN_MCP_LEGACY_SSE),
    sessionIdleTimeoutMs:
      process.env.JUSHUITAN_MCP_SESSION_TIMEOUT_MINUTES === undefined
        ? DEFAULT_SESSION_IDLE_TIMEOUT_MS
        : Number(process.env.JUSHUITAN_MCP_SESSION_TIMEOUT_MINUTES) * 60 * 1000,
    allowedHosts: envAllowedHosts() ?? [...DEFAULT_ALLOWED_HOSTS],
  };
}

const VALUE_FLAGS = new Set(["--host", "--port", "--path", "--allowed-hosts", "--transport", "--session-timeout"]);
const BOOL_FLAGS = new Set(["--json-response", "--stateless", "--no-sse"]);

interface ParsedArgs {
  transport?: string;
  values: Map<string, string>;
  bools: Set<string>;
}

/** Supports both `--flag=value` and `--flag value` forms. */
function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) throw new Error(`未知参数：${arg}`);
    const eq = arg.indexOf("=");
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (BOOL_FLAGS.has(flag)) bools.add(flag);
    else if (VALUE_FLAGS.has(flag)) {
      if (inline !== undefined) values.set(flag, inline);
      else {
        const next = argv[++i];
        if (next === undefined) throw new Error(`缺少参数值：${flag}`);
        values.set(flag, next);
      }
    } else throw new Error(`未知参数：${arg}`);
  }
  return { transport: values.get("--transport"), values, bools };
}

function applyCliOverrides(opts: Partial<HttpOptions>, args: ParsedArgs): string[] {
  const used: string[] = ["--transport"];
  const { values, bools } = args;
  if (values.has("--host")) { opts.host = values.get("--host"); used.push("--host"); }
  if (values.has("--port")) { opts.port = Number(values.get("--port")); used.push("--port"); }
  if (values.has("--path")) { opts.path = values.get("--path"); used.push("--path"); }
  if (values.has("--allowed-hosts")) {
    opts.allowedHosts = (values.get("--allowed-hosts") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    used.push("--allowed-hosts");
  }
  if (values.has("--session-timeout")) {
    const minutes = Number(values.get("--session-timeout"));
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error(`--session-timeout 需为非负分钟数`);
    opts.sessionIdleTimeoutMs = minutes * 60 * 1000;
    used.push("--session-timeout");
  }
  if (bools.has("--json-response")) { opts.jsonResponse = true; used.push("--json-response"); }
  if (bools.has("--stateless")) { opts.stateless = true; used.push("--stateless"); }
  if (bools.has("--no-sse")) { opts.legacySse = false; used.push("--no-sse"); }
  return used;
}

async function runStdio(): Promise<void> {
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.includes("-V") || argv.includes("--version")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const args = parseArgs(argv);
  const transport = (args.transport ?? process.env.JUSHUITAN_MCP_TRANSPORT ?? "stdio").toLowerCase();
  const httpArgs = applyCliOverrides({}, args);

  if (transport === "stdio" && httpArgs.length > 1) {
    throw new Error(`HTTP 参数在 stdio 模式下无效：${httpArgs.slice(1).join(" ")}（是否漏了 --transport=http？）`);
  }

  if (transport === "stdio") {
    await runStdio();
    return;
  }
  if (transport !== "http" && transport !== "http+sse") {
    throw new Error(`不支持的传输方式：${transport}（可选 stdio / http）`);
  }

  const opts = httpOptionsFromEnv();
  applyCliOverrides(opts, args);
  if (!Number.isFinite(opts.port)) throw new Error(`端口无效：${opts.port}`);

  const handle = await startHttpServer(opts);
  const shutdown = () => {
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`${SERVER_NAME}: ${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
  process.exit(1);
});
