import {
  CustomerProfileError,
  customerInstant,
  customerReference,
  type CustomerInstant,
  type CustomerReference,
} from "./customer-profile.js";

export type ConsentPurpose = "Marketing" | "Loyalty" | "Personalization";
export type ContactChannel = "Email" | "SMS" | "Push" | "WeChat";
export type ConsentStatus = "Granted" | "Withdrawn";
export type CommunicationClass = "Marketing" | "Operational";
export interface ConsentChoice {
  readonly consentReference: CustomerReference;
  readonly purpose: ConsentPurpose;
  readonly channel: ContactChannel;
  readonly status: ConsentStatus;
  readonly contactMethodReference: CustomerReference;
  readonly policyVersion: string;
  readonly jurisdictionCode: string;
  readonly sourceCode: string;
  readonly actorReference: CustomerReference;
  readonly effectiveAt: CustomerInstant;
  readonly recordedAt: CustomerInstant;
  readonly evidenceReference: CustomerReference;
}
export interface ContactPreference {
  readonly preferredLanguage: string;
  readonly preferredChannel: ContactChannel | null;
  readonly quietHours: null | { readonly startMinute: number; readonly endMinute: number };
  readonly frequencyCode: "TransactionalOnly" | "Standard" | "Reduced";
  readonly storeReference: CustomerReference | null;
  readonly evidenceReference: CustomerReference;
  readonly actorReference: CustomerReference;
  readonly recordedAt: CustomerInstant;
}
export interface ConsentPreferenceRecord {
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly customerReference: CustomerReference;
  readonly choices: readonly ConsentChoice[];
  readonly preference: ContactPreference | null;
  readonly aggregateVersion: number;
  readonly updatedAt: CustomerInstant;
}
const fail = (
  code: ConstructorParameters<typeof CustomerProfileError>[0] = "CUSTOMER_PROFILE_INVALID",
): never => {
  throw new CustomerProfileError(code);
};
const token = (v: unknown, pattern = /^[A-Z][A-Za-z0-9_-]{0,63}$/u) =>
  typeof v === "string" && pattern.test(v) ? v : fail();
