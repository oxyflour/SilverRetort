"""Expose the MCP server Hermes uses for UI control and file access."""

from mcp.server.fastmcp import FastMCP

import mcp_tools

mcp = FastMCP("silverretort-ui", stateless_http=True, streamable_http_path="/")

for tool in mcp_tools.TOOL_FUNCTIONS.values():
    mcp.add_tool(tool)


def set_render_types(types: list[str]) -> None:
    mcp_tools.set_render_types(types)


def set_render_definitions(renderers: list[dict]) -> None:
    mcp_tools.set_render_definitions(renderers)


def set_artifact_modules(modules: list[dict]) -> None:
    mcp_tools.set_artifact_modules(modules)
