import {
  MUSTER_MCP_ENDPOINT_SCOPE,
  isWireId,
  type AuthenticatedWorkerSubject,
  type McpStateStore,
  type McpSubjectBinding,
  type McpTokenRevocationSource,
  type MusterMcpScope,
  type Timestamp,
  type WorkerId,
} from "@kuindji/muster-contract";
import type {
  Clock,
  WorkerStatusResult,
  WorkerStatusService,
} from "@kuindji/muster-core";
import {
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import type {
  MusterMcpConfig,
  MusterMcpIssuerConfig,
} from "./config.js";
import { plainErrorResponse } from "./errors.js";

const TOKEN_TYPE = "at+jwt";

export interface MusterMcpAuthenticationDependencies {
  readonly clock: Clock;
  readonly revocationSource: McpTokenRevocationSource;
  readonly stateStore: Pick<McpStateStore, "resolveSubject">;
  readonly workerStatus: Pick<WorkerStatusService, "getWorkerStatus">;
  /** Test/deployment fetch boundary. It must preserve normal HTTP cache headers. */
  readonly fetch?: typeof fetch;
}

export interface MusterMcpAuthenticatedRequest {
  readonly workerId: WorkerId;
  readonly binding: McpSubjectBinding;
  readonly workerStatus: Extract<WorkerStatusResult, { readonly ok: true }>["status"];
  readonly scopes: ReadonlySet<string>;
  readonly at: Timestamp;
}

export type MusterMcpAuthenticationResult =
  | { readonly ok: true; readonly authenticated: MusterMcpAuthenticatedRequest }
  | { readonly ok: false; readonly response: Response };

interface VerifiedToken {
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
  readonly fingerprintSha256: string;
}

interface CachedJwks {
  readonly jwks: JSONWebKeySet;
  readonly freshUntil: number;
}

function quotedChallengeValue(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function resourceMetadataUrl(config: MusterMcpConfig): string {
  return new URL(
    `/.well-known/oauth-protected-resource${config.endpointPath}`,
    config.resourceOrigin,
  ).href;
}

function challengeResponse(
  config: MusterMcpConfig,
  input: { readonly kind: "unauthorized" | "insufficient_scope"; readonly scope: string },
): Response {
  const parts = [
    `resource_metadata=${quotedChallengeValue(resourceMetadataUrl(config))}`,
    `scope=${quotedChallengeValue(input.scope)}`,
  ];
  if (input.kind === "unauthorized") {
    parts.push('error="invalid_token"');
  } else {
    parts.push('error="insufficient_scope"');
  }
  return plainErrorResponse(
    input.kind === "unauthorized" ? 401 : 403,
    input.kind === "unauthorized" ? "Unauthorized." : "Insufficient scope.",
    { "www-authenticate": `Bearer ${parts.join(", ")}` },
  );
}

function validTimestamp(value: string): value is Timestamp {
  return value.length > 0 && Number.isFinite(Date.parse(value));
}

function validSubject(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function parseScopes(value: unknown): ReadonlySet<string> | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return null;
  }
  const scopes = value.split(" ");
  if (
    scopes.some((scope) => scope.length === 0 || !/^[\x21-\x7e]+$/.test(scope)) ||
    new Set(scopes).size !== scopes.length
  ) {
    return null;
  }
  return new Set(scopes);
}

function validNumericDate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function cacheFreshUntil(headers: Headers, now: number): number {
  const cacheControl = headers.get("cache-control")?.toLowerCase() ?? "";
  if (/(?:^|,)\s*(?:no-store|no-cache)(?:\s|,|$)/.test(cacheControl)) return now;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/.exec(cacheControl);
  if (maxAge !== null) {
    const seconds = Number(maxAge[1]);
    const age = Number(headers.get("age") ?? "0");
    if (Number.isSafeInteger(seconds) && Number.isFinite(age) && age >= 0) {
      return now + Math.max(0, seconds - age) * 1_000;
    }
    return now;
  }
  const expires = Date.parse(headers.get("expires") ?? "");
  const responseDate = Date.parse(headers.get("date") ?? "");
  if (Number.isFinite(expires)) {
    return now + Math.max(0, expires - (Number.isFinite(responseDate) ? responseDate : now));
  }
  return now;
}

function validJwks(value: unknown): value is JSONWebKeySet {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = (value as { readonly keys?: unknown }).keys;
  return Array.isArray(keys) && keys.length > 0 && keys.every((key) =>
    typeof key === "object" && key !== null && !Array.isArray(key)
  );
}

class JwksCache {
  private readonly cache = new Map<string, CachedJwks>();
  private readonly refreshes = new Map<string, Promise<CachedJwks>>();

  constructor(private readonly fetcher: typeof fetch) {}

  async get(
    issuer: MusterMcpIssuerConfig,
    now: number,
    forceRefresh: boolean,
  ): Promise<JSONWebKeySet> {
    const cached = this.cache.get(issuer.jwksUrl);
    if (!forceRefresh && cached !== undefined && cached.freshUntil > now) {
      return cached.jwks;
    }
    const active = this.refreshes.get(issuer.jwksUrl);
    if (active !== undefined) return (await active).jwks;

    const refresh = this.load(issuer.jwksUrl, now);
    this.refreshes.set(issuer.jwksUrl, refresh);
    try {
      const loaded = await refresh;
      this.cache.set(issuer.jwksUrl, loaded);
      return loaded.jwks;
    } finally {
      this.refreshes.delete(issuer.jwksUrl);
    }
  }

  private async load(url: string, now: number): Promise<CachedJwks> {
    const response = await this.fetcher(url, {
      method: "GET",
      headers: { accept: "application/jwk-set+json, application/json" },
      redirect: "error",
    });
    if (!response.ok) throw new Error("JWKS unavailable");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]
      ?.trim().toLowerCase();
    if (contentType !== "application/jwk-set+json" && contentType !== "application/json") {
      throw new Error("JWKS content type invalid");
    }
    const body = await response.json().catch(() => null);
    if (!validJwks(body)) throw new Error("JWKS body invalid");
    return { jwks: body, freshUntil: cacheFreshUntil(response.headers, now) };
  }
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const matched = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    authorization,
  );
  return matched?.[1] ?? null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bindingMatches(
  binding: McpSubjectBinding,
  subject: AuthenticatedWorkerSubject,
): boolean {
  return Number.isSafeInteger(binding.revision) && binding.revision >= 0 &&
    isWireId(binding.bindingId) &&
    isWireId(binding.workerId) &&
    validTimestamp(binding.boundAt) &&
    binding.subject.issuer === subject.issuer &&
    binding.subject.subject === subject.subject;
}

