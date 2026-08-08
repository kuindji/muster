import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  MUSTER_MCP_ENDPOINT_SCOPE,
  MUSTER_MCP_JOB_SCOPE,
  type AuthenticatedWorkerSubject,
  type McpSubjectBinding,
  type Timestamp,
  type WorkerId,
} from "@kuindji/muster-contract";
import type { WorkerStatusResult } from "@kuindji/muster-core";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMusterMcpConfig,
  createMusterMcpHandler,
  readMcpJson,
  type MusterMcpAuthenticationDependencies,
  type MusterMcpHandler,
} from "../src/index.js";
import {
  TEST_NOW,
  TEST_WORKER_ID,
  createTestJobTools,
  validConfigInput,
} from "./helpers.js";

const NOW_SECONDS = Math.floor(Date.parse(TEST_NOW) / 1_000);
const accept = "application/json, text/event-stream";
const openServers: Array<{ close(): Promise<void> }> = [];

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

async function signingKey(kid: string): Promise<SigningKey> {
  const generated = await generateKeyPair("RS256");
  return {
    kid,
    privateKey: generated.privateKey,
    publicJwk: {
      ...await exportJWK(generated.publicKey),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

async function token(input: {
  readonly key: SigningKey;
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly scope?: unknown;
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly notBefore?: number;
  readonly typ?: string;
}): Promise<string> {
  const jwt = new SignJWT({ scope: input.scope ?? "muster:access muster:jobs" })
    .setProtectedHeader({
      alg: "RS256",
      kid: input.key.kid,
      typ: input.typ ?? "at+jwt",
    })
    .setIssuer(input.issuer ?? "https://issuer.example/")
    .setAudience(input.audience ?? "https://muster.example/mcp")
    .setIssuedAt(input.issuedAt ?? NOW_SECONDS)
    .setExpirationTime(input.expiresAt ?? NOW_SECONDS + 300);
  if (input.subject !== undefined) jwt.setSubject(input.subject);
  if (input.notBefore !== undefined) jwt.setNotBefore(input.notBefore);
  return jwt.sign(input.key.privateKey);
}

async function listen(
  listener: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((request, response) => {
    Promise.resolve(listener(request, response)).catch(() => {
      response.statusCode = 500;
      response.end("fixture failure");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture address");
  const fixture = {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
  openServers.push(fixture);
  return fixture;
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(new Uint8Array(chunk));
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function handlerServer(handler: MusterMcpHandler) {
  return listen(async (incoming, outgoing) => {
    const body = await readBody(incoming);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("host", "muster.example");
    const response = await handler.fetch(new Request(
      `https://muster.example${incoming.url ?? "/"}`,
      {
        method: incoming.method ?? "GET",
        headers,
        ...(body.byteLength === 0
          ? {}
          : { body: new Uint8Array(body) }),
      },
    ));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(new Uint8Array(await response.arrayBuffer()));
  });
}

function protectedRequest(
  bearer: string | undefined,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
): Request {
  return new Request("https://muster.example/mcp", {
    method: "POST",
    headers: {
      accept,
      "content-type": "application/json",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });
}

async function fixture(options: {
  readonly initialKeys?: readonly SigningKey[];
  readonly cacheControl?: string;
} = {}) {
  const initial = options.initialKeys ?? [await signingKey("key-1")];
  const jwksState: {
    keys: readonly SigningKey[];
    cacheControl: string;
    status: number;
    malformed: boolean;
    requests: number;
  } = {
    keys: initial,
    cacheControl: options.cacheControl ?? "public, max-age=300",
    status: 200,
    malformed: false,
    requests: 0,
  };
  const jwksServer = await listen((_request, response) => {
    jwksState.requests += 1;
    response.statusCode = jwksState.status;
    response.setHeader("content-type", "application/jwk-set+json");
    response.setHeader("cache-control", jwksState.cacheControl);
    response.end(jwksState.malformed
      ? "{" : JSON.stringify({ keys: jwksState.keys.map((key) => key.publicJwk) }));
  });
  const config = createMusterMcpConfig(validConfigInput());
  const rawSubject = "raw-subject-secret";
  const binding: McpSubjectBinding = {
    revision: 1,
    bindingId: "binding-auth-1",
    subject: { issuer: config.authorizationServers[0]!.issuerUrl, subject: rawSubject },
    workerId: TEST_WORKER_ID,
    boundAt: TEST_NOW,
  };
  const revocationSource = {
    isRevoked: vi.fn(async (_input: {
      readonly issuer: string;
      readonly tokenFingerprintSha256: string;
      readonly at: Timestamp;
    }) => false),
  };
  const stateStore = {
    resolveSubject: vi.fn(async (
      _subject: AuthenticatedWorkerSubject,
    ): Promise<McpSubjectBinding | null> => binding),
  };
  const workerStatus = {
    getWorkerStatus: vi.fn(async (
      _workerId: WorkerId,
      _at?: Timestamp,
    ): Promise<WorkerStatusResult> => ({
      ok: true as const,
      status: {
        workerId: TEST_WORKER_ID,
        state: "active" as const,
        contractVersion: "1.1.0",
        jobClassIds: ["class-1"],
        capUsageBucket: 0 as const,
        nextSlotBucket: 0 as const,
        assignedSlotOccurrence: "slot-1",
        nextSlotOccurrence: "slot-1",
      },
    })),
  };
  const authentication: MusterMcpAuthenticationDependencies = {
    clock: { now: () => TEST_NOW },
    revocationSource,
    stateStore,
    workerStatus,
    fetch: async (input, init) => {
      expect(String(input)).toBe(config.authorizationServers[0]!.jwksUrl);
      return fetch(`${jwksServer.url}/jwks`, init);
    },
  };
  const handler = createMusterMcpHandler(config, {
    authentication,
    jobTools: createTestJobTools(),
  });
  return {
    config,
    rawSubject,
    binding,
    revocationSource,
    stateStore,
    workerStatus,
    authentication,
    handler,
    jwksState,
    keys: initial,
  };
}

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!.close();
});

describe("OAuth resource-server authentication", () => {
  it("serves discovery and resolves a verified subject over disposable HTTP fixtures", async () => {
    const test = await fixture();
    const resource = await handlerServer(test.handler);
    for (const path of test.config.protectedResourceMetadataPaths) {
      const response = await fetch(`${resource.url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: test.config.resourceUrl,
        authorization_servers: [test.config.authorizationServers[0]!.issuerUrl],
        scopes_supported: ["muster:access", "muster:jobs", "muster:worker"],
      });
    }

    const bearer = await token({
      key: test.keys[0]!,
      subject: test.rawSubject,
    });
    const response = await fetch(`${resource.url}/mcp`, {
      method: "POST",
      headers: {
        accept,
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
    expect(await readMcpJson(response)).toMatchObject({ result: { tools: expect.any(Array) } });
    expect(test.revocationSource.isRevoked).toHaveBeenCalledOnce();
    const revocationInput = test.revocationSource.isRevoked.mock.calls[0]![0];
    expect(revocationInput).toEqual({
      issuer: test.config.authorizationServers[0]!.issuerUrl,
      tokenFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      at: TEST_NOW,
    });
    expect(JSON.stringify(revocationInput)).not.toContain(test.rawSubject);
    expect(JSON.stringify(revocationInput)).not.toContain(bearer);
    expect(test.stateStore.resolveSubject).toHaveBeenCalledWith({
      issuer: test.config.authorizationServers[0]!.issuerUrl,
      subject: test.rawSubject,
    });
    expect(test.workerStatus.getWorkerStatus).toHaveBeenCalledWith(TEST_WORKER_ID, TEST_NOW);
    await test.handler.close();
  });

  it("returns uniform bearer challenges and preserves the frozen gate order", async () => {
    const test = await fixture();
    const valid = await token({ key: test.keys[0]!, subject: test.rawSubject });

    const missing = await test.handler.fetch(protectedRequest(undefined));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://muster.example/.well-known/oauth-protected-resource/mcp"',
    );
    expect(missing.headers.get("www-authenticate")).toContain('scope="muster:access"');
    expect(test.revocationSource.isRevoked).not.toHaveBeenCalled();

    test.revocationSource.isRevoked.mockResolvedValueOnce(true);
    const revoked = await test.handler.fetch(protectedRequest(valid));
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).toBe("Unauthorized.");
    expect(test.stateStore.resolveSubject).not.toHaveBeenCalled();

    const jobsOnly = await token({
      key: test.keys[0]!,
      subject: test.rawSubject,
      scope: MUSTER_MCP_JOB_SCOPE,
    });
    const missingEndpoint = await test.handler.fetch(protectedRequest(jobsOnly));
    expect(missingEndpoint.status).toBe(403);
    expect(missingEndpoint.headers.get("www-authenticate")).toContain(
      `scope="${MUSTER_MCP_ENDPOINT_SCOPE}"`,
    );
    expect(test.stateStore.resolveSubject).not.toHaveBeenCalled();

    const accessOnly = await token({
      key: test.keys[0]!,
      subject: test.rawSubject,
      scope: MUSTER_MCP_ENDPOINT_SCOPE,
    });
    const insufficient = await test.handler.fetch(protectedRequest(accessOnly, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lease_job", arguments: { availability: { budget_bucket: 1 } } },
    }));
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toContain(
      `scope="${MUSTER_MCP_JOB_SCOPE}"`,
    );
    expect(insufficient.headers.get("www-authenticate")).not.toContain(
      'scope="muster:access muster:jobs"',
    );
    expect(test.stateStore.resolveSubject).not.toHaveBeenCalled();
    await test.handler.close();
  });

  it("fails invalid JWT claims, signatures, key IDs, and JWKS failures closed", async () => {
    const test = await fixture({ cacheControl: "no-store" });
    const other = await signingKey("other-key");
    const confusedAlgorithm = await new SignJWT({ scope: "muster:access muster:jobs" })
      .setProtectedHeader({ alg: "HS256", kid: test.keys[0]!.kid, typ: "at+jwt" })
      .setIssuer(test.config.authorizationServers[0]!.issuerUrl)
      .setAudience(test.config.audience)
      .setSubject(test.rawSubject)
      .setIssuedAt(NOW_SECONDS)
      .setExpirationTime(NOW_SECONDS + 300)
      .sign(new TextEncoder().encode("not-an-rsa-public-key"));
    const cases = [
      await token({ key: test.keys[0]!, subject: test.rawSubject, issuer: "https://wrong.example/" }),
      await token({ key: test.keys[0]!, subject: test.rawSubject, audience: "https://other.example/mcp" }),
      await token({ key: test.keys[0]!, subject: test.rawSubject, scope: "muster:access  muster:jobs" }),
      await token({ key: test.keys[0]!, subject: test.rawSubject, expiresAt: NOW_SECONDS - 1 }),
      await token({ key: test.keys[0]!, subject: test.rawSubject, notBefore: NOW_SECONDS + 120 }),
      await token({ key: test.keys[0]!, subject: test.rawSubject, typ: "JWT" }),
      confusedAlgorithm,
      await token({ key: other, subject: test.rawSubject }),
      await token({ key: test.keys[0]! }),
      await token({ key: test.keys[0]!, subject: test.rawSubject, scope: ["muster:access"] }),
    ];
    for (const bearer of cases) {
      const response = await test.handler.fetch(protectedRequest(bearer));
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized.");
    }
    expect(test.revocationSource.isRevoked).not.toHaveBeenCalled();
    expect(test.stateStore.resolveSubject).not.toHaveBeenCalled();

    test.jwksState.status = 503;
    const unavailable = await test.handler.fetch(protectedRequest(
      await token({ key: test.keys[0]!, subject: test.rawSubject }),
    ));
    expect(unavailable.status).toBe(401);
    test.jwksState.status = 200;
    test.jwksState.malformed = true;
    const malformed = await test.handler.fetch(protectedRequest(
      await token({ key: test.keys[0]!, subject: test.rawSubject }),
    ));
    expect(malformed.status).toBe(401);
    await test.handler.close();
  });

  it("coalesces concurrent refresh for a rotating unknown key and never uses stale keys", async () => {
    const oldKey = await signingKey("old-key");
    const newKey = await signingKey("new-key");
    const test = await fixture({ initialKeys: [oldKey] });
    const oldToken = await token({ key: oldKey, subject: test.rawSubject });
    expect((await test.handler.fetch(protectedRequest(oldToken))).status).toBe(200);
    expect(test.jwksState.requests).toBe(1);

    test.jwksState.keys = [newKey];
    const newToken = await token({ key: newKey, subject: test.rawSubject });
    const rotated = await Promise.all(
      Array.from({ length: 8 }, () => test.handler.fetch(protectedRequest(newToken))),
    );
    expect(rotated.every((response) => response.status === 200)).toBe(true);
    expect(test.jwksState.requests).toBe(2);

    test.jwksState.cacheControl = "no-store";
    test.jwksState.status = 503;
    const unknown = await signingKey("unknown-key");
    const refused = await test.handler.fetch(protectedRequest(
      await token({ key: unknown, subject: test.rawSubject }),
    ));
    expect(refused.status).toBe(401);
    await test.handler.close();
  });

  it("projects mapping, worker, and thrown sensitive failures through one scrubbed path", async () => {
    const test = await fixture();
    const bearer = await token({ key: test.keys[0]!, subject: test.rawSubject });

    test.stateStore.resolveSubject.mockResolvedValueOnce(null);
    const missing = await test.handler.fetch(protectedRequest(bearer));
    expect(missing.status).toBe(401);

    test.stateStore.resolveSubject.mockResolvedValueOnce({
      ...test.binding,
      workerId: "conflicting-worker",
      subject: { ...test.binding.subject, subject: "conflicting-subject" },
    });
    const conflicting = await test.handler.fetch(protectedRequest(bearer));
    expect(conflicting.status).toBe(401);

    test.workerStatus.getWorkerStatus.mockResolvedValueOnce({
      ok: false as const,
      kind: "unavailable" as const,
    });
    const revokedWorker = await test.handler.fetch(protectedRequest(bearer));
    expect(revokedWorker.status).toBe(401);

    test.stateStore.resolveSubject.mockRejectedValueOnce(
      new Error(`${test.rawSubject} ${bearer}`),
    );
    const thrown = await test.handler.fetch(protectedRequest(bearer));
    const serializedHeaders: Record<string, string> = {};
    thrown.headers.forEach((value, name) => {
      serializedHeaders[name] = value;
    });
    const serialized = `${await thrown.text()} ${JSON.stringify(serializedHeaders)}`;
    expect(thrown.status).toBe(401);
    expect(serialized).not.toContain(test.rawSubject);
    expect(serialized).not.toContain(bearer);
    await test.handler.close();
  });
});
