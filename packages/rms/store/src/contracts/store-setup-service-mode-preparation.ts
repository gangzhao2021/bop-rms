import {
  parseCanonicalInstant,
  parseBrandReference,
  parseStoreReference,
  parsePlatformTenantReference,
} from "@bop/tenant";
import {
  parseStoreAdministrationReference,
  type StoreAdministrationServiceMode,
} from "./store-configuration-administration.js";
import {
  StoreSetupDraftError,
  parseStoreSetupDraft,
  type StoreSetupDraft,
} from "./store-setup-draft.js";
import { parseStoreSetupCurrent } from "./store-setup-operation.js";
/** Preparation only: neither publication nor authority/coverage qualification. */
export interface StoreSetupServiceModePreparation {
  readonly profile: "StoreSetupServiceModePreparationV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly setupDraftReference: string;
  readonly sourceRevision: number;
  readonly sourceSnapshotDigest: string;
  readonly serviceModes: readonly StoreAdministrationServiceMode[];
  readonly semanticDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publicationStatus: "NotPublished";
  readonly businessReferenceValidation: "NotEvaluated";
}
export interface StoreSetupServiceModePreparationReferences {
  canonicalize(value: unknown): string;
  hashIntent(value: string): string;
}
const fields = [
  "profile",
  "tenantReference",
  "brandReference",
  "storeReference",
  "setupDraftReference",
  "sourceRevision",
  "sourceSnapshotDigest",
  "serviceModes",
  "semanticDigest",
  "observedAt",
  "validUntil",
  "publicationStatus",
  "businessReferenceValidation",
];
const fail = (code: StoreSetupDraftError["code"] = "STORE_SETUP_INPUT_INVALID"): never => {
  throw new StoreSetupDraftError(code);
};
function normal<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof StoreSetupDraftError) throw error;
    return fail();
  }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some((k) => typeof k !== "string" || !keys.includes(k)))
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
const hash = (value: unknown) =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value) ? value : fail();
function modes(value: unknown): readonly StoreAdministrationServiceMode[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 3 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const actual: StoreAdministrationServiceMode[] = [];
  const allowed: readonly StoreAdministrationServiceMode[] = ["DineIn", "Pickup", "Delivery"];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d) || !allowed.includes(d.value) || actual.includes(d.value))
      return fail();
    actual.push(d.value);
  }
  return Object.freeze(allowed.filter((mode) => actual.includes(mode)));
}
function semantic(
  value: Pick<
    StoreSetupServiceModePreparation,
    "tenantReference" | "brandReference" | "storeReference" | "setupDraftReference" | "serviceModes"
  >,
) {
  return Object.freeze({
    profile: "StoreSetupServiceModePreparationV1",
    tenantReference: value.tenantReference,
    brandReference: value.brandReference,
    storeReference: value.storeReference,
    setupDraftReference: value.setupDraftReference,
    serviceModes: value.serviceModes,
  });
}
// Reversible canonical output admission prevents a callback returning unrelated
// JSON from being used as the digest preimage. The actual hash port remains owned.
function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((v, i) => equalJson(v, right[i]));
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  const a = Object.keys(left).sort(),
    b = Object.keys(right).sort();
  return (
    a.length === b.length &&
    a.every(
      (key, i) =>
        key === b[i] &&
        equalJson(
          Object.getOwnPropertyDescriptor(left, key)?.value,
          Object.getOwnPropertyDescriptor(right, key)?.value,
        ),
    )
  );
}
function digester(references: StoreSetupServiceModePreparationReferences) {
  const r = closed(references, ["canonicalize", "hashIntent"]);
  if (typeof r.canonicalize !== "function" || typeof r.hashIntent !== "function") return fail();
  const canonicalize = r.canonicalize,
    hashIntent = r.hashIntent;
  const unchanged = () => {
    const actual = closed(references, ["canonicalize", "hashIntent"]);
    if (actual.canonicalize !== canonicalize || actual.hashIntent !== hashIntent)
      return fail("STORE_SETUP_STATE_INVALID");
  };
  return (value: unknown): string => {
    unchanged();
    const text = canonicalize.call(references, value);
    unchanged();
    if (
      typeof text !== "string" ||
      new TextEncoder().encode(text).length > 2097152 ||
      !equalJson(JSON.parse(text), value)
    )
      return fail();
    const result = hash(hashIntent.call(references, text));
    unchanged();
    return result;
  };
}
function structural(
  value: unknown,
  digest: (v: unknown) => string,
): StoreSetupServiceModePreparation {
  const r = closed(value, fields);
  if (
    r.profile !== "StoreSetupServiceModePreparationV1" ||
    r.publicationStatus !== "NotPublished" ||
    r.businessReferenceValidation !== "NotEvaluated" ||
    typeof r.sourceRevision !== "number" ||
    !Number.isInteger(r.sourceRevision) ||
    r.sourceRevision < 1 ||
    r.sourceRevision > 2147483647
  )
    return fail();
  const observedAt = parseCanonicalInstant(r.observedAt),
    validUntil = parseCanonicalInstant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
    return fail();
  const result: StoreSetupServiceModePreparation = {
    profile: "StoreSetupServiceModePreparationV1",
    tenantReference: parsePlatformTenantReference(
      parseStoreAdministrationReference(r.tenantReference),
    ),
    brandReference: parseBrandReference(parseStoreAdministrationReference(r.brandReference)),
    storeReference: parseStoreReference(parseStoreAdministrationReference(r.storeReference)),
    setupDraftReference: parseStoreAdministrationReference(r.setupDraftReference),
    sourceRevision: r.sourceRevision,
    sourceSnapshotDigest: hash(r.sourceSnapshotDigest),
    serviceModes: modes(r.serviceModes),
    semanticDigest: hash(r.semanticDigest),
    observedAt,
    validUntil,
    publicationStatus: "NotPublished",
    businessReferenceValidation: "NotEvaluated",
  };
  if (result.semanticDigest !== digest(semantic(result))) return fail();
  return Object.freeze(result);
}
function fresh(value: StoreSetupServiceModePreparation, observedAt: unknown) {
  const at = parseCanonicalInstant(observedAt);
  if (at < value.observedAt || at >= value.validUntil) return fail("STORE_SETUP_STATE_INVALID");
}
/** Requires the caller's actual clock observation; it never renews the owner lease. */
export function parseStoreSetupServiceModePreparation(
  value: unknown,
  references: StoreSetupServiceModePreparationReferences,
  observedAt: unknown,
): StoreSetupServiceModePreparation {
  return normal(() => {
    const result = structural(value, digester(references));
    fresh(result, observedAt);
    return result;
  });
}
function projectSnapshot(
  snapshot: StoreSetupDraft,
  sourceObservedAt: string,
  validUntil: string,
  references: StoreSetupServiceModePreparationReferences,
  observedAt: unknown,
): StoreSetupServiceModePreparation {
  if (snapshot.content.enabledServiceModes.state !== "Configured")
    return fail("STORE_SETUP_INCOMPLETE");
  const digest = digester(references);
  const base = {
    tenantReference: snapshot.tenantReference,
    brandReference: snapshot.brandReference,
    storeReference: snapshot.storeReference,
    setupDraftReference: snapshot.setupDraftReference,
    serviceModes: modes(snapshot.content.enabledServiceModes.value),
  };
  const result = structural(
    {
      profile: "StoreSetupServiceModePreparationV1",
      ...base,
      sourceRevision: snapshot.revision,
      sourceSnapshotDigest: digest(snapshot),
      semanticDigest: digest(semantic(base)),
      observedAt: sourceObservedAt,
      validUntil,
      publicationStatus: "NotPublished",
      businessReferenceValidation: "NotEvaluated",
    },
    digest,
  );
  fresh(result, observedAt);
  return result;
}
/** Uses only an actual parsed owning Current snapshot, not a proposed form. */
export function createStoreSetupServiceModePreparation(
  value: unknown,
  references: StoreSetupServiceModePreparationReferences,
  observedAt: unknown,
): StoreSetupServiceModePreparation {
  return normal(() => {
    const current = parseStoreSetupCurrent(value);
    if (!current.snapshot) return fail("STORE_SETUP_INCOMPLETE");
    return projectSnapshot(
      current.snapshot,
      current.observedAt,
      current.validUntil,
      references,
      observedAt,
    );
  });
}
/** Projects an owning immutable recorded revision under its actual read lease.
 * It does not claim that the revision is the current head or is Published.
 * The persistence owner authenticates the original immutable record separately. */
