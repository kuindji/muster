import { describe, expect, it } from "vitest";
import {
  createMusterMcpConfig,
  createMusterMcpHandler,
  readMcpJson,
  type CreateMusterMcpHandlerOptions,
} from "../src/index.js";
import {
  createTestAuthentication,
  createTestJobTools,
  validConfigInput,
} from "./helpers.js";

const accept = "application/json, text/event-stream";

function request(
  body: string,
  options: {
    readonly url?: string;
    readonly method?: string;
    readonly headers?: HeadersInit;
  } = {},
): Request {
  return new Request(options.url ?? "https://muster.example/mcp", {
    method: options.method ?? "POST",
    headers: {
      accept,
      "content-type": "application/json",
      ...options.headers,
    },
    ...(options.method === "GET" ? {} : { body }),
  });
}

const legacyList = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});

async function authenticatedHandler(
  options: Omit<
    CreateMusterMcpHandlerOptions,
    "authentication" | "jobTools"
  > = {},
) {
  const config = createMusterMcpConfig(validConfigInput());
  const auth = await createTestAuthentication(config);
  return {
    config,
    handler: createMusterMcpHandler(config, {
      ...options,
      authentication: auth.authentication,
      jobTools: createTestJobTools(),
    }),
    authorizationHeader: auth.authorizationHeader,
  };
}

describe("framework-neutral MCP handler gates", () => {
  it("serves both exact protected-resource metadata routes", async () => {
    const { config, handler } = await authenticatedHandler();
    for (const path of config.protectedResourceMetadataPaths) {
      const response = await handler.fetch(
        new Request(`https://muster.example${path}`, { method: "GET" }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        resource: config.resourceUrl,
        authorization_servers: ["https://issuer.example/"],
        scopes_supported: ["muster:access", "muster:jobs", "muster:worker"],
        bearer_methods_supported: ["header"],
      });
    }
    await handler.close();
  });

  it.each([
    [
      "Origin",
      () => request(legacyList, { headers: { origin: "https://evil.example" } }),
      403,
    ],
    [
      "resource origin",
      () => request(legacyList, { url: "https://other.example/mcp" }),
      400,
    ],
    [
      "Host",
      () => request(legacyList, { headers: { host: "other.example" } }),
      400,
    ],
    ["path", () => request(legacyList, { url: "https://muster.example/no" }), 404],
    ["method", () => request("", { method: "GET" }), 405],
    [
      "content type",
      () => request(legacyList, { headers: { "content-type": "text/plain" } }),
      415,
    ],
    [
      "Accept",
      () => request(legacyList, { headers: { accept: "application/json" } }),
      406,
    ],
    [
      "disabled Accept",
      () => request(legacyList, {
        headers: {
          accept: "application/json, text/event-stream;q=0",
        },
      }),
      406,
    ],
    [
      "declared size",
      () => request(legacyList, { headers: { "content-length": "4097" } }),
      413,
    ],
  ])("rejects invalid %s before protocol dispatch", async (_name, make, status) => {
    const { handler } = await authenticatedHandler();
    const response = await handler.fetch(make());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await handler.close();
  });

  it("rejects actual oversized and malformed bodies", async () => {
    const { handler } = await authenticatedHandler();
    const oversized = await handler.fetch(request(`"${"x".repeat(4_097)}"`));
    expect(oversized.status).toBe(413);
    const malformed = await handler.fetch(request("{"));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });
    await handler.close();
  });

  it("lets the SDK reject unknown methods and modern header mismatches", async () => {
    const { handler } = await authenticatedHandler({ responseMode: "auto" });
    const unknown = await handler.fetch(
      request(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "unknown/read",
        params: {},
      })),
    );
    expect(await readMcpJson(unknown)).toMatchObject({
      error: { code: -32601 },
    });

    const modern = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const mismatch = await handler.fetch(
      request(modern, {
        headers: {
          "mcp-protocol-version": "2025-11-25",
          "mcp-method": "tools/list",
        },
      }),
    );
    expect(mismatch.status).toBe(400);
    expect(await readMcpJson(mismatch)).toMatchObject({
      error: { code: -32020 },
    });
    await handler.close();
  });
});
