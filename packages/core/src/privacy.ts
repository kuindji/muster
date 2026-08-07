import {
  PRIVACY_CLASS_RULES,
  type CanonicalJsonValue,
  type PrivacyClass,
} from "@kuindji/muster-contract";

import type { LedgerEntry } from "./ports.js";

export interface PrivacyContent {
  readonly body?: CanonicalJsonValue;
  readonly descriptors?: CanonicalJsonValue;
}

/** Apply the frozen ledger-retention rule before crossing the Store boundary. */
export const privacyLedgerEntry = (
  entry: Omit<LedgerEntry, "body" | "descriptors"> & PrivacyContent,
): LedgerEntry => {
  const rules = PRIVACY_CLASS_RULES[entry.privacy];
  const { body, descriptors, ...base } = entry;
  if (rules.ledgerBodies === "hash_only") return structuredClone(base);
  return structuredClone({
    ...base,
    ...(body === undefined ? {} : { body }),
    ...(descriptors === undefined
      ? {}
      : { descriptors }),
  });
};

/** Consumer-notification visibility is stricter than ledger retention. */
export const privacyNotificationContent = (
  privacy: PrivacyClass,
  content: PrivacyContent,
): PrivacyContent => {
  const rules = PRIVACY_CLASS_RULES[privacy];
  return structuredClone({
    ...(rules.bodiesInConsumerNotifications && content.body !== undefined
      ? { body: content.body }
      : {}),
    ...(rules.descriptorsInConsumerNotifications &&
        content.descriptors !== undefined
      ? { descriptors: content.descriptors }
      : {}),
  });
};
