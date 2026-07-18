from contextlib import asynccontextmanager
import os
import sys
import threading

from fastapi import FastAPI
import uvicorn

import bridge_client
from artifact_bridge import artifact_bridge_response
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
    bridge_tasks = bridge_client.start_tasks()
    try:
        async with mcp_server.mcp.session_manager.run():
            yield
    finally:
        await bridge_client.stop_tasks(bridge_tasks)


app = FastAPI(lifespan=lifespan)
app.include_router(router)
app.mount("/mcp", mcp_server.mcp.streamable_http_app())


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/artifact-bridge-v1.js")
def artifact_bridge():
    return artifact_bridge_response()


def main() -> None:
    port = int(os.getenv("LISTEN_PORT", "23001"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level=os.getenv("LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
