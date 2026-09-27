# jushuitan-mcp

[English](#english) | [中文](#中文)

---

## 中文

**聚水潭开放平台 API 文档 MCP Server** —— 让 AI Agent（Claude、Cursor、ZCode、Cline 等）直接检索聚水潭开放 API 的接口分类、参数说明、错误码与请求/响应示例，不再需要人工翻文档。

数据来源于聚水潭开放平台官方文档站（[openweb.jushuitan.com](https://openweb.jushuitan.com/dev-doc?docType=1&docId=1)），通过其公开文档接口抓取并本地结构化。

> ⚠️ 本项目为非官方工具，仅聚合公开文档便于检索；文档内容版权归聚水潭所有。仓库**不包含**抓取的文档数据，使用前请自行执行 `npm run fetch` 获取。

### 功能

| 工具 | 说明 |
| --- | --- |
| `list_categories` | 列出全部接口分类（20 个）及接口数量 |
| `list_apis` | 列出某分类下的所有接口（名称 / 路由 / docId） |
| `search_apis` | 按关键词全局搜索接口（名称、路由、分类） |
| `get_api_doc` | 查看接口完整文档，支持按节过滤（公共参数 / 请求参数 / 返回参数 / 错误码 / 各类示例） |
| `refresh_data` | 从官方文档站重新抓取并更新本地快照 |

`get_api_doc` 输出包含：请求地址（正式/测试环境 baseurl）、公共请求参数、请求参数说明（由官方 JSON Schema 展开，含嵌套层级与示例值）、返回参数说明、错误码与排查方法、请求/响应/异常示例、CURL/JAVA/C#/PHP 代码示例。

### 快速开始

要求 Node.js ≥ 20。

```bash
git clone https://github.com/CO2T5ZN/jushuitan-mcp.git
cd jushuitan-mcp
npm install
npm run build
npm run fetch   # 拉取文档数据到 data/jushuitan-docs.json（约 10-30 秒）
```

### 一键安装（把提示词复制给 AI Agent）

不想手动改配置的话，把下面这段提示词复制给你的 AI Agent（ZCode、Claude Code、Cursor、Cline 等）即可，详细步骤在仓库 README 里，Agent 克隆后会自行阅读执行：

```text
请帮我安装 MCP Server「jushuitan-mcp」：把仓库 https://github.com/CO2T5ZN/jushuitan-mcp 克隆到本地目录，然后阅读仓库根目录的 README.md，按其中「给 AI Agent 的操作指引」完成构建、数据拉取与 MCP 注册，最后调用 list_categories 验证并向我报告结果。
```

### 给 AI Agent 的操作指引

1. **克隆与构建**：把 https://github.com/CO2T5ZN/jushuitan-mcp.git 克隆到本地目录（若目标目录已存在且是该仓库则跳过克隆），进入仓库目录依次执行 `npm install`、`npm run build`、`npm run fetch`。`fetch` 会从官方文档站拉取数据到 `data/jushuitan-docs.json`，约 10-30 秒；若执行失败，可在完成 MCP 注册后改用 `refresh_data` 工具在线拉取。
2. **注册 MCP**：把你自己的 MCP 服务器配置写入 Agent 所用的 MCP 配置文件——名称 `jushuitan-mcp`，stdio 方式，`command: node`，`args: ["<仓库绝对路径>/dist/index.js"]`，`env.JUSHUITAN_MCP_DATA` 设为 `<仓库绝对路径>/data/jushuitan-docs.json`。各客户端的配置文件位置与格式见下节「客户端配置」；Windows 下 JSON 里路径必须用正斜杠或双反斜杠。
3. **验证**：重新加载 / 重启后调用工具 `list_categories`，能返回 20 个接口分类即安装成功；向用户报告结果，失败则排查修复后重试。

### 客户端配置

通用前提：

- 服务器以 **stdio** 方式启动：`node <仓库绝对路径>/dist/index.js`。配置中请使用**绝对路径**。
- 首次使用前先在仓库目录执行 `npm run fetch` 生成数据快照；如果没生成，也可以直接让 Agent 调用 `refresh_data` 工具在线拉取。
- 建议在 `env` 中设置 `JUSHUITAN_MCP_DATA` 指向数据文件绝对路径（IDE 启动 MCP 时不一定以仓库为工作目录）。
- **Windows 路径注意**：JSON 字符串里 `\` 是转义符，`"D:\Tools\..."` 会因非法转义（如 `\T`）导致解析失败、无法保存。请改用正斜杠 `"D:/Tools/..."`，或写成双反斜杠 `"D:\\Tools\\..."`。

**ZCode**（两种方式任选）：

*方式一：客户端界面添加* —— **Settings → MCP** → 添加，粘贴如下 JSON（单个服务器条目，无外层包装）：

```json
{
  "jushuitan-mcp": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/jushuitan-mcp/dist/index.js"],
    "env": {
      "JUSHUITAN_MCP_DATA": "/path/to/jushuitan-mcp/data/jushuitan-docs.json"
    }
  }
}
```

*方式二：直接编辑配置文件* —— 工作区级 `<repo>/.zcode/config.json`（随仓库共享）或用户级 `~/.zcode/cli/config.json`，文件里需要包一层 `mcp.servers`：

```json
{
  "mcp": {
    "servers": {
      "jushuitan-mcp": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/jushuitan-mcp/dist/index.js"],
        "env": {
          "JUSHUITAN_MCP_DATA": "/path/to/jushuitan-mcp/data/jushuitan-docs.json"
        }
      }
    }
  }
}
```

注意：ZCode 配置文件**不展开 `${...}` 模板变量**，`command`/`args` 必须写绝对路径；schema 校验严格，不要添加未知字段。保存后重启会话，在 **Settings → MCP** 中确认 `jushuitan-mcp` 已自动连接。仓库内的 `.zcode/config.json.example` 可复制后替换路径使用。

**CodeBuddy**（项目级：`.codebuddy/mcp_settings.json`；或在 IDE 的 MCP 管理界面添加）：

```json
{
  "mcpServers": {
    "jushuitan-mcp": {
      "command": "node",
      "args": ["/path/to/jushuitan-mcp/dist/index.js"],
      "env": {
        "JUSHUITAN_MCP_DATA": "/path/to/jushuitan-mcp/data/jushuitan-docs.json"
      }
    }
  }
}
```

**Trae**（v1.3.0+）：AI 面板 → 右上角设置 → **MCP** → 添加 → **手动配置**，粘贴以下 JSON 保存；也可直接写入项目级 `.trae/mcp.json`：

```json
{
  "mcpServers": {
    "jushuitan-mcp": {
      "command": "node",
      "args": ["/path/to/jushuitan-mcp/dist/index.js"],
      "env": {
        "JUSHUITAN_MCP_DATA": "/path/to/jushuitan-mcp/data/jushuitan-docs.json"
      }
    }
  }
}
```

**Claude Desktop / Cursor / Cline**（Claude Desktop 写入 `claude_desktop_config.json`，Cursor/Cline 用设置界面或项目级 `.mcp.json`，格式相同）：

```json
{
  "mcpServers": {
    "jushuitan-mcp": {
      "command": "node",
      "args": ["/path/to/jushuitan-mcp/dist/index.js"],
      "env": {
        "JUSHUITAN_MCP_DATA": "/path/to/jushuitan-mcp/data/jushuitan-docs.json"
      }
    }
  }
}
```

**通过 npx 运行**（发布 npm 后可用）：

```json
{
  "mcpServers": {
    "jushuitan-mcp": {
      "command": "npx",
      "args": ["-y", "jushuitan-mcp"]
    }
  }
}
```

npx 方式首次使用时，若无本地数据，可直接让 Agent 调用 `refresh_data` 工具在线拉取。

### 数据存放路径

快照默认写入/读取 `data/jushuitan-docs.json`，查找优先级：

1. 环境变量 `JUSHUITAN_MCP_DATA` 指定的文件路径
2. 当前工作目录 `./data/jushuitan-docs.json`
3. 包安装目录下的 `data/jushuitan-docs.json`

### 典型用法（Agent 视角）

```
list_categories                    → 浏览 20 个分类
list_apis(category="订单API")      → 该分类 16 个接口
search_apis(keyword="订单上传")    → 定位 /open/jushuitan/orders/upload
get_api_doc(api="/open/shops/query", section="request_params")
                                   → 只看请求参数
