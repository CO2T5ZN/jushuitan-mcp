/** HTTP client + traversal for the official doc API (api.jushuitan.com). */

import { cleanText } from "./text.js";
import { flattenSchema } from "./schema.js";
import type { ApiCategory, ApiDoc, DocsData } from "./types.js";

const BASE = "https://api.jushuitan.com/openWeb/doc/api/";
const SOURCE_URL = "https://openweb.jushuitan.com/dev-doc?docType=1&docId=1";

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json;charset=UTF-8",
  Accept: "application/json",
  Origin: "https://openweb.jushuitan.com",
  Referer: "https://openweb.jushuitan.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/** Raw payload shapes returned by the doc API. */
interface RawCategory {
  id: number;
  name: string;
  ordered: number;
}
interface RawApiListItem {
  id: number;
  name: string;
  description: string | null;
}
interface RawDetail {
  id: number;
  name: string;
  description: string | null;
  meno: string | null;
  apiDocTextUrlRespDtoList: { env: string; url: string }[] | null;
  apiDocTextCommonParamRespDtoList:
    | { paramName: string; paramType: string; isRequired: boolean; description: string }[]
    | null;
  docTextResultRespDto: { requestText: string | null; returnText: string | null; errorText: string | null } | null;
  reqJsonSchema: string | null;
  respJsonSchema: string | null;
  errorCodeDTOList: { errorCode: string; errorMsg: string; solveInfo: string }[] | null;
  apiDocTextDemoRespDtoList: { codeType: string; codeText: string }[] | null;
}
interface Envelope<T> {
  code: number;
  msg: string | null;
  data: T;
}

class JstDocClient {
  private cookie = "";

  private mergeCookies(res: Response): void {
    const jar = new Map<string, string>();
    for (const pair of this.cookie.split(";").map((s) => s.trim()).filter(Boolean)) {
      const [k, ...v] = pair.split("=");
      jar.set(k.trim(), v.join("="));
    }
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const [k, ...v] = pair.split("=");
      if (k.trim()) jar.set(k.trim(), v.join("="));
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async post<T>(endpoint: string, body: unknown, tries = 4): Promise<T> {
    let lastErr: Error = new Error("unreachable");
    for (let i = 1; i <= tries; i++) {
      try {
        const res = await fetch(BASE + endpoint, {
          method: "POST",
          headers: { ...HEADERS, ...(this.cookie ? { Cookie: this.cookie } : {}) },
          body: JSON.stringify(body),
        });
        this.mergeCookies(res);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Envelope<T>;
        if (json.code !== 0) throw new Error(`code=${json.code} msg=${json.msg}`);
        return json.data;
      } catch (e) {
        lastErr = e as Error;
        if (i < tries) await new Promise((r) => setTimeout(r, 800 * i));
      }
    }
    throw new Error(`${endpoint} ${JSON.stringify(body)} failed: ${lastErr.message}`);
  }
}

async function pool<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const my = idx++;
        results[my] = await worker(items[my]);
      }
    })
  );
  return results;
}

function trimOrNull(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t || null;
}

function rawDetailToApiDoc(d: RawDetail): ApiDoc {
  return {
    docId: d.id,
    route: d.name,
    name: d.description ?? d.name,
    apiDescription: cleanText(d.meno),
    urls: (d.apiDocTextUrlRespDtoList ?? []).map((u) => ({ env: u.env, url: u.url })),
    commonParams: (d.apiDocTextCommonParamRespDtoList ?? []).map((p) => ({
      name: p.paramName,
      type: p.paramType,
      required: !!p.isRequired,
      description: cleanText(p.description),
    })),
    requestParams: flattenSchema(d.reqJsonSchema),
    responseParams: flattenSchema(d.respJsonSchema),
    errors: (d.errorCodeDTOList ?? []).map((e) => ({
      code: e.errorCode,
      message: cleanText(e.errorMsg),
      solve: cleanText(e.solveInfo),
    })),
    requestExample: trimOrNull(d.docTextResultRespDto?.requestText),
    responseExample: trimOrNull(d.docTextResultRespDto?.returnText),
    exceptionExample: trimOrNull(d.docTextResultRespDto?.errorText),
    codeDemos: (d.apiDocTextDemoRespDtoList ?? [])
      .filter((x) => (x.codeText ?? "").trim())
      .map((x) => ({ language: x.codeType, code: x.codeText })),
  };
}

/**
 * Traverse categories -> api lists -> api details and return normalized docs.
 * Concurrency is kept low to stay friendly to the public endpoint.
 */
export async function fetchAllDocs(log: (msg: string) => void = () => {}): Promise<DocsData> {
  const client = new JstDocClient();

  const cats = await client.post<RawCategory[]>("getApiContents", { data: {} });
  log(`categories: ${cats.length}`);

  const catWithApis = await pool(cats, async (c) => {
    const apis = await client.post<RawApiListItem[]>("getApiList", { data: String(c.id) });
    return { ...c, apis: apis ?? [] };
  }, 4);

  const flat = catWithApis.flatMap((c) => c.apis.map((a) => ({ api: a, categoryId: c.id, categoryName: c.name })));
  const uniqueIds = [...new Set(flat.map((f) => f.api.id))];
  log(`apis: ${flat.length} (unique ${uniqueIds.length})`);

  const details = new Map<number, RawDetail>();
  let done = 0;
  await pool(uniqueIds, async (id) => {
    details.set(id, await client.post<RawDetail>("getApiDetail", { data: String(id) }));
    if (++done % 50 === 0) log(`progress ${done}/${uniqueIds.length}`);
  }, 6);

  const categories: ApiCategory[] = catWithApis.map((c) => ({
    id: c.id,
    name: c.name,
    ordered: c.ordered,
    apis: c.apis
      .filter((a) => details.has(a.id))
      .map((a) => rawDetailToApiDoc(details.get(a.id)!)),
  }));

  const total = categories.reduce((s, c) => s + c.apis.length, 0);
  log(`done: ${categories.length} categories, ${total} apis`);
  return { fetchedAt: new Date().toISOString(), source: SOURCE_URL, categories };
}
