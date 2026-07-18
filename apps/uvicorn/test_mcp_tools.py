import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mcp_tools


class McpToolsRenderTypesTest(unittest.TestCase):
    def tearDown(self):
        mcp_tools.set_render_definitions([])

    def test_builtin_renderers_include_payload_schemas(self):
        definitions = {
            renderer["type"]: renderer
            for renderer in mcp_tools.supported_render_definitions()
        }

        for renderer_type in ["iframe", "image", "markdown"]:
            self.assertIn("payloadSchema", definitions[renderer_type])

    def test_frontend_renderer_report_keeps_builtin_markdown(self):
        mcp_tools.set_render_definitions([{"type": "circuit"}])

        self.assertEqual(
            mcp_tools.validate_render_type("markdown"),
            None,
        )
        self.assertEqual(
            mcp_tools.supported_render_types(),
            ["iframe", "image", "markdown", "circuit"],
        )

    def test_sparse_builtin_renderer_report_keeps_payload_schemas(self):
        mcp_tools.set_render_definitions([
            {"type": "iframe"},
            {"type": "image"},
            {"type": "markdown"},
        ])
        definitions = {
            renderer["type"]: renderer
            for renderer in mcp_tools.supported_render_definitions()
        }

        for renderer_type in ["iframe", "image", "markdown"]:
            self.assertIn("payloadSchema", definitions[renderer_type])

    def test_legacy_type_report_keeps_builtin_markdown(self):
        mcp_tools.set_render_types(["demo.stat"])

        self.assertEqual(
            mcp_tools.validate_render_type("markdown"),
            None,
        )
        self.assertIn("demo.stat", mcp_tools.supported_render_types())


if __name__ == "__main__":
    unittest.main()
