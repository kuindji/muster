import {
  DEFAULT_MUSTER_MCP_TOOL_DESCRIPTIONS,
  type MusterMcpConfigInput,
} from "../src/index.js";

export function validConfigInput(): MusterMcpConfigInput {
  return {
    resourceUrl: "https://muster.example/mcp",
    endpointPath: "/mcp",
    audience: "https://muster.example/mcp",
    authorizationServers: [
      {
        issuerUrl: "https://issuer.example/",
        jwksUrl: "https://issuer.example/.well-known/jwks.json",
        algorithms: ["RS256"],
      },
    ],
    allowedOrigins: ["https://client.example/"],
    bodyLimitBytes: 4_096,
    clockSkewSeconds: 30,
    toolDescriptions: DEFAULT_MUSTER_MCP_TOOL_DESCRIPTIONS,
  };
}
