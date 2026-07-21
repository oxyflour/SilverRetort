"""Persistent stdio MCP subprocesses used by the remote bridge."""

import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class StdioConfig:
    command: str
    args: tuple[str, ...]
    env: tuple[tuple[str, str], ...]
    cwd: str

    @classmethod
    def from_server(cls, server: dict[str, Any]) -> "StdioConfig":
        return cls(
            command=str(server["command"]),
            args=tuple(str(item) for item in server.get("args", [])),
            env=tuple(
                sorted(
                    (str(key), str(value))
                    for key, value in server.get("env", {}).items()
                )
            ),
            cwd=str(server.get("cwd") or ""),
        )


class StdioMcpProcess:
    def __init__(self, name: str, config: StdioConfig) -> None:
        self.name = name
        self.config = config
        self.process: asyncio.subprocess.Process | None = None
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.write_lock = asyncio.Lock()
        self.reader_task: asyncio.Task[None] | None = None
        self.stderr_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self.process and self.process.returncode is None:
            return
        env = {**os.environ, **dict(self.config.env)}
        cwd = self.config.cwd or None
        if cwd and not Path(cwd).is_dir():
            raise RuntimeError(f"stdio MCP cwd does not exist: {cwd}")
        self.process = await asyncio.create_subprocess_exec(
            self.config.command,
            *self.config.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
        )
        self.reader_task = asyncio.create_task(
            self._read_stdout(), name=f"mcp-stdio-{self.name}"
        )
        self.stderr_task = asyncio.create_task(
            self._read_stderr(), name=f"mcp-stderr-{self.name}"
        )

    async def request(self, message: dict[str, Any]) -> dict[str, Any] | None:
        await self.start()
        if not self.process or not self.process.stdin:
            raise RuntimeError(f"stdio MCP server failed to start: {self.name}")
        request_id = message.get("id")
        key = json.dumps(request_id, ensure_ascii=False) if request_id is not None else ""
        future: asyncio.Future[dict[str, Any]] | None = None
        if key:
            future = asyncio.get_running_loop().create_future()
            if key in self.pending:
                raise RuntimeError(f"duplicate stdio MCP request id: {request_id}")
            self.pending[key] = future
        try:
            encoded = (
                json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode()
                + b"\n"
            )
            async with self.write_lock:
                self.process.stdin.write(encoded)
                await self.process.stdin.drain()
            if future is None:
                return None
            return await asyncio.wait_for(future, timeout=300)
        finally:
            if key:
                self.pending.pop(key, None)

    async def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        try:
            while line := await self.process.stdout.readline():
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(message, dict) or "id" not in message:
                    continue
                key = json.dumps(message["id"], ensure_ascii=False)
                future = self.pending.get(key)
                if future and not future.done():
                    future.set_result(message)
        finally:
            error = RuntimeError(f"stdio MCP server exited: {self.name}")
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(error)

    async def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        while line := await self.process.stderr.readline():
            print(f"[mcp:{self.name}] {line.decode(errors='replace').rstrip()}")

    async def close(self) -> None:
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        for task in (self.reader_task, self.stderr_task):
            if task:
                task.cancel()
        self.process = None


class StdioMcpRegistry:
    def __init__(self) -> None:
        self.processes: dict[str, StdioMcpProcess] = {}
        self.lock = asyncio.Lock()

    async def request(
        self, name: str, server: dict[str, Any], message: dict[str, Any]
    ) -> dict[str, Any] | None:
        config = StdioConfig.from_server(server)
        async with self.lock:
            process = self.processes.get(name)
            if process and process.config != config:
                await process.close()
                process = None
            if process is None:
                process = StdioMcpProcess(name, config)
                self.processes[name] = process
        return await process.request(message)

    async def close(self) -> None:
        for process in list(self.processes.values()):
            await process.close()
        self.processes.clear()


registry = StdioMcpRegistry()
