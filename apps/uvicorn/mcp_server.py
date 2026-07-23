"""Expose the MCP server Hermes uses for UI control and file access."""

from mcp.server.fastmcp import FastMCP

import mcp_tools

mcp = FastMCP("silverretort-ui", stateless_http=True, streamable_http_path="/")

for tool in mcp_tools.TOOL_FUNCTIONS.values():
    mcp.add_tool(tool)