const expected = (record: ConsentPreferenceRecord, version: number) => {
  if (!Number.isSafeInteger(version) || record.aggregateVersion !== version)
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
};
const later = (record: ConsentPreferenceRecord, at: CustomerInstant) => {
  if (record.updatedAt > at) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
};
export function createConsentPreferenceRecord(input: {
  tenantReference: unknown;
  brandReference: unknown;
  customerReference: unknown;
  occurredAt: unknown;
}): ConsentPreferenceRecord {
  return Object.freeze({
    tenantReference: customerReference(input.tenantReference),
    brandReference: customerReference(input.brandReference),
    customerReference: customerReference(input.customerReference),
    choices: Object.freeze([]),
    preference: null,
    aggregateVersion: 1,
    updatedAt: customerInstant(input.occurredAt),
  });
}
export function recordConsentChoice(
  record: ConsentPreferenceRecord,
  input: {
    expectedVersion: number;
    consentReference: unknown;
    purpose: ConsentPurpose;
    channel: ContactChannel;
    status: ConsentStatus;
    contactMethodReference: unknown;
    policyVersion: unknown;
    jurisdictionCode: unknown;
    sourceCode: unknown;
    actorReference: unknown;
    effectiveAt: unknown;
    recordedAt: unknown;
    evidenceReference: unknown;
  },
): ConsentPreferenceRecord {
  expected(record, input.expectedVersion);
  if (
    !["Marketing", "Loyalty", "Personalization"].includes(input.purpose) ||
    !["Email", "SMS", "Push", "WeChat"].includes(input.channel) ||
    !["Granted", "Withdrawn"].includes(input.status)
  )
    fail();
  const effectiveAt = customerInstant(input.effectiveAt),
    recordedAt = customerInstant(input.recordedAt),
    consentReference = customerReference(input.consentReference);
  later(record, recordedAt);
  if (effectiveAt > recordedAt) fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
  if (record.choices.some((item) => item.consentReference === consentReference))
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const latest = latestConsent(record, input.purpose, input.channel);
  if (latest && latest.effectiveAt > effectiveAt) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const choice: ConsentChoice = Object.freeze({
    consentReference,
    purpose: input.purpose,
    channel: input.channel,
    status: input.status,
    contactMethodReference: customerReference(input.contactMethodReference),
    policyVersion: token(input.policyVersion, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    jurisdictionCode: token(input.jurisdictionCode),
    sourceCode: token(input.sourceCode),
    actorReference: customerReference(input.actorReference),
    effectiveAt,
    recordedAt,
    evidenceReference: customerReference(input.evidenceReference),
  });
  return Object.freeze({
    ...record,
    choices: Object.freeze([...record.choices, choice]),
    aggregateVersion: record.aggregateVersion + 1,
    updatedAt: recordedAt,
  });
}
export function updateContactPreference(
  record: ConsentPreferenceRecord,
  input: {
    expectedVersion: number;
    preferredLanguage: unknown;
    preferredChannel: ContactChannel | null;
    quietHours: null | { readonly startMinute: number; readonly endMinute: number };
    frequencyCode: ContactPreference["frequencyCode"];
    storeReference: unknown | null;
    evidenceReference: unknown;
    actorReference: unknown;
    recordedAt: unknown;
  },
): ConsentPreferenceRecord {
  expected(record, input.expectedVersion);
  if (
    (input.preferredChannel !== null &&
      !["Email", "SMS", "Push", "WeChat"].includes(input.preferredChannel)) ||
    !["TransactionalOnly", "Standard", "Reduced"].includes(input.frequencyCode)
  )
    fail();
  if (
    input.quietHours !== null &&
    (![input.quietHours.startMinute, input.quietHours.endMinute].every(
      (v) => Number.isSafeInteger(v) && v >= 0 && v < 1440,
    ) ||
      input.quietHours.startMinute === input.quietHours.endMinute)
  )
    fail();
  const recordedAt = customerInstant(input.recordedAt);
  later(record, recordedAt);
  return Object.freeze({
    ...record,
    preference: Object.freeze({
      preferredLanguage: token(input.preferredLanguage, /^[a-z]{2,3}(?:-[A-Z]{2})?$/u),
      preferredChannel: input.preferredChannel,
      quietHours: input.quietHours === null ? null : Object.freeze({ ...input.quietHours }),
      frequencyCode: input.frequencyCode,
      storeReference:
        input.storeReference === null ? null : customerReference(input.storeReference),
      evidenceReference: customerReference(input.evidenceReference),
      actorReference: customerReference(input.actorReference),
      recordedAt,
    }),
    aggregateVersion: record.aggregateVersion + 1,
    updatedAt: recordedAt,
  });
}
export function latestConsent(
  record: ConsentPreferenceRecord,
  purpose: ConsentPurpose,
  channel: ContactChannel,
): ConsentChoice | null {
  return (
    [...record.choices]
      .filter((choice) => choice.purpose === purpose && choice.channel === channel)
      .sort(
        (a, b) =>
          b.effectiveAt.localeCompare(a.effectiveAt) || b.recordedAt.localeCompare(a.recordedAt),
      )[0] ?? null
  );
}
export function evaluateCommunicationPermission(input: {
  record: ConsentPreferenceRecord;
  classification: CommunicationClass;
  purpose: ConsentPurpose;
  channel: ContactChannel;
}): Readonly<{ allowed: boolean; consentReference: CustomerReference | null; reason: string }> {
  if (input.classification === "Operational")
    return Object.freeze({ allowed: true, consentReference: null, reason: "OPERATIONAL_SEPARATE" });
  const latest = latestConsent(input.record, input.purpose, input.channel);
  return Object.freeze({
    allowed: latest?.status === "Granted",
    consentReference: latest?.consentReference ?? null,
    reason: latest?.status === "Granted" ? "CURRENT_GRANT" : "NO_CURRENT_GRANT",
  });
}
