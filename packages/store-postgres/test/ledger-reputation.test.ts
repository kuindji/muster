import {
  runTask8StoreConformance,
  type LedgerEntry,
  type ReputationEvidenceRecord,
  type Store,
  type WorkerRegistration,
} from "@kuindji/muster-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapMusterPostgres,
  migrateMusterPostgres,
  PostgresInfrastructureError,
  PostgresStore,
} from "../src/index.js";
import {
  startPostgresHarness,
  type PostgresTestHarness,
} from "./postgres-harness.js";

const NOW = "2026-08-08T08:00:00.000Z";
const LATER = "2026-08-08T08:01:00.000Z";

const workerRegistration = (workerId = "worker-ledger"): WorkerRegistration => ({
  worker: {
    workerId,
    state: "active",
    enrolledAt: NOW,
    declaredCapPerWeek: 4,
    capabilities: {
      providerSurface: "provider.example",
      unattendedScheduling: true,
      languages: ["en"],
      jobClassIds: ["class-ledger"],
    },
    accountCluster: "cluster-ledger",
    slot: 1,
    contractAcceptance: { contractVersion: "1.1.0", acceptedAt: NOW },
  },
  routing: {
    contributionWindowId: "2026-W32",
    contributionUsed: 0,
    assignedSlotOccurrence: "2026-W32-slot-1",
  },
});

type LedgerEntryOverrides = Omit<Partial<LedgerEntry>, "body" | "descriptors"> & {
  body?: LedgerEntry["body"] | undefined;
  descriptors?: LedgerEntry["descriptors"] | undefined;
};

const ledgerEntry = (overrides: LedgerEntryOverrides = {}): LedgerEntry => {
  const entry = {
    at: NOW,
    kind: "submit",
    outcome: "accepted",
    privacy: "internal",
    classId: "class-ledger",
    workerId: "worker-ledger",
    hashes: { result: "result-hash" },
    body: { nested: { retained: true } },
    ...overrides,
  } as unknown as LedgerEntry;
  if (Object.hasOwn(overrides, "body") && overrides.body === undefined) {
    delete (entry as { body?: LedgerEntry["body"] }).body;
  }
  if (Object.hasOwn(overrides, "descriptors") &&
      overrides.descriptors === undefined) {
    delete (entry as { descriptors?: LedgerEntry["descriptors"] }).descriptors;
  }
  return entry;
};

const evidence = (
  evidenceId: string,
  overrides: Partial<ReputationEvidenceRecord> = {},
): ReputationEvidenceRecord => ({
  evidenceId,
  workerId: "worker-ledger",
  at: NOW,
  source: "validator_failure",
  impact: "negative",
  detailHash: `detail-${evidenceId}`,
  ...overrides,
} as ReputationEvidenceRecord);

