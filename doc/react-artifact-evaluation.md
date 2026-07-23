# iframe artifact 导入受控 ESM 组件设计

## 结论

不新增 `react` artifact，也不再将 `packages/` 中的组件注册为 chat-ui
artifact renderer。组件复用只通过现有 `iframe` artifact 提供：

1. 宿主在构建时将获准组件编译成 ESM。
2. 后端通过 MCP 将 ESM catalog（包括 URL 和 props schema）传递给 agent。
3. agent 在 workspace 中创建 HTML/JavaScript，从 catalog 给出的 URL 导入组件。
4. agent 使用现有 `ui_show_artifact(type="iframe", ...)` 打开页面。

这样既保留 agent 组合多个组件和编写页面逻辑的能力，也使任意
agent JavaScript 继续运行在现有的专用-origin iframe 边界内。

## 不提供 `react` artifact

以下能力明确不在方案中：

- 不提供 `{ component, props }` 类型的 `react` artifact payload。
- 不把 agent 提交的 TSX/JavaScript mount 到 chat-ui React tree。
- 不允许 agent 指定 `packages/...` 物理路径或任意 package export。
- 不在 `apps/next` 中注册 demo/circuit 等自定义 React artifact renderer。

chat-ui 只需保留 `iframe`、`markdown` 等内置 renderer。受控组件是 iframe 可导入
的资源，而不是新 artifact type。

## ESM 公开接口

每个获准组件应提供一个 artifact-safe entrypoint。对 agent 暴露框架中立的
`mount` API，而不是 React component：

```ts
export function mount(
  element: Element,
  props: unknown,
  options?: {
    setContext?: (
      action: string,
      data: unknown,
      options?: { displayText?: string },
    ) => Promise<unknown>;
  },
): () => void;
```

`mount` 必须：

- 在创建 React root 之前使用与 catalog 一致的 schema 校验 props。
- 在 props 不合法时抛出包含 component ID 和字段路径的可诊断错误。
- 内部管理 React/ReactDOM 版本，不要求 agent 提供 React runtime。
- 返回幂等 dispose 函数，清理 React root、事件、worker 和其他资源。
- 不接收宿主 store、API client、session token 或 Electron 能力。

agent 页面的调用形式为：

```html
<div id="root"></div>
<script src="/artifact-bridge-v1.js"></script>
<script type="module">
  import { mount } from "COMPONENT_MODULE_URL_FROM_CATALOG";

  const dispose = mount(
    document.querySelector("#root"),
    { label: "Yield", value: 98.4 },
    { setContext: window.silverRetort.setContext },
  );
  window.addEventListener("pagehide", dispose, { once: true });
</script>
```

## 必须传递给 agent 的 catalog

props schema 不能只存在 ESM 内部。agent 在生成 HTML 之前必须能通过 MCP
查询到它。当前提供独立的 `ui_list_artifact_modules` 和
`ui_get_artifact_module` 工具，而不把所有 schema 塞入 `ui_list_render_types`：

- `ui_list_artifact_modules` 返回精简索引：`id`、`version`、`description`。
- `ui_get_artifact_module(id)` 返回单个模块的完整合同。

完整合同示例：

```json
{
  "id": "demo.stat",
  "version": "1.2.0",
  "description": "Compact statistic card",
  "moduleUrl": "https://APP_ORIGIN/artifact-components/v1/demo.stat.js",
  "exportName": "mount",
  "propsSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["label", "value"],
    "properties": {
      "label": { "type": "string" },
      "value": { "type": "number" }
    }
  },
  "example": {
    "label": "Yield",
    "value": 98.4
  }
}
```

### catalog 约束

- `moduleUrl` 必须是宿主产生的绝对 http(s) URL，不接受 agent 传入的路径。
- ID 是稳定逻辑名，不包含源码物理路径。
- URL 带 catalog API 大版本；不兼容的 props 变更必须切换 ID 或大版本。
- schema 和 example 必须 JSON-serializable，并设置单项与响应总大小上限。
- MCP 返回的 schema 和 ESM 运行时校验使用同一份生成产物，避免漂移。
- 目录只发布已审核的 artifact-safe entrypoint，不自动重导出 package API。

