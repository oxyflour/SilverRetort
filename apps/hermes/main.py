"""以 API Server 模式启动 hermes gateway，并接入 SilverRetort 的 MCP server。

与 apps/uvicorn/main.py 相同的 stdin 看门狗模式：父进程（Electron）管道关闭即退出。
"""

import json
import os
import signal
import sys
import threading
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import yaml

MCP_SERVER_NAME = "silverretort-ui"
SHARED_ENV_KEYS = frozenset({"OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAI_MODEL_ID"})


def exit_on_stdin_eof() -> None:
    while True:
        chunk = sys.stdin.buffer.read(1)
        if chunk == b"":
            os._exit(0)


def resolve_hermes_home() -> Path:
    """独立的 HERMES_HOME：不与用户全局 hermes 配置（含消息平台等）互相干扰。"""
    home = Path(os.getenv("HERMES_HOME", Path(__file__).parent / "home"))
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HERMES_HOME"] = str(home)
    return home


def resolve_shared_env_file() -> Path | None:
    configured = os.getenv("HERMES_ENV_FILE", "").strip()
    if configured:
        return Path(configured).expanduser()

    candidate = Path(__file__).resolve().parent.parent / "desktop" / ".env"
    return candidate if candidate.exists() else None


def _strip_env_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def load_shared_env() -> None:
    """默认读取 apps/desktop/.env，让手动 hermes 启动与 desktop 托管共用同一配置源。"""
    env_file = resolve_shared_env_file()
    if env_file is None or not env_file.exists():
        return

    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        value = _strip_env_value(raw_value)
        if not key:
            continue
        if key in SHARED_ENV_KEYS:
            os.environ[key] = value
        else:
            os.environ.setdefault(key, value)


def load_hermes_config_json() -> dict:
    """从可选的 HERMES_CONFIG_JSON 读取托管 Hermes 配置。"""
    raw_config = os.getenv("HERMES_CONFIG_JSON", "").strip()
    if not raw_config:
        return {}

    try:
        config = json.loads(raw_config)
    except json.JSONDecodeError as error:
        raise ValueError(f"HERMES_CONFIG_JSON must be valid JSON: {error.msg}") from error

    if not isinstance(config, dict):
        raise ValueError("HERMES_CONFIG_JSON must be a JSON object")
    return config


