import {
  parsePlatformTenantReference,
  parseBrandReference,
  parseStoreReference,
  parseCanonicalInstant,
} from "@bop/tenant";
import { parseStoreAdministrationReference } from "./store-configuration-administration.js";
import {
  parseStoreBusinessAddress,
  parseStoreBusinessPhone,
  parseStoreBusinessWebsite,
  type PublicStoreAddress,
} from "./public-store-profile.js";

export class StoreSetupReferenceError extends Error {
  constructor(
    readonly code:
      | "STORE_SETUP_REFERENCE_INPUT_INVALID"
      | "STORE_SETUP_REFERENCE_PERMISSION_DENIED"
      | "STORE_SETUP_REFERENCE_VERSION_CONFLICT"
      | "STORE_SETUP_REFERENCE_IDEMPOTENCY_CONFLICT"
      | "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Store setup reference is unavailable");
    this.name = "StoreSetupReferenceError";
  }
}
const invalid = (): never => {
  throw new StoreSetupReferenceError("STORE_SETUP_REFERENCE_INPUT_INVALID");
};
export type StoreSetupReferenceKind = "Address" | "Contact";
export interface StoreSetupReferenceContact {
  readonly contactName: string;
  readonly businessPhone: string;
  readonly website: string | null;
}
export interface StoreSetupReferenceScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface StoreSetupReferenceActorScope extends StoreSetupReferenceScope {
  readonly actorReference: string;
}
export interface StoreSetupReferenceVersion extends StoreSetupReferenceScope {
  readonly profile: "StoreSetupReferenceVersionV1";
  readonly kind: StoreSetupReferenceKind;
  readonly reference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly previousReference: string | null;
  readonly content: PublicStoreAddress | StoreSetupReferenceContact;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataClassification: "Internal";
}
interface Original extends StoreSetupReferenceActorScope {
  readonly kind: StoreSetupReferenceKind;
  readonly operationReference: string;
  readonly expectedReference: string | null;
  readonly expectedRevision: number;
  readonly purposeCode: "STORE_SETUP_REFERENCE";
}
export interface StoreSetupReferenceSave extends Original {
  readonly profile: "StoreSetupReferenceSaveV1";
  readonly content: PublicStoreAddress | StoreSetupReferenceContact;
}
export interface StoreSetupReferenceResolve extends Original {
  readonly profile: "StoreSetupReferenceResolveV1";
  readonly intentDigest: string;
}
export interface StoreSetupReferenceReceipt extends StoreSetupReferenceActorScope {
  readonly profile: "StoreSetupReferenceReceiptV1";
  readonly kind: StoreSetupReferenceKind;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly expectedReference: string | null;
  readonly expectedRevision: number;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: StoreSetupReferenceVersion | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
export interface StoreSetupReferencesCurrent extends StoreSetupReferenceActorScope {
  readonly profile: "StoreSetupReferencesCurrentV1";
  readonly address: StoreSetupReferenceVersion | null;
  readonly contact: StoreSetupReferenceVersion | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly businessReferenceValidation: "NotEvaluated";
}
/** Owning metadata inventory; an inventory is not evidence of authorization or address validation. */
export const storeSetupReferenceOperationRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "kind",
  "operationReference",
  "expectedReference",
  "expectedRevision",
  "content",
  "intentDigest",
  "snapshot",
  "auditReference",
  "occurredAt",
] as const);

function protect<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
function detached(value: unknown): unknown {
  let nodes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 16) return invalid();
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object") return invalid();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 10000 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return invalid();
      const result: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d?.enumerable || !("value" in d)) return invalid();
        result.push(copy(d.value, depth + 1));
      }
      return Object.freeze(result);
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) return invalid();
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== "string" || key === "__proto__") return invalid();
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !("value" in d)) return invalid();
      Object.defineProperty(out, key, { value: copy(d.value, depth + 1), enumerable: true });
    }
    return Object.freeze(out);
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 16384) return invalid();
  return result;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const ref = (v: unknown): string => parseStoreAdministrationReference(v);
const kind = (v: unknown): StoreSetupReferenceKind =>
  v === "Address" || v === "Contact" ? v : invalid();
