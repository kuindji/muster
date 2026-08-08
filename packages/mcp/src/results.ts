import type { CallToolResult } from "@modelcontextprotocol/server";

export const TOOL_DISPATCH_PENDING_MESSAGE =
  "Muster tool authentication is not configured.";

export const MUSTER_MCP_GENERIC_TOOL_ERROR_MESSAGE =
  "Muster tool request could not be completed.";

export function genericToolError(): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: MUSTER_MCP_GENERIC_TOOL_ERROR_MESSAGE }],
  };
}

export function pendingToolResult(): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: TOOL_DISPATCH_PENDING_MESSAGE }],
  };
}
