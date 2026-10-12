# AGENTS.md — jushuitan-mcp 协作上下文

> 本文件面向在此仓库工作的 AI Agent（跨会话交接用），记录项目定位、硬约束、架构、决策记录与当前状态。
> 面向最终用户的安装/使用文档在 [README.md](README.md)，两者互补，重大变更需同步更新。
> 最后更新：2026-10-12。

## 项目是什么

聚水潭开放平台 API 文档的 **MCP Server**（Node ≥ 20，TypeScript，支持 stdio / Streamable HTTP / 旧版 HTTP+SSE 三种传输），让 AI Agent 直接检索聚水潭（erp321，国内主流电商 ERP/SaaS）开放 API 文档：20 个分类 / 175 个接口，含路由、baseurl、公共参数、请求/返回参数表（由官方 JSON Schema 展开）、错误码、请求/响应/异常示例与多语言代码示例。

- 仓库：<https://github.com/CO2T5ZN/jushuitan-mcp>
- 本地路径：`D:\Tools\jushuitan-mcp`
- 非官方工具，文档内容版权归聚水潭所有。

## 硬约束（红线，任何改动不得违反）

1. **文档数据不入库**：`data/`、`jushuitan-api-docs/` 永不提交（已在 .gitignore）。仓库只含代码；使用者通过 `npm run fetch` 或 MCP 工具 `refresh_data` 现场拉取。
2. **勿高频抓取官方站**：`refresh_data` 是全量重抓（约 10-30 秒），仅按需调用；抓取逻辑需维护 cookie / 重试 / 并发控制。
3. **本地机器配置不入库**：`.zcode/config.json`、`.mcp.json` 已 ignore，只提交 `.zcode/config.json.example`。
4. `package.json#files` 只发布 `dist`/`README.md`/`LICENSE`，npm 发布前确认不含数据。

## 5 个 MCP 工具

| 工具 | 作用 |
| --- | --- |
| `list_categories` | 20 个分类及接口数（分类 id 56「奇门API」官方站本就为空，不是抓取缺陷） |
| `list_apis(category)` | 某分类下接口（名称/路由/docId） |
| `search_apis(keyword)` | 按名称/路由/分类全局搜索 |
| `get_api_doc(api, section?)` | 完整文档，可按节过滤；`api` 接路由、docId 或名称模糊匹配 |
| `refresh_data` | 全量重抓官方文档站并更新本地快照 |

数据文件查找优先级：环境变量 `JUSHUITAN_MCP_DATA` → `./data/jushuitan-docs.json` → 包安装目录下 `data/`。

## 架构（src/）

```
index.ts    CLI 入口（stdio/http 分发）  server.ts   MCP Server 与工具注册
tools.ts    5 个工具定义与处理            render.ts   Markdown 渲染
store.ts    本地快照读写与检索            fetcher.ts  官方接口抓取与归一化
schema.ts   JSON Schema → 扁平参数表      text.ts     富文本/表格转义
types.ts                                 fetch-cli.ts  `npm run fetch` 的 CLI 入口
http-server.ts  Streamable HTTP + 旧版 SSE 传输（node:http，无 Express 依赖）
```

## 传输方式

`src/index.ts` 是统一 CLI 入口，默认 **stdio**（保持所有既有 MCP 配置零改动），`--transport=http` 启动 HTTP 服务：

| 端点 | 方法 | 传输 | 说明 |
| --- | --- | --- | --- |
| `/mcp`（可用 `--path` 改） | POST/GET/DELETE | Streamable HTTP | 默认有状态会话（`Mcp-Session-Id`）；`--stateless` 则每请求新建 server+transport |
| `/sse` | GET | HTTP+SSE（2024-11-05，SDK 已标记 deprecated，为老客户端保留） | 首帧 `event: endpoint` 给出回传地址 |
| `/messages` | POST | 同上 | 需 `?sessionId=…` |
| `/health`、`/healthz` | GET | — | 返回传输列表、活跃会话数、端点清单（不含任何文档数据） |

关键约定：

- **每个会话一个 `McpServer` 实例**（`McpServer` 只能绑定一个 transport）；工具处理逻辑共享进程级文档缓存，开销很小。
- **清理必须用 `once()` 包一层**：`transport.close()` 会触发 `onclose` → `server.close()` → 再次 `close()`，`res.on("close")` 与 `transport.onclose` 双注册时会无限递归 `RangeError: Maximum call stack size exceeded`（已修复，勿删 `once`）。
- **默认安全**：监听 `127.0.0.1`，且只允许 Host/Origin 为 localhost 系列（DNS 防重绑），放开需显式 `--allowed-hosts`（`*` = 不校验）。校验在 `assertAllowedOrigin` 里自建，不传给 SDK 的 deprecated 选项。
- 三种时间超时（`keepAliveTimeout`/`headersTimeout`/`requestTimeout`）都置 0，否则长连接 SSE 会被 Node 掐断。

## 常用命令

