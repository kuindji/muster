import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(resolve(packageRoot, ".packed-test-"));
const require = createRequire(import.meta.url);

const NOW = "2026-08-08T10:00:00.000Z";
const WORKER_ID = "worker-packed-1";

const ratePolicy = {
  version: "rate-packed-1",
  windowSeconds: 60,
  maxCallsPerWindow: {
    lease_job: 10,
    submit_result: 10,
    abandon_job: 10,
    extend_lease: 10,
    get_worker_status: 10,
    set_availability: 10,
  },
  maxLeaseAttemptsPerSlot: 10,
};

const authenticated = {
  workerId: WORKER_ID,
  subject: {
    issuer: "https://issuer.example/",
    subject: "subject-packed-1",
  },
  scopes: ["muster:access", "muster:jobs", "muster:worker"],
  binding: {
    revision: 1,
    bindingId: "binding-packed-1",
    subject: {
      issuer: "https://issuer.example/",
      subject: "subject-packed-1",
    },
    workerId: WORKER_ID,
    boundAt: NOW,
  },
  workerStatus: {
    workerId: WORKER_ID,
    state: "active",
    contractVersion: "1.1.0",
    jobClassIds: ["class-packed-1"],
    capUsageBucket: 1,
    nextSlotBucket: 0,
    assignedSlotOccurrence: "slot-packed-1",
    nextSlotOccurrence: "slot-packed-1",
  },
  at: NOW,
};

const authorizeCall = async (input) => ({
  kind: "authorized",
  current: {
    workerId: WORKER_ID,
    bindingRevision: 1,
    tool: input.tool,
    ratePolicyVersion: ratePolicy.version,
    rateWindowId: input.window.id,
    assignedSlotOccurrence: input.assignedSlotOccurrence,
    callsUsed: 1,
    leaseAttemptsUsed: input.tool === "lease_job" ? 1 : 0,
    ...(input.availabilityBudgetBucket === undefined
      ? {}
      : { availabilityBudgetBucket: input.availabilityBudgetBucket }),
  },
});

async function successfulResults(module) {
  const jobTools = new module.MusterMcpJobToolDispatcher({
    stateStore: { authorizeCall },
    rateLimitPolicy: ratePolicy,
    leaseService: {
      leaseJob: async () => ({ outcome: "no_work" }),
      extendLease: async () => ({
        outcome: "extended",
        newExpiry: "2026-08-08T10:05:00.000Z",
      }),
      abandonLease: async () => ({ outcome: "recorded" }),
    },
    submissionService: {
      submitResult: async () => ({
        ok: true,
        kind: "accepted",
        receipt: {
          leaseId: "lease-packed-1",
          jobId: "job-packed-1",
          collectionCycle: 1,
          inputHash: "input-packed-1",
          resultHash: "result-packed-1",
          contractVersion: "1.0.0",
          permitEpoch: "epoch-packed-1",
          outcome: "accepted",
          acceptedAt: NOW,
        },
      }),
    },
  });
  const workerTools = new module.MusterMcpWorkerToolDispatcher({
    stateStore: { authorizeCall },
    rateLimitPolicy: ratePolicy,
    controlPlaneService: {
      setWorkerAvailability: async (_workerId, state) => ({
        ok: true,
        kind: "applied",
        worker: { state },
        requeuedLeaseCount: 0,
      }),
    },
    skillReleaseRegistry: {
      select: () => ({ skillSha256: "a".repeat(64) }),
    },
  });
  const calls = [
    jobTools.call(
      "lease_job",
      { availability: { budget_bucket: 2 } },
      authenticated,
    ),
    jobTools.call(
      "submit_result",
      {
        lease_id: "lease-packed-1",
        input_hash: "input-packed-1",
        result: { answer: "packed" },
      },
      authenticated,
    ),
    jobTools.call(
      "abandon_job",
      { lease_id: "lease-packed-1", reason: "platform_failure" },
      authenticated,
    ),
    jobTools.call(
      "extend_lease",
      { lease_id: "lease-packed-1" },
      authenticated,
    ),
    workerTools.call("get_worker_status", {}, authenticated),
    workerTools.call(
      "set_availability",
      { state: "maintenance" },
      authenticated,
    ),
  ];
  return Promise.all(calls).then((results) =>
    results.map((result) => JSON.stringify(result))
  );
}

try {
  const sourceEsm = await import(
    pathToFileURL(resolve(packageRoot, "dist", "index.js")).href
  );
  const { stdout } = await execute(
    "npm",
    ["pack", "--json", "--pack-destination", temporaryRoot],
    { cwd: packageRoot },
  );
  const packResult = JSON.parse(stdout);
  const filename = packResult[0]?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack did not return a package filename");
  }
  await execute("tar", ["-xzf", resolve(temporaryRoot, filename)], {
    cwd: temporaryRoot,
  });
  const packedRoot = resolve(temporaryRoot, "package", "dist");
  const packedEsm = await import(
    `${pathToFileURL(resolve(packedRoot, "index.js")).href}?packed=1`
  );
  const packedCjs = require(resolve(packedRoot, "index.cjs"));

  for (const module of [sourceEsm, packedEsm, packedCjs]) {
    for (const name of [
      "runMusterMcpConformance",
      "MusterMcpJobToolDispatcher",
      "MusterMcpWorkerToolDispatcher",
    ]) {
      if (typeof module[name] !== "function") {
        throw new TypeError(`packed export ${name} is missing`);
      }
    }
  }

  const sourceResults = await successfulResults(sourceEsm);
  const esmResults = await successfulResults(packedEsm);
  const cjsResults = await successfulResults(packedCjs);
  if (
    JSON.stringify(sourceResults) !== JSON.stringify(esmResults) ||
    JSON.stringify(sourceResults) !== JSON.stringify(cjsResults)
  ) {
    throw new Error("source/packed ESM/CJS successful results differ");
  }
  process.stdout.write(
    `packed MCP parity ok (${sourceResults.length} successful tool results)\n`,
  );
} finally {
  const expectedPrefix = `${packageRoot}${sep}.packed-test-`;
  if (!temporaryRoot.startsWith(expectedPrefix)) {
    throw new Error(`refusing to remove unexpected path ${temporaryRoot}`);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