export class MusterMcpAuthenticator {
  private readonly jwks: JwksCache;

  constructor(
    private readonly config: MusterMcpConfig,
    private readonly dependencies: MusterMcpAuthenticationDependencies,
  ) {
    this.jwks = new JwksCache(dependencies.fetch ?? globalThis.fetch);
  }

  async authenticate(
    request: Request,
    requiredToolScope?: MusterMcpScope,
  ): Promise<MusterMcpAuthenticationResult> {
    const at = this.dependencies.clock.now();
    if (!validTimestamp(at)) return this.unauthorized();
    const token = bearerToken(request);
    if (token === null) return this.unauthorized();

    const verified = await this.verify(token, Date.parse(at));
    if (verified === null) return this.unauthorized();

    let revoked: boolean;
    try {
      revoked = await this.dependencies.revocationSource.isRevoked({
        issuer: verified.issuer,
        tokenFingerprintSha256: verified.fingerprintSha256,
        at,
      });
    } catch {
      return this.unauthorized();
    }
    if (revoked) return this.unauthorized();

    if (!verified.scopes.has(MUSTER_MCP_ENDPOINT_SCOPE)) {
      return this.insufficient(MUSTER_MCP_ENDPOINT_SCOPE);
    }
    if (requiredToolScope !== undefined && !verified.scopes.has(requiredToolScope)) {
      return this.insufficient(requiredToolScope);
    }

    const subject = {
      issuer: verified.issuer,
      subject: verified.subject,
    } satisfies AuthenticatedWorkerSubject;
    let binding: McpSubjectBinding | null;
    try {
      binding = await this.dependencies.stateStore.resolveSubject(subject);
    } catch {
      return this.unauthorized();
    }
    if (binding === null || !bindingMatches(binding, subject)) {
      return this.unauthorized();
    }

    let workerStatus: WorkerStatusResult;
    try {
      workerStatus = await this.dependencies.workerStatus.getWorkerStatus(binding.workerId, at);
    } catch {
      return this.unauthorized();
    }
    if (!workerStatus.ok || workerStatus.status.workerId !== binding.workerId) {
      return this.unauthorized();
    }

    return {
      ok: true,
      authenticated: {
        workerId: binding.workerId,
        binding,
        workerStatus: workerStatus.status,
        scopes: verified.scopes,
        at,
      },
    };
  }

