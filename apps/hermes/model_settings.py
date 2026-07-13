"""Read and persist the Hermes models exposed in SilverRetort settings."""

from typing import Any

from fastapi import HTTPException


def model_id(provider: str, model: str) -> str:
    return f"{provider}:{model}"


def model_default() -> dict[str, Any]:
    from hermes_cli.config import load_config

    cfg = load_config()
    model_cfg = cfg.get("model", {})
    if isinstance(model_cfg, dict):
        return {
            "provider": str(model_cfg.get("provider") or ""),
            "model": str(model_cfg.get("default") or model_cfg.get("name") or ""),
            "baseUrl": str(model_cfg.get("base_url") or ""),
            "hasApiKey": bool(model_cfg.get("api_key")),
        }
    return {
        "provider": "",
        "model": str(model_cfg or ""),
        "baseUrl": "",
        "hasApiKey": False,
    }


def vision_model() -> dict[str, Any]:
    from hermes_cli.config import load_config

    cfg = load_config()
    auxiliary = cfg.get("auxiliary", {})
    vision = auxiliary.get("vision", {}) if isinstance(auxiliary, dict) else {}
    provider = str(vision.get("provider") or "") if isinstance(vision, dict) else ""
    model = str(vision.get("model") or "") if isinstance(vision, dict) else ""
    base_url = str(vision.get("base_url") or "") if isinstance(vision, dict) else ""
    has_api_key = bool(vision.get("api_key")) if isinstance(vision, dict) else False
    inherited = provider.strip().lower() in {"", "auto"} and model.strip().lower() in {
        "",
        "auto",
    }
    if inherited:
        default = model_default()
        provider = default["provider"]
        model = default["model"]
        base_url = str(default["baseUrl"])
        has_api_key = bool(default["hasApiKey"])
    return {
        "provider": provider,
        "model": model,
        "baseUrl": base_url,
        "hasApiKey": has_api_key,
        "inherited": inherited,
    }


def collect_models() -> dict[str, Any]:
    default = model_default()
    provider = default["provider"]
    model = default["model"]
    models: list[dict[str, Any]] = []
    if provider and model:
        models.append(
            {
                "id": model_id(provider, model),
                "provider": provider,
                "providerLabel": provider,
                "model": model,
                "label": model.split("/")[-1],
                "available": True,
                "current": True,
            }
        )
    vision = vision_model()
    vision_provider = str(vision.get("provider") or "")
    vision_name = str(vision.get("model") or "")
    vision_id = model_id(vision_provider, vision_name)
    if vision_provider and vision_name and not any(item["id"] == vision_id for item in models):
        models.append(
            {
                "id": vision_id,
                "provider": vision_provider,
                "providerLabel": vision_provider,
                "model": vision_name,
                "label": vision_name.split("/")[-1],
                "available": True,
                "current": False,
            }
        )
    return {"models": models, "default": default}


def set_default_model(
    provider: str,
    model: str,
    base_url: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    from hermes_cli.config import (
        clear_model_endpoint_credentials,
        load_config,
        save_config,
    )

    cfg = load_config()
    current = cfg.get("model", {})
    if isinstance(current, dict):
        model_cfg = dict(current)
    elif isinstance(current, str) and current.strip():
        model_cfg = {"default": current.strip()}
    else:
        model_cfg = {}
    model_cfg["provider"] = provider
    model_cfg["default"] = model
    if provider.strip().lower() == "custom":
        if base_url is not None:
            previous_base_url = str(model_cfg.get("base_url") or "").strip().rstrip("/")
            next_base_url = base_url.strip().rstrip("/")
            model_cfg["base_url"] = next_base_url
            if previous_base_url != next_base_url and not api_key:
                model_cfg.pop("api_key", None)
        if api_key:
            model_cfg["api_key"] = api_key.strip()
    else:
        clear_model_endpoint_credentials(model_cfg, clear_base_url=True)
    cfg["model"] = model_cfg
    save_config(cfg)
    return {
        "provider": provider,
        "model": model,
        "modelId": model_id(provider, model),
        "baseUrl": str(model_cfg.get("base_url") or ""),
        "hasApiKey": bool(model_cfg.get("api_key")),
    }


def set_vision_model(
    provider: str,
    model: str,
    base_url: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    from hermes_cli.config import (
        clear_model_endpoint_credentials,
        load_config,
        save_config,
    )

    cfg = load_config()
    auxiliary = cfg.get("auxiliary", {})
    auxiliary = dict(auxiliary) if isinstance(auxiliary, dict) else {}

    if not provider and not model:
        auxiliary.pop("vision", None)
        if auxiliary:
            cfg["auxiliary"] = auxiliary
        else:
            cfg.pop("auxiliary", None)
        save_config(cfg)
        return vision_model()

    if not provider or not model:
        raise HTTPException(400, "provider and model are required")
    current = auxiliary.get("vision", {})
    vision = dict(current) if isinstance(current, dict) else {}
    vision["provider"] = provider
    vision["model"] = model
    if provider.strip().lower() == "custom":
        if base_url is not None:
            previous_base_url = str(vision.get("base_url") or "").strip().rstrip("/")
            next_base_url = base_url.strip().rstrip("/")
            vision["base_url"] = next_base_url
            if previous_base_url != next_base_url and not api_key:
                vision.pop("api_key", None)
        if api_key:
            vision["api_key"] = api_key.strip()
        elif not vision.get("api_key"):
            main = cfg.get("model", {})
            main_base_url = (
                str(main.get("base_url") or "").strip().rstrip("/")
                if isinstance(main, dict)
                else ""
            )
            vision_base_url = str(vision.get("base_url") or "").strip().rstrip("/")
            if (
                isinstance(main, dict)
                and main.get("api_key")
                and main_base_url
                and main_base_url == vision_base_url
            ):
                vision["api_key"] = main["api_key"]
    else:
        clear_model_endpoint_credentials(vision, clear_base_url=True)
    auxiliary["vision"] = vision
    cfg["auxiliary"] = auxiliary
    save_config(cfg)
    return {
        "provider": provider,
        "model": model,
        "modelId": model_id(provider, model),
        "baseUrl": str(vision.get("base_url") or ""),
        "hasApiKey": bool(vision.get("api_key")),
        "inherited": False,
    }
