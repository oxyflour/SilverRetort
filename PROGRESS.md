# 实施进度

方案：`~/.claude/plans/codex-claude-misty-parnas.md`（2026-07-08 批准）

## 已完成

### 1. packages/protocol — TS 协议层 ✅
- `src/types.ts`：zod schema（Session / Message / Artifact / ChatEvent / UiCommand），所有事件带 `sessionId` + `runId` 支持多会话并发路由
- `src/sse.ts`：SSE 解析器 + `subscribeEvents`（自动重连、指数退避、重连后回调补数据）
- `src/client.ts`：类型化 REST 客户端（ApiClient）

### 2. packages/chat-ui — 自研三栏 UI ✅
- `src/store.ts`：zustand，消息按 session_id 分桶，与当前显示解耦（多会话并发基础）
- `src/registry.tsx`：artifact 渲染器注册表；`src/renderers/builtins.tsx`：内置 iframe（sandboxed）/ image / markdown
- `src/components/`：ChatApp（react-resizable-panels 三栏 + 事件通道订阅 + 渲染器类型上报）、SessionSidebar（新建/重命名/删除/运行中指示）、ChatPane（自动滚动跟随）、MessageView（流式 Markdown + 工具卡片 + 附件 + artifact chip）、ChatInput（附件上传/粘贴、停止按钮）、ArtifactPanel（tab 切换 + 关闭）
- 已验证：浏览器中完整跑通（mock 引擎流式回复、工具卡片、artifact 自动开面板、标题自动生成同步、刷新/重启后历史保留）

### 3. apps/uvicorn — BFF 后端 ✅
- `models.py`（pydantic camelCase wire）、`db.py`（SQLite: sessions/messages/files/artifacts，DATA_DIR 可配）
- `events.py`：广播器 + `/api/events` 常驻 SSE 通道（run 事件 + MCP UI 命令共用）
- `runs.py`：后台 run 管理（每 session 至多一个，边收边落库，stop 取消，多 session 并发互不阻塞）
- `engines.py`：Engine 协议 + MockEngine；`create_engine()` 有 `HERMES_URL` 用 hermes 否则 mock
- `routes.py`：session CRUD / messages / chat(返回 run_id) / stop / files 上传下载 / events / render-types 上报
- `mcp_server.py`：FastMCP streamable HTTP 挂 `/mcp`，工具：`ui_show_artifact` / `ui_update_artifact` / `ui_list_render_types` / `list_user_files` / `read_user_file`
- 已验证：in-process smoke 全过（含双 session 并发）；真实 MCP client 调工具 → 浏览器右栏实时弹出 iframe 并增量更新，落库正确

### 4. apps/next — 代理 + 组装 ✅
- `app/api/[...path]/route.ts`：catch-all 代理，运行时读 `API_REWRITE`，SSE 流式透传
- `app/page.tsx` 渲染 ChatApp；globals.css 加 tailwind `@source` 扫描 chat-ui + typography 插件 + highlight.js 样式

### 5. apps/hermes — hermes-agent 封装 ⏳ 大部分完成
- `pyproject.toml`：`hermes-agent[web]` + `aiohttp`（API server 适配器必需，[web] extra 不含）+ `mcp>=1.26.0`（否则 `silverretort-ui` MCP server 不会注册进 Hermes 工具集）+ pyyaml
- `main.py`：独立 `HERMES_HOME`（默认 `apps/hermes/home`，避免与用户全局 hermes 配置冲突——全局配置里有坏的 weixin 条目会阻止 gateway 启动）；设置 `API_SERVER_*` env；把 uvicorn MCP server 合并进 `{HERMES_HOME}/config.yaml` 的 `mcp_servers.silverretort-ui`；stdin 看门狗（WATCH_STDIN=0 可关）
- `main.py`（2026-07-09）：默认读取 `apps/desktop/.env`，把 `OPENAI_*` 配置归一化写入隔离 `HERMES_HOME/config.yaml` 的 `model` 段（`provider: custom` + `default/base_url/api_key`），手动启动与 desktop 托管共用同一配置源，避免 provider auto-detect 偏到 OpenRouter
- 已验证：gateway 启动成功，`/health` 返回 ok（v0.18.2），`/v1/models` 返回模型 id `hermes-agent`（注意不是 "hermes"，适配层默认值已同步改）
- 已验证（2026-07-09）：在不额外手工注入 `OPENAI_*` 的情况下，仅传 `LISTEN_PORT/HERMES_API_KEY/MCP_URL` 启动，hermes 可自动吃到 `apps/desktop/.env` 并成功完成一次真实 non-stream completion（DeepSeek 返回 `ok`）
- **注意**：`API_SERVER_KEY` 必须 ≥16 字符否则拒绝启动（desktop 生成随机 64 hex 即可）
- `hermes_client.py`（在 apps/uvicorn）：HermesEngine，httpx 流式调 `/v1/chat/completions`，识别 `event: hermes.tool.progress` SSE 并归一化为内部 `tool-start/tool-end` 事件；system prompt 改为提示使用实际 MCP 函数名（`mcp__silverretort_ui__*`）；图片附件编成 base64 image_url，session_id + 文件清单写进 ephemeral system prompt
- 已验证（2026-07-09）：真实 hermes 联调已跑通。`discover_mcp_tools()` 能连上 `silverretort-ui` 并注册 `mcp__silverretort_ui__*` 工具；`/api/events` 实测收到 `run-started → tool-start → artifact/ui-command → tool-end → text-delta → done`；assistant 消息已落库 `tool` part + `text` part；Hermes 可主动调用 `ui_show_artifact` 创建 markdown artifact，也可通过 `read_user_file` 读取用户上传的文本附件

