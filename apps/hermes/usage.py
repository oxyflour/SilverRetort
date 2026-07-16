"""Normalize Hermes usage data for the SilverRetort UI."""

from typing import Any

from model_settings import model_default


def _runner() -> Any:
    try:
        from gateway.run import _gateway_runner_ref

        return _gateway_runner_ref()
    except Exception:
        return None


def _session_override(session_key: str) -> dict[str, Any] | None:
    runner = _runner()
    overrides = getattr(runner, "_session_model_overrides", None)
    if isinstance(overrides, dict):
        override = overrides.get(session_key)
        if isinstance(override, dict):
            return dict(override)
    return None


def _iso_datetime(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return value.isoformat()
    except AttributeError:
        return str(value)


def _clean_percent(value: Any) -> float | None:
    try:
        percent = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(100.0, percent))


def _usage_window(
    label: str,
    used_percent: Any = None,
    *,
    reset_at: Any = None,
    detail: str | None = None,
) -> dict[str, Any]:
    return {
        "label": label,
        "usedPercent": _clean_percent(used_percent),
        "resetAt": _iso_datetime(reset_at),
        "detail": detail,
    }


def _best_usage_label(
    windows: list[dict[str, Any]], fallback: str
) -> tuple[float | None, str]:
    usable = [
        (float(window["usedPercent"]), str(window.get("label") or fallback))
        for window in windows
        if window.get("usedPercent") is not None
    ]
    if not usable:
        return None, fallback
    return max(usable, key=lambda item: item[0])


def _active_model_setting(session_key: str) -> dict[str, Any]:
    active = _session_override(session_key) if session_key else None
    if active is None:
        active = model_default()
    return dict(active)


def _account_usage_response(
    provider: str,
    model: str,
    base_url: str,
    api_key: str | None,
) -> dict[str, Any] | None:
    try:
        from agent.account_usage import fetch_account_usage

        snapshot = fetch_account_usage(
            provider,
            base_url=base_url or None,
            api_key=api_key or None,
        )
    except Exception:
        return None
    if snapshot is None:
        return None

    windows = [
        _usage_window(
            str(getattr(window, "label", "") or "Usage"),
            getattr(window, "used_percent", None),
            reset_at=getattr(window, "reset_at", None),
            detail=getattr(window, "detail", None),
        )
        for window in getattr(snapshot, "windows", ()) or ()
    ]
    details = [str(item) for item in (getattr(snapshot, "details", ()) or ())]
    percent, label = _best_usage_label(
        windows, str(getattr(snapshot, "title", "") or "Usage")
    )
    unavailable = str(getattr(snapshot, "unavailable_reason", "") or "")
    return {
        "available": bool(windows or details) and not unavailable,
        "percent": percent,
        "label": label,
        "title": str(getattr(snapshot, "title", "") or "Account usage"),
        "provider": str(getattr(snapshot, "provider", "") or provider),
        "model": model,
        "source": str(getattr(snapshot, "source", "") or "account"),
        "fetchedAt": _iso_datetime(getattr(snapshot, "fetched_at", None)) or "",
        "windows": windows,
        "details": details,
        "unavailableReason": unavailable,
    }


