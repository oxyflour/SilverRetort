"""Outbound bridge client for remote Hermes relay instances."""

import asyncio
import base64
import json
import os
from contextlib import suppress
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx
from websockets.asyncio.client import connect

import local_mcp_servers
import switch_profiles

RETRY_DELAYS = (1, 2, 5)
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
HOP_BY_HOP_HEADERS = {
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


def _normalized_base_url(url: str) -> str:
    return url.strip().rstrip("/")


def _coerce_bridge_url(url: str) -> str:
    normalized = _normalized_base_url(url)
    if not normalized:
        return ""

    parsed = urlsplit(normalized)
    if parsed.scheme in {"http", "https"}:
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunsplit((scheme, parsed.netloc, parsed.path, parsed.query, parsed.fragment))
    return normalized


def _is_remote_host(hostname: str | None) -> bool:
    if not hostname:
        return False
    return hostname.lower() not in LOOPBACK_HOSTS


def resolve_bridge_url() -> str | None:
    explicit = _coerce_bridge_url(os.getenv("HERMES_BRIDGE_URL", ""))
    if explicit:
        return explicit

    hermes_url = _normalized_base_url(os.getenv("HERMES_URL", ""))
    if not hermes_url:
        return None

    parsed = urlsplit(hermes_url)
    if not _is_remote_host(parsed.hostname):
        return None

    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = parsed.path.rstrip("/")
    if not path:
        path = "/bridge"
    else:
        path = f"{path}/bridge"
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


def _filter_headers(headers: dict[str, str]) -> dict[str, str]:
    return {
        key: value
        for key, value in headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
    }


def _target_url(base_url: str, path: str, query: str) -> str:
    suffix = str(path or "")
    if suffix:
        url = f"{base_url.rstrip('/')}/{suffix.lstrip('/')}"
    else:
        url = base_url
    return f"{url}?{query}" if query else url


async def _send_json(websocket: Any, send_lock: asyncio.Lock, payload: dict[str, Any]) -> None:
    async with send_lock:
        await websocket.send(json.dumps(payload, ensure_ascii=False))


async def _send_local_mcp_servers(websocket: Any, send_lock: asyncio.Lock) -> None:
    servers = [{"name": name} for name in sorted(local_mcp_servers.load_servers())]
    await _send_json(websocket, send_lock, {"kind": "mcp_servers", "servers": servers})


async def _handle_mcp_http(payload: dict[str, Any], websocket: Any, send_lock: asyncio.Lock) -> None:
    request_id = str(payload.get("id") or "")
    server_name = str(payload.get("server") or "")
    servers = local_mcp_servers.load_servers()
    server = servers.get(server_name)
    if not server:
        await _send_json(websocket, send_lock, {
            "kind": "mcp_http_response_error",
            "id": request_id,
            "error": f"unknown local MCP server: {server_name}",
        })
        return

    raw_body = str(payload.get("body") or "")
    try:
        body = base64.b64decode(raw_body) if raw_body else b""
    except ValueError:
        body = b""

    headers = payload.get("headers") if isinstance(payload.get("headers"), dict) else {}
    request_headers = _filter_headers({str(key): str(value) for key, value in headers.items()})
    merged_headers = {**request_headers, **server.get("headers", {})}
    url = _target_url(server["url"], str(payload.get("path") or ""), str(payload.get("query") or ""))

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10)) as client:
            async with client.stream(
                str(payload.get("method") or "POST"),
                url,
                headers=merged_headers,
                content=body,
            ) as response:
                await _send_json(websocket, send_lock, {
                    "kind": "mcp_http_response_start",
                    "id": request_id,
                    "status": response.status_code,
                    "headers": _filter_headers(dict(response.headers.items())),
                })
                async for chunk in response.aiter_raw():
                    if not chunk:
                        continue
                    await _send_json(websocket, send_lock, {
                        "kind": "mcp_http_response_chunk",
                        "id": request_id,
                        "body": base64.b64encode(chunk).decode("ascii"),
                    })
                await _send_json(websocket, send_lock, {"kind": "mcp_http_response_end", "id": request_id})
    except Exception as exc:
        await _send_json(websocket, send_lock, {
            "kind": "mcp_http_response_error",
            "id": request_id,
            "error": str(exc),
        })


async def _bridge_forever(bridge_url: str, api_key: str) -> None:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    attempt = 0

    while True:
        try:
            async with connect(bridge_url, additional_headers=headers) as websocket:
                print(f"[bridge] connected {bridge_url}")
                attempt = 0
                send_lock = asyncio.Lock()
                await _send_local_mcp_servers(websocket, send_lock)
                async for raw_message in websocket:
                    try:
                        payload = json.loads(raw_message)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue
                    if payload.get("kind") == "mcp_http_request":
                        asyncio.create_task(_handle_mcp_http(payload, websocket, send_lock))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            delay = RETRY_DELAYS[min(attempt, len(RETRY_DELAYS) - 1)]
            attempt += 1
            print(f"[bridge] disconnected from {bridge_url}: {exc}; retrying in {delay}s")
            await asyncio.sleep(delay)


def start_task() -> asyncio.Task[None] | None:
    bridge_url = resolve_bridge_url()
    if not bridge_url:
        return None
    return asyncio.create_task(
        _bridge_forever(bridge_url, os.getenv("HERMES_API_KEY", "").strip()),
        name="hermes-bridge",
    )


def _bridge_url_from_switch_url(switch_url: str) -> str:
    parsed = urlsplit(switch_url.rstrip("/"))
    scheme = "wss" if parsed.scheme == "https" else "ws"
    path = parsed.path.rstrip("/")
    path = f"{path}/bridge" if path else "/bridge"
    return urlunsplit((scheme, parsed.netloc, path, "", ""))


def start_tasks() -> list[asyncio.Task[None]]:
    tasks: list[asyncio.Task[None]] = []
    legacy = start_task()
    if legacy is not None:
        tasks.append(legacy)
    seen = {resolve_bridge_url()} if resolve_bridge_url() else set()
    for connection in switch_profiles.list_remote_connections():
        bridge_url = _bridge_url_from_switch_url(connection.switch_url)
        if bridge_url in seen:
            continue
        seen.add(bridge_url)
        tasks.append(
            asyncio.create_task(
                _bridge_forever(bridge_url, connection.api_key),
                name=f"hermes-bridge-{connection.profile_id}",
            )
        )
    return tasks


async def stop_task(task: asyncio.Task[None] | None) -> None:
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


async def stop_tasks(tasks: list[asyncio.Task[None]]) -> None:
    for task in tasks:
        await stop_task(task)