## 待做

- [x] #7 apps/desktop：`main.cjs` 已接入 hermes 托管
  - 默认 `DATA_DIR`：`app.getPath("userData")/data`；可用 `SILVERRETORT_DATA_DIR` 覆盖，desktop 会把 `DATA_DIR` 传给 uvicorn
  - 本地模式：无 `DATA_DIR/settings.json` 时，development 下自动 spawn 第三个子进程 `apps/hermes`，生成随机 64 hex API key，轮询 `http://127.0.0.1:23002/health`，并把 `HERMES_URL/HERMES_API_KEY` 传给 uvicorn
  - 远程模式：`DATA_DIR/settings.json` 含 `hermesUrl` + `hermesApiKey` 时，不再本地拉起 hermes，uvicorn 直接走远端；已验证实际请求发往远端 `/v1/chat/completions`
  - 远端 Docker 模式由 `apps/switch` 托管：desktop 只配置用户级 `hermesUrl` 和 `hermesApiKey`；switch 按 `{userId}.conf` 创建/恢复容器并转发 HTTP 与 WebSocket bridge
  - 当前边界：packaged 模式下本地 hermes runtime 仍依赖 #9 的打包工作；在未配置远程 hermes 时暂回退 mock 引擎，避免现阶段桌面包直接启动失败
- [ ] #8 远程沙盒：apps/hermes relay.py（沙盒内 MCP 端点 + /bridge WebSocket）+ Dockerfile + uvicorn 出站 bridge 连接
- [ ] #9 打包：extraResources 带 uv.exe + lock，首启 `uv sync` 到 DATA_DIR/hermes-env + 进度页
- [ ] 测试用例（按 CLAUDE.md 需先确认清单）：pytest（session/run 生命周期/并发/MCP 工具/hermes 归一化）+ vitest（协议/SSE/store 路由）

## 开发运行方式

```
# 后端（mock 引擎）
pnpm --filter silverretort-uvicorn run dev        # :23001
# 前端
pnpm --filter silverretort-next run dev           # :3000，/api/* 代理到 23001
# 桌面（默认本地 hermes；若 DATA_DIR/settings.json 配了 hermesUrl/hermesApiKey 则走远程）
pnpm dev
# hermes（可选，需 LLM key）
cd apps/hermes
LISTEN_PORT=23002 HERMES_API_KEY=<32+字符> MCP_URL=http://127.0.0.1:23001/mcp/ uv run python main.py
# uvicorn 侧加 HERMES_URL=http://127.0.0.1:23002 HERMES_API_KEY=<同上> 即切换真实引擎
```

## 关键决策记录

- hermes 接入走官方 API Server 模式（OpenAI 兼容 + SSE），不用其 Python 库（无流式/无工具事件）
- uvicorn 拥有数据真相（SQLite），hermes 无状态每次传全量历史
- run 与 HTTP 请求解耦：POST /chat 立即返回 run_id，事件走常驻 /api/events，多会话并发、刷新不丢
- next 代理用 route handler 而非 rewrites（standalone 构建 rewrites 被烘焙，无法运行时改端口）
- hermes 不做 PyInstaller（skills 运行时写文件/装依赖），打包用内置 uv 首启引导安装
