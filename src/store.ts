/** Load/save of the local docs snapshot. The snapshot is generated data and
 * intentionally NOT committed to the repo — run `npm run fetch` to create it. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiCategory, DocsData, ResolvedApi } from "./types.js";

const DATA_FILE = "jushuitan-docs.json";
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directory used when writing a fresh snapshot. */
export function dataDir(): string {
  if (process.env.JUSHUITAN_MCP_DATA) return path.dirname(path.resolve(process.env.JUSHUITAN_MCP_DATA));
  // prefer the current project when it looks like a checkout of this repo
  if (fs.existsSync(path.join(process.cwd(), "package.json"))) {
    return path.join(process.cwd(), "data");
  }
  return path.join(PKG_ROOT, "data");
}

export function dataWritePath(): string {
  if (process.env.JUSHUITAN_MCP_DATA) return path.resolve(process.env.JUSHUITAN_MCP_DATA);
  return path.join(dataDir(), DATA_FILE);
}

/** Resolve the snapshot path: env override > cwd > package dir. */
export function dataReadPath(): string {
  if (process.env.JUSHUITAN_MCP_DATA) return path.resolve(process.env.JUSHUITAN_MCP_DATA);
  const candidates = [path.join(process.cwd(), "data", DATA_FILE), path.join(PKG_ROOT, "data", DATA_FILE)];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function saveDocs(data: DocsData, file: string = dataWritePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

let cache: DocsData | null = null;

export function loadDocs(file: string = dataReadPath()): DocsData | null {
  if (cache) return cache;
  if (!fs.existsSync(file)) return null;
  try {
    cache = JSON.parse(fs.readFileSync(file, "utf8")) as DocsData;
    return cache;
  } catch {
    return null;
  }
}

/** For `refresh_data`: drop the in-memory cache so the next load re-reads disk. */
export function invalidateCache(): void {
  cache = null;
}

export function dataMissingError(): Error {
  return new Error(
    "本地文档快照不存在。请先运行 `npm run fetch` 拉取数据，或在对话中调用 refresh_data 工具在线拉取。" +
      `（查找路径：${dataReadPath()}，可用环境变量 JUSHUITAN_MCP_DATA 指定）`
  );
}

// ---------- lookups over the loaded snapshot ----------

export function allApis(data: DocsData): ResolvedApi[] {
  return data.categories.flatMap((c) => c.apis.map((doc) => ({ category: c, doc })));
}

export function findCategory(data: DocsData, key: string): ApiCategory | undefined {
  const k = key.trim();
  return (
    data.categories.find((c) => String(c.id) === k || c.name === k) ??
    data.categories.find((c) => c.name.toLowerCase().includes(k.toLowerCase()))
  );
}

/** Resolve an API by docId, exact route, exact name, or unique name substring. */
export function findApi(data: DocsData, key: string, categoryName?: string): ResolvedApi[] {
  const k = key.trim();
  let scope = allApis(data);
  if (categoryName) {
    const cat = findCategory(data, categoryName);
    if (cat) scope = scope.filter((r) => r.category.id === cat.id);
  }
  const byId = /^\d+$/.test(k) ? scope.filter((r) => r.doc.docId === Number(k)) : [];
  if (byId.length) return byId;
  const byRoute = scope.filter((r) => r.doc.route === k);
  if (byRoute.length) return byRoute;
  const byExactName = scope.filter((r) => r.doc.name === k);
  if (byExactName.length) return byExactName;
  const kw = k.toLowerCase();
  return scope.filter(
    (r) => r.doc.name.toLowerCase().includes(kw) || r.doc.route.toLowerCase().includes(kw)
  );
}
