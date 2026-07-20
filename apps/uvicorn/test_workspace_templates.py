import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db
import hermes_client
import workspace_templates
from api_routes import workspaces as workspace_routes
from fastapi import HTTPException
from models import CreateWorkspaceRequest, Workspace, WorkspaceTemplate


def template_payload(template_id: str = "structural", name: str = "Structural") -> dict:
    return {
        "version": 1,
        "id": template_id,
        "name": name,
        "description": "Structural design workflow",
        "emptyState": {
            "title": "Start design",
            "description": "Define constraints",
            "suggestions": [{"label": "Define loads", "prompt": "List the loads"}],
        },
        "ui": {"module": template_id},
        "agent": {"instructions": "Prioritize explicit engineering assumptions."},
    }


class WorkspaceTemplateLoaderTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self):
        workspace_templates.load_templates(self.root / "missing")
        self.temp_dir.cleanup()

    def write(self, name: str, payload: dict | str) -> None:
        text = payload if isinstance(payload, str) else json.dumps(payload)
        (self.root / name).write_text(text, encoding="utf-8")

    def test_loads_valid_templates_and_skips_invalid_and_duplicate_ids(self):
        self.write("a.json", template_payload(name="First"))
        self.write("b.json", template_payload(name="Duplicate"))
        self.write("invalid.json", {**template_payload("bad"), "unexpected": True})

        loaded = workspace_templates.load_templates(self.root)

        self.assertEqual([item.name for item in loaded], ["First"])
        self.assertEqual(workspace_templates.get_template("structural").name, "First")
        self.assertEqual(
            workspace_templates.get_template("structural").agent.instructions,
            "Prioritize explicit engineering assumptions.",
        )
        self.assertIsNone(workspace_templates.get_template("bad"))

    def test_rejects_invalid_agent_instructions(self):
        payload = template_payload()
        payload["agent"] = {"instructions": ""}
        self.write("invalid-agent.json", payload)

        self.assertEqual(workspace_templates.load_templates(self.root), [])

    def test_missing_directory_clears_registry(self):
        self.write("valid.json", template_payload())
        workspace_templates.load_templates(self.root)

        self.assertEqual(workspace_templates.load_templates(self.root / "missing"), [])
        self.assertEqual(workspace_templates.list_templates(), [])


class WorkspaceTemplateDatabaseTest(unittest.TestCase):
    def test_migration_adds_nullable_template_id_and_persists_selection(self):
        old_conn = db._conn
        old_data_dir = os.environ.get("DATA_DIR")
        temp_dir = tempfile.TemporaryDirectory()
        try:
            db._conn = None
            os.environ["DATA_DIR"] = temp_dir.name
            legacy = sqlite3.connect(Path(temp_dir.name) / "silverretort.db")
            legacy.execute(
                "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
                "connection_id TEXT NOT NULL DEFAULT 'local', status TEXT NOT NULL, "
                "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
            )
            legacy.commit()
            legacy.close()

            conn = db.connect()
            columns = {row[1] for row in conn.execute("PRAGMA table_info(workspaces)")}
            created = db.create_workspace("domain", "Domain", template_id="structural")

            self.assertIn("template_id", columns)
            self.assertEqual(created.template_id, "structural")
            self.assertIsNone(db.get_workspace("default").template_id)
        finally:
            if db._conn is not None:
                db._conn.close()
            db._conn = old_conn
            if old_data_dir is None:
                os.environ.pop("DATA_DIR", None)
            else:
                os.environ["DATA_DIR"] = old_data_dir
            temp_dir.cleanup()


class WorkspaceTemplateInstructionsTest(unittest.TestCase):
    def test_appends_bound_template_instructions(self):
        template = WorkspaceTemplate.model_validate(template_payload())
        workspace = Workspace(
            id="workspace-a",
            name="Domain",
            template_id="structural",
            created_at="2026-07-20T00:00:00Z",
            updated_at="2026-07-20T00:00:00Z",
        )
        with patch.object(hermes_client.db, "get_workspace", return_value=workspace), patch.object(
            hermes_client.workspace_templates, "get_template", return_value=template
        ):
            result = hermes_client._append_template_instructions(
                "Base instructions", "workspace-a"
            )

        self.assertEqual(
            result,
            "Base instructions\n\nWorkspace template instructions:\n"
            "Prioritize explicit engineering assumptions.",
        )

    def test_keeps_base_instructions_when_template_is_missing(self):
        workspace = Workspace(
            id="workspace-a",
            name="Domain",
            template_id="deleted-template",
            created_at="2026-07-20T00:00:00Z",
            updated_at="2026-07-20T00:00:00Z",
        )
        with patch.object(hermes_client.db, "get_workspace", return_value=workspace), patch.object(
            hermes_client.workspace_templates, "get_template", return_value=None
        ):
            result = hermes_client._append_template_instructions(
                "Base instructions", "workspace-a"
            )

        self.assertEqual(result, "Base instructions")


class WorkspaceTemplateRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_unknown_template(self):
        workspace_templates.load_templates(Path("missing-template-directory"))
        with patch.object(workspace_routes.switch_profiles, "default_profile_id", return_value="local"), patch.object(
            workspace_routes.switch_profiles, "get_profile", return_value=object()
        ):
            with self.assertRaises(HTTPException) as raised:
                await workspace_routes.create_workspace(
                    CreateWorkspaceRequest(name="Domain", template_id="missing")
                )
        self.assertEqual(raised.exception.status_code, 400)

    async def test_persists_valid_template_on_creation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "valid.json").write_text(
                json.dumps(template_payload()), encoding="utf-8"
            )
            workspace_templates.load_templates(root)
            active = Workspace(
                id="workspace-a",
                name="Domain",
                template_id="structural",
                status="active",
                connection_id="local",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
            )
            with patch.object(workspace_routes.uuid, "uuid4") as uuid4, patch.object(
                workspace_routes.switch_profiles, "default_profile_id", return_value="local"
            ), patch.object(
                workspace_routes.switch_profiles, "get_profile", return_value=object()
            ), patch.object(
                workspace_routes.workspace_service,
                "capability",
                AsyncMock(return_value={"supported": True, "writable": True}),
            ), patch.object(
                workspace_routes.workspace_service, "create_remote", AsyncMock()
            ), patch.object(
                workspace_routes.db, "create_workspace", return_value=active
            ) as create_workspace, patch.object(
                workspace_routes.db, "set_workspace_status"
            ), patch.object(
                workspace_routes.db, "get_workspace", return_value=active
            ), patch.object(
                workspace_routes.switch_profiles,
                "workspace_summary",
                return_value={
                    "connectionId": "local",
                    "switchMode": "local",
                    "switchUrl": "",
                    "hasHermesApiKey": False,
                },
            ):
                uuid4.return_value.hex = "workspace-a"
                result = await workspace_routes.create_workspace(
                    CreateWorkspaceRequest(name="Domain", template_id="structural")
                )

            self.assertEqual(result.template_id, "structural")
            create_workspace.assert_called_once_with(
                "workspace-a", "Domain", "creating", "local", "structural"
            )


if __name__ == "__main__":
    unittest.main()
