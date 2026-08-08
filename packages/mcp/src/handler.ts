import { MUSTER_MCP_SCOPES } from "@kuindji/muster-contract";
import {
  createMcpHandler,
  type PerRequestResponseMode,
} from "@modelcontextprotocol/server";
import type { MusterMcpConfig } from "./config.js";
import {
  JSON_RPC_ERRORS,
  jsonRpcErrorResponse,
  plainErrorResponse,
} from "./errors.js";
import { createMusterMcpServer } from "./server.js";

export interface CreateMusterMcpHandlerOptions {
  readonly responseMode?: PerRequestResponseMode;
  readonly onerror?: (error: Error) => void;
}

export interface MusterMcpHandler {
  readonly config: MusterMcpConfig;
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

function metadataResponse(config: MusterMcpConfig): Response {
  return new Response(
    JSON.stringify({
      resource: config.resourceUrl,
      authorization_servers: config.authorizationServers.map(
        (server) => server.issuerUrl,
      ),
      scopes_supported: MUSTER_MCP_SCOPES,
      bearer_methods_supported: ["header"],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    },
  );
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function acceptsMcp(value: string | null): boolean {
  if (value === null) return false;
  const accepted = value.toLowerCase().split(",").map((part) => {
    const [essence, ...parameters] = part.split(";").map((item) => item.trim());
    const q = parameters.find((parameter) => parameter.startsWith("q="));
    return { essence, enabled: q === undefined || Number(q.slice(2)) > 0 };
  });
  return accepted.some(
    (part) => part.essence === "application/json" && part.enabled,
  ) && accepted.some(
    (part) => part.essence === "text/event-stream" && part.enabled,
  );
}

async function boundedRequestBody(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return plainErrorResponse(400, "Invalid Content-Length.");
    }
    if (parsed > limit) return plainErrorResponse(413, "Request body too large.");
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk: Uint8Array<ArrayBuffer> = new Uint8Array(value);
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return plainErrorResponse(413, "Request body too large.");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createMusterMcpHandler(
  config: MusterMcpConfig,
  options: CreateMusterMcpHandlerOptions = {},
): MusterMcpHandler {
  const sdkHandler = createMcpHandler(
    () => createMusterMcpServer(config),
    {
      legacy: "stateless",
      ...(options.responseMode === undefined
        ? {}
        : { responseMode: options.responseMode }),
      ...(options.onerror === undefined ? {} : { onerror: options.onerror }),
    },
  );

  return {
    config,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (origin !== null && !config.allowedOrigins.includes(origin)) {
        return plainErrorResponse(403, "Forbidden Origin.");
      }
      if (url.origin !== config.resourceOrigin) {
        return plainErrorResponse(400, "Canonical resource origin required.");
      }
      if (url.search !== "") {
        return plainErrorResponse(400, "Canonical resource URL required.");
      }
      const host = request.headers.get("host");
      if (
        host !== null &&
        host.toLowerCase() !== new URL(config.resourceUrl).host
      ) {
        return plainErrorResponse(400, "Canonical resource Host required.");
      }

      if (config.protectedResourceMetadataPaths.includes(url.pathname)) {
        if (request.method !== "GET") {
          return plainErrorResponse(405, "Method Not Allowed.", { allow: "GET" });
        }
        return metadataResponse(config);
      }
      if (url.pathname !== config.endpointPath) {
        return plainErrorResponse(404, "Not Found.");
      }
      if (request.method !== "POST") {
        return plainErrorResponse(405, "Method Not Allowed.", { allow: "POST" });
      }
      if (!isJsonContentType(request.headers.get("content-type"))) {
        return plainErrorResponse(415, "Content-Type must be application/json.");
      }
      if (!acceptsMcp(request.headers.get("accept"))) {
        return plainErrorResponse(
          406,
          "Accept must include application/json and text/event-stream.",
        );
      }

      const body = await boundedRequestBody(request, config.bodyLimitBytes);
      if (body instanceof Response) return body;
      try {
        JSON.parse(new TextDecoder().decode(body));
      } catch {
        return jsonRpcErrorResponse({
          status: 400,
          code: JSON_RPC_ERRORS.parseError,
          message: "Parse error",
        });
      }

      const forwarded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      });
      const response = await sdkHandler.fetch(forwarded);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.delete("mcp-session-id");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
    close: () => sdkHandler.close(),
  };
}
