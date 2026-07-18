"""Workspace-to-Switch connection profile resolution."""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from secret_store import SecretStoreError, decrypt_secret, encrypt_secret

LOCAL_PROFILE_ID = "local"
LEGACY_REMOTE_PROFILE_ID = "default-remote"


@dataclass(frozen=True)
class SwitchProfile:
    id: str
    name: str
    mode: Literal["local", "remote"]
    switch_url: str = ""
    has_hermes_api_key: bool = False


@dataclass(frozen=True)
class SwitchConnection:
    profile_id: str
    mode: Literal["local", "remote", "mock"]
    switch_url: str = ""
    api_key: str = ""
    local_workspaces_dir: str = ""


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
    return _migrate_legacy_settings(payload) if isinstance(payload, dict) else {}


def _write_settings(settings: dict[str, Any]) -> None:
    _settings_path().write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", "utf-8")


def _remote_profiles(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = settings.get("switchProfiles")
    if isinstance(raw, dict):
        return {str(key): value for key, value in raw.items() if isinstance(value, dict)}
    return {}


def _migrate_legacy_settings(settings: dict[str, Any]) -> dict[str, Any]:
    legacy_keys = {"switchUrl", "hermesUrl", "hermesApiKey", "encryptedHermesApiKey"}
    if not any(key in settings for key in legacy_keys):
        return settings

    switch_url = str(settings.get("switchUrl") or settings.get("hermesUrl") or "").strip().rstrip("/")
    if not switch_url:
        return settings

    profiles = _remote_profiles(settings)
    raw = profiles.get(LEGACY_REMOTE_PROFILE_ID)
    profile = dict(raw) if isinstance(raw, dict) else {}
    profile["name"] = str(profile.get("name") or "Default remote")
    profile["mode"] = "remote"
    profile["switchUrl"] = str(profile.get("switchUrl") or switch_url).strip().rstrip("/")

    encrypted = str(profile.get("encryptedHermesApiKey") or "")
    legacy_encrypted = str(settings.get("encryptedHermesApiKey") or "")
    legacy_plaintext = str(settings.get("hermesApiKey") or "").strip()
    try:
        if not encrypted and legacy_encrypted:
            profile["encryptedHermesApiKey"] = legacy_encrypted
        elif not encrypted and legacy_plaintext:
            profile["encryptedHermesApiKey"] = encrypt_secret(legacy_plaintext)
    except SecretStoreError:
        return settings

    migrated = dict(settings)
    profiles[LEGACY_REMOTE_PROFILE_ID] = profile
    migrated["switchProfiles"] = profiles
    migrated.setdefault("defaultSwitchProfileId", LEGACY_REMOTE_PROFILE_ID)
    for key in legacy_keys:
        migrated.pop(key, None)
    _write_settings(migrated)
    return migrated


def _legacy_remote(settings: dict[str, Any]) -> dict[str, Any] | None:
    switch_url = str(settings.get("switchUrl") or settings.get("hermesUrl") or "").strip().rstrip("/")
    if not switch_url:
        return None
    encrypted = str(settings.get("encryptedHermesApiKey") or "")
    legacy_key = str(settings.get("hermesApiKey") or "")
    return {
        "name": "Default remote",
        "mode": "remote",
        "switchUrl": switch_url,
        "encryptedHermesApiKey": encrypted,
        "hasLegacyHermesApiKey": bool(legacy_key),
    }


def _profile_from_raw(profile_id: str, raw: dict[str, Any]) -> SwitchProfile | None:
    mode = str(raw.get("mode") or "remote")
    if mode != "remote":
        return None
    switch_url = str(raw.get("switchUrl") or "").strip().rstrip("/")
    if not switch_url:
        return None
    encrypted = str(raw.get("encryptedHermesApiKey") or "")
    return SwitchProfile(
        id=profile_id,
        name=str(raw.get("name") or "Remote"),
        mode="remote",
        switch_url=switch_url,
        has_hermes_api_key=bool(encrypted or raw.get("hasLegacyHermesApiKey")),
    )


def list_profiles() -> list[SwitchProfile]:
    settings = _read_settings()
    profiles = [
        SwitchProfile(
            id=LOCAL_PROFILE_ID,
            name="Local",
            mode="local",
            has_hermes_api_key=bool(os.getenv("HERMES_API_KEY", "").strip()),
        )
    ]
    for profile_id, raw in sorted(_remote_profiles(settings).items()):
        profile = _profile_from_raw(profile_id, raw)
        if profile is not None:
            profiles.append(profile)
    legacy = _legacy_remote(settings)
    if legacy and LEGACY_REMOTE_PROFILE_ID not in {profile.id for profile in profiles}:
        profile = _profile_from_raw(LEGACY_REMOTE_PROFILE_ID, legacy)
        if profile is not None:
            profiles.append(profile)
    return profiles


def get_profile(profile_id: str | None) -> SwitchProfile | None:
    resolved_id = profile_id or default_profile_id()
    return next((profile for profile in list_profiles() if profile.id == resolved_id), None)


def default_profile_id() -> str:
    settings = _read_settings()
    configured = str(settings.get("defaultSwitchProfileId") or "")
    if configured and get_profile(configured) is not None:
        return configured
    if _legacy_remote(settings):
        return LEGACY_REMOTE_PROFILE_ID
    runtime_mode = os.getenv("SILVERRETORT_HERMES_MODE")
    if runtime_mode == "remote" and os.getenv("HERMES_URL"):
        return LEGACY_REMOTE_PROFILE_ID
    return LOCAL_PROFILE_ID


def _api_key_from_raw(raw: dict[str, Any]) -> str:
    encrypted = str(raw.get("encryptedHermesApiKey") or "")
    if encrypted:
        return decrypt_secret(encrypted)
    return str(raw.get("hermesApiKey") or "")


def connection_for_profile(profile_id: str | None) -> SwitchConnection:
    resolved_id = profile_id or default_profile_id()
    if resolved_id == LOCAL_PROFILE_ID:
        base_url = os.getenv("HERMES_URL", "").strip().rstrip("/")
        api_key = os.getenv("HERMES_API_KEY", "").strip()
        if base_url:
            return SwitchConnection(
                profile_id=LOCAL_PROFILE_ID,
                mode="local",
                switch_url=base_url,
                api_key=api_key,
                local_workspaces_dir=os.getenv("LOCAL_HERMES_WORKSPACES_DIR", "").strip(),
            )
        return SwitchConnection(profile_id=LOCAL_PROFILE_ID, mode="mock")

    settings = _read_settings()
    raw = _remote_profiles(settings).get(resolved_id)
    if raw is None and resolved_id == LEGACY_REMOTE_PROFILE_ID:
        raw = _legacy_remote(settings)
        if raw is not None and raw.get("hasLegacyHermesApiKey"):
            raw = {**raw, "hermesApiKey": str(settings.get("hermesApiKey") or "")}
    if not isinstance(raw, dict):
        raise KeyError(f"switch profile not found: {resolved_id}")
    switch_url = str(raw.get("switchUrl") or "").strip().rstrip("/")
    if not switch_url:
        raise ValueError("switchUrl is required")
    return SwitchConnection(
        profile_id=resolved_id,
        mode="remote",
        switch_url=switch_url,
        api_key=_api_key_from_raw(raw),
    )


def list_remote_connections() -> list[SwitchConnection]:
    connections: list[SwitchConnection] = []
    seen: set[tuple[str, str]] = set()
    for profile in list_profiles():
        if profile.mode != "remote":
            continue
        try:
            connection = connection_for_profile(profile.id)
        except Exception:
            continue
        key = (connection.switch_url, connection.api_key)
        if key not in seen:
            seen.add(key)
            connections.append(connection)
    return connections


def create_profile(name: str, switch_url: str, api_key: str) -> SwitchProfile:
    clean_name = name.strip() or "Remote"
    clean_url = switch_url.strip().rstrip("/")
    if not clean_url:
        raise ValueError("switchUrl is required")
    if not api_key.strip():
        raise ValueError("hermesApiKey is required")
    settings = _read_settings()
    profiles = _remote_profiles(settings)
    profile_id = uuid.uuid4().hex
    profiles[profile_id] = {
        "name": clean_name,
        "mode": "remote",
        "switchUrl": clean_url,
        "encryptedHermesApiKey": encrypt_secret(api_key.strip()),
    }
    settings["switchProfiles"] = profiles
    settings.setdefault("defaultSwitchProfileId", profile_id)
    _write_settings(settings)
    return get_profile(profile_id)  # type: ignore[return-value]


def set_default_remote_profile(switch_url: str, api_key: str | None) -> SwitchProfile:
    clean_url = switch_url.strip().rstrip("/")
    if not clean_url:
        raise ValueError("switchUrl is required")
    settings = _read_settings()
    profiles = _remote_profiles(settings)
    raw = profiles.get(LEGACY_REMOTE_PROFILE_ID)
    profile = dict(raw) if isinstance(raw, dict) else {}
    profile["name"] = str(profile.get("name") or "Default remote")
    profile["mode"] = "remote"
    profile["switchUrl"] = clean_url
    if api_key is not None and api_key.strip():
        profile["encryptedHermesApiKey"] = encrypt_secret(api_key.strip())
    elif not str(profile.get("encryptedHermesApiKey") or ""):
        raise ValueError("hermesApiKey is required")
    profiles[LEGACY_REMOTE_PROFILE_ID] = profile
    settings["switchProfiles"] = profiles
    settings["defaultSwitchProfileId"] = LEGACY_REMOTE_PROFILE_ID
    for key in ("switchUrl", "hermesUrl", "hermesApiKey", "encryptedHermesApiKey"):
        settings.pop(key, None)
    _write_settings(settings)
    return get_profile(LEGACY_REMOTE_PROFILE_ID)  # type: ignore[return-value]


def set_default_local_profile() -> None:
    settings = _read_settings()
    settings["defaultSwitchProfileId"] = LOCAL_PROFILE_ID
    for key in ("switchUrl", "hermesUrl", "hermesApiKey", "encryptedHermesApiKey"):
        settings.pop(key, None)
    _write_settings(settings)


def update_profile(profile_id: str, name: str, switch_url: str, api_key: str | None) -> SwitchProfile:
    if profile_id == LOCAL_PROFILE_ID:
        raise ValueError("built-in switch profile cannot be edited here")
    settings = _read_settings()
    profiles = _remote_profiles(settings)
    raw = profiles.get(profile_id)
    if not isinstance(raw, dict):
        raise KeyError(f"switch profile not found: {profile_id}")
    clean_url = switch_url.strip().rstrip("/")
    if not clean_url:
        raise ValueError("switchUrl is required")
    raw["name"] = name.strip() or "Remote"
    raw["mode"] = "remote"
    raw["switchUrl"] = clean_url
    if api_key is not None and api_key.strip():
        raw["encryptedHermesApiKey"] = encrypt_secret(api_key.strip())
    profiles[profile_id] = raw
    settings["switchProfiles"] = profiles
    _write_settings(settings)
    return get_profile(profile_id)  # type: ignore[return-value]


def delete_profile(profile_id: str) -> None:
    if profile_id == LOCAL_PROFILE_ID:
        raise ValueError("built-in switch profile cannot be deleted")
    settings = _read_settings()
    profiles = _remote_profiles(settings)
    if profile_id not in profiles:
        raise KeyError(f"switch profile not found: {profile_id}")
    profiles.pop(profile_id, None)
    workspace_profiles = settings.get("workspaceSwitchProfiles")
    if isinstance(workspace_profiles, dict):
        settings["workspaceSwitchProfiles"] = {
            str(workspace_id): str(current_profile_id)
            for workspace_id, current_profile_id in workspace_profiles.items()
            if str(current_profile_id) != profile_id
        }
    if settings.get("defaultSwitchProfileId") == profile_id:
        settings["defaultSwitchProfileId"] = LOCAL_PROFILE_ID
    settings["switchProfiles"] = profiles
    _write_settings(settings)


def profile_response(profile: SwitchProfile) -> dict[str, Any]:
    return {
        "id": profile.id,
        "name": profile.name,
        "mode": profile.mode,
        "switchUrl": profile.switch_url,
        "hasHermesApiKey": profile.has_hermes_api_key,
    }


def workspace_profile_id(workspace_id: str, db_connection_id: str | None = None) -> str:
    if db_connection_id:
        return db_connection_id
    settings = _read_settings()
    raw = settings.get("workspaceSwitchProfiles")
    if isinstance(raw, dict):
        profile_id = str(raw.get(workspace_id) or "")
        if profile_id and get_profile(profile_id) is not None:
            return profile_id
    return default_profile_id()


def workspace_summary(workspace_id: str, db_connection_id: str | None = None) -> dict[str, Any]:
    profile_id = workspace_profile_id(workspace_id, db_connection_id)
    profile = get_profile(profile_id) or get_profile(LOCAL_PROFILE_ID)
    if profile is None:
        return {
            "connectionId": LOCAL_PROFILE_ID,
            "switchMode": "local",
            "switchUrl": "",
            "hasHermesApiKey": False,
        }
    return {
        "connectionId": profile.id,
        "switchMode": profile.mode,
        "switchUrl": profile.switch_url,
        "hasHermesApiKey": profile.has_hermes_api_key,
    }


def secret_error_message(exc: Exception) -> str:
    if isinstance(exc, SecretStoreError):
        return str(exc)
    return str(exc)
