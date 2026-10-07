import {
  exactPaymentObject,
  parsePaymentDigest,
  parsePaymentInstant,
} from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";

export type StorePaymentConfigurationErrorCode =
  | "STORE_PAYMENT_CONFIGURATION_INPUT_INVALID"
  | "STORE_PAYMENT_CONFIGURATION_PERMISSION_DENIED"
  | "STORE_PAYMENT_CONFIGURATION_VERSION_CONFLICT"
  | "STORE_PAYMENT_CONFIGURATION_IDEMPOTENCY_CONFLICT"
  | "STORE_PAYMENT_CONFIGURATION_DEPENDENCY_UNAVAILABLE";
export class StorePaymentConfigurationError extends Error {
  constructor(readonly code: StorePaymentConfigurationErrorCode) {
    super("Store payment configuration is unavailable");
    this.name = "StorePaymentConfigurationError";
  }
}
const invalid = (): never => {
  throw new StorePaymentConfigurationError("STORE_PAYMENT_CONFIGURATION_INPUT_INVALID");
};
function protect<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
export interface StorePaymentConfigurationContent {
  readonly customerOnlineCardEnabled: boolean;
  readonly staffTerminalCardPresentEnabled: boolean;
  readonly staffTerminalInteracEnabled: boolean;
}
export interface StorePaymentConfigurationScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface StorePaymentConfigurationActorScope extends StorePaymentConfigurationScope {
  readonly actorReference: string;
}
export interface StorePaymentConfigurationVersion extends StorePaymentConfigurationScope {
  readonly profile: "StorePaymentConfigurationV1";
  readonly configurationReference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly previousConfigurationReference: string | null;
  readonly content: StorePaymentConfigurationContent;
  readonly currencyCode: "CAD";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "Internal";
}
interface OriginalIdentity extends StorePaymentConfigurationActorScope {
  readonly operationReference: string;
  readonly expectedConfigurationReference: string | null;
  readonly expectedRevision: number;
  readonly purposeCode: "STORE_PAYMENT_CONFIGURATION";
}
export interface StorePaymentConfigurationSave extends OriginalIdentity {
  readonly profile: "StorePaymentConfigurationSaveV1";
  readonly content: StorePaymentConfigurationContent;
}
export interface StorePaymentConfigurationResolve extends OriginalIdentity {
  readonly profile: "StorePaymentConfigurationResolveV1";
  readonly intentDigest: string;
}
export interface StorePaymentConfigurationReceipt extends StorePaymentConfigurationActorScope {
  readonly profile: "StorePaymentConfigurationReceiptV1";
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly expectedConfigurationReference: string | null;
  readonly expectedRevision: number;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: StorePaymentConfigurationVersion | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export interface StorePaymentConfigurationCurrent extends StorePaymentConfigurationActorScope {
  readonly profile: "StorePaymentConfigurationCurrentV1";
  readonly snapshot: StorePaymentConfigurationVersion | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly providerReadiness: "NotEvaluated";
}
/** This fixed owning field inventory is not proof of Provider readiness or authorization. */
export const storePaymentConfigurationRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "operationReference",
  "expectedConfigurationReference",
  "expectedRevision",
  "configurationReference",
  "revision",
  "authoredByReference",
  "previousConfigurationReference",
  "content",
  "currencyCode",
  "createdAt",
  "updatedAt",
  "dataClassification",
  "intentDigest",
  "outcome",
  "snapshot",
  "auditReference",
  "occurredAt",
] as const);
const scopeKeys = ["tenantReference", "brandReference", "storeReference"] as const;
const actorScopeKeys = [...scopeKeys, "actorReference"];
const reference = (value: unknown): string => parsePaymentReference(value);
function scope(value: Readonly<Record<string, unknown>>): StorePaymentConfigurationScope {
  return {
    tenantReference: reference(value.tenantReference),
    brandReference: reference(value.brandReference),
    storeReference: reference(value.storeReference),
  };
}
function actorScope(value: Readonly<Record<string, unknown>>): StorePaymentConfigurationActorScope {
  return { ...scope(value), actorReference: reference(value.actorReference) };
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    return invalid();
  return value;
}
function pins(value: Readonly<Record<string, unknown>>) {
  const expectedRevision = revision(value.expectedRevision),
    expectedConfigurationReference =
      value.expectedConfigurationReference === null
        ? null
        : reference(value.expectedConfigurationReference);
  if ((expectedRevision === 0) !== (expectedConfigurationReference === null)) return invalid();
  return { expectedRevision, expectedConfigurationReference };
}
/** Three explicit channel choices only. All disabled remains a legal saved rule,
 * never a declaration that the Store or any Provider is ready to accept payment. */
