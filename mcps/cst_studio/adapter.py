"""MCP adapter for controlling a local CST Studio Suite instance."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI
from mcp.server.fastmcp import FastMCP

MCP_NAME = "cst_studio"

mcp = FastMCP(MCP_NAME, stateless_http=True, streamable_http_path="/")
_application: Any | None = None
_project: Any | None = None


def _config() -> dict[str, Any]:
    try:
        payload = json.loads(os.getenv("SILVERRETORT_MANAGED_MCP_CONFIG", "{}"))
    except json.JSONDecodeError:
        payload = {}
    return payload if isinstance(payload, dict) else {}


def _error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def _ok(**payload: Any) -> dict[str, Any]:
    return {"ok": True, **payload}


def _win32_client() -> Any:
    try:
        import win32com.client  # type: ignore[import-not-found]
    except Exception as exc:
        raise RuntimeError("pywin32 is not available; install the CST COM adapter dependency") from exc
    return win32com.client


def _connect_application(start_if_missing: bool = True) -> Any:
    global _application
    if _application is not None:
        return _application

    config = _config()
    win32com = _win32_client()
    attach_existing = bool(config.get("attachExisting", True))
    if attach_existing:
        try:
            _application = win32com.GetActiveObject("CSTStudio.Application")
            return _application
        except Exception:
            pass

    if not start_if_missing:
        raise RuntimeError("CST Studio is not running")
    executable = str(config.get("cstExecutablePath") or "").strip()
    if executable:
        path = Path(executable).expanduser()
        if not path.exists():
            raise RuntimeError(f"configured CST executable does not exist: {path}")
        subprocess.Popen([str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(20):
            time.sleep(0.5)
            try:
                _application = win32com.GetActiveObject("CSTStudio.Application")
                return _application
            except Exception:
                continue
    try:
        _application = win32com.Dispatch("CSTStudio.Application")
        return _application
    except Exception as exc:
        raise RuntimeError("CST Studio COM automation is unavailable") from exc


def _allowed_roots() -> list[Path]:
    roots = _config().get("allowedProjectRoots")
    if not isinstance(roots, list):
        return []
    return [Path(str(root)).expanduser().resolve() for root in roots if str(root).strip()]


def _is_allowed_path(path: Path) -> bool:
    roots = _allowed_roots()
    if not roots:
        return True
    try:
        resolved = path.expanduser().resolve()
    except OSError:
        return False
    return any(resolved == root or root in resolved.parents for root in roots)


def _current_project() -> Any:
    if _project is None:
        raise RuntimeError("no CST project is open through this adapter")
    return _project


@mcp.tool()
def cst_status() -> dict[str, Any]:
    """Return CST adapter and COM availability status."""
    try:
        app = _connect_application(start_if_missing=False)
        return _ok(connected=True, application=str(app))
    except RuntimeError as exc:
        message = str(exc)
        code = "com_unavailable" if "pywin32" in message or "COM" in message else "cst_not_running"
        return _error(code, message)
    except Exception as exc:
        return _error("cst_status_failed", str(exc))


@mcp.tool()
def cst_open_project(path: str) -> dict[str, Any]:
    """Open a CST project file if it is inside the configured allowed roots."""
    global _project
    project_path = Path(path).expanduser()
    if not _is_allowed_path(project_path):
        return _error("project_outside_allowed_roots", "project path is outside allowedProjectRoots")
    if not project_path.exists():
        return _error("project_not_found", f"project file not found: {project_path}")
    try:
        app = _connect_application(start_if_missing=True)
        _project = app.OpenFile(str(project_path.resolve()))
        return _ok(path=str(project_path.resolve()))
    except RuntimeError as exc:
        return _error("com_unavailable", str(exc))
    except Exception as exc:
        return _error("open_project_failed", str(exc))


@mcp.tool()
def cst_save_project() -> dict[str, Any]:
    """Save the current CST project."""
    try:
        project = _current_project()
        project.Save()
        return _ok()
    except RuntimeError as exc:
        return _error("no_project", str(exc))
    except Exception as exc:
        return _error("save_project_failed", str(exc))


@mcp.tool()
def cst_set_parameter(name: str, value: str) -> dict[str, Any]:
    """Set a CST project parameter and rebuild the model."""
    try:
        project = _current_project()
        project.StoreParameter(str(name), str(value))
        project.Rebuild()
        return _ok(name=name, value=value)
    except RuntimeError as exc:
        return _error("no_project", str(exc))
    except Exception as exc:
        return _error("set_parameter_failed", str(exc))


@mcp.tool()
def cst_get_parameter(name: str) -> dict[str, Any]:
    """Read a CST project parameter."""
    try:
        project = _current_project()
        value = project.GetParameterNValue(str(name))
        return _ok(name=name, value=str(value))
    except RuntimeError as exc:
        return _error("no_project", str(exc))
    except Exception as exc:
        return _error("get_parameter_failed", str(exc))


@mcp.tool()
def cst_run_vba_macro(code: str) -> dict[str, Any]:
    """Run a VBA macro in CST when macro execution is explicitly enabled."""
    if not bool(_config().get("allowMacroExecution", False)):
        return _error("macro_execution_disabled", "allowMacroExecution is disabled")
    try:
        project = _current_project()
        project.AddToHistory("SilverRetort MCP macro", str(code))
        return _ok()
    except RuntimeError as exc:
        return _error("no_project", str(exc))
    except Exception as exc:
        return _error("macro_failed", str(exc))


@mcp.tool()
def cst_start_solver() -> dict[str, Any]:
    """Start the CST solver for the current project."""
    try:
        project = _current_project()
        solver = project.Solver()
        solver.Start()
        return _ok()
    except RuntimeError as exc:
        return _error("no_project", str(exc))
    except Exception as exc:
        return _error("solver_failed", str(exc))


@mcp.tool()
def cst_export_result(result_path: str, output_path: str) -> dict[str, Any]:
    """Export a selected CST result item to an allowed local output path."""
    target = Path(output_path).expanduser()
    if not _is_allowed_path(target):
        return _error("export_outside_allowed_roots", "output path is outside allowedProjectRoots")
    try:
        project = _current_project()
        project.SelectTreeItem(str(result_path))
        export = project.ASCIIExport()
        export.Reset()
        export.FileName(str(target.resolve()))
        export.Execute()
        return _ok(outputPath=str(target.resolve()))
    except RuntimeError as exc:
        return _error("no_project", str(exc))
    except Exception as exc:
        return _error("export_failed", str(exc))


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        async with mcp.session_manager.run():
            yield

    app = FastAPI(lifespan=lifespan)
    app.mount("/mcp", mcp.streamable_http_app())

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "name": MCP_NAME}

    return app


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args(argv)
    uvicorn.run(create_app(), host="127.0.0.1", port=args.port, log_level=os.getenv("LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