def _format_count(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


def _session_agent(session_key: str) -> Any:
    runner = _runner()
    if runner is None or not session_key:
        return None

    adapters = getattr(runner, "adapters", None)
    if isinstance(adapters, dict):
        for adapter in adapters.values():
            agents = getattr(adapter, "_silverretort_usage_agents", None)
            if isinstance(agents, dict):
                agent = agents.get(session_key)
                if agent is not None:
                    return agent

    agent = getattr(runner, "_running_agents", {}).get(session_key)
    if agent is None:
        cache = getattr(runner, "_agent_cache", None)
        lock = getattr(runner, "_agent_cache_lock", None)
        cached = None
        try:
            if cache is not None and lock is not None:
                with lock:
                    cached = cache.get(session_key)
            elif cache is not None:
                cached = cache.get(session_key)
        except Exception:
            cached = None
        agent = cached[0] if isinstance(cached, tuple) and cached else cached
    return agent


def _stored_response_usage(
    session_key: str, provider: str, model: str
) -> dict[str, Any] | None:
    runner = _runner()
    adapters = getattr(runner, "adapters", None)
    if not isinstance(adapters, dict) or not session_key:
        return None

    for adapter in adapters.values():
        store = getattr(adapter, "_response_store", None)
        if not hasattr(store, "get_conversation") or not hasattr(store, "get"):
            continue
        try:
            response_id = store.get_conversation(session_key)
            stored = store.get(response_id) if response_id else None
        except Exception:
            continue
        response = stored.get("response") if isinstance(stored, dict) else None
        usage = response.get("usage") if isinstance(response, dict) else None
        if not isinstance(usage, dict):
            continue
        input_tokens = int(usage.get("input_tokens", 0) or 0)
        output_tokens = int(usage.get("output_tokens", 0) or 0)
        total_tokens = int(usage.get("total_tokens", 0) or 0)
        if input_tokens <= 0 and output_tokens <= 0 and total_tokens <= 0:
            continue
        details = [
            f"Input tokens: {_format_count(input_tokens)}",
            f"Output tokens: {_format_count(output_tokens)}",
            f"Total tokens: {_format_count(total_tokens)}",
        ]
        return {
            "available": True,
            "percent": None,
            "label": "Session usage",
            "title": "Session usage",
            "provider": provider,
            "model": model or str(response.get("model") or ""),
            "source": "responses_store",
            "fetchedAt": "",
            "windows": [],
            "details": [item for item in details if not item.endswith(": 0")],
            "unavailableReason": "",
        }
    return None


def _rate_limit_response(
    session_key: str, provider: str, model: str
) -> dict[str, Any] | None:
    agent = _session_agent(session_key)
    if not hasattr(agent, "get_rate_limit_state"):
        return None
    try:
        state = agent.get_rate_limit_state()
    except Exception:
        return None
    if not getattr(state, "has_data", False):
        return None

    windows: list[dict[str, Any]] = []
    for attr, label in (
        ("requests_min", "Requests/min"),
        ("requests_hour", "Requests/hour"),
        ("tokens_min", "Tokens/min"),
        ("tokens_hour", "Tokens/hour"),
    ):
        bucket = getattr(state, attr, None)
        limit = int(getattr(bucket, "limit", 0) or 0)
        if limit <= 0:
            continue
        remaining = max(0, int(getattr(bucket, "remaining", 0) or 0))
        used = max(0, limit - remaining)
        reset = int(getattr(bucket, "remaining_seconds_now", 0) or 0)
        windows.append(
            _usage_window(
                label,
                used / limit * 100.0,
                detail=(
                    f"{_format_count(used)}/{_format_count(limit)} used, "
                    f"{_format_count(remaining)} left, resets in {reset}s"
                ),
            )
        )
    if not windows:
        return None
    percent, label = _best_usage_label(windows, "Rate limits")
    return {
        "available": True,
        "percent": percent,
        "label": label,
        "title": "Rate limits",
        "provider": str(getattr(state, "provider", "") or provider),
        "model": model,
        "source": "rate_limit_headers",
        "fetchedAt": "",
        "windows": windows,
        "details": [],
        "unavailableReason": "",
    }


def _session_usage_response(
    session_key: str, provider: str, model: str
) -> dict[str, Any] | None:
    agent = _session_agent(session_key)
    if agent is None:
        return None

    compressor = getattr(agent, "context_compressor", None)
    last_prompt = int(getattr(compressor, "last_prompt_tokens", 0) or 0)
    context_length = int(getattr(compressor, "context_length", 0) or 0)
    prompt_tokens = int(getattr(agent, "session_prompt_tokens", 0) or 0)
    completion_tokens = int(getattr(agent, "session_completion_tokens", 0) or 0)
    total_tokens = int(getattr(agent, "session_total_tokens", 0) or 0)
    input_tokens = int(getattr(agent, "session_input_tokens", 0) or 0)
    output_tokens = int(getattr(agent, "session_output_tokens", 0) or 0)
    api_calls = int(getattr(agent, "session_api_calls", 0) or 0)
    compressions = int(getattr(compressor, "compression_count", 0) or 0)

    windows: list[dict[str, Any]] = []
    if context_length > 0 and last_prompt > 0:
        windows.append(
            _usage_window(
                "Current context",
                last_prompt / context_length * 100.0,
                detail=(
                    f"{_format_count(last_prompt)}/{_format_count(context_length)} "
                    "prompt tokens"
                ),
            )
        )

    details = [
        f"Input tokens: {_format_count(input_tokens)}",
        f"Output tokens: {_format_count(output_tokens)}",
        f"Prompt tokens: {_format_count(prompt_tokens)}",
        f"Completion tokens: {_format_count(completion_tokens)}",
        f"Total tokens: {_format_count(total_tokens)}",
        f"API calls: {_format_count(api_calls)}",
        f"Compressions: {_format_count(compressions)}",
    ]
    details = [item for item in details if not item.endswith(": 0")]
    if not windows and not details:
        return None

    percent, label = _best_usage_label(windows, "Session usage")
    return {
        "available": True,
        "percent": percent,
        "label": label,
        "title": "Session usage",
        "provider": provider,
        "model": model or str(getattr(agent, "model", "") or ""),
        "source": "session_agent",
        "fetchedAt": "",
        "windows": windows,
        "details": details,
        "unavailableReason": "",
    }


def usage_response(session_key: str = "") -> dict[str, Any]:
    active = _active_model_setting(session_key)
    provider = str(active.get("provider") or "")
    model = str(active.get("model") or "")
    base_url = str(active.get("base_url") or active.get("baseUrl") or "")
    api_key = active.get("api_key")
    if api_key is not None:
        api_key = str(api_key)

    account = _account_usage_response(provider, model, base_url, api_key)
    if account and account.get("windows"):
        return account

    rate_limits = _rate_limit_response(session_key, provider, model)
    if rate_limits:
        return rate_limits

    session_usage = _session_usage_response(session_key, provider, model)
    if session_usage:
        return session_usage

    stored_usage = _stored_response_usage(session_key, provider, model)
    if stored_usage:
        return stored_usage

    if account:
        return account

    return {
        "available": False,
        "percent": None,
        "label": "Usage unavailable",
        "title": "Usage",
        "provider": provider,
        "model": model,
        "source": "",
        "fetchedAt": "",
        "windows": [],
        "details": [],
        "unavailableReason": "No usage data is available for this model yet.",
    }
