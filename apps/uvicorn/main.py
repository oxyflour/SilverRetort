from contextlib import asynccontextmanager
import os
import sys
import threading

from fastapi import FastAPI
import uvicorn

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
    async with mcp_server.mcp.session_manager.run():
        yield


app = FastAPI(lifespan=lifespan)
app.include_router(router)
app.mount("/mcp", mcp_server.mcp.streamable_http_app())


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def main() -> None:
    port = int(os.getenv("LISTEN_PORT", "23001"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level=os.getenv("LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
