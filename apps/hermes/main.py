"""以 API Server 模式启动 hermes gateway，并接入 SilverRetort 的 MCP server。

与 apps/uvicorn/main.py 相同的 stdin 看门狗模式：父进程（Electron）管道关闭即退出。
"""

import os
import signal
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import yaml

MCP_SERVER_NAME = "silverretort-ui"
MANAGED_MODEL_KEYS = ("provider", "default", "base_url", "api_key")
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


def normalize_openai_base_url(base_url: str) -> str:
    normalized = base_url.strip().rstrip("/")
    if not normalized:
        return ""

    parsed = urlsplit(normalized)
    if not parsed.scheme or not parsed.netloc:
        return normalized

    path = parsed.path.rstrip("/")
    if not path:
        path = "/v1"
    return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment)).rstrip("/")


def build_managed_model_config() -> dict:
    """把共享 .env 里的 OpenAI-compatible 配置落成 Hermes 可直接消费的 model 段。"""
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    base_url = normalize_openai_base_url(os.getenv("OPENAI_BASE_URL", ""))
    model_id = os.getenv("OPENAI_MODEL_ID", os.getenv("OPENAI_MODEL", "")).strip()

    if not any((api_key, base_url, model_id)):
        return {}

    model_config = {"provider": "custom"}
    if model_id:
        model_config["default"] = model_id
    if base_url:
        model_config["base_url"] = base_url
    if api_key:
        model_config["api_key"] = api_key
    return model_config


def merge_runtime_config(home: Path, mcp_url: str | None) -> None:
    """把 uvicorn MCP 地址和受控 model 配置合并进隔离的 config.yaml。"""
    config_path = home / "config.yaml"
    config: dict = {}
    if config_path.exists():
        config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}

    changed = False
    config['model_catalog'] = { 'enabled': False }
    config["approvals"] = { "mode": "off" }

    if mcp_url:
        servers = config.setdefault("mcp_servers", {})
        if servers.get(MCP_SERVER_NAME, {}).get("url") != mcp_url:
            servers[MCP_SERVER_NAME] = {"url": mcp_url}
            changed = True

    managed_model = build_managed_model_config()
    if managed_model:
        current_model = config.get("model")
        preserved_model = dict(current_model) if isinstance(current_model, dict) else {}
        for key in MANAGED_MODEL_KEYS:
            preserved_model.pop(key, None)
        next_model = preserved_model | managed_model
        if config.get("model") != next_model:
            config["model"] = next_model
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
    from hermes_cli.main import main as hermes_main

    sys.argv = ["hermes", "gateway"]
    signal.signal(signal.SIGINT, signal.default_int_handler)
    hermes_main()


if __name__ == "__main__":
    main()
