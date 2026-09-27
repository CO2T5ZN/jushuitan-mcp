/** MCP tool definitions: inputs (zod), handlers, output rendering. */

import { z } from "zod";
import { fetchAllDocs } from "./fetcher.js";
import { DOC_SECTIONS, renderApiDoc, renderApiList, renderCategoryList, renderSearchResults, type DocSection } from "./render.js";
import { allApis, dataMissingError, findApi, findCategory, invalidateCache, loadDocs, saveDocs } from "./store.js";
import type { DocsData } from "./types.js";

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `错误：${msg}` }], isError: true };
}

function withData(fn: (data: DocsData) => string): ToolResult {
  const data = loadDocs();
  if (!data) return fail(dataMissingError());
  return ok(fn(data));
}

/** Build the final tool list (name -> def) used by the server. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: any) => Promise<ToolResult>;
}

export function buildTools(): ToolDef[] {
  return [
    {
      name: "list_categories",
      title: "列出接口分类",
      description:
        "列出聚水潭开放平台 API 的全部分类（如 基础API、订单API、库存API…）及每个分类的接口数量。推荐作为浏览文档的第一步。",
      inputSchema: {},
      async handler(): Promise<ToolResult> {
        return withData((data) => renderCategoryList(data));
      },
    },
    {
      name: "list_apis",
      title: "列出分类下的接口",
      description: "列出某个接口分类下的所有 API（名称、路由、docId）。",
      inputSchema: {
        category: z.string().describe("分类名称或分类ID，例如「订单API」或「4」"),
      },
      async handler(args: { category: string }): Promise<ToolResult> {
        return withData((data) => {
          const cat = findCategory(data, args.category);
          if (!cat) {
            const names = data.categories.map((c) => c.name).join("、");
            return `未找到分类「${args.category}」。可用分类：${names}`;
          }
          return renderApiList(cat.id, cat.name, cat.apis, data.fetchedAt);
        });
      },
    },
    {
      name: "search_apis",
      title: "全局搜索接口",
      description: "按关键词搜索接口（匹配接口名称、路由、分类名），找到要调用的接口。",
      inputSchema: {
        keyword: z.string().min(1).describe("关键词，例如「订单上传」「shops/query」「退货」"),
        limit: z.number().int().min(1).max(50).default(20).describe("最多返回条数，默认 20"),
      },
      async handler(args: { keyword: string; limit: number }): Promise<ToolResult> {
        return withData((data) => {
          const kw = args.keyword.trim().toLowerCase();
          const matches = allApis(data).filter(
            (r) =>
              r.doc.name.toLowerCase().includes(kw) ||
              r.doc.route.toLowerCase().includes(kw) ||
              r.category.name.toLowerCase().includes(kw) ||
              String(r.doc.docId) === kw
          );
          return renderSearchResults(matches.slice(0, args.limit), args.keyword);
        });
      },
    },
    {
      name: "get_api_doc",
      title: "查看接口文档",
      description:
        "查看某个接口的完整文档：请求地址、公共参数、请求/返回参数说明、错误码、请求/响应/异常示例。可先用 list_apis 或 search_apis 找到接口。",
      inputSchema: {
        api: z
          .string()
          .describe("接口标识：docId、路由（如 /open/shops/query）或接口名称（名称支持模糊匹配，命中多个时会列出候选）"),
        category: z.string().optional().describe("可选：限定分类（名称或ID），用于消除重名"),
        section: z
          .enum(DOC_SECTIONS)
          .default("all")
          .describe("只看某一节：overview/urls/common_params/request_params/response_params/errors/request_example/response_example/exception_example，默认全部"),
      },
      async handler(args: { api: string; category?: string; section: DocSection }): Promise<ToolResult> {
        return withData((data) => {
          const matches = findApi(data, args.api, args.category);
          if (!matches.length) {
            return `未找到接口「${args.api}」。请用 search_apis 搜索，或 list_apis 浏览分类。`;
          }
          if (matches.length > 1) {
            const lines = [
              `「${args.api}」命中 ${matches.length} 个接口，请用路由或 docId 精确指定：`,
              "",
              "| 接口名称 | 路由 | 接口分类 | docId |",
              "| --- | --- | --- | --- |",
            ];
            for (const m of matches) {
              lines.push(`| ${m.doc.name} | \`${m.doc.route}\` | ${m.category.name} | ${m.doc.docId} |`);
            }
            return lines.join("\n");
          }
          return renderApiDoc(matches[0], args.section);
        });
      },
    },
    {
      name: "refresh_data",
      title: "刷新文档数据",
      description:
        "从聚水潭开放平台官方文档站重新抓取全部 API 文档并更新本地快照（约 175 个接口，需要网络，耗时约 10-30 秒）。首次使用或文档可能已更新时调用。",
      inputSchema: {},
      async handler(): Promise<ToolResult> {
        try {
          const data = await fetchAllDocs((m) => console.error(`[jushuitan-mcp] ${m}`));
          saveDocs(data);
          invalidateCache();
          const total = data.categories.reduce((s, c) => s + c.apis.length, 0);
          return ok(`数据已更新：${data.categories.length} 个分类，${total} 个接口，抓取时间 ${data.fetchedAt}。`);
        } catch (e) {
          return fail(e);
        }
      },
    },
  ];
}
