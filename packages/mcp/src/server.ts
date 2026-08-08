import {
  MUSTER_MCP_TOOL_NAMES,
  TOOL_SCHEMAS,
} from "@kuindji/muster-contract";
import { Server, type ListToolsResult } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import type { MusterMcpAuthenticatedRequest } from "./auth.js";
import {
  MUSTER_MCP_PROTOCOL_VERSIONS,
  type MusterMcpConfig,
} from "./config.js";
import type { MusterMcpJobToolDispatcher } from "./job-tools.js";
import { pendingToolResult } from "./results.js";

export interface MusterMcpServerRequestOptions {
  readonly authenticated?: MusterMcpAuthenticatedRequest;
  readonly jobTools?: MusterMcpJobToolDispatcher;
}

export function createMusterMcpServer(
  config: MusterMcpConfig,
  options: MusterMcpServerRequestOptions = {},
): Server {
  const validator = new AjvJsonSchemaValidator();
  const server = new Server(
    { name: "muster", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: false } },
      jsonSchemaValidator: validator,
      supportedProtocolVersions: [...MUSTER_MCP_PROTOCOL_VERSIONS],
      cacheHints: { "tools/list": { ttlMs: 300_000, cacheScope: "public" } },
    },
  );

  server.setRequestHandler(
    "tools/list",
    async () =>
      ({
        tools: MUSTER_MCP_TOOL_NAMES.map((name) => ({
          name,
          description: config.toolDescriptions[name],
          inputSchema: TOOL_SCHEMAS[name].inputSchema,
          outputSchema: TOOL_SCHEMAS[name].outputSchema,
        })),
      }) as unknown as ListToolsResult,
  );
  server.setRequestHandler("tools/call", async (request) => {
    const result = options.jobTools === undefined
      ? pendingToolResult()
      : await options.jobTools.call(
          request.params.name,
          request.params.arguments ?? {},
          options.authenticated,
        );
    const schema = TOOL_SCHEMAS[
      request.params.name as keyof typeof TOOL_SCHEMAS
    ]?.outputSchema;
    return server.projectCallToolResult(result, schema);
  });
  return server;
}
