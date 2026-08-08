import type { CallToolResult } from "@modelcontextprotocol/server";

export const TOOL_DISPATCH_PENDING_MESSAGE =
  "Muster tool authentication is not configured.";

export function pendingToolResult(): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: TOOL_DISPATCH_PENDING_MESSAGE }],
  };
}