```bash
npm run build      # tsc → dist/（fetch 依赖 dist/fetch-cli.js，必须先 build）
npm run fetch      # 拉取文档数据到 data/jushuitan-docs.json（约 10-30 秒）
npm test           # build + smoke-test.mjs（stdio，16 项）+ smoke-test-http.mjs（HTTP/SSE，28 项）
npm run test:http  # 只跑 HTTP 传输测试
npm run start:http # node dist/index.js --transport=http（默认 http://127.0.0.1:3000/mcp）
```

改抓取/渲染/store/传输逻辑后必须跑 `npm test`。HTTP 测试自启子进程服务（随机端口 + 重试），覆盖 streamable http（有状态/stateless/JSON 响应/自定义 path）、旧版 SSE 握手与消息投递、404/400/403 分支。

## 数据来源（官方公开文档接口，无需登录）

均为 `POST https://api.jushuitan.com/openWeb/doc/api/<action>`，需带 Origin/Referer 头 + `acw_tc` cookie（fetcher 已实现 cookie 维护/重试/并发控制）：

- `getApiContents`，body `{"data":{}}` → 分类
- `getApiList`，body `{"data":"<分类id>"}`（**字符串**）→ 接口列表（id 即 docId）
- `getApiDetail`，body `{"data":"<docId>"}`（字符串）→ 完整文档

更细的反爬/端点笔记：`C:\Users\79017\.zcode\skills\web-access\references\site-patterns\jushuitan.com.md`。

## 仓库内另一产物：jushuitan-api-docs/（本地文档全量副本，不入库）

2026-09-27 用可断点续抓脚本抓的全量文档副本：`docs/01-基础API.md … 20-WMS API.md`、`docs/structured.json`（机器可读归一化数据）、`raw/`（原始 JSON）、`fetch-docs.mjs`（cookie 走 `JST_COOKIE` 环境变量）、`convert.mjs`（raw → Markdown 重生成）。与 MCP server 的 `data/` 快照是两套东西，勿混淆。

## Git 状态与决策记录

- 远程 `origin` = <https://github.com/CO2T5ZN/jushuitan-mcp.git>，`main` 已跟踪 `origin/main`。
- 提交历史：`3fd3177`（GitHub 建仓自动生成的 LICENSE）→ `b07d939`（全部项目代码 + README）。
- **决策：LICENSE 保留远程版**，版权署名 `o-2t-5z`；本地曾写 `jushuitan-mcp contributors`，已弃用。如需改署名只需改一行再提交。
- **决策：README 一键安装提示词保持一句话**，详细步骤在 README「给 AI Agent 的操作指引」一节，Agent clone 后读 README 执行——安装步骤变化只改 README，不动提示词。
- 2026-09-27 已实测：MCP 四个读工具（list_categories / list_apis / search_apis / get_api_doc）在 ZCode 中连接并返回正常。
- 2026-10-12 新增 HTTP 传输。**决策：不引入 Express**，HTTP 层用 `node:http` 手写（保持依赖只有 `@modelcontextprotocol/sdk` + `zod`）。**决策：stdio 保持默认**，已有的所有 MCP 客户端配置继续零改动生效。**决策：HTTP 默认只监听 127.0.0.1 且校验 Host/Origin**（DNS 防重绑），放开要显式 `--allowed-hosts`。已实测 `npm test`：stdio 16 项 + HTTP/SSE 28 项全通过。

## 待办 / 开放事项

- **npm 发布未做**：README 里「通过 npx 运行」一节标注了"发布 npm 后可用"；发布后记得同步 `bin`、`files` 并实测 npx 链路。
- **Gitee 镜像未配**：用户有意向（国内访问快）。已确认同机 Gitee/GitHub 账号可共存（凭据按主机分开存储），加第二个 remote `gitee` 即可：`git remote add gitee https://gitee.com/<用户名>/jushuitan-mcp.git && git push gitee main`。
- README 快速开始与一键安装中的仓库地址已用真实地址，无占位符残留。

## 已知坑（踩过的）

- **Windows JSON 路径**：MCP 配置 JSON 里 `"D:\Tools\..."` 因 `\T` 非法转义解析失败，必须写 `D:/Tools/...` 或 `D:\\Tools\\...`（README 已记录）。
- **ZCode MCP 注册格式**：Settings → MCP 界面粘贴的是扁平条目 `{"<name>":{...}}`；直接编辑配置文件才要 `mcp.servers` 嵌套。ZCode 配置不展开 `${...}` 变量，`command`/`args` 必须绝对路径。
- **Windows 端口 EACCES**：随机高端口常落在 Hyper-V 保留区间，`listen EACCES`。smoke-test-http 已用 21000-25000 低段 + 失败重试；用户手动换端口即可（README 已记录）。
- **脚本里的 http 服务必须自启自停**：Bash 工具调用结束后后台进程会被回收，`&` 起的 server 活不过一次调用；测试一律在脚本内 spawn/kill。
- **Node fetch 在本机无代理问题，curl 有**：用户机器有 Clash，`curl 127.0.0.1` 会撞代理报 `upstream connect failed`，需 `--noproxy '*'`；Node 脚本不受影响。
- git add 时 LF→CRLF 警告无害（Windows autocrlf），不用处理。
- Chrome DevTools MCP 的 `evaluate_script` `filePath` 写不了本仓库目录（不在其 workspace roots 内）；批量抓取用 Bash 里 Node/curl。
