// End-to-end smoke test: spawns the MCP stdio server and speaks JSON-RPC to it.
// Usage: node scripts/smoke-test.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(ROOT, "dist", "index.js");

const child = spawn(process.execPath, [CHILD], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

let buf = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id=${id})`)), 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  check("initialize", init.result?.serverInfo?.name === "jushuitan-mcp", JSON.stringify(init));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  check(
    "tools/list",
    ["list_categories", "list_apis", "search_apis", "get_api_doc", "refresh_data"].every((n) => names.includes(n)),
    JSON.stringify(names)
  );

  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.result?.isError) throw new Error(`${name} isError: ${JSON.stringify(r.result)}`);
    return r.result.content.map((c) => c.text).join("\n");
  };

  const cats = await call("list_categories", {});
  check("list_categories", cats.includes("订单API") && cats.includes("20"), cats.slice(0, 120));

  const list = await call("list_apis", { category: "订单API" });
  check("list_apis", list.includes("/open/jushuitan/orders/upload"), list.slice(0, 120));

  const search = await call("search_apis", { keyword: "订单上传" });
  check("search_apis", search.includes("/open/jushuitan/orders/upload"), search.slice(0, 120));

  const doc = await call("get_api_doc", { api: "/open/shops/query" });
  for (const sec of ["公共参数", "请求参数说明", "返回参数说明", "错误说明", "请求示例", "响应示例", "异常示例"]) {
    check(`get_api_doc 含「${sec}」`, doc.includes(`## ${sec}`) || doc.includes(`### ${sec}`) || doc.includes(`#### ${sec}`));
  }
  check("get_api_doc baseurl", doc.includes("https://openapi.jushuitan.com/open/shops/query"));

  const secDoc = await call("get_api_doc", { api: "1", section: "request_params" });
  check("get_api_doc section 过滤", secDoc.includes("请求参数说明") && !secDoc.includes("响应示例"));

  const ambiguous = await rpc("tools/call", { name: "get_api_doc", arguments: { api: "查询" } });
  const ambText = ambiguous.result.content.map((c) => c.text).join("\n");
  check("get_api_doc 重名候选", ambText.includes("命中") && ambText.includes("docId"), ambText.slice(0, 100));

  const missing = await rpc("tools/call", { name: "get_api_doc", arguments: { api: "/not/exist" } });
  check("get_api_doc 未命中", (missing.result.content[0].text || "").includes("未找到"));

  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
  process.exitCode = results.every((r) => r.pass) ? 0 : 1;
} catch (e) {
  console.error("SMOKE TEST ERROR:", e);
  process.exitCode = 1;
} finally {
  child.kill();
}
