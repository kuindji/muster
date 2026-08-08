import {
  MUSTER_MCP_TOOL_NAMES,
  TOOL_SCHEMAS,
} from "@kuindji/muster-contract";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  createHandlerFetch,
  createMusterMcpConfig,
  createMusterMcpHandler,
} from "../src/index.js";
import {
  createTestAuthentication,
  createTestJobTools,
  createTestWorkerTools,
  validConfigInput,
} from "./helpers.js";

async function connectClient(input: {
  readonly mode: "modern" | "legacy";
  readonly responseMode: "auto" | "sse";
  readonly fetch?: typeof fetch;
}) {
  const config = createMusterMcpConfig(validConfigInput());
  const auth = await createTestAuthentication(config);
  const handler = createMusterMcpHandler(config, {
    authentication: auth.authentication,
    jobTools: createTestJobTools(),
    workerTools: await createTestWorkerTools(),
    responseMode: input.responseMode,
  });
  const seen: Response[] = [];
  const baseFetch = input.fetch ?? createHandlerFetch(handler);
  const recordingFetch: typeof fetch = async (requestInput, init) => {
    const response = await baseFetch(requestInput, init);
    seen.push(response.clone());
    return response;
  };
  const transport = new StreamableHTTPClientTransport(
    new URL(config.resourceUrl),
    {
      fetch: recordingFetch,
      requestInit: { headers: { authorization: auth.authorizationHeader } },
    },
  );
  const client = new Client(
    { name: "muster-mcp-harness", version: "0.1.0" },
    input.mode === "modern"
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : { versionNegotiation: { mode: "legacy" } },
  );
  await client.connect(transport);
  return { client, transport, handler, seen };
}

async function closeHarness(harness: Awaited<ReturnType<typeof connectClient>>) {
  await harness.client.close();
  await harness.handler.close();
}

describe("real MCP SDK protocol harness", () => {
  it.each([
    ["2026-07-28 JSON", "modern", "auto"],
    ["2026-07-28 SSE", "modern", "sse"],
    ["2025-11-25 compatibility", "legacy", "auto"],
  ] as const)("lists frozen schemas over %s", async (_name, mode, responseMode) => {
    const harness = await connectClient({ mode, responseMode });
    const listed = await harness.client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(MUSTER_MCP_TOOL_NAMES);
    for (const tool of listed.tools) {
      const frozen = TOOL_SCHEMAS[tool.name as keyof typeof TOOL_SCHEMAS];
      expect(tool.inputSchema).toEqual(frozen.inputSchema);
      const expectedOutput = mode === "legacy" && !("type" in frozen.outputSchema)
        ? {
            type: "object",
            properties: { result: frozen.outputSchema },
            required: ["result"],
          }
        : frozen.outputSchema;
      expect(tool.outputSchema).toEqual(expectedOutput);
    }
    const listResponse = harness.seen.at(-1)!;
    expect(listResponse.headers.get("content-type")).toContain(
      responseMode === "sse" || mode === "legacy"
        ? "text/event-stream"
        : "application/json",
    );
    expect(harness.seen.every(
      (response) => response.headers.get("mcp-session-id") === null,
    )).toBe(true);
    await closeHarness(harness);
  });

  it("serves concurrent request-local calls without protocol sessions", async () => {
    const harness = await connectClient({ mode: "modern", responseMode: "auto" });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        harness.client.listTools(undefined, { cacheMode: "bypass" })
      ),
    );
    expect(results.every((result) => result.tools.length === 6)).toBe(true);
    expect(harness.seen.every(
      (response) => response.headers.get("mcp-session-id") === null,
    )).toBe(true);
    await closeHarness(harness);
  });

  it("propagates SDK request cancellation before handler dispatch", async () => {
    const config = createMusterMcpConfig(validConfigInput());
    const auth = await createTestAuthentication(config);
    const handler = createMusterMcpHandler(config, {
      authentication: auth.authentication,
      jobTools: createTestJobTools(),
      workerTools: await createTestWorkerTools(),
      responseMode: "sse",
    });
    const handlerFetch = createHandlerFetch(handler);
    let delayLists = false;
    let observedAbort = false;
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const cancellableFetch: typeof fetch = async (input, init) => {
      const request = input instanceof Request && init === undefined
        ? input
        : new Request(input, init);
      const body = request.method === "POST"
        ? await request.clone().json().catch(() => null)
        : null;
      if (delayLists && body?.method === "tools/list") {
        enteredResolve?.();
        await new Promise<never>((_resolve, reject) => {
          const abort = () => {
            observedAbort = true;
            reject(new DOMException("cancelled", "AbortError"));
          };
          if (request.signal.aborted) abort();
          else request.signal.addEventListener("abort", abort, { once: true });
        });
      }
      return handlerFetch(request);
    };
    const transport = new StreamableHTTPClientTransport(
      new URL(config.resourceUrl),
      {
        fetch: cancellableFetch,
        requestInit: { headers: { authorization: auth.authorizationHeader } },
      },
    );
    const client = new Client(
      { name: "cancel-test", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
    delayLists = true;
    const controller = new AbortController();
    const pending = client.listTools(undefined, {
      cacheMode: "bypass",
      signal: controller.signal,
    });
    await entered;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(observedAbort).toBe(true);
    await client.close();
    await handler.close();
  });

  it("fails unsupported modern protocol negotiation without a session fallback", async () => {
    const config = createMusterMcpConfig(validConfigInput());
    const auth = await createTestAuthentication(config);
    const handler = createMusterMcpHandler(config, {
      authentication: auth.authentication,
      jobTools: createTestJobTools(),
      workerTools: await createTestWorkerTools(),
    });
    const transport = new StreamableHTTPClientTransport(
      new URL(config.resourceUrl),
      {
        fetch: createHandlerFetch(handler),
        requestInit: { headers: { authorization: auth.authorizationHeader } },
      },
    );
    const client = new Client(
      { name: "unsupported-version-test", version: "1" },
      { versionNegotiation: { mode: { pin: "2099-01-01" } } },
    );
    await expect(client.connect(transport)).rejects.toThrow();
    expect(transport.sessionId).toBeUndefined();
    await client.close();
    await handler.close();
  });
});
