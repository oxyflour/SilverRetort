"""Outbound bridge client for remote Hermes relay instances."""

import asyncio
import json
import os
from contextlib import suppress
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import connect

import mcp_tools

RETRY_DELAYS = (1, 2, 5)
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _normalized_base_url(url: str) -> str:
    return url.strip().rstrip("/")


def _is_remote_host(hostname: str | None) -> bool:
    if not hostname:
        return False
    return hostname.lower() not in LOOPBACK_HOSTS


def resolve_bridge_url() -> str | None:
    explicit = _normalized_base_url(os.getenv("HERMES_BRIDGE_URL", ""))
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


async def _handle_request(payload: dict[str, Any]) -> dict[str, Any]:
    request_id = str(payload.get("id") or "")
    tool_name = str(payload.get("name") or "")
    raw_args = payload.get("args")
    args = raw_args if isinstance(raw_args, dict) else {}

    try:
        result = mcp_tools.call_tool(tool_name, args)
        return {"id": request_id, "ok": True, "result": result}
    except Exception as exc:
        return {"id": request_id, "ok": False, "error": str(exc)}


async def _bridge_forever(bridge_url: str, api_key: str) -> None:
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    attempt = 0

    while True:
        try:
            async with connect(bridge_url, additional_headers=headers) as websocket:
                print(f"[bridge] connected {bridge_url}")
                attempt = 0
                async for raw_message in websocket:
                    try:
                        payload = json.loads(raw_message)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(payload, dict):
                        continue
                    response = await _handle_request(payload)
                    await websocket.send(json.dumps(response, ensure_ascii=False))
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


async def stop_task(task: asyncio.Task[None] | None) -> None:
    if task is None:
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
