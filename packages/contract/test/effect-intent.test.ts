import { describe, expect, it } from "vitest";

import { hashCanonical } from "../src/canonical/sha256.js";
import {
  canonicalEffectIntent,
  computeEffectIntentHash,
} from "../src/effect.js";
import type { EffectIntent } from "../src/effect.js";

const intent: EffectIntent = {
  id: "intent-1",
  effects: [
    {
      action: "suppress",
      descriptor: { reason: "duplicate", of: "item-9" },
    },
    {
      action: "mutateCanonicalState",
      descriptor: { dedupKey: "k-1" },
    },
  ],
};

describe("canonicalEffectIntent (spec 4.3)", () => {
  it("sorts effects into stable Action enum order", () => {
    const out = canonicalEffectIntent(intent);

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.effects.map((effect) => effect.action)).toEqual([
        "mutateCanonicalState",
        "suppress",
      ]);
    }
  });

  it("rejects duplicate actions", () => {
    const duplicate: EffectIntent = {
      id: "i",
      effects: [
        { action: "suppress", descriptor: {} },
        { action: "suppress", descriptor: {} },
      ],
    };

    expect(canonicalEffectIntent(duplicate)).toEqual({
      ok: false,
      error: "duplicate_action",
    });
  });

  it("rejects unknown actions", () => {
    const invalid = {
      id: "i",
      effects: [{ action: "detonate", descriptor: {} }],
    } as unknown as EffectIntent;

    expect(canonicalEffectIntent(invalid)).toEqual({
      ok: false,
      error: "unknown_action",
    });
  });

  it("rejects an empty effects array", () => {
    const empty = { id: "i", effects: [] } as unknown as EffectIntent;

    expect(canonicalEffectIntent(empty)).toEqual({
      ok: false,
      error: "empty_effects",
    });
  });
});

describe("computeEffectIntentHash", () => {
  it("is hashCanonical({ id, effects }) over sorted effects", async () => {
    const sorted = canonicalEffectIntent(intent);
    if (!sorted.ok) throw new Error("unexpected invalid effect intent");

    await expect(computeEffectIntentHash(intent)).resolves.toBe(
      await hashCanonical({
        id: sorted.value.id,
        effects: sorted.value.effects,
      }),
    );
  });

  it("is order-insensitive in the caller's effect list", async () => {
    const reversed: EffectIntent = {
      id: intent.id,
      effects: [intent.effects[1]!, intent.effects[0]!],
    };

    await expect(computeEffectIntentHash(reversed)).resolves.toBe(
      await computeEffectIntentHash(intent),
    );
  });

  it("differs when a descriptor differs", async () => {
    const other: EffectIntent = {
      id: intent.id,
      effects: [
        {
          action: "suppress",
          descriptor: { reason: "duplicate", of: "item-8" },
        },
        {
          action: "mutateCanonicalState",
          descriptor: { dedupKey: "k-1" },
        },
      ],
    };

    await expect(computeEffectIntentHash(other)).resolves.not.toBe(
      await computeEffectIntentHash(intent),
    );
  });
});
