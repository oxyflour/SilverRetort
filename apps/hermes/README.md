# silverretort-hermes

hermes-agent (Nous Research) 的启动封装：以 API Server 模式起 `hermes gateway`，
供 apps/uvicorn 经 OpenAI 兼容接口调用；同时把 uvicorn 的 MCP server
（UI 操控 + 附件读取工具）合并进 hermes 配置。

- 本地模式：由 apps/desktop 直接 spawn，stdin 关闭即退出
- 远程模式：以 Docker 长驻容器运行（见 Dockerfile），desktop 配置 `hermesUrl` 指过来
- 开发模式：默认自动读取 `apps/desktop/.env`，把其中的 `OPENAI_*` 配置写成隔离 `HERMES_HOME` 下的 `model` 配置，手动启动与 desktop 托管共用同一配置源

环境变量：
- `LISTEN_PORT` API server 端口（默认 23002）
- `HERMES_API_KEY` Bearer token（desktop 生成随机值传入）
- `MCP_URL` uvicorn MCP server 地址（本地形如 `http://127.0.0.1:23001/mcp`）
- `HERMES_ENV_FILE` 共享 `.env` 路径；不传时默认找 `apps/desktop/.env`
- LLM key（OPENROUTER_API_KEY / ANTHROPIC_API_KEY 等）从环境或 `~/.hermes/.env` 读取
