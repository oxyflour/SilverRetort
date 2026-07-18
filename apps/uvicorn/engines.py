"""Agent 引擎接口与 mock 实现。

引擎产出内部事件 dict（kind: text / tool-start / tool-end / artifact），
由 runs.py 负责落库与广播。hermes 引擎见 hermes_client.py。
"""

import asyncio
import json
import os
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator, Protocol

import db
import switch_profiles
from models import Message


def _data_dir() -> Path:
    path = Path(os.getenv("DATA_DIR", Path(__file__).parent / "data"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def _model_settings_path() -> Path:
    return _data_dir() / "model-settings.json"


def _model_id(provider: str, model: str) -> str:
    return f"{provider}:{model}"


def _read_model_settings() -> dict[str, Any]:
    path = _model_settings_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_model_settings(settings: dict[str, Any]) -> None:
    path = _model_settings_path()
    path.write_text(json.dumps(settings, ensure_ascii=False, indent=2), "utf-8")


def _setting_response(setting: dict[str, Any], inherited: bool = False) -> dict[str, Any]:
    provider = str(setting.get("provider") or "")
    model = str(setting.get("model") or "")
    return {
        "provider": provider,
        "model": model,
        "modelId": _model_id(provider, model) if provider and model else "",
        "baseUrl": str(setting.get("baseUrl") or ""),
        "hasApiKey": bool(setting.get("apiKey")),
        "inherited": inherited,
    }


class Engine(Protocol):
    def run(
        self, session_id: str, workspace_id: str, history: list[Message], user_message: Message
    ) -> AsyncGenerator[dict[str, Any], None]: ...


class MockEngine:
    """开发/兜底引擎：回显 + 假工具事件；输入含 artifact 时产出示例 artifact。"""

    async def list_models(self) -> dict[str, Any]:
        default = await self.get_default_model()
        models = []
        if default["provider"] and default["model"]:
            models.append(
                {
                    "id": default["modelId"],
                    "provider": default["provider"],
                    "providerLabel": default["provider"],
                    "model": default["model"],
                    "label": default["model"].split("/")[-1],
                    "available": True,
                    "current": True,
                }
            )
        return {"models": models, "default": default}

    async def get_default_model(self) -> dict[str, Any]:
        settings = _read_model_settings()
        default = settings.get("default")
        return _setting_response(default if isinstance(default, dict) else {})

    async def set_default_model(
        self,
        provider: str,
        model: str,
        model_id: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        settings = _read_model_settings()
        current = settings.get("default")
        default = dict(current) if isinstance(current, dict) else {}
        default["provider"] = provider
        default["model"] = model
        if provider.strip().lower() == "custom":
            if base_url is not None:
                previous_base_url = str(default.get("baseUrl") or "").strip().rstrip("/")
                next_base_url = base_url.strip().rstrip("/")
                default["baseUrl"] = next_base_url
                if previous_base_url != next_base_url and not api_key:
                    default.pop("apiKey", None)
            if api_key:
                default["apiKey"] = api_key.strip()
        else:
            default.pop("baseUrl", None)
            default.pop("apiKey", None)
        settings["default"] = default
        _write_model_settings(settings)
        return _setting_response(default)

    async def get_vision_model(self) -> dict[str, Any]:
        settings = _read_model_settings()
        vision = settings.get("vision")
        if isinstance(vision, dict):
            return _setting_response(vision, inherited=False)
        default = settings.get("default")
        return _setting_response(default if isinstance(default, dict) else {}, inherited=True)

    async def set_vision_model(
        self,
        provider: str | None,
        model: str | None,
        model_id: str | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        settings = _read_model_settings()
        if not provider and not model:
            settings.pop("vision", None)
            _write_model_settings(settings)
            return await self.get_vision_model()
        current = settings.get("vision")
        vision = dict(current) if isinstance(current, dict) else {}
        vision["provider"] = provider or ""
        vision["model"] = model or ""
        if vision["provider"].strip().lower() == "custom":
            if base_url is not None:
                previous_base_url = str(vision.get("baseUrl") or "").strip().rstrip("/")
                next_base_url = base_url.strip().rstrip("/")
                vision["baseUrl"] = next_base_url
                if previous_base_url != next_base_url and not api_key:
                    vision.pop("apiKey", None)
            if api_key:
                vision["apiKey"] = api_key.strip()
        else:
            vision.pop("baseUrl", None)
            vision.pop("apiKey", None)
        settings["vision"] = vision
        _write_model_settings(settings)
        return _setting_response(vision, inherited=False)

    async def run(
        self, session_id: str, workspace_id: str, history: list[Message], user_message: Message
    ) -> AsyncGenerator[dict[str, Any], None]:
        user_text = next((p.text for p in user_message.parts if p.type == "text"), "")

        tool_id = uuid.uuid4().hex
        yield {"kind": "tool-start", "id": tool_id, "name": "mock_think", "detail": "思考中"}
        await asyncio.sleep(0.4)
        yield {"kind": "tool-end", "id": tool_id, "status": "done", "result": f"收到 {len(history)} 条历史消息"}

        reply = f"（mock 引擎）你说的是：{user_text}"
        for char in reply:
            await asyncio.sleep(0.02)
            yield {"kind": "text", "delta": char}

        if "artifact" in user_text.lower():
            yield {
                "kind": "artifact",
                "type": "markdown",
                "title": "示例 Artifact",
                "payload": {"text": f"# 示例\n\n由 mock 引擎生成。\n\n> {user_text}"},
            }
            yield {"kind": "text", "delta": "\n\n已生成一个示例 artifact，见右侧面板。"}


_engine_cache: dict[tuple[str, str, str], Engine] = {}


def _mock_engine() -> Engine:
    key = ("mock", "", "")
    if key not in _engine_cache:
        _engine_cache[key] = MockEngine()
    return _engine_cache[key]


def create_engine() -> Engine:
    """按环境选择引擎：配置了 HERMES_URL 用 hermes，否则 mock 兜底。"""
    hermes_url = os.getenv("HERMES_URL")
    if hermes_url:
        from hermes_client import HermesEngine

        return HermesEngine(
            base_url=hermes_url,
            api_key=os.getenv("HERMES_API_KEY", ""),
            model=os.getenv("HERMES_MODEL", "hermes-agent"),
        )
    return MockEngine()


def create_engine_for_workspace(workspace_id: str | None) -> Engine:
    workspace = db.get_workspace(workspace_id) if workspace_id else None
    connection = switch_profiles.connection_for_profile(
        workspace.connection_id if workspace is not None else None
    )
    if connection.mode == "mock" or not connection.switch_url:
        return _mock_engine()
    key = (connection.mode, connection.switch_url, connection.api_key)
    if key not in _engine_cache:
        from hermes_client import HermesEngine

        _engine_cache[key] = HermesEngine(
            base_url=connection.switch_url,
            api_key=connection.api_key,
            model=os.getenv("HERMES_MODEL", "hermes-agent"),
        )
    return _engine_cache[key]