## URL、origin 与资源

iframe 使用按 artifact ID 划分的专用 origin，而 ESM 由应用 asset origin 提供。
因此 ESM 及其静态依赖需要：

- 返回精确的 JavaScript/CSS/WASM MIME type 和 `X-Content-Type-Options: nosniff`。
- 仅对 artifact origin 允许 CORS，不携带 cookie/authorization，不允许 credentials。
- 使用内容 hash 的不可变 chunk URL，entry URL 按 catalog 大版本管理。
- CSS、字体、图片、WASM 和 worker URL 由构建器处理，且被 iframe CSP 允许。
- ESM 不能依赖 chat-ui DOM、CSS 或全局 React；它是可独立加载的产物。
- agent 如使用 `/artifact-components/...` 相对路径，请求会先落到当前 artifact
  的专用 origin。artifact origin middleware 会将该保留路径重定向到应用
  asset origin，不会将它当作 workspace 文件或 workspacePort 路由。重定向响应
  本身也必须返回 CORS/CORP/Private-Network 响应头，因为 module fetch 会校验
  整条 redirect chain，而不只是最终 ESM 响应。
- artifact origin middleware 对它转发的 workspace 文件和 workspacePort HTTP
  响应统一补全同样的 CORS/CORP/Private-Network 响应头，使 sandbox 导致的
  opaque (`null`) origin 也能加载 artifact 页面及其内部资源。

对 `{ "path": "circuit.html" }` 这类本地 iframe artifact，`path` 是 workspace entry
文件，不是浏览器最终显示的 URL。前端会先从同源
`/api/artifacts/{id}/origin` 取得专用 origin URL，再将该 URL 直接设为 iframe
`src`。这避免了 sandbox iframe 先请求同源 content endpoint、再通过跨源 307
跳转到 artifact root 时出现 opaque-origin/request-mode 冲突。

## 交互

组件如需将用户操作返回 agent，继续使用
`window.silverRetort.setContext(action, data, { displayText })`。ESM wrapper 可将它作为
`mount` option 传给内部组件。

不新增 React 专用交互协议，不向 ESM 暴露 chat-ui store 或 API client。

## 建议实施顺序

1. 选一个无副作用组件，实现 ESM `mount`/dispose 与运行时 props 校验。
2. 构建并发布版本化 ESM/CSS/chunk，验证专用 artifact origin 下的 CORS 和 CSP。
3. 实现两个 catalog MCP 工具，将同源 props schema 传递给 agent。
4. 使用 agent 生成的 iframe HTML 验证导入、渲染、错误诊断、dispose 和 context。
5. 通过同一流程逐个增加获准组件，不开放 package 级通配导出。

当前首批 catalog 包含 `demo.stat` 和 `circuit`。它们由
`packages/artifact-esm` 构建为带独立 CSS/worker 资源的 ESM，Next 启动和构建前
会自动刷新产物。前端连接后端时读取生成的 catalog，将模块 URL
转换为当前应用 origin 下的绝对 URL，再与 renderer 能力一起上报。
由于 desktop 开发模式直接启动 Next CLI，不会触发 package 的 `predev`，desktop
服务栈会在启动 Next 前直接用 Node 调用 workspace 中的 Vite CLI 执行一次
ESM 构建，不再递归启动 pnpm 子进程。这既保证 catalog 不会因静态产物缺失
而上报为空，也避免 Windows/Electron 启动阶段被 shell/pnpm 调用卡住。

## 验收标准

- `ui_list_render_types` 不包含 `react`、`demo.stat` 或 `circuit` 等自定义 React type。
- agent 能先查询模块索引，再按 ID 取得 ESM URL、完整 props schema 和示例。
- iframe 能从 catalog URL 导入 ESM，并完整加载 CSS、worker 与其他依赖。
- schema 不合法时在 mount 前失败，且错误可供 agent 诊断。
- agent 无法通过 catalog 访问任意 package export 或物理文件路径。
- artifact panel 和独立 artifact window 中的导入、渲染和 context 行为一致。
