import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../src/memory-store.js";
import {
  privacyLedgerEntry,
  privacyNotificationContent,
} from "../src/privacy.js";

const base = {
  at: "2026-08-07T15:00:00.000Z",
  kind: "submit",
  outcome: "accepted",
  hashes: { result: "result-hash" },
  body: { answer: "private" },
  descriptors: { target: "customer-record" },
} as const;

describe("M2 Task 8 privacy integration", () => {
  it("retains public/internal ledger content and makes sensitive hash-only", () => {
    expect(privacyLedgerEntry({ ...base, privacy: "public" })).toMatchObject({
      body: base.body,
      descriptors: base.descriptors,
    });
    expect(privacyLedgerEntry({ ...base, privacy: "internal" })).toMatchObject({
      body: base.body,
      descriptors: base.descriptors,
    });
    expect(privacyLedgerEntry({ ...base, privacy: "sensitive" })).toEqual({
      at: base.at,
      kind: base.kind,
      outcome: base.outcome,
      privacy: "sensitive",
      hashes: base.hashes,
    });
  });

  it("shows bodies and descriptors only in public notifications", () => {
    const content = { body: base.body, descriptors: base.descriptors };
    expect(privacyNotificationContent("public", content)).toEqual(content);
    expect(privacyNotificationContent("internal", content)).toEqual({});
    expect(privacyNotificationContent("sensitive", content)).toEqual({});
  });

  it("crosses the Store boundary without privacy refusal", async () => {
    const store = new InMemoryStore({
      initialQueue: { mode: "normal", updatedAt: base.at },
    });
    await expect(store.appendLedger(privacyLedgerEntry({
      ...base,
      privacy: "sensitive",
    }))).resolves.toEqual({ kind: "recorded" });
    expect(await store.listLedger()).toEqual([
      privacyLedgerEntry({ ...base, privacy: "sensitive" }),
    ]);
  });
});
