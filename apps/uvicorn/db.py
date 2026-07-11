"""SQLite 持久化：sessions / messages / files / artifacts。

桌面单用户场景，stdlib sqlite3 + 全局锁足够；所有 JSON 列存 camelCase wire 格式。
"""

import json
import os
import shutil
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from models import Artifact, Attachment, Message, Session, TextPart, Workspace

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


class MessageRestartNotAllowedError(ValueError):
    pass


class MessageRestartNotFoundError(LookupError):
    pass


@dataclass
class RestartMessageResult:
    history: list[Message]
    user_message: Message
    old_text: str
    was_first_user_message: bool


def data_dir() -> Path:
    path = Path(os.getenv("DATA_DIR", Path(__file__).parent / "data"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    parts TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    artifact_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'complete',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT 'null',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);
"""


def connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(data_dir() / "silverretort.db", check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript(_SCHEMA)
        _migrate(_conn)
        _conn.commit()
    return _conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _migrate(conn: sqlite3.Connection) -> None:
    now = now_iso()
    default_id = "default"
    conn.execute(
        "INSERT OR IGNORE INTO workspaces (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
        (default_id, "默认工作区", now, now),
    )
    if "workspace_id" not in _columns(conn, "sessions"):
        conn.execute("ALTER TABLE sessions ADD COLUMN workspace_id TEXT")
    conn.execute("UPDATE sessions SET workspace_id = ? WHERE workspace_id IS NULL OR workspace_id = ''", (default_id,))
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at)")
    conn.execute("DROP TABLE IF EXISTS files")
    for row in conn.execute("SELECT id, attachments FROM messages WHERE attachments != '[]'").fetchall():
        attachments = json.loads(row["attachments"])
        changed = False
        for attachment in attachments:
            if "id" in attachment:
                attachment.pop("id", None)
                changed = True
            if "workspaceId" not in attachment:
                attachment["workspaceId"] = default_id
                attachment["relativePath"] = attachment.get("name") or attachment.get("id")
                changed = True
        if changed:
            conn.execute(
                "UPDATE messages SET attachments = ? WHERE id = ?",
                (json.dumps(attachments, ensure_ascii=False), row["id"]),
            )
    legacy_files = data_dir() / "files"
    if legacy_files.is_dir():
        shutil.rmtree(legacy_files)


def _execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    with _lock:
        cursor = connect().execute(sql, params)
        connect().commit()
        return cursor


def _query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return connect().execute(sql, params).fetchall()


def _dump_parts(message: Message) -> str:
    return json.dumps([part.model_dump(by_alias=True) for part in message.parts], ensure_ascii=False)


def _dump_attachments(message: Message) -> str:
    return json.dumps([attachment.model_dump(by_alias=True) for attachment in message.attachments], ensure_ascii=False)


def _dump_string_list(values: list[str]) -> str:
    return json.dumps(values, ensure_ascii=False)


def _message_text(message: Message) -> str:
    return "".join(part.text for part in message.parts if getattr(part, "type", None) == "text")


def _delete_messages_by_ids(conn: sqlite3.Connection, message_ids: list[str]) -> None:
    if not message_ids:
        return
    placeholders = ",".join("?" for _ in message_ids)
    conn.execute(f"DELETE FROM messages WHERE id IN ({placeholders})", tuple(message_ids))


def _delete_artifacts_by_ids(conn: sqlite3.Connection, artifact_ids: list[str]) -> None:
    if not artifact_ids:
        return
    placeholders = ",".join("?" for _ in artifact_ids)
    conn.execute(f"DELETE FROM artifacts WHERE id IN ({placeholders})", tuple(artifact_ids))


# ---- sessions ----

def _row_to_workspace(row: sqlite3.Row) -> Workspace:
    return Workspace(
        id=row["id"], name=row["name"], status=row["status"],
        created_at=row["created_at"], updated_at=row["updated_at"],
    )


def list_workspaces() -> list[Workspace]:
    return [_row_to_workspace(row) for row in _query("SELECT * FROM workspaces ORDER BY updated_at DESC")]


def get_workspace(workspace_id: str) -> Workspace | None:
    rows = _query("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
    return _row_to_workspace(rows[0]) if rows else None


def create_workspace(workspace_id: str, name: str, status: str = "active") -> Workspace:
    now = now_iso()
    _execute(
        "INSERT INTO workspaces (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (workspace_id, name, status, now, now),
    )
    return get_workspace(workspace_id)  # type: ignore[return-value]


def rename_workspace(workspace_id: str, name: str) -> Workspace | None:
    _execute("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?", (name, now_iso(), workspace_id))
    return get_workspace(workspace_id)


def set_workspace_status(workspace_id: str, status: str) -> None:
    _execute("UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?", (status, now_iso(), workspace_id))


def delete_workspace(workspace_id: str) -> None:
    with _lock:
        conn = connect()
        session_rows = conn.execute("SELECT id FROM sessions WHERE workspace_id = ?", (workspace_id,)).fetchall()
        session_ids = [str(row["id"]) for row in session_rows]
        if session_ids:
            placeholders = ",".join("?" for _ in session_ids)
            conn.execute(f"DELETE FROM messages WHERE session_id IN ({placeholders})", tuple(session_ids))
            conn.execute(f"DELETE FROM artifacts WHERE session_id IN ({placeholders})", tuple(session_ids))
        conn.execute("DELETE FROM sessions WHERE workspace_id = ?", (workspace_id,))
        conn.execute("DELETE FROM workspaces WHERE id = ?", (workspace_id,))
        conn.commit()

def _row_to_session(row: sqlite3.Row) -> Session:
    return Session(id=row["id"], workspace_id=row["workspace_id"], title=row["title"], created_at=row["created_at"], updated_at=row["updated_at"])


def list_sessions() -> list[Session]:
    return [_row_to_session(r) for r in _query("SELECT * FROM sessions ORDER BY updated_at DESC")]


def get_session(session_id: str) -> Session | None:
    rows = _query("SELECT * FROM sessions WHERE id = ?", (session_id,))
    return _row_to_session(rows[0]) if rows else None


def create_session(session_id: str, workspace_id: str, title: str) -> Session:
    now = now_iso()
    _execute(
        "INSERT INTO sessions (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        (session_id, workspace_id, title, now, now),
    )
    return Session(id=session_id, workspace_id=workspace_id, title=title, created_at=now, updated_at=now)


def rename_session(session_id: str, title: str) -> Session | None:
    _execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", (title, now_iso(), session_id))
    return get_session(session_id)


def touch_session(session_id: str) -> None:
    _execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now_iso(), session_id))


def delete_session(session_id: str) -> None:
    _execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    _execute("DELETE FROM artifacts WHERE session_id = ?", (session_id,))
    _execute("DELETE FROM sessions WHERE id = ?", (session_id,))


# ---- messages ----

def _row_to_message(row: sqlite3.Row) -> Message:
    return Message(
        id=row["id"],
        session_id=row["session_id"],
        role=row["role"],
        parts=json.loads(row["parts"]),
        attachments=json.loads(row["attachments"]),
        artifact_ids=json.loads(row["artifact_ids"]),
        status=row["status"],
        created_at=row["created_at"],
    )


def list_messages(session_id: str) -> list[Message]:
    return [
        _row_to_message(r)
        for r in _query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid", (session_id,))
    ]


def insert_message(message: Message) -> None:
    _execute(
        "INSERT INTO messages (id, session_id, role, parts, attachments, artifact_ids, status, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            message.id,
            message.session_id,
            message.role,
            _dump_parts(message),
            _dump_attachments(message),
            _dump_string_list(message.artifact_ids),
            message.status,
            message.created_at,
        ),
    )


def update_message(message: Message) -> None:
    _execute(
        "UPDATE messages SET parts = ?, artifact_ids = ?, status = ? WHERE id = ?",
        (
            _dump_parts(message),
            _dump_string_list(message.artifact_ids),
            message.status,
            message.id,
        ),
    )


def restart_message(session_id: str, message_id: str, text: str) -> RestartMessageResult:
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT rowid, * FROM messages WHERE session_id = ? ORDER BY created_at, rowid",
                (session_id,),
            ).fetchall()
            messages = [_row_to_message(row) for row in rows]

            target_index = next((index for index, row in enumerate(rows) if row["id"] == message_id), None)
            if target_index is None:
                raise MessageRestartNotFoundError("message not found")

            target_message = messages[target_index]
            if target_message.role != "user":
                raise MessageRestartNotAllowedError("only user messages can be restarted")

            history = messages[:target_index]
            first_user_index = next(
                (index for index, message in enumerate(messages) if message.role == "user"),
                None,
            )
            old_text = _message_text(target_message)

            target_message.parts = [TextPart(text=text)]
            target_message.artifact_ids = []
            target_message.status = "complete"

            trailing_messages = messages[target_index + 1 :]
            trailing_message_ids = [message.id for message in trailing_messages]
            trailing_artifact_ids = sorted(
                {
                    artifact_id
                    for message in trailing_messages
                    for artifact_id in message.artifact_ids
                }
            )

            conn.execute(
                "UPDATE messages SET parts = ?, artifact_ids = ?, status = ? WHERE id = ?",
                (
                    _dump_parts(target_message),
                    _dump_string_list(target_message.artifact_ids),
                    target_message.status,
                    target_message.id,
                ),
            )
            _delete_messages_by_ids(conn, trailing_message_ids)
            _delete_artifacts_by_ids(conn, trailing_artifact_ids)
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    return RestartMessageResult(
        history=history,
        user_message=target_message,
        old_text=old_text,
        was_first_user_message=target_index == first_user_index,
    )


# ---- artifacts ----

def _row_to_artifact(row: sqlite3.Row) -> Artifact:
    return Artifact(
        id=row["id"],
        session_id=row["session_id"],
        type=row["type"],
        title=row["title"],
        payload=json.loads(row["payload"]),
        created_at=row["created_at"],
    )


def list_artifacts(session_id: str) -> list[Artifact]:
    return [
        _row_to_artifact(r)
        for r in _query("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at, rowid", (session_id,))
    ]


def get_artifact(artifact_id: str) -> Artifact | None:
    rows = _query("SELECT * FROM artifacts WHERE id = ?", (artifact_id,))
    return _row_to_artifact(rows[0]) if rows else None


def upsert_artifact(artifact: Artifact) -> None:
    _execute(
        "INSERT INTO artifacts (id, session_id, type, title, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title, payload = excluded.payload",
        (
            artifact.id,
            artifact.session_id,
            artifact.type,
            artifact.title,
            json.dumps(artifact.payload, ensure_ascii=False),
            artifact.created_at,
        ),
    )
