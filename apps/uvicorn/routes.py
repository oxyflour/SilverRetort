"""REST API and event routes."""

import asyncio
import json
import mimetypes
import os
import re
import threading
from contextlib import suppress
from pathlib import Path, PurePosixPath
import uuid
from urllib.parse import quote, unquote, urlparse
from urllib.request import url2pathname

import httpx
from fastapi import APIRouter
from fastapi import Body, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from sse_starlette.sse import EventSourceResponse
from websockets.asyncio.client import connect

import artifact_contexts
import db
import events
import mcp_server
import runs
import switch_profiles
import workspace_service
from api_routes import artifacts, chat, files, hermes, managed_mcp, proxy, system, workspaces
from api_routes.artifacts import (
    _artifact_content_headers,
    _workspace_file_response,
    _workspace_port_payload_target,
    clear_artifact_context,
    get_artifact,
    get_artifact_content,
    list_artifact_contexts,
    list_artifacts,
    options_artifact_content,
    set_artifact_context,
)
from api_routes.chat import restart_message, send_chat, stop_run
from api_routes.common import (
    DEFAULT_TITLE,
    TOOL_SUMMARY_LIMIT,
    _auto_title,
    _engine_from_context,
    _models_response,
    _require_engine_method,
    _require_hermes_method,
    _workspace_id_from_context,
    _workspace_response,
    engine,
)
from api_routes.files import _resolve_local_image_path, get_file, get_local_image, list_workspace_files, upload_file
from api_routes.hermes import (
    MCP_LOOPBACK_HOSTS,
    MCP_SERVER_NAME_RE,
    _data_dir,
    _desktop_settings_path,
    _hermes_connection_response,
    _mcp_server_response,
    _mcp_servers_from_body,
    _read_desktop_settings,
    _validate_mcp_url,
    _write_desktop_settings,
    create_switch_profile,
    delete_switch_profile,
    hermes_connection,
    hermes_default_model,
    hermes_mcp_servers,
    hermes_models,
    hermes_slash_commands,
    hermes_usage,
    hermes_vision_model,
    list_switch_profiles,
    set_hermes_connection,
    set_hermes_default_model,
    set_hermes_mcp_servers,
    set_hermes_vision_model,
    update_switch_profile,
)
from api_routes.proxy import (
    HOP_BY_HOP_HEADERS,
    HTTP_METHODS,
    _browser_to_remote,
    _filter_proxy_headers,
    _proxy_workspace_port_http,
    _proxy_workspace_port_websocket,
    _remote_auth_headers,
    _remote_auth_headers_for_workspace,
    _remote_to_browser,
    _stream_remote_proxy_response,
    _validate_workspace_proxy_request,
)
from api_routes.system import event_stream, restart_app
from api_routes.workspaces import (
    _compact_message,
    create_session,
    create_workspace,
    delete_session,
    delete_workspace,
    get_message_tool,
    get_session_model,
    list_messages,
    list_sessions,
    list_workspaces,
    list_workspace_templates,
    rename_session,
    rename_workspace,
    search_messages,
    set_session_model,
)
from engines import create_engine, create_engine_for_workspace
from models import (
    ApiModel,
    Artifact,
    ArtifactContext,
    ArtifactContextUpdateRequest,
    Attachment,
    CreateSessionRequest,
    CreateSwitchProfileRequest,
    CreateWorkspaceRequest,
    HermesModel,
    HermesModelsResponse,
    HermesUsageResponse,
    Message,
    MessageSearchResponse,
    ModelSetting,
    RestartMessageRequest,
    SendChatRequest,
    SendChatResponse,
    Session,
    SessionModel,
    SetModelRequest,
    SlashCommand,
    SwitchProfile,
    TextPart,
    ToolCall,
    UpdateSessionRequest,
    UpdateSwitchProfileRequest,
    UpdateWorkspaceRequest,
    Workspace,
    WorkspaceTemplate,
)

router = APIRouter(prefix="/api")
for route_module in (hermes, managed_mcp, system, workspaces, artifacts, proxy, chat, files):
    router.include_router(route_module.router)