describe("PostgreSQL ledger and reputation Store slice", () => {
  let harness: PostgresTestHarness;
  const schemas: string[] = [];

  beforeAll(async () => {
    harness = await startPostgresHarness();
  });

  afterAll(async () => {
    for (const schema of schemas) await harness.dropSchema(schema);
    await harness.stop();
  });

  const createStore = async (): Promise<PostgresStore> => {
    const schema = await harness.createSchema();
    schemas.push(schema);
    await migrateMusterPostgres({ pool: harness.pool, schema });
    await bootstrapMusterPostgres({
      pool: harness.pool,
      schema,
      initialQueue: { mode: "normal", updatedAt: NOW },
    });
    return new PostgresStore({ pool: harness.pool, schema });
  };

  const registerWorker = async (store: Store): Promise<void> => {
    const registered = await store.registerWorker(workerRegistration());
    expect(registered.kind).toBe("registered");
  };

  it("passes the complete cumulative Task-8 Store conformance runner", async () => {
    await runTask8StoreConformance(createStore);
  }, 60_000);

  it("rejects invalid or sensitive content before allocating a ledger ordinal", async () => {
    const store = await createStore();
    await expect(store.appendLedger(ledgerEntry({
      privacy: "sensitive",
      body: { secret: true },
    }))).resolves.toEqual({ kind: "refused", reason: "privacy_violation" });
    await expect(store.appendLedger(ledgerEntry({
      privacy: "sensitive",
      body: undefined,
      descriptors: { secret: true },
    }))).resolves.toEqual({ kind: "refused", reason: "privacy_violation" });
    await expect(store.appendLedger({
      ...ledgerEntry({ body: undefined }),
      unexpected: "field",
    } as LedgerEntry)).resolves.toEqual({
      kind: "refused",
      reason: "invalid_entry",
    });

    await expect(store.appendLedger(ledgerEntry({
      privacy: "sensitive",
      body: undefined,
    }))).resolves.toEqual({ kind: "recorded" });
    const sequence = await harness.pool.query<{ ledger_sequence: string }>(
      `SELECT ledger_sequence::text
         FROM ${store.quotedSchema}.ledger_entries`,
    );
    expect(sequence.rows).toEqual([{ ledger_sequence: "1" }]);
  });

  it("persists detached ledger values in append order with exact filters", async () => {
    const store = await createStore();
    const entries = [
      ledgerEntry(),
      ledgerEntry({ kind: "lease", classId: "class-other", body: ["second"] }),
      ledgerEntry({ kind: "lease", body: { ordinal: 3 } }),
    ];
    for (const entry of entries) {
      await expect(store.appendLedger(entry)).resolves.toEqual({ kind: "recorded" });
    }

    const restarted = new PostgresStore({ pool: harness.pool, schema: store.schema });
    const listed = await restarted.listLedger();
    expect(listed).toEqual(entries);
    expect(await restarted.listLedger({ kind: "lease" })).toEqual(entries.slice(1));
    expect(await restarted.listLedger({
      classId: "class-ledger",
      kind: "lease",
    })).toEqual([entries[2]]);

    const mutable = listed[0]!.body as { nested: { retained: boolean } };
    mutable.nested.retained = false;
    expect((await restarted.listLedger())[0]).toEqual(entries[0]);
  });

  it("records, replays, conflicts, races, restarts, and bytewise-orders evidence", async () => {
    const store = await createStore();
    await registerWorker(store);
    const racer = new PostgresStore({ pool: harness.pool, schema: store.schema });
    const exact = evidence("evidence-race", { at: LATER });
    const exactRace = await Promise.all([
      store.recordReputationEvidence(exact),
      racer.recordReputationEvidence(exact),
    ]);
    expect(exactRace.map(({ kind }) => kind).sort()).toEqual([
      "recorded",
      "replayed",
    ]);

    const changedRace = await Promise.all([
      store.recordReputationEvidence(evidence("evidence-conflict", {
        source: "validator_failure",
        impact: "negative",
      })),
      racer.recordReputationEvidence(evidence("evidence-conflict", {
        source: "structural_failure",
        impact: "negative",
      })),
    ]);
    expect(changedRace.map(({ kind }) => kind).sort()).toEqual([
      "conflict",
      "recorded",
    ]);

    await store.recordReputationEvidence(evidence("evidence-z", { at: NOW }));
    await store.recordReputationEvidence(evidence("evidence-a", { at: NOW }));
    const restarted = new PostgresStore({ pool: harness.pool, schema: store.schema });
    expect((await restarted.listReputationEvidence("worker-ledger")).map(
      ({ evidenceId }) => evidenceId,
    )).toEqual([
      "evidence-a",
      "evidence-conflict",
      "evidence-z",
      "evidence-race",
    ]);
  });

  it("fails closed for raw evidence fields and malformed stored rows", async () => {
    const store = await createStore();
    await registerWorker(store);
    await expect(store.recordReputationEvidence({
      ...evidence("evidence-raw"),
      resultBody: { secret: true },
      oauthSubject: "raw-subject",
    } as unknown as ReputationEvidenceRecord)).rejects.toMatchObject({
      code: "invalid_stored_value",
    } satisfies Partial<PostgresInfrastructureError>);
    expect(await store.listReputationEvidence("worker-ledger")).toEqual([]);

    await store.appendLedger(ledgerEntry({ body: undefined }));
    await harness.pool.query(
      `UPDATE ${store.quotedSchema}.ledger_entries
          SET record = '{"kind":"broken"}'::jsonb`,
    );
    await expect(store.listLedger()).rejects.toMatchObject({
      code: "invalid_stored_value",
    });

    await store.recordReputationEvidence(evidence("evidence-malformed"));
    await harness.pool.query(
      `UPDATE ${store.quotedSchema}.reputation_evidence
          SET record = record || '{"oauthSubject":"raw"}'::jsonb
        WHERE evidence_id = 'evidence-malformed'`,
    );
    await expect(store.listReputationEvidence("worker-ledger"))
      .rejects.toMatchObject({ code: "invalid_stored_value" });
  });
});