  private unauthorized(): MusterMcpAuthenticationResult {
    return {
      ok: false,
      response: challengeResponse(this.config, {
        kind: "unauthorized",
        scope: MUSTER_MCP_ENDPOINT_SCOPE,
      }),
    };
  }

  private insufficient(scope: MusterMcpScope): MusterMcpAuthenticationResult {
    return {
      ok: false,
      response: challengeResponse(this.config, {
        kind: "insufficient_scope",
        scope,
      }),
    };
  }

  private async verify(token: string, now: number): Promise<VerifiedToken | null> {
    let unverified: JWTPayload;
    let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
    try {
      unverified = decodeJwt(token);
      protectedHeader = decodeProtectedHeader(token);
    } catch {
      return null;
    }
    if (
      typeof unverified.iss !== "string" ||
      typeof protectedHeader.kid !== "string" ||
      protectedHeader.kid.length === 0 ||
      protectedHeader.typ?.toLowerCase() !== TOKEN_TYPE
    ) {
      return null;
    }
    const issuer = this.config.authorizationServers.find(
      (candidate) => candidate.issuerUrl === unverified.iss,
    );
    if (issuer === undefined || !issuer.algorithms.includes(
      protectedHeader.alg as (typeof issuer.algorithms)[number],
    )) {
      return null;
    }

    let payload: JWTPayload | null = null;
    for (const forceRefresh of [false, true] as const) {
      try {
        const jwks = await this.jwks.get(issuer, now, forceRefresh);
        const verified = await jwtVerify(token, createLocalJWKSet(jwks), {
          algorithms: [...issuer.algorithms],
          issuer: issuer.issuerUrl,
          audience: this.config.audience,
          typ: TOKEN_TYPE,
          currentDate: new Date(now),
          clockTolerance: this.config.clockSkewSeconds,
          requiredClaims: ["iss", "aud", "sub", "iat", "exp"],
        });
        payload = verified.payload;
        break;
      } catch (error) {
        if (!(error instanceof joseErrors.JWKSNoMatchingKey) || forceRefresh) {
          return null;
        }
      }
    }
    if (
      payload === null ||
      !validSubject(payload.sub) ||
      !validNumericDate(payload.iat) ||
      !validNumericDate(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.iat > Math.floor(now / 1_000) + this.config.clockSkewSeconds ||
      (payload.nbf !== undefined && !validNumericDate(payload.nbf))
    ) {
      return null;
    }
    const scopes = parseScopes(payload.scope);
    if (scopes === null) return null;
    return {
      issuer: issuer.issuerUrl,
      subject: payload.sub,
      scopes,
      fingerprintSha256: await sha256Hex(token),
    };
  }
}
