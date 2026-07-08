"""SQLite 持久化：sessions / messages / files / artifacts。

桌面单用户场景，stdlib sqlite3 + 全局锁足够；所有 JSON 列存 camelCase wire 格式。
"""

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

from models import Artifact, Attachment, Message, Session

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def data_dir() -> Path:
    path = Path(os.getenv("DATA_DIR", Path(__file__).parent / "data"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def files_dir() -> Path:
    path = data_dir() / "files"
    path.mkdir(parents=True, exist_ok=True)
    return path


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
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
        _conn.commit()
    return _conn


def _execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    with _lock:
        cursor = connect().execute(sql, params)
        connect().commit()
        return cursor


def _query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return connect().execute(sql, params).fetchall()


# ---- sessions ----

def _row_to_session(row: sqlite3.Row) -> Session:
    return Session(id=row["id"], title=row["title"], created_at=row["created_at"], updated_at=row["updated_at"])


def list_sessions() -> list[Session]:
    return [_row_to_session(r) for r in _query("SELECT * FROM sessions ORDER BY updated_at DESC")]


def get_session(session_id: str) -> Session | None:
    rows = _query("SELECT * FROM sessions WHERE id = ?", (session_id,))
    return _row_to_session(rows[0]) if rows else None


def create_session(session_id: str, title: str) -> Session:
    now = now_iso()
    _execute(
        "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (session_id, title, now, now),
    )
    return Session(id=session_id, title=title, created_at=now, updated_at=now)


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
            json.dumps([p.model_dump(by_alias=True) for p in message.parts], ensure_ascii=False),
            json.dumps([a.model_dump(by_alias=True) for a in message.attachments], ensure_ascii=False),
            json.dumps(message.artifact_ids, ensure_ascii=False),
            message.status,
            message.created_at,
        ),
    )


def update_message(message: Message) -> None:
    _execute(
        "UPDATE messages SET parts = ?, artifact_ids = ?, status = ? WHERE id = ?",
        (
            json.dumps([p.model_dump(by_alias=True) for p in message.parts], ensure_ascii=False),
            json.dumps(message.artifact_ids, ensure_ascii=False),
            message.status,
            message.id,
        ),
    )


# ---- files ----

def insert_file(attachment: Attachment, path: str) -> None:
    _execute(
        "INSERT INTO files (id, name, mime_type, size, kind, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (attachment.id, attachment.name, attachment.mime_type, attachment.size, attachment.kind, path, now_iso()),
    )


def get_file(file_id: str) -> tuple[Attachment, str] | None:
    rows = _query("SELECT * FROM files WHERE id = ?", (file_id,))
    if not rows:
        return None
    row = rows[0]
    attachment = Attachment(
        id=row["id"], name=row["name"], mime_type=row["mime_type"], size=row["size"], kind=row["kind"]
    )
    return attachment, row["path"]


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
