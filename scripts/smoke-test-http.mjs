// End-to-end smoke test for the HTTP transports: Streamable HTTP (stateful + stateless)
// and the legacy HTTP+SSE pair. Usage: node scripts/smoke-test-http.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "dist", "index.js");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
}

function freePort() {
  // Windows reserves dynamic ranges (Hyper-V) — stay in a low band and retry on failure.
  return 21000 + Math.floor(Math.random() * 4000);
}

async function spawnServer(port, args, env) {
  const child = spawn(process.execPath, [ENTRY, "--transport=http", "--port", String(port), ...args], {
    env: { ...process.env, ...env, JUSHUITAN_MCP_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let listenError = null;
  child.stderr.on("data", (d) => {
    const text = d.toString();
    if (/listen E(ACCES|ADDRINUSE)/.test(text)) listenError = text.trim();
    process.stderr.write(`[server stderr] ${text}`);
  });
  const base = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (listenError) {
      child.kill();
      throw new Error(listenError);
    }
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return { child, base, port };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error(`timeout waiting for ${base}`);
}

async function startServer(args = [], env = {}) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await spawnServer(freePort(), args, env);
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`server did not start: ${lastError?.message ?? lastError}`);
}

/** POST JSON to an endpoint; returns { status, headers, text }. */
async function post(base, urlPath, body, headers = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

/** Parse an SSE payload (or a bare JSON body) into JSON-RPC messages. */
function parseMessages(text) {
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) return [JSON.parse(text)];
  const out = [];
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) continue;
    try {
      out.push(JSON.parse(dataLine.slice(5).trim()));
    } catch {
      /* ignore keep-alive comments */
    }
  }
  return out;
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test-http", version: "0.0.1" } },
};

const servers = [];
const watchdog = setTimeout(() => {
  console.error("HTTP SMOKE TEST TIMEOUT");
  process.exit(1);
}, 120000);

