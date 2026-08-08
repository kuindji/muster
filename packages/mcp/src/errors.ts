export const JSON_RPC_ERRORS = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const);

export function jsonRpcErrorResponse(input: {
  readonly status: number;
  readonly code: number;
  readonly message: string;
  readonly id?: string | number | null;
  readonly headers?: HeadersInit;
}): Response {
  const headers = new Headers(input.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: input.code, message: input.message },
      id: input.id ?? null,
    }),
    { status: input.status, headers },
  );
}

export function plainErrorResponse(
  status: number,
  message: string,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "text/plain; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(message, { status, headers: responseHeaders });
}
