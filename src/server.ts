/** MCP server wiring: registers all tools on a stdio McpServer. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildTools } from "./tools.js";

export const SERVER_NAME = "jushuitan-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "这是聚水潭开放平台 API 文档检索服务。典型用法：先 list_categories 浏览分类 → list_apis 或 search_apis 定位接口 → get_api_doc 读取完整文档（参数/错误码/示例）。" +
        "所有接口的调用方式一致：业务参数以 biz（JSON 字符串）+ 公共参数（app_key/access_token/timestamp/charset/version/sign）POST 提交，签名规则见 https://openweb.jushuitan.com/doc?docId=30 。" +
        "若工具提示本地快照缺失，调用 refresh_data 在线拉取。",
    }
  );

  for (const t of buildTools()) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema }, async (args) =>
      t.handler(args as never)
    );
  }
  return server;
}
