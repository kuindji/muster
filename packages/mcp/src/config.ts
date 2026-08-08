import {
  MUSTER_MCP_SCOPES,
  MUSTER_MCP_TOOL_NAMES,
  deepFreeze,
  type MusterMcpToolName,
} from "@kuindji/muster-contract";

export const MUSTER_MCP_PROTOCOL_VERSIONS = deepFreeze([
  "2026-07-28",
  "2025-11-25",
] as const);

export const MUSTER_MCP_JWT_ALGORITHMS = deepFreeze([
  "RS256",
  "PS256",
  "ES256",
  "EdDSA",
] as const);

export type MusterMcpJwtAlgorithm =
  (typeof MUSTER_MCP_JWT_ALGORITHMS)[number];

export const DEFAULT_MUSTER_MCP_TOOL_DESCRIPTIONS: Readonly<
  Record<MusterMcpToolName, string>
> = deepFreeze({
  lease_job: "Lease one sanitized Muster job.",
  submit_result: "Submit a result for a held Muster lease.",
  abandon_job: "Abandon a held Muster lease with a coarse reason.",
  extend_lease: "Request one bounded extension for a held Muster lease.",
  get_worker_status: "Read the authenticated worker's coarse Muster status.",
  set_availability: "Set the authenticated worker's coarse availability state.",
});

export interface MusterMcpIssuerConfigInput {
  readonly issuerUrl: string | URL;
  readonly jwksUrl: string | URL;
  readonly algorithms: readonly MusterMcpJwtAlgorithm[];
}

export interface MusterMcpConfigInput {
  readonly resourceUrl: string | URL;
  readonly endpointPath: string;
  readonly audience: string | URL;
  readonly authorizationServers: readonly MusterMcpIssuerConfigInput[];
  readonly allowedOrigins: readonly (string | URL)[];
  readonly bodyLimitBytes: number;
  readonly clockSkewSeconds: number;
  readonly toolDescriptions: Readonly<Record<MusterMcpToolName, string>>;
}

export interface MusterMcpIssuerConfig {
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  readonly algorithms: readonly MusterMcpJwtAlgorithm[];
}

export interface MusterMcpConfig {
  readonly resourceUrl: string;
  readonly resourceOrigin: string;
  readonly endpointPath: string;
  readonly audience: string;
  readonly authorizationServers: readonly MusterMcpIssuerConfig[];
  readonly allowedOrigins: readonly string[];
  readonly bodyLimitBytes: number;
  readonly clockSkewSeconds: number;
  readonly toolDescriptions: Readonly<Record<MusterMcpToolName, string>>;
  readonly protectedResourceMetadataPaths: readonly string[];
  readonly scopesSupported: typeof MUSTER_MCP_SCOPES;
}

function canonicalHttpsUrl(
  value: string | URL,
  label: string,
  options: { readonly allowPath: boolean },
): URL {
  let url: URL;
  try {
    url = new URL(value instanceof URL ? value.href : value);
  } catch {
    throw new RangeError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:") throw new RangeError(`${label} must use HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    throw new RangeError(`${label} must not contain credentials, query, or fragment`);
  }
  if (!options.allowPath && url.pathname !== "/") {
    throw new RangeError(`${label} must be an origin without a path`);
  }
  return url;
}

function validateEndpointPath(path: string): string {
  if (
    !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/.test(path) ||
    path.includes("..")
  ) {
    throw new RangeError("endpointPath must be one canonical non-root URL path");
  }
  return path;
}

function validateDescriptions(
  descriptions: Readonly<Record<MusterMcpToolName, string>>,
): Readonly<Record<MusterMcpToolName, string>> {
  const keys = Object.keys(descriptions).sort();
  const expected = [...MUSTER_MCP_TOOL_NAMES].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new RangeError("toolDescriptions must contain exactly the frozen tool names");
  }
  for (const name of MUSTER_MCP_TOOL_NAMES) {
    const description = descriptions[name];
    if (
      description !== DEFAULT_MUSTER_MCP_TOOL_DESCRIPTIONS[name] ||
      description.trim() !== description ||
      description.length === 0 ||
      description.length > 256 ||
      /[\r\n]/.test(description)
    ) {
      throw new RangeError(`description for ${name} is not the closed package value`);
    }
  }
  return { ...descriptions };
}

export function createMusterMcpConfig(input: MusterMcpConfigInput): MusterMcpConfig {
  const endpointPath = validateEndpointPath(input.endpointPath);
  const resource = canonicalHttpsUrl(input.resourceUrl, "resourceUrl", {
    allowPath: true,
  });
  if (resource.pathname !== endpointPath) {
    throw new RangeError("resourceUrl path must equal endpointPath");
  }
  const audience = canonicalHttpsUrl(input.audience, "audience", {
    allowPath: true,
  });
  if (audience.href !== resource.href) {
    throw new RangeError("audience must equal the canonical resourceUrl");
  }
  if (input.authorizationServers.length === 0) {
    throw new RangeError("at least one authorization server is required");
  }

  const issuerUrls = new Set<string>();
  const authorizationServers = input.authorizationServers.map((candidate) => {
    const issuerUrl = canonicalHttpsUrl(candidate.issuerUrl, "issuerUrl", {
      allowPath: true,
    }).href;
    const jwksUrl = canonicalHttpsUrl(candidate.jwksUrl, "jwksUrl", {
      allowPath: true,
    }).href;
    if (issuerUrls.has(issuerUrl)) throw new RangeError("duplicate issuerUrl");
    issuerUrls.add(issuerUrl);
    if (
      candidate.algorithms.length === 0 ||
      new Set(candidate.algorithms).size !== candidate.algorithms.length ||
      candidate.algorithms.some(
        (algorithm) => !MUSTER_MCP_JWT_ALGORITHMS.includes(algorithm),
      )
    ) {
      throw new RangeError("issuer algorithms must be a unique closed JWT set");
    }
    return {
      issuerUrl,
      jwksUrl,
      algorithms: [...candidate.algorithms],
    };
  });

  const allowedOrigins = input.allowedOrigins.map(
    (candidate) =>
      canonicalHttpsUrl(candidate, "allowed Origin", { allowPath: false }).origin,
  );
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new RangeError("allowedOrigins must be unique");
  }
  if (
    !Number.isSafeInteger(input.bodyLimitBytes) ||
    input.bodyLimitBytes < 1_024 ||
    input.bodyLimitBytes > 16 * 1_024 * 1_024
  ) {
    throw new RangeError("bodyLimitBytes must be between 1024 and 16777216");
  }
  if (
    !Number.isSafeInteger(input.clockSkewSeconds) ||
    input.clockSkewSeconds < 0 ||
    input.clockSkewSeconds > 300
  ) {
    throw new RangeError("clockSkewSeconds must be between 0 and 300");
  }

  return deepFreeze({
    resourceUrl: resource.href,
    resourceOrigin: resource.origin,
    endpointPath,
    audience: audience.href,
    authorizationServers,
    allowedOrigins,
    bodyLimitBytes: input.bodyLimitBytes,
    clockSkewSeconds: input.clockSkewSeconds,
    toolDescriptions: validateDescriptions(input.toolDescriptions),
    protectedResourceMetadataPaths: [
      "/.well-known/oauth-protected-resource",
      `/.well-known/oauth-protected-resource${endpointPath}`,
    ],
    scopesSupported: MUSTER_MCP_SCOPES,
  } as const) as MusterMcpConfig;
}