export function parseStorePaymentConfigurationContent(
  value: unknown,
): StorePaymentConfigurationContent {
  return protect(() => {
    const r = exactPaymentObject(value, [
      "customerOnlineCardEnabled",
      "staffTerminalCardPresentEnabled",
      "staffTerminalInteracEnabled",
    ]);
    if (
      typeof r.customerOnlineCardEnabled !== "boolean" ||
      typeof r.staffTerminalCardPresentEnabled !== "boolean" ||
      typeof r.staffTerminalInteracEnabled !== "boolean"
    )
      return invalid();
    return Object.freeze({
      customerOnlineCardEnabled: r.customerOnlineCardEnabled,
      staffTerminalCardPresentEnabled: r.staffTerminalCardPresentEnabled,
      staffTerminalInteracEnabled: r.staffTerminalInteracEnabled,
    });
  });
}
export function parseStorePaymentConfigurationVersion(
  value: unknown,
): StorePaymentConfigurationVersion {
  return protect(() => {
    const r = exactPaymentObject(value, [
      "profile",
      ...scopeKeys,
      "configurationReference",
      "revision",
      "authoredByReference",
      "previousConfigurationReference",
      "content",
      "currencyCode",
      "createdAt",
      "updatedAt",
      "dataClassification",
    ]);
    const rev = revision(r.revision),
      configurationReference = reference(r.configurationReference),
      previousConfigurationReference =
        r.previousConfigurationReference === null
          ? null
          : reference(r.previousConfigurationReference),
      createdAt = parsePaymentInstant(r.createdAt),
      updatedAt = parsePaymentInstant(r.updatedAt);
    if (
      r.profile !== "StorePaymentConfigurationV1" ||
      r.currencyCode !== "CAD" ||
      r.dataClassification !== "Internal" ||
      rev === 0 ||
      (rev === 1) !== (previousConfigurationReference === null) ||
      configurationReference === previousConfigurationReference ||
      updatedAt < createdAt ||
      (rev === 1 && updatedAt !== createdAt)
    )
      return invalid();
    return Object.freeze({
      profile: "StorePaymentConfigurationV1",
      ...scope(r),
      configurationReference,
      revision: rev,
      authoredByReference: reference(r.authoredByReference),
      previousConfigurationReference,
      content: parseStorePaymentConfigurationContent(r.content),
      currencyCode: "CAD",
      createdAt,
      updatedAt,
      dataClassification: "Internal",
    });
  });
}
const identityKeys = [
  ...actorScopeKeys,
  "operationReference",
  "expectedConfigurationReference",
  "expectedRevision",
  "purposeCode",
];
function identity(r: Readonly<Record<string, unknown>>): OriginalIdentity {
  if (r.purposeCode !== "STORE_PAYMENT_CONFIGURATION") return invalid();
  return {
    ...actorScope(r),
    operationReference: reference(r.operationReference),
    ...pins(r),
    purposeCode: "STORE_PAYMENT_CONFIGURATION",
  };
}
export function parseStorePaymentConfigurationSave(value: unknown): StorePaymentConfigurationSave {
  return protect(() => {
    const r = exactPaymentObject(value, ["profile", ...identityKeys, "content"]);
    if (r.profile !== "StorePaymentConfigurationSaveV1") return invalid();
    const original = identity(r);
    if (original.expectedRevision === 2147483647) return invalid();
    return Object.freeze({
      profile: "StorePaymentConfigurationSaveV1",
      ...original,
      content: parseStorePaymentConfigurationContent(r.content),
    });
  });
}
export function parseStorePaymentConfigurationResolve(
  value: unknown,
): StorePaymentConfigurationResolve {
  return protect(() => {
    const r = exactPaymentObject(value, ["profile", ...identityKeys, "intentDigest"]);
    if (r.profile !== "StorePaymentConfigurationResolveV1") return invalid();
    return Object.freeze({
      profile: "StorePaymentConfigurationResolveV1",
      ...identity(r),
      intentDigest: parsePaymentDigest(r.intentDigest),
    });
  });
}
export function parseStorePaymentConfigurationReceipt(
  value: unknown,
): StorePaymentConfigurationReceipt {
  return protect(() => {
    const r = exactPaymentObject(value, [
        "profile",
        ...actorScopeKeys,
        "operationReference",
        "intentDigest",
        "expectedConfigurationReference",
        "expectedRevision",
        "outcome",
        "snapshot",
        "auditReference",
        "occurredAt",
      ]),
      actualScope = actorScope(r),
      original = pins(r),
      occurredAt = parsePaymentInstant(r.occurredAt);
    if (
      r.profile !== "StorePaymentConfigurationReceiptV1" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return invalid();
    const snapshot = r.snapshot === null ? null : parseStorePaymentConfigurationVersion(r.snapshot);
    if ((r.outcome === "Abandoned") !== (snapshot === null)) return invalid();
    if (
      snapshot &&
      (scopeKeys.some((key) => snapshot[key] !== actualScope[key]) ||
        snapshot.authoredByReference !== actualScope.actorReference ||
        snapshot.revision !== original.expectedRevision + 1 ||
        snapshot.previousConfigurationReference !== original.expectedConfigurationReference ||
        snapshot.configurationReference === original.expectedConfigurationReference ||
        snapshot.updatedAt !== occurredAt)
    )
      return invalid();
    return Object.freeze({
      profile: "StorePaymentConfigurationReceiptV1",
      ...actualScope,
      operationReference: reference(r.operationReference),
      intentDigest: parsePaymentDigest(r.intentDigest),
      ...original,
      outcome: r.outcome,
      snapshot,
      auditReference: reference(r.auditReference),
      occurredAt,
    });
  });
}
export function parseStorePaymentConfigurationCurrent(
  value: unknown,
): StorePaymentConfigurationCurrent {
  return protect(() => {
    const r = exactPaymentObject(value, [
        "profile",
        ...actorScopeKeys,
        "snapshot",
        "observedAt",
        "validUntil",
        "providerReadiness",
      ]),
      actualScope = actorScope(r),
      observedAt = parsePaymentInstant(r.observedAt),
      validUntil = parsePaymentInstant(r.validUntil);
    if (
      r.profile !== "StorePaymentConfigurationCurrentV1" ||
      r.providerReadiness !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return invalid();
    const snapshot = r.snapshot === null ? null : parseStorePaymentConfigurationVersion(r.snapshot);
    if (
      snapshot &&
      (scopeKeys.some((key) => snapshot[key] !== actualScope[key]) ||
        snapshot.updatedAt > observedAt)
    )
      return invalid();
    return Object.freeze({
      profile: "StorePaymentConfigurationCurrentV1",
      ...actualScope,
      snapshot,
      observedAt,
      validUntil,
      providerReadiness: "NotEvaluated",
    });
  });
}