get_api_doc(api="1")               → 按 docId 读完整文档
```

### 开发

```bash
npm run build   # tsc 编译到 dist/
npm test        # 端到端 smoke test（stdio JSON-RPC，16 项断言）
npm run fetch   # 重新抓取数据
```

### 目录结构

```
src/
├── index.ts       # stdio 入口
├── server.ts      # MCP Server 与工具注册
├── tools.ts       # 5 个工具的定义与处理
├── render.ts      # Markdown 渲染
├── store.ts       # 本地快照读写与检索
├── fetcher.ts     # 官方文档接口抓取（cookie 维护/重试/并发控制）与数据归一化
├── schema.ts      # JSON Schema -> 扁平参数表
├── text.ts        # 富文本/表格转义
└── types.ts
scripts/smoke-test.mjs
```

### 声明

本项目与聚水潭（上海聚水潭网络科技股份有限公司）无隶属关系。接口文档内容（含参数说明、示例）版权归原作者所有，请仅将其用于开发对接聚水潭开放平台时的参考。请合理使用 `refresh_data`，勿高频抓取。

## English

An MCP server that exposes the **Jushuitan Open Platform API documentation** (an ERP/SaaS order platform widely used in China) to AI agents: 20 categories / ~175 APIs with routes, base URLs, common params, request/response param tables (flattened from official JSON Schemas), error codes, and request/response/exception examples.

The repo ships **code only** — doc content is fetched from the platform's public doc endpoint via `npm run fetch` and stored locally (`data/jushuitan-docs.json`, gitignored). Tools: `list_categories`, `list_apis`, `search_apis`, `get_api_doc`, `refresh_data`.

See the 中文 section above for full instructions; configuration is identical apart from language. To auto-install, copy the prompt in the 「一键安装」 block above and paste it into your AI agent.

## License

MIT
