import type { MusterMcpHandler } from "./handler.js";

export function createHandlerFetch(handler: MusterMcpHandler): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input, init);
    return handler.fetch(request);
  };
}

export async function readMcpJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.startsWith("application/json")) return response.json();
  if (!contentType.startsWith("text/event-stream")) {
    throw new Error(`unexpected MCP content type ${contentType}`);
  }
  const text = await response.text();
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .at(-1);
  if (data === undefined) throw new Error("SSE response has no data frame");
  return JSON.parse(data);
}