try {
  // ---------------- 1. Streamable HTTP, stateful ----------------
  const main = await startServer();
  servers.push(main);
  const { base } = main;

  const health = await fetch(`${base}/health`).then((r) => r.json());
  check("/health 返回 ok", health.status === "ok" && health.endpoints.streamableHttp === "/mcp", JSON.stringify(health));

  const init = await post(base, "/mcp", INIT);
  const sessionId = init.headers.get("mcp-session-id");
  const initMsgs = parseMessages(init.text);
  check("streamable http initialize", init.status === 200 && initMsgs[0]?.result?.serverInfo?.name === "jushuitan-mcp", init.text.slice(0, 200));
  check("initialize 返回 Mcp-Session-Id", !!sessionId, init.text.slice(0, 120));

  await post(base, "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, { "Mcp-Session-Id": sessionId });

  const tools = await post(base, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "Mcp-Session-Id": sessionId });
  const names = (parseMessages(tools.text)[0]?.result?.tools ?? []).map((t) => t.name);
  check(
    "streamable http tools/list",
    ["list_categories", "list_apis", "search_apis", "get_api_doc", "refresh_data"].every((n) => names.includes(n)),
    JSON.stringify(names)
  );

  const cats = await post(
    base,
    "/mcp",
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_categories", arguments: {} } },
    { "Mcp-Session-Id": sessionId }
  );
  const catsText = (parseMessages(cats.text)[0]?.result?.content ?? []).map((c) => c.text).join("\n");
  check("streamable http tools/call list_categories", catsText.includes("订单API"), catsText.slice(0, 120));

  const search = await post(
    base,
    "/mcp",
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_apis", arguments: { keyword: "订单上传" } } },
    { "Mcp-Session-Id": sessionId }
  );
  const searchText = (parseMessages(search.text)[0]?.result?.content ?? []).map((c) => c.text).join("\n");
  check("streamable http tools/call search_apis", searchText.includes("/open/jushuitan/orders/upload"), searchText.slice(0, 120));

  const badSession = await post(base, "/mcp", { jsonrpc: "2.0", id: 5, method: "tools/list" }, { "Mcp-Session-Id": "does-not-exist" });
  check("未知 session → 404", badSession.status === 404, `got ${badSession.status}`);

  const noSession = await post(base, "/mcp", { jsonrpc: "2.0", id: 6, method: "tools/list" });
  check("缺少 session 的非 initialize 请求 → 400", noSession.status === 400, `got ${noSession.status}`);

  const listen = await fetch(`${base}/mcp`, { method: "GET", headers: { Accept: "text/event-stream", "Mcp-Session-Id": sessionId } });
  check(
    "GET /mcp 打开监听流",
    listen.ok && (listen.headers.get("content-type") ?? "").includes("text/event-stream"),
    `${listen.status} ${listen.headers.get("content-type")}`
  );
  await listen.body.cancel().catch(() => {});

  const noIdGet = await fetch(`${base}/mcp`, { method: "GET", headers: { Accept: "text/event-stream" } });
  check("GET /mcp 缺少 session → 400", noIdGet.status === 400, `got ${noIdGet.status}`);

  const del = await fetch(`${base}/mcp`, { method: "DELETE", headers: { "Mcp-Session-Id": sessionId } });
  check("DELETE 关闭 session → 204", del.status === 204, `got ${del.status}`);
  const afterDel = await post(base, "/mcp", { jsonrpc: "2.0", id: 7, method: "tools/list" }, { "Mcp-Session-Id": sessionId });
  check("关闭后 session 失效 → 404", afterDel.status === 404, `got ${afterDel.status}`);

  const evil = await post(base, "/mcp", INIT, { Origin: "http://evil.example.com" });
  check("非法 Origin → 403（DNS 防重绑）", evil.status === 403, `got ${evil.status}`);

  // ---------------- 2. Legacy HTTP + SSE ----------------
  const sseRes = await fetch(`${base}/sse`, { headers: { Accept: "text/event-stream" } });
  check("GET /sse 建立 SSE 连接", sseRes.ok && (sseRes.headers.get("content-type") ?? "").includes("text/event-stream"), String(sseRes.status));
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  const readUntil = async (predicate, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(sseBuf)) return;
      const { value, done } = await reader.read();
      if (done) return;
      sseBuf += decoder.decode(value, { stream: true });
    }
  };
  await readUntil(() => /event: endpoint/.test(sseBuf));
  const endpoint = /data: (\/messages\?sessionId=[^\s]+)/.exec(sseBuf)?.[1];
  check("SSE 首帧带 endpoint", !!endpoint, sseBuf.slice(0, 200));

  const sseInit = await post(base, endpoint, INIT);
  check("POST /messages 被接受 → 202", sseInit.status === 202, `got ${sseInit.status}: ${sseInit.text.slice(0, 120)}`);

  await readUntil(() => /"id":1/.test(sseBuf));
  const sseMsgs = parseMessages(sseBuf).find((m) => m.id === 1);
  check("SSE 收到 initialize 响应", sseMsgs?.result?.serverInfo?.name === "jushuitan-mcp", sseBuf.slice(0, 300));

  await post(base, endpoint, { jsonrpc: "2.0", method: "notifications/initialized" });
  const sseToolsSession = endpoint;
  await post(base, sseToolsSession, { jsonrpc: "2.0", id: 8, method: "tools/list" });
  await readUntil(() => /"id":8/.test(sseBuf));
  const sseTools = parseMessages(sseBuf).find((m) => m.id === 8);
  const sseNames = (sseTools?.result?.tools ?? []).map((t) => t.name);
  check("legacy SSE tools/list", sseNames.includes("get_api_doc"), JSON.stringify(sseNames));

  const sseCall = await post(base, endpoint, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "get_api_doc", arguments: { api: "/open/shops/query", section: "request_params" } },
  });
  check("legacy SSE tools/call 已投递", sseCall.status === 202, String(sseCall.status));
  await readUntil(() => /"id":9/.test(sseBuf));
  const callMsg = parseMessages(sseBuf).find((m) => m.id === 9);
  const callText = (callMsg?.result?.content ?? []).map((c) => c.text).join("\n");
  check("legacy SSE 收到 get_api_doc 结果", callText.includes("请求参数说明"), callText.slice(0, 120));

  await reader.cancel().catch(() => {});

  // ---------------- 3. Stateless + JSON response ----------------
  const stateless = await startServer(["--stateless", "--json-response", "--no-sse"]);
  servers.push(stateless);
  const sBase = stateless.base;

  const sInit = await post(sBase, "/mcp", INIT);
  const sInitBody = parseMessages(sInit.text)[0];
  check("stateless initialize（JSON 响应）", sInit.status === 200 && sInitBody?.result?.serverInfo?.name === "jushuitan-mcp", sInit.text.slice(0, 200));
  check("stateless 不返回 session", !sInit.headers.get("mcp-session-id"), String(sInit.headers.get("mcp-session-id")));
  check("stateless 响应为 application/json", (sInit.headers.get("content-type") ?? "").includes("application/json"), String(sInit.headers.get("content-type")));

  const sTools = await post(sBase, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("stateless tools/list（无 session 复用状态）", (parseMessages(sTools.text)[0]?.result?.tools ?? []).length === 5, sTools.text.slice(0, 160));

  const sNoSse = await fetch(`${sBase}/sse`).catch((e) => ({ status: 0, text: String(e) }));
  check("--no-sse 时 /sse 不可用", sNoSse.status === 404, `got ${sNoSse.status}`);

  // ---------------- 4. Custom path + / ----------------
  const custom = await startServer(["--path=/api/mcp", "--allowed-hosts=*", "--session-timeout=0"]);
  servers.push(custom);
  const cInit = await post(custom.base, "/api/mcp", INIT);
  check("自定义 --path 生效", cInit.status === 200 && !!cInit.headers.get("mcp-session-id"), `got ${cInit.status}`);
  const rootMiss = await fetch(`${custom.base}/mcp`, { method: "GET" });
  check("未开启的路径返回 404", rootMiss.status === 404, `got ${rootMiss.status}`);
  const wildHost = await post(custom.base, "/api/mcp", INIT, { Origin: "http://anything.example" });
  check("--allowed-hosts=* 放行任意 Host/Origin", wildHost.status === 200, `got ${wildHost.status}`);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exitCode = passed === results.length ? 0 : 1;
} catch (e) {
  console.error("HTTP SMOKE TEST ERROR:", e);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const s of servers) s.child.kill();
  // Live SSE/session sockets keep the event loop alive — exit explicitly.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
}