function revision(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 2147483647)
    return invalid();
  return v;
}
export function parseStoreSetupReferenceIntentDigest(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(v)) return invalid();
  return v;
}
function scope(r: Record<string, unknown>): StoreSetupReferenceScope {
  return {
    tenantReference: parsePlatformTenantReference(ref(r.tenantReference)),
    brandReference: parseBrandReference(ref(r.brandReference)),
    storeReference: parseStoreReference(ref(r.storeReference)),
  };
}
function pins(r: Record<string, unknown>) {
  const expectedRevision = revision(r.expectedRevision),
    expectedReference = r.expectedReference === null ? null : ref(r.expectedReference);
  if ((expectedRevision === 0) !== (expectedReference === null)) return invalid();
  return { expectedReference, expectedRevision };
}
function content(
  k: StoreSetupReferenceKind,
  v: unknown,
): PublicStoreAddress | StoreSetupReferenceContact {
  if (k === "Address") return parseStoreBusinessAddress(v);
  const r = closed(v, ["contactName", "businessPhone", "website"]);
  if (
    typeof r.contactName !== "string" ||
    r.contactName.trim() === "" ||
    r.contactName.length > 120 ||
    /[\p{Cc}\p{Cf}<>]/u.test(r.contactName)
  )
    return invalid();
  const businessPhone = parseStoreBusinessPhone(r.businessPhone);
  if (businessPhone === null) return invalid();
  return Object.freeze({
    contactName: r.contactName.trim(),
    businessPhone,
    website: parseStoreBusinessWebsite(r.website),
  });
}
export function parseStoreSetupReferenceContent(
  k: StoreSetupReferenceKind,
  v: unknown,
): PublicStoreAddress | StoreSetupReferenceContact {
  return protect(() => content(kind(k), detached(v)));
}
const scopeKeys = ["tenantReference", "brandReference", "storeReference"];
function version(v: unknown): StoreSetupReferenceVersion {
  const r = closed(v, [
    "profile",
    ...scopeKeys,
    "kind",
    "reference",
    "revision",
    "authoredByReference",
    "previousReference",
    "content",
    "createdAt",
    "updatedAt",
    "dataClassification",
  ]);
  const k = kind(r.kind),
    rev = revision(r.revision),
    previousReference = r.previousReference === null ? null : ref(r.previousReference),
    reference = ref(r.reference),
    createdAt = parseCanonicalInstant(r.createdAt),
    updatedAt = parseCanonicalInstant(r.updatedAt);
  if (
    r.profile !== "StoreSetupReferenceVersionV1" ||
    r.dataClassification !== "Internal" ||
    rev === 0 ||
    (rev === 1) !== (previousReference === null) ||
    previousReference === reference ||
    updatedAt < createdAt ||
    (rev === 1 && createdAt !== updatedAt)
  )
    return invalid();
  return Object.freeze({
    profile: "StoreSetupReferenceVersionV1",
    ...scope(r),
    kind: k,
    reference,
    revision: rev,
    authoredByReference: ref(r.authoredByReference),
    previousReference,
    content: content(k, r.content),
    createdAt,
    updatedAt,
    dataClassification: "Internal",
  });
}
export function parseStoreSetupReferenceVersion(v: unknown): StoreSetupReferenceVersion {
  return protect(() => version(detached(v)));
}
function original(r: Record<string, unknown>): Original {
  if (r.purposeCode !== "STORE_SETUP_REFERENCE") return invalid();
  return {
    ...scope(r),
    actorReference: ref(r.actorReference),
    kind: kind(r.kind),
    operationReference: ref(r.operationReference),
    ...pins(r),
    purposeCode: "STORE_SETUP_REFERENCE",
  };
}
const originalKeys = [
  ...scopeKeys,
  "actorReference",
  "kind",
  "operationReference",
  "expectedReference",
  "expectedRevision",
  "purposeCode",
];
export function parseStoreSetupReferenceSave(v: unknown): StoreSetupReferenceSave {
  return protect(() => {
    const r = closed(detached(v), ["profile", ...originalKeys, "content"]);
    if (r.profile !== "StoreSetupReferenceSaveV1") return invalid();
    const o = original(r);
    if (o.expectedRevision === 2147483647) return invalid();
    return Object.freeze({
      profile: "StoreSetupReferenceSaveV1",
      ...o,
      content: content(o.kind, r.content),
    });
  });
}
export function parseStoreSetupReferenceResolve(v: unknown): StoreSetupReferenceResolve {
  return protect(() => {
    const r = closed(detached(v), ["profile", ...originalKeys, "intentDigest"]);
    if (r.profile !== "StoreSetupReferenceResolveV1") return invalid();
    return Object.freeze({
      profile: "StoreSetupReferenceResolveV1",
      ...original(r),
      intentDigest: parseStoreSetupReferenceIntentDigest(r.intentDigest),
    });
  });
}
export function parseStoreSetupReferenceReceipt(v: unknown): StoreSetupReferenceReceipt {
  return protect(() => {
    const r = closed(detached(v), [
      "profile",
      ...scopeKeys,
      "actorReference",
      "kind",
      "operationReference",
      "intentDigest",
      "expectedReference",
      "expectedRevision",
      "outcome",
      "snapshot",
      "auditReference",
      "occurredAt",
    ]);
    if (
      r.profile !== "StoreSetupReferenceReceiptV1" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return invalid();
    const s = scope(r),
      actorReference = ref(r.actorReference),
      k = kind(r.kind),
      p = pins(r),
      occurredAt = parseCanonicalInstant(r.occurredAt),
      snapshot = r.snapshot === null ? null : version(r.snapshot);
    if (r.outcome === "Abandoned" ? snapshot !== null : snapshot === null) return invalid();
    if (
      snapshot &&
      (snapshot.kind !== k ||
        scopeKeys.some(
          (key) =>
            snapshot[key as keyof StoreSetupReferenceScope] !==
            s[key as keyof StoreSetupReferenceScope],
        ) ||
        snapshot.authoredByReference !== actorReference ||
        snapshot.revision !== p.expectedRevision + 1 ||
        snapshot.previousReference !== p.expectedReference ||
        snapshot.reference === p.expectedReference ||
        snapshot.updatedAt !== occurredAt)
    )
      return invalid();
    return Object.freeze({
      profile: "StoreSetupReferenceReceiptV1",
      ...s,
      actorReference,
      kind: k,
      operationReference: ref(r.operationReference),
      intentDigest: parseStoreSetupReferenceIntentDigest(r.intentDigest),
      ...p,
      outcome: r.outcome,
      snapshot,
      auditReference: ref(r.auditReference),
      occurredAt,
    });
  });
}
export function parseStoreSetupReferencesCurrent(v: unknown): StoreSetupReferencesCurrent {
  return protect(() => {
    const r = closed(detached(v), [
        "profile",
        ...scopeKeys,
        "actorReference",
        "address",
        "contact",
        "observedAt",
        "validUntil",
        "businessReferenceValidation",
      ]),
      s = scope(r),
      observedAt = parseCanonicalInstant(r.observedAt),
      validUntil = parseCanonicalInstant(r.validUntil);
    if (
      r.profile !== "StoreSetupReferencesCurrentV1" ||
      r.businessReferenceValidation !== "NotEvaluated" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return invalid();
    const address = r.address === null ? null : version(r.address),
      contact = r.contact === null ? null : version(r.contact);
    for (const [snapshot, k] of [
      [address, "Address"],
      [contact, "Contact"],
    ] as const)
      if (
        snapshot &&
        (snapshot.kind !== k ||
          scopeKeys.some(
            (key) =>
              snapshot[key as keyof StoreSetupReferenceScope] !==
              s[key as keyof StoreSetupReferenceScope],
          ) ||
          snapshot.updatedAt > observedAt)
      )
        return invalid();
    return Object.freeze({
      profile: "StoreSetupReferencesCurrentV1",
      ...s,
      actorReference: ref(r.actorReference),
      address,
      contact,
      observedAt,
      validUntil,
      businessReferenceValidation: "NotEvaluated",
    });
  });
}
