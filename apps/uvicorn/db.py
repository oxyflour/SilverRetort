"""SQLite persistence for sessions, messages, artifacts, and workspaces."""

import json
import os
import shutil
import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from models import (
    Artifact,
    ArtifactContext,
    ArtifactContextPart,
    ArtifactInputPart,
    Attachment,
    Message,
    Session,
    TextPart,
    Workspace,
)

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
    connection_id TEXT NOT NULL DEFAULT 'local',
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
CREATE TABLE IF NOT EXISTS artifact_contexts (
    artifact_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    action TEXT NOT NULL,
    data TEXT NOT NULL,
    display_text TEXT,
    updated_at TEXT NOT NULL,
    consumed_by_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifact_contexts_session
    ON artifact_contexts(session_id, consumed_by_message_id, updated_at);
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
    if "connection_id" not in _columns(conn, "workspaces"):
        conn.execute("ALTER TABLE workspaces ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'local'")
        import switch_profiles
        conn.execute(
            "UPDATE workspaces SET connection_id = ? WHERE connection_id = 'local'",
            (switch_profiles.default_profile_id(),),
        )
    import switch_profiles
    conn.execute(
        "INSERT OR IGNORE INTO workspaces (id, name, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        (default_id, "Default workspace", switch_profiles.default_profile_id(), now, now),
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
    conn.execute(f"DELETE FROM artifact_contexts WHERE artifact_id IN ({placeholders})", tuple(artifact_ids))
    conn.execute(f"DELETE FROM artifacts WHERE id IN ({placeholders})", tuple(artifact_ids))


# ---- sessions ----

def _row_to_workspace(row: sqlite3.Row) -> Workspace:
    return Workspace(
        id=row["id"], name=row["name"], status=row["status"],
        connection_id=row["connection_id"],
        created_at=row["created_at"], updated_at=row["updated_at"],
    )


def list_workspaces() -> list[Workspace]:
    return [_row_to_workspace(row) for row in _query("SELECT * FROM workspaces ORDER BY updated_at DESC")]


def get_workspace(workspace_id: str) -> Workspace | None:
    rows = _query("SELECT * FROM workspaces WHERE id = ?", (workspace_id,))
    return _row_to_workspace(rows[0]) if rows else None


def create_workspace(workspace_id: str, name: str, status: str = "active", connection_id: str = "local") -> Workspace:
    now = now_iso()
    _execute(
        "INSERT INTO workspaces (id, name, connection_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (workspace_id, name, connection_id, status, now, now),
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
            conn.execute(f"DELETE FROM artifact_contexts WHERE session_id IN ({placeholders})", tuple(session_ids))
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
    _execute("DELETE FROM artifact_contexts WHERE session_id = ?", (session_id,))
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


def get_message(session_id: str, message_id: str) -> Message | None:
    rows = _query(
        "SELECT * FROM messages WHERE session_id = ? AND id = ?",
        (session_id, message_id),
    )
    return _row_to_message(rows[0]) if rows else None


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


def insert_message_with_pending_artifact_contexts(
    message: Message,
) -> list[ArtifactContext]:
    with _lock:
        conn = connect()
        try:
            rows = conn.execute(
                "SELECT * FROM artifact_contexts "
                "WHERE session_id = ? AND consumed_by_message_id IS NULL "
                "ORDER BY updated_at, artifact_id",
                (message.session_id,),
            ).fetchall()
            contexts = [_row_to_artifact_context(row) for row in rows]
            message.parts.extend(
                ArtifactContextPart(
                    artifact_id=context.artifact_id,
                    revision=context.revision,
                    action=context.action,
                    data=context.data,
                    display_text=context.display_text,
                )
                for context in contexts
            )
            conn.execute(
                "INSERT INTO messages "
                "(id, session_id, role, parts, attachments, artifact_ids, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
            if contexts:
                conn.executemany(
                    "UPDATE artifact_contexts SET consumed_by_message_id = ? "
                    "WHERE artifact_id = ? AND revision = ? "
                    "AND consumed_by_message_id IS NULL",
                    [
                        (message.id, context.artifact_id, context.revision)
                        for context in contexts
                    ],
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return contexts


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

            artifact_parts = [
                part
                for part in target_message.parts
                if isinstance(part, (ArtifactContextPart, ArtifactInputPart))
            ]
            target_message.parts = [TextPart(text=text), *artifact_parts]
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

def _row_to_artifact_context(row: sqlite3.Row) -> ArtifactContext:
    return ArtifactContext(
        artifact_id=row["artifact_id"],
        session_id=row["session_id"],
        revision=row["revision"],
        action=row["action"],
        data=json.loads(row["data"]),
        display_text=row["display_text"],
        updated_at=row["updated_at"],
    )


def set_artifact_context(
    artifact_id: str,
    session_id: str,
    action: str,
    data: object,
    display_text: str | None,
) -> ArtifactContext:
    updated_at = now_iso()
    with _lock:
        conn = connect()
        conn.execute(
            "INSERT INTO artifact_contexts "
            "(artifact_id, session_id, revision, action, data, display_text, updated_at, consumed_by_message_id) "
            "VALUES (?, ?, 1, ?, ?, ?, ?, NULL) "
            "ON CONFLICT(artifact_id) DO UPDATE SET "
            "session_id = excluded.session_id, revision = artifact_contexts.revision + 1, "
            "action = excluded.action, data = excluded.data, display_text = excluded.display_text, "
            "updated_at = excluded.updated_at, consumed_by_message_id = NULL",
            (
                artifact_id,
                session_id,
                action,
                json.dumps(data, ensure_ascii=False),
                display_text,
                updated_at,
            ),
        )
        row = conn.execute(
            "SELECT * FROM artifact_contexts WHERE artifact_id = ?",
            (artifact_id,),
        ).fetchone()
        conn.commit()
    return _row_to_artifact_context(row)


def list_pending_artifact_contexts(session_id: str) -> list[ArtifactContext]:
    return [
        _row_to_artifact_context(row)
        for row in _query(
            "SELECT * FROM artifact_contexts "
            "WHERE session_id = ? AND consumed_by_message_id IS NULL "
            "ORDER BY updated_at, artifact_id",
            (session_id,),
        )
    ]


def clear_artifact_context(artifact_id: str) -> None:
    _execute(
        "UPDATE artifact_contexts SET consumed_by_message_id = 'dismissed' "
        "WHERE artifact_id = ? AND consumed_by_message_id IS NULL",
        (artifact_id,),
    )

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
