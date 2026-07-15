from contextlib import asynccontextmanager
import os
import sys
import threading

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

import bridge_client
import db
import mcp_server
from routes import router


def exit_on_stdin_eof() -> None:
    while True:
        chunk = sys.stdin.buffer.read(1)
        if chunk == b"":
            os._exit(0)


@asynccontextmanager
async def lifespan(_: FastAPI):
    watcher = threading.Thread(target=exit_on_stdin_eof, daemon=True)
    watcher.start()
    db.connect()
    bridge_task = bridge_client.start_task()
    try:
        async with mcp_server.mcp.session_manager.run():
            yield
    finally:
        await bridge_client.stop_task(bridge_task)


app = FastAPI(lifespan=lifespan)
app.include_router(router)
app.mount("/mcp", mcp_server.mcp.streamable_http_app())


def frontend_dist() -> str | None:
    path = os.getenv("FRONTEND_DIST", "").strip()
    if not path:
        return None
    index_path = os.path.join(path, "index.html")
    return path if os.path.isfile(index_path) else None


static_frontend = frontend_dist()
if static_frontend:
    next_static = os.path.join(static_frontend, "_next")
    if os.path.isdir(next_static):
        app.mount("/_next", StaticFiles(directory=next_static), name="next-static")
    frontend_assets = os.path.join(static_frontend, "assets")
    if os.path.isdir(frontend_assets):
        app.mount("/assets", StaticFiles(directory=frontend_assets), name="frontend-assets")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/{path:path}", include_in_schema=False)
def serve_frontend(path: str):
    root = frontend_dist()
    if not root:
        raise HTTPException(404, "frontend is not bundled")
    requested = os.path.abspath(os.path.join(root, path))
    root_abs = os.path.abspath(root)
    if path and requested.startswith(root_abs + os.sep) and os.path.isfile(requested):
        return FileResponse(requested)
    return FileResponse(os.path.join(root, "index.html"))


def main() -> None:
    port = int(os.getenv("LISTEN_PORT", "23001"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level=os.getenv("LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
