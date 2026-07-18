import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import routes
from models import Artifact, Session


class FakeUrl:
    query = "v=1"


class FakeRequest:
    method = "POST"
    headers = {}
    url = FakeUrl()

    async def body(self) -> bytes:
        return b""


class WorkspacePortArtifactTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_get_artifact = routes.db.get_artifact
        self.original_get_session = routes.db.get_session
        self.original_require_workspace_proxy = routes.workspace_service.require_workspace_proxy
        self.original_listen_port = os.environ.get("LISTEN_PORT")
        os.environ["LISTEN_PORT"] = "23001"

    def tearDown(self):
        routes.db.get_artifact = self.original_get_artifact
        routes.db.get_session = self.original_get_session
        routes.workspace_service.require_workspace_proxy = self.original_require_workspace_proxy
        if self.original_listen_port is None:
            os.environ.pop("LISTEN_PORT", None)
        else:
            os.environ["LISTEN_PORT"] = self.original_listen_port

    def install_artifact(self, payload):
        routes.db.get_artifact = lambda artifact_id: Artifact(
            id=artifact_id,
            session_id="session-a",
            type="iframe",
            title="Preview",
            payload=payload,
            created_at="2026-07-18T00:00:00Z",
        )
        routes.db.get_session = lambda session_id: Session(
            id=session_id,
            workspace_id="workspace-a",
            title="Session",
            created_at="2026-07-18T00:00:00Z",
            updated_at="2026-07-18T00:00:00Z",
        )

        async def require_workspace_proxy(workspace_id):
            self.assertEqual(workspace_id, "workspace-a")

        routes.workspace_service.require_workspace_proxy = require_workspace_proxy

    async def test_workspace_port_root_redirect_keeps_trailing_slash(self):
        self.install_artifact({"workspacePort": {"port": 8765}})

        response = await routes.get_artifact_content(
            "artifact-a",
            FakeRequest(),
        )

        self.assertEqual(response.status_code, 307)
        self.assertEqual(
            response.headers["location"],
            "http://127.0.0.1:23001/api/workspace-proxy/workspace/workspace-a/port/8765/?v=1",
        )

    async def test_workspace_port_directory_redirect_keeps_trailing_slash(self):
        self.install_artifact({"workspacePort": {"port": 8765, "path": "app/"}})

        response = await routes.get_artifact_content(
            "artifact-a",
            FakeRequest(),
        )

        self.assertEqual(response.status_code, 307)
        self.assertEqual(
            response.headers["location"],
            "http://127.0.0.1:23001/api/workspace-proxy/workspace/workspace-a/port/8765/app/?v=1",
        )

    async def test_workspace_port_content_redirects_to_proxy_with_asset_path_and_query(self):
        self.install_artifact({"workspacePort": {"port": 5173, "path": "app/index.html"}})

        response = await routes.get_artifact_content(
            "artifact-a",
            FakeRequest(),
            "assets/app.js",
        )

        self.assertEqual(response.status_code, 307)
        self.assertEqual(
            response.headers["location"],
            "http://127.0.0.1:23001/api/workspace-proxy/workspace/workspace-a/port/5173/app/assets/app.js?v=1",
        )

    def test_workspace_port_directory_entry_keeps_assets_under_directory(self):
        self.assertEqual(
            routes._workspace_port_payload_target(
                {"workspacePort": {"port": 5173, "path": "app/"}},
                "assets/app.js",
            ),
            (5173, "app/assets/app.js"),
        )


if __name__ == "__main__":
    unittest.main()
