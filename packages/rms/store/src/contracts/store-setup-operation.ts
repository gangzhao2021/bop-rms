import {
  parseBrandReference,
  parseStoreReference,
  parsePlatformTenantReference,
  parseCanonicalInstant,
} from "@bop/tenant";
import { parseStoreAdministrationReference } from "./store-configuration-administration.js";
import {
  parseStoreSetupDraft,
  parseStoreSetupDraftContent,
  type StoreSetupDraft,
  type StoreSetupDraftContent,
} from "./store-setup-draft.js";
export class StoreSetupOperationError extends Error {
  constructor(
    readonly code:
      | "STORE_SETUP_OPERATION_INPUT_INVALID"
      | "STORE_SETUP_OPERATION_PERMISSION_DENIED"
      | "STORE_SETUP_OPERATION_VERSION_CONFLICT"
      | "STORE_SETUP_OPERATION_IDEMPOTENCY_CONFLICT"
      | "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Store setup operation is unavailable");
    this.name = "StoreSetupOperationError";
  }
}
const invalid = (): never => {
  throw new StoreSetupOperationError("STORE_SETUP_OPERATION_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return !d?.enumerable || !("value" in d);
    })
  )
    return invalid();
  return value as Record<string, unknown>;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36) return invalid();
  return parseStoreAdministrationReference(value);
}
export function parseStoreSetupIntentDigest(value: unknown): string {
  if (typeof value !== "string" || value.length !== 71 || !/^sha256:[a-f0-9]{64}$/u.test(value))
    return invalid();
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    return invalid();
  return value;
}
export interface StoreSetupOperationScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
}
interface OriginalIdentity extends StoreSetupOperationScope {
  readonly operationReference: string;
  readonly expectedSetupReference: string | null;
  readonly expectedRevision: number;
  readonly purposeCode: "STORE_SETUP_DRAFT";
}
export interface StoreSetupSaveCommand extends OriginalIdentity {
  readonly profile: "StoreSetupSaveV1" | "StoreSetupSaveV2";
  readonly content: StoreSetupDraftContent;
}
export interface StoreSetupResolveCommand extends OriginalIdentity {
  readonly profile: "StoreSetupResolveV1";
  readonly intentDigest: string;
}
function identity(r: Record<string, unknown>): OriginalIdentity {
  const expectedRevision = revision(r.expectedRevision),
    expectedSetupReference =
      r.expectedSetupReference === null ? null : reference(r.expectedSetupReference);
  if (
    (expectedRevision === 0) !== (expectedSetupReference === null) ||
    r.purposeCode !== "STORE_SETUP_DRAFT"
  )
    return invalid();
  return {
    tenantReference: parsePlatformTenantReference(reference(r.tenantReference)),
    brandReference: parseBrandReference(reference(r.brandReference)),
    storeReference: parseStoreReference(reference(r.storeReference)),
    actorReference: reference(r.actorReference),
    operationReference: reference(r.operationReference),
    expectedSetupReference,
    expectedRevision,
    purposeCode: "STORE_SETUP_DRAFT",
  };
}
const identityKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "operationReference",
  "expectedSetupReference",
  "expectedRevision",
  "purposeCode",
] as const;
export function parseStoreSetupSaveCommand(value: unknown): StoreSetupSaveCommand {
  const r = closed(value, ["profile", ...identityKeys, "content"]);
  if (r.profile !== "StoreSetupSaveV1" && r.profile !== "StoreSetupSaveV2") return invalid();
  const content = parseStoreSetupDraftContent(r.content);
  if ((r.profile === "StoreSetupSaveV2") !== Object.hasOwn(content, "feeContexts"))
    return invalid();
  return Object.freeze({
    profile: r.profile,
    ...identity(r),
    content,
  });
}
export function parseStoreSetupResolveCommand(value: unknown): StoreSetupResolveCommand {
  const r = closed(value, ["profile", ...identityKeys, "intentDigest"]);
  if (r.profile !== "StoreSetupResolveV1") return invalid();
  return Object.freeze({
    profile: "StoreSetupResolveV1",
    ...identity(r),
    intentDigest: parseStoreSetupIntentDigest(r.intentDigest),
  });
}
export interface StoreSetupOperationReceipt extends OriginalIdentity {
  readonly profile: "StoreSetupOperationReceiptV1";
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: StoreSetupDraft | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export function parseStoreSetupOperationReceipt(value: unknown): StoreSetupOperationReceipt {
  const r = closed(value, [
      "profile",
      ...identityKeys,
      "intentDigest",
      "outcome",
      "snapshot",
      "auditReference",
      "occurredAt",
    ]),
    id = identity(r),
    at = parseCanonicalInstant(r.occurredAt);
  if (
    r.profile !== "StoreSetupOperationReceiptV1" ||
    (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
    (r.outcome === "Abandoned") !== (r.snapshot === null)
  )
    return invalid();
  const snapshot = r.snapshot === null ? null : parseStoreSetupDraft(r.snapshot);
  if (
    snapshot &&
    (snapshot.tenantReference !== id.tenantReference ||
      snapshot.brandReference !== id.brandReference ||
      snapshot.storeReference !== id.storeReference ||
      snapshot.authoredByReference !== id.actorReference ||
      snapshot.revision !== id.expectedRevision + 1 ||
      (id.expectedSetupReference !== null &&
        snapshot.setupDraftReference !== id.expectedSetupReference) ||
      snapshot.updatedAt !== at ||
      (id.expectedRevision === 0 && snapshot.createdAt !== at))
  )
    return invalid();
  return Object.freeze({
    profile: "StoreSetupOperationReceiptV1",
    ...id,
    intentDigest: parseStoreSetupIntentDigest(r.intentDigest),
    outcome: r.outcome,
    snapshot,
    auditReference: reference(r.auditReference),
    occurredAt: at,
  });
}
export interface StoreSetupCurrent {
  readonly profile: "StoreSetupCurrentV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly readerActorReference: string;
  readonly snapshot: StoreSetupDraft | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly businessReferenceValidation: "NotEvaluated";
}
export function parseStoreSetupCurrent(value: unknown): StoreSetupCurrent {
  const r = closed(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "storeReference",
    "readerActorReference",
    "snapshot",
    "observedAt",
    "validUntil",
    "businessReferenceValidation",
  ]);
  if (r.profile !== "StoreSetupCurrentV1" || r.businessReferenceValidation !== "NotEvaluated")
    return invalid();
  const tenantReference = parsePlatformTenantReference(reference(r.tenantReference)),
    brandReference = parseBrandReference(reference(r.brandReference)),
    storeReference = parseStoreReference(reference(r.storeReference)),
    observedAt = parseCanonicalInstant(r.observedAt),
    validUntil = parseCanonicalInstant(r.validUntil),
    snapshot = r.snapshot === null ? null : parseStoreSetupDraft(r.snapshot);
  if (
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    (snapshot &&
      (snapshot.tenantReference !== tenantReference ||
        snapshot.brandReference !== brandReference ||
        snapshot.storeReference !== storeReference ||
        snapshot.updatedAt > observedAt))
  )
    return invalid();
  return Object.freeze({
    profile: "StoreSetupCurrentV1",
    tenantReference,
    brandReference,
    storeReference,
    readerActorReference: reference(r.readerActorReference),
    snapshot,
    observedAt,
    validUntil,
    businessReferenceValidation: "NotEvaluated",
  });
}