def merge_runtime_config(home: Path, mcp_url: str | None) -> None:
    """把环境传入的 Hermes 配置和 uvicorn MCP 地址合并进隔离的 config.yaml。"""
    config_path = home / "config.yaml"
    config: dict = {}
    changed = False
    if config_path.exists():
        config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}

    runtime_config = load_hermes_config_json()
    if runtime_config:
        next_config = config | runtime_config
        if next_config != config:
            config = next_config
            changed = True

    if config.get("model_catalog") != {"enabled": False}:
        config["model_catalog"] = {"enabled": False}
        changed = True
    if config.get("approvals") != {"mode": "off"}:
        config["approvals"] = {"mode": "off"}
        changed = True

    if mcp_url:
        servers = config.setdefault("mcp_servers", {})
        if servers.get(MCP_SERVER_NAME, {}).get("url") != mcp_url:
            servers[MCP_SERVER_NAME] = {"url": mcp_url}
            changed = True

    if changed:
        config_path.write_text(
            yaml.safe_dump(config, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )


def relay_enabled() -> bool:
    return os.getenv("HERMES_RELAY_ENABLED", "0").strip() == "1"


def configure_api_server() -> tuple[str, str]:
    public_port = os.getenv("LISTEN_PORT", "23002")
    public_host = os.getenv("LISTEN_HOST", "127.0.0.1")
    if relay_enabled():
        gateway_port = os.getenv("HERMES_GATEWAY_PORT", str(int(public_port) + 1))
        gateway_host = os.getenv("HERMES_GATEWAY_HOST", "127.0.0.1")
        os.environ.setdefault("API_SERVER_ENABLED", "true")
        os.environ["API_SERVER_PORT"] = gateway_port
        os.environ["API_SERVER_HOST"] = gateway_host
        return public_host, public_port

    os.environ.setdefault("API_SERVER_ENABLED", "true")
    os.environ.setdefault("API_SERVER_PORT", public_port)
    os.environ.setdefault("API_SERVER_HOST", public_host)
    return public_host, public_port


def configure_bridge_relay(public_host: str, public_port: str) -> str | None:
    if not relay_enabled():
        return os.getenv("MCP_URL")

    from relay import start_background_server

    gateway_host = os.environ["API_SERVER_HOST"]
    gateway_port = os.environ["API_SERVER_PORT"]
    start_background_server(
        listen_host=public_host,
        listen_port=int(public_port),
        gateway_base_url=f"http://{gateway_host}:{gateway_port}",
        api_key=os.getenv("HERMES_API_KEY", "").strip(),
    )
    return f"http://127.0.0.1:{public_port}/mcp/"


def patch_hermes() -> None:
    import agent.model_metadata as model_metadata

    def disabled_fetch_model_metadata(
        force_refresh: bool = False,
    ) -> dict[str, dict[str, Any]]:
        return {}

    model_metadata.fetch_model_metadata = disabled_fetch_model_metadata
    patch_api_server_usage_tracking()


def patch_api_server_usage_tracking() -> None:
    try:
        from gateway.platforms.api_server import APIServerAdapter
    except Exception:
        return

    if getattr(APIServerAdapter, "_silverretort_usage_tracking_patched", False):
        return

    original_create_agent = APIServerAdapter._create_agent
    original_session_model_override_for = APIServerAdapter._session_model_override_for
    resolving_session_override = ContextVar(
        "silverretort_resolving_session_override",
        default=False,
    )

    def session_model_override_for(self, session_key: str | None) -> dict[str, Any] | None:
        if resolving_session_override.get():
            return None
        return original_session_model_override_for(self, session_key)

    def create_agent_with_usage_tracking(self, *args: Any, **kwargs: Any) -> Any:
        session_key = str(
            kwargs.get("gateway_session_key") or kwargs.get("session_id") or ""
        )
        session_override = original_session_model_override_for(self, session_key)
        if session_override:
            # Hermes 0.14 notices a session override only to suppress static
            # model routing, but does not apply that override when constructing
            # an API-server agent. Feed it through the existing route path while
            # hiding it from that one guard so toolbar model changes affect the
            # next response without changing the global default in Settings.
            kwargs["route"] = session_override
            token = resolving_session_override.set(True)
            try:
                agent = original_create_agent(self, *args, **kwargs)
            finally:
                resolving_session_override.reset(token)
        else:
            agent = original_create_agent(self, *args, **kwargs)
        if session_key:
            agents = getattr(self, "_silverretort_usage_agents", None)
            if not isinstance(agents, dict):
                agents = {}
                self._silverretort_usage_agents = agents
            agents[session_key] = agent
        return agent

    APIServerAdapter._session_model_override_for = session_model_override_for
    APIServerAdapter._create_agent = create_agent_with_usage_tracking
    APIServerAdapter._silverretort_usage_tracking_patched = True


def main() -> None:
    if os.getenv("WATCH_STDIN", "1") != "0":
        threading.Thread(target=exit_on_stdin_eof, daemon=True).start()

    load_shared_env()
    home = resolve_hermes_home()
    public_host, public_port = configure_api_server()
    if os.getenv("HERMES_API_KEY"):
        os.environ.setdefault("API_SERVER_KEY", os.environ["HERMES_API_KEY"])

    mcp_url = configure_bridge_relay(public_host, public_port)
    merge_runtime_config(home, mcp_url)

    # 复用 hermes CLI 入口，等价于命令行执行 `hermes gateway`
    patch_hermes()
    from hermes_cli.main import main as hermes_main

    sys.argv = ["hermes", "gateway"]
    signal.signal(signal.SIGINT, signal.default_int_handler)
    hermes_main()


if __name__ == "__main__":
    main()