export function createStoreSetupServiceModePreparationFromRecordedRevision(
  value: unknown,
  references: StoreSetupServiceModePreparationReferences,
  observedAt: unknown,
): StoreSetupServiceModePreparation {
  return normal(() => {
    const r = closed(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "readerActorReference",
      "snapshot",
      "observedAt",
      "validUntil",
      "recordingStatus",
    ]);
    if (r.profile !== "StoreSetupRecordedRevisionV1" || r.recordingStatus !== "Recorded")
      return fail();
    const tenantReference = parsePlatformTenantReference(
      parseStoreAdministrationReference(r.tenantReference),
    );
    const brandReference = parseBrandReference(parseStoreAdministrationReference(r.brandReference));
    const storeReference = parseStoreReference(parseStoreAdministrationReference(r.storeReference));
    parseStoreAdministrationReference(r.readerActorReference);
    const snapshot = parseStoreSetupDraft(r.snapshot);
    const sourceObservedAt = parseCanonicalInstant(r.observedAt);
    const validUntil = parseCanonicalInstant(r.validUntil);
    if (
      snapshot.tenantReference !== tenantReference ||
      snapshot.brandReference !== brandReference ||
      snapshot.storeReference !== storeReference
    )
      return fail("STORE_SETUP_SCOPE_MISMATCH");
    if (
      snapshot.updatedAt > sourceObservedAt ||
      validUntil <= sourceObservedAt ||
      Date.parse(validUntil) - Date.parse(sourceObservedAt) > 5000
    )
      return fail();
    return projectSnapshot(snapshot, sourceObservedAt, validUntil, references, observedAt);
  });
}
/** Semantic comparison only. Expired original observations are historical,
 * never current authority, qualification or a substituted immutable-version proof. */
export function storeSetupServiceModePreparationSemanticallyEqual(
  left: unknown,
  right: unknown,
  references: StoreSetupServiceModePreparationReferences,
): boolean {
  return normal(() => {
    const digest = digester(references),
      a = structural(left, digest),
      b = structural(right, digest);
    return equalJson(semantic(a), semantic(b));
  });
}
/** Read a fresh actual owning source and retain original provenance untouched.
 * Historical immutable source authentication is a separate mandatory consumer step. */
export function revalidateStoreSetupServiceModePreparation(
  original: unknown,
  current: unknown,
  references: StoreSetupServiceModePreparationReferences,
  observedAt: unknown,
): boolean {
  return normal(() => {
    const a = structural(original, digester(references)),
      b = createStoreSetupServiceModePreparation(current, references, observedAt);
    return (
      b.sourceRevision >= a.sourceRevision &&
      b.observedAt >= a.observedAt &&
      (b.sourceRevision !== a.sourceRevision ||
        b.sourceSnapshotDigest === a.sourceSnapshotDigest) &&
      storeSetupServiceModePreparationSemanticallyEqual(a, b, references)
    );
  });
}
