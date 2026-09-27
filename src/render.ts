/** Markdown renderers for tool output. */

import { cell } from "./text.js";
import type { ApiDoc, DocsData, ParamRow, ResolvedApi } from "./types.js";

export const DOC_SECTIONS = [
  "all",
  "overview",
  "urls",
  "common_params",
  "request_params",
  "response_params",
  "errors",
  "request_example",
  "response_example",
  "exception_example",
] as const;

export type DocSection = (typeof DOC_SECTIONS)[number];

const DEMO_LANG: Record<string, string> = {
  CURL: "bash",
  JAVA: "java",
  "C#": "csharp",
  PHP: "php",
  PYTHON: "python",
  GO: "go",
};

function paramTable(rows: ParamRow[], columns: { name: string; type: string; required: boolean; example: boolean }): string[] {
  const header = [
    columns.name,
    columns.type,
    ...(columns.required ? ["是否必填"] : []),
    ...(columns.example ? ["示例值"] : []),
    columns.name === "参数名称" ? "参数描述" : "说明",
  ];
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const r of rows) {
    const cols = [cell(r.path), cell(r.type)];
    if (columns.required) cols.push(r.required ? "是" : "否");
    if (columns.example) cols.push(cell(r.example));
    cols.push(cell(r.description));
    lines.push(`| ${cols.join(" | ")} |`);
  }
  return lines;
}

function jsonBlock(text: string | null): string {
  return text ? "```json\n" + text.replace(/\r\n/g, "\n").trim() + "\n```" : "无";
}

function apiHeader(r: ResolvedApi): string[] {
  return [
    `## ${r.doc.name}`,
    "",
    `- 路由：\`${r.doc.route}\``,
    `- API名：${r.doc.name}`,
    `- 接口分类：${r.category.name}`,
    `- 文档来源：https://openweb.jushuitan.com/dev-doc?docType=1&docId=${r.doc.docId}`,
    "",
  ];
}

/** Render one API doc (optionally a single section) as markdown. */
export function renderApiDoc(r: ResolvedApi, section: DocSection = "all"): string {
  const d: ApiDoc = r.doc;
  const out: string[] = [];

  const need = (s: DocSection) => section === "all" || section === s;

  out.push(...apiHeader(r));

  if (need("overview") && d.apiDescription) {
    out.push("### API 说明", "", "> " + d.apiDescription.split("\n").join("\n> "), "");
  }

  if (need("urls") || need("common_params")) {
    out.push("### 公共参数", "");
  }
  if (need("urls")) {
    out.push("#### 请求地址（baseurl）", "", "| 环境 | HTTPS地址 |", "| --- | --- |");
    for (const u of d.urls) out.push(`| ${cell(u.env)} | ${cell(u.url)} |`);
    out.push("");
  }
  if (need("common_params")) {
    out.push("#### 公共请求参数", "", "| 参数名称 | 参数类型 | 是否必填 | 参数描述 |", "| --- | --- | --- | --- |");
    for (const p of d.commonParams) {
      out.push(`| ${cell(p.name)} | ${cell(p.type)} | ${p.required ? "是" : "否"} | ${cell(p.description)} |`);
    }
    out.push("");
  }

  if (need("request_params")) {
    out.push("## 请求参数说明", "");
    if (d.requestParams.length) {
      out.push("> 业务参数以 `biz` 字段（JSON 字符串）随公共参数一同 POST 提交。", "");
      out.push(...paramTable(d.requestParams, { name: "参数名称", type: "参数类型", required: true, example: true }));
    } else {
      out.push("无");
    }
    out.push("");
  }

  if (need("response_params")) {
    out.push("## 返回参数说明", "");
    if (d.responseParams.length) {
      out.push(...paramTable(d.responseParams, { name: "参数接口", type: "参数类型", required: false, example: true }));
    } else {
      out.push("无");
    }
    out.push("");
  }

  if (need("errors")) {
    out.push("## 错误说明", "");
    if (d.errors.length) {
      out.push("| 错误码 | 错误信息 | 排查方法 |", "| --- | --- | --- |");
      for (const e of d.errors) out.push(`| ${cell(e.code)} | ${cell(e.message)} | ${cell(e.solve)} |`);
    } else {
      out.push(
        "本接口无专属错误码说明。通用错误码（如 120 验证失败、140 签名/编码问题等）参见接口调用规则文档：https://openweb.jushuitan.com/doc?docId=30"
      );
    }
    out.push("");
  }

  if (need("request_example")) {
    out.push("## 请求示例", "");
    if (d.requestExample) out.push(jsonBlock(d.requestExample), "");
    for (const demo of d.codeDemos) {
      out.push(`**${demo.language}：**`, "", "```" + (DEMO_LANG[demo.language] ?? "") + "\n" + demo.code.trim() + "\n```", "");
    }
    if (!d.requestExample && !d.codeDemos.length) out.push("无");
  }

  if (need("response_example")) {
    out.push("## 响应示例", "", jsonBlock(d.responseExample), "");
  }

  if (need("exception_example")) {
    out.push("## 异常示例", "", jsonBlock(d.exceptionExample), "");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function renderCategoryList(data: DocsData): string {
  const lines = [
    `# 聚水潭开放平台 API 分类（共 ${data.categories.length} 个）`,
    "",
    `数据抓取时间：${data.fetchedAt}；来源：${data.source}`,
    "",
    "| # | 分类ID | 接口分类 | 接口数 |",
    "| --- | --- | --- | --- |",
  ];
  data.categories.forEach((c, i) => lines.push(`| ${i + 1} | ${c.id} | ${c.name} | ${c.apis.length} |`));
  lines.push(
    "",
    "下一步：用 `list_apis(category=\"<分类名或ID>\")` 查看某分类下的接口，或用 `search_apis(keyword=...)` 全局搜索。"
  );
  return lines.join("\n");
}

export function renderApiList(categoryId: number, categoryName: string, apis: ApiDoc[], fetchedAt: string): string {
  const lines = [
    `# ${categoryName}（分类ID ${categoryId}，共 ${apis.length} 个接口）`,
    "",
    `数据抓取时间：${fetchedAt}`,
    "",
    "| 接口名称 | 路由 | docId |",
    "| --- | --- | --- |",
  ];
  for (const a of apis) lines.push(`| ${a.name} | \`${a.route}\` | ${a.docId} |`);
  lines.push(
    "",
    "下一步：用 `get_api_doc(api=\"<路由或docId或名称>\")` 查看接口完整文档。"
  );
  return lines.join("\n");
}

export function renderSearchResults(matches: ResolvedApi[], keyword: string): string {
  if (!matches.length) return `未找到与「${keyword}」匹配的接口。可尝试更短的关键词，或用 list_categories 浏览分类。`;
  const lines = [
    `# 搜索「${keyword}」（${matches.length} 个结果）`,
    "",
    "| 接口名称 | 路由 | 接口分类 | docId |",
    "| --- | --- | --- | --- |",
  ];
  for (const m of matches) {
    lines.push(`| ${m.doc.name} | \`${m.doc.route}\` | ${m.category.name} | ${m.doc.docId} |`);
  }
  lines.push("", "下一步：用 `get_api_doc(api=\"<路由或docId或名称>\")` 查看接口完整文档。");
  return lines.join("\n");
}
