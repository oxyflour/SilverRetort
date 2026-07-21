"""Local MCP server forwarding configuration.

Remote Hermes relay mode forwards explicitly configured local HTTP and stdio
MCP servers. Configuration lives in DATA_DIR/settings.json:

{
  "mcpServers": {
    "filesystem": {
      "transport": "streamable_http",
      "url": "http://127.0.0.1:9901/mcp/",
      "headers": {"Authorization": "Bearer ..."}
    },
    "local_tools": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "env": {},
      "cwd": "/workspace"
    }
  },
  "managedMcpServers": {
    "example_adapter": {
      "serverName": "example_adapter",
      "enabled": true,
      "installedVersion": "0.1.0",
      "running": true,
      "port": 9901
    }
  }
}
"""

import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

SERVER_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
BUILTIN_MCP_SERVER_NAME = "silverretort-ui"


def _data_dir() -> Path:
    path = Path(os.getenv("DATA_DIR", Path(__file__).parent / "data"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _settings_path() -> Path:
    return _data_dir() / "settings.json"


def _read_settings() -> dict[str, Any]:
    path = _settings_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _valid_local_http_url(raw_url: Any) -> str:
    url = str(raw_url or "").strip()
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    if parsed.hostname.lower() not in LOOPBACK_HOSTS:
        return ""
    return url


def _headers(raw_headers: Any) -> dict[str, str]:
    if not isinstance(raw_headers, dict):
        return {}
    result: dict[str, str] = {}
    for raw_key, raw_value in raw_headers.items():
        key = str(raw_key).strip()
        if key:
            result[key] = str(raw_value)
    return result


def _builtin_server() -> dict[str, Any]:
    port = os.getenv("LISTEN_PORT", "23001").strip() or "23001"
    return {"url": f"http://127.0.0.1:{port}/mcp/", "headers": {}}


def _load_managed_servers(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw_servers = settings.get("managedMcpServers")
    if not isinstance(raw_servers, dict):
        return {}

    result: dict[str, dict[str, Any]] = {}
    for raw_id, raw_config in raw_servers.items():
        config = raw_config if isinstance(raw_config, dict) else {}
        if config.get("enabled") is False:
            continue
        if not str(config.get("installedVersion") or "").strip():
            continue
        if config.get("running") is not True:
            continue
        name = str(config.get("serverName") or raw_id or "").strip()
        if name == BUILTIN_MCP_SERVER_NAME or not SERVER_NAME_RE.fullmatch(name):
            continue
        try:
            port = int(config.get("port") or 0)
        except (TypeError, ValueError):
            continue
        if port < 1 or port > 65535:
            continue
        result[name] = {"url": f"http://127.0.0.1:{port}/mcp/", "headers": {}}
    return result


def load_servers() -> dict[str, dict[str, Any]]:
    settings = _read_settings()
    raw_servers = settings.get("mcpServers")
    servers: dict[str, dict[str, Any]] = {BUILTIN_MCP_SERVER_NAME: _builtin_server()}
    servers.update(_load_managed_servers(settings))
    if not isinstance(raw_servers, dict):
        return servers

    for raw_name, raw_config in raw_servers.items():
        name = str(raw_name).strip()
        if name == BUILTIN_MCP_SERVER_NAME or not SERVER_NAME_RE.fullmatch(name):
            continue
        config = raw_config if isinstance(raw_config, dict) else {}
        if config.get("enabled") is False:
            continue
        if config.get("transport") == "stdio":
            command = str(config.get("command") or "").strip()
            raw_args = config.get("args")
            raw_env = config.get("env")
            if not command or not isinstance(raw_args, list) or not all(
                isinstance(item, str) for item in raw_args
            ):
                continue
            if not isinstance(raw_env, dict):
                raw_env = {}
            servers[name] = {
                "transport": "stdio",
                "command": command,
                "args": list(raw_args),
                "env": {str(key): str(value) for key, value in raw_env.items()},
                "cwd": str(config.get("cwd") or "").strip(),
            }
            continue
        url = _valid_local_http_url(config.get("url"))
        if not url:
            continue
        servers[name] = {
            "transport": "streamable_http",
            "url": url,
            "headers": _headers(config.get("headers")),
        }
    return servers
