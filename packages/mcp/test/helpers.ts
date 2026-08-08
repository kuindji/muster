import {
  DEFAULT_MUSTER_MCP_TOOL_DESCRIPTIONS,
  type MusterMcpAuthenticationDependencies,
  type MusterMcpConfig,
  type MusterMcpConfigInput,
} from "../src/index.js";
import type {
  AuthorizeMcpCallInput,
  McpRateLimitPolicy,
  McpSubjectBinding,
  MusterMcpScope,
} from "@kuindji/muster-contract";
import {
  computeSkillSha256,
  renderSkill,
  type SkillSource,
} from "@kuindji/muster-contract";
import {
  SkillReleaseRegistry,
  type MusterMcpJobToolDependencies,
  type MusterMcpWorkerToolDependencies,
} from "../src/index.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export const TEST_NOW = "2026-08-08T10:00:00.000Z";
export const TEST_SUBJECT = "subject-test-1";
export const TEST_WORKER_ID = "worker-test-1";

export const TEST_RATE_LIMIT_POLICY: McpRateLimitPolicy = {
  version: "rate-test-1",
  windowSeconds: 60,
  maxCallsPerWindow: {
    lease_job: 20,
    submit_result: 20,
    abandon_job: 20,
    extend_lease: 20,
    get_worker_status: 20,
    set_availability: 20,
  },
  maxLeaseAttemptsPerSlot: 20,
};

export function createTestJobTools(
  overrides: Partial<MusterMcpJobToolDependencies> = {},
): MusterMcpJobToolDependencies {
  return {
    stateStore: {
      authorizeCall: async (input: AuthorizeMcpCallInput) => ({
        kind: "authorized" as const,
        current: {
          workerId: input.expectedBinding.workerId,
          bindingRevision: input.expectedBinding.revision,
          tool: input.tool,
          ratePolicyVersion: input.policy.version,
          rateWindowId: input.window.id,
          assignedSlotOccurrence: input.assignedSlotOccurrence,
          callsUsed: 1,
          leaseAttemptsUsed: input.tool === "lease_job" ? 1 : 0,
          ...(input.availabilityBudgetBucket === undefined
            ? {}
            : { availabilityBudgetBucket: input.availabilityBudgetBucket }),
        },
      }),
    },
    rateLimitPolicy: TEST_RATE_LIMIT_POLICY,
    leaseService: {
      leaseJob: async () => ({ outcome: "no_work" as const }),
      extendLease: async () => ({ outcome: "refused" as const }),
      abandonLease: async () => ({ outcome: "refused" as const }),
    },
    submissionService: {
      submitResult: async () => ({
        ok: false as const,
        error: "lease_not_held" as const,
      }),
    },
    ...overrides,
  };
}

const testSkillSource: SkillSource = {
  contractVersion: "1.1.0",
  jobClassIds: ["class-test-1"],
  instructions: "Lease one registered test job and submit its result.",
};

const testSkillReleaseRegistry = (async () => {
  const rendered = renderSkill(testSkillSource);
  return SkillReleaseRegistry.create([{
    source: testSkillSource,
    skillSha256: await computeSkillSha256(rendered),
  }]);
})();

export async function createTestWorkerTools(
  overrides: Partial<MusterMcpWorkerToolDependencies> = {},
): Promise<MusterMcpWorkerToolDependencies> {
  return {
    stateStore: {
      authorizeCall: async (input: AuthorizeMcpCallInput) => ({
        kind: "authorized" as const,
        current: {
          workerId: input.expectedBinding.workerId,
          bindingRevision: input.expectedBinding.revision,
          tool: input.tool,
          ratePolicyVersion: input.policy.version,
          rateWindowId: input.window.id,
          assignedSlotOccurrence: input.assignedSlotOccurrence,
          callsUsed: 1,
          leaseAttemptsUsed: 0,
        },
      }),
    },
    rateLimitPolicy: TEST_RATE_LIMIT_POLICY,
    controlPlaneService: {
      setWorkerAvailability: async (_workerId, to) => ({
        ok: true as const,
        kind: "applied" as const,
        worker: {
          workerId: TEST_WORKER_ID,
          state: to,
          enrolledAt: TEST_NOW,
          declaredCapPerWeek: 4,
          capabilities: {
            providerSurface: "provider.example",
            unattendedScheduling: true,
            languages: ["en"],
            jobClassIds: ["class-test-1"],
          },
          accountCluster: "cluster-test-1",
          slot: 1,
          contractAcceptance: {
            contractVersion: "1.1.0",
            acceptedAt: TEST_NOW,
          },
        },
        requeuedLeaseCount: 0,
      }),
    },
    skillReleaseRegistry: await testSkillReleaseRegistry,
    ...overrides,
  };
}

const keyMaterial = generateKeyPair("RS256").then(async ({ privateKey, publicKey }) => {
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { ...publicJwk, kid: "test-key-1", alg: "RS256", use: "sig" },
  };
});

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

export async function createTestAuthentication(
  config: MusterMcpConfig,
  options: {
    readonly scopes?: readonly MusterMcpScope[];
    readonly revoked?: boolean;
    readonly mapped?: boolean;
    readonly workerAvailable?: boolean;
  } = {},
): Promise<{
  readonly authentication: MusterMcpAuthenticationDependencies;
  readonly token: string;
  readonly authorizationHeader: string;
}> {
  const keys = await keyMaterial;
  const scopes = options.scopes ?? ["muster:access", "muster:jobs", "muster:worker"];
  const token = await new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1", typ: "at+jwt" })
    .setIssuer(config.authorizationServers[0]!.issuerUrl)
    .setAudience(config.audience)
    .setSubject(TEST_SUBJECT)
    .setIssuedAt(Math.floor(Date.parse(TEST_NOW) / 1_000))
    .setExpirationTime(Math.floor(Date.parse(TEST_NOW) / 1_000) + 300)
    .sign(keys.privateKey);
  const binding: McpSubjectBinding = {
    revision: 1,
    bindingId: "binding-test-1",
    subject: {
      issuer: config.authorizationServers[0]!.issuerUrl,
      subject: TEST_SUBJECT,
    },
    workerId: TEST_WORKER_ID,
    boundAt: TEST_NOW,
  };
  const jwksFetch: typeof fetch = async () => new Response(
    JSON.stringify({ keys: [keys.publicJwk] }),
    {
      status: 200,
      headers: {
        "content-type": "application/jwk-set+json",
        "cache-control": "public, max-age=60",
      },
    },
  );
  return {
    authentication: {
      clock: { now: () => TEST_NOW },
      revocationSource: { isRevoked: async () => options.revoked ?? false },
      stateStore: {
        resolveSubject: async () => options.mapped === false ? null : binding,
      },
      workerStatus: {
        getWorkerStatus: async () => options.workerAvailable === false
          ? { ok: false as const, kind: "unavailable" as const }
          : {
              ok: true as const,
              status: {
                workerId: TEST_WORKER_ID,
                state: "active" as const,
                contractVersion: "1.1.0",
                jobClassIds: ["class-test-1"],
                capUsageBucket: 0 as const,
                nextSlotBucket: 0 as const,
                assignedSlotOccurrence: "slot-test-1",
                nextSlotOccurrence: "slot-test-1",
              },
            },
      },
      fetch: jwksFetch,
    },
    token,
    authorizationHeader: `Bearer ${token}`,
  };
}
