import { parseStoreFeeContexts, type StoreFeeContext } from "./store-fee-context.js";
import {
  parseBrandReference,
  parseStoreReference,
  parsePlatformTenantReference,
  parseCanonicalInstant,
} from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
  parseStoreWeeklyServiceSchedule,
  parseStoreServiceExceptions,
  type StoreConfigurationSource,
  type StoreAdministrationServiceMode,
  type StoreWeeklyServiceDay,
  type StoreServiceException,
  type StoreConfigurationVersion,
} from "./store-configuration-administration.js";

export class StoreSetupDraftError extends Error {
  constructor(
    readonly code:
      | "STORE_SETUP_INPUT_INVALID"
      | "STORE_SETUP_SCOPE_MISMATCH"
      | "STORE_SETUP_VERSION_CONFLICT"
      | "STORE_SETUP_INCOMPLETE"
      | "STORE_SETUP_STATE_INVALID",
  ) {
    super("Store setup draft is unavailable for the requested operation");
    this.name = "StoreSetupDraftError";
  }
}
const fail = (code: StoreSetupDraftError["code"] = "STORE_SETUP_INPUT_INVALID"): never => {
  throw new StoreSetupDraftError(code);
};
export type StoreSetupValue<T> =
  Readonly<{ state: "Unconfigured" }> | Readonly<{ state: "Configured"; value: T }>;
export type StoreSetupFeeContext = StoreFeeContext;
export interface StoreSetupDraftContent {
  readonly feeContexts?: StoreSetupValue<readonly StoreSetupFeeContext[]>;
  readonly source: StoreSetupValue<StoreConfigurationSource>;
  readonly brandBaseVersionReference: StoreSetupValue<string>;
  readonly timeZone: StoreSetupValue<string>;
  readonly businessDayStartLocalTime: StoreSetupValue<string>;
  readonly addressReference: StoreSetupValue<string>;
  readonly contactReference: StoreSetupValue<string>;
  readonly receiptReference: StoreSetupValue<string>;
  readonly taxConfigurationReference: StoreSetupValue<string>;
  readonly paymentConfigurationReference: StoreSetupValue<string>;
  readonly capacityConfigurationReference: StoreSetupValue<string | null>;
  readonly enabledServiceModes: StoreSetupValue<readonly StoreAdministrationServiceMode[]>;
  readonly weeklySchedule: StoreSetupValue<readonly StoreWeeklyServiceDay[]>;
  readonly exceptions: StoreSetupValue<readonly StoreServiceException[]>;
  readonly effectiveFrom: StoreSetupValue<string>;
  readonly effectiveUntil: StoreSetupValue<string | null>;
}
export const storeSetupDraftContentFields = Object.freeze([
  "source",
  "brandBaseVersionReference",
  "timeZone",
  "businessDayStartLocalTime",
  "addressReference",
  "contactReference",
  "receiptReference",
  "taxConfigurationReference",
  "paymentConfigurationReference",
  "capacityConfigurationReference",
  "enabledServiceModes",
  "weeklySchedule",
  "exceptions",
  "effectiveFrom",
  "effectiveUntil",
] as const);
export interface StoreSetupDraft {
  readonly profile: "StoreSetupDraftV1" | "StoreSetupDraftV2";
  readonly setupDraftReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly revision: number;
  readonly authoredByReference: string;
  readonly defaultLocale: string;
  readonly currencyCode: "CAD";
  /** Actual previous complete version identity; this does not assert Published. */
  readonly baseConfigurationReference: string | null;
  readonly content: StoreSetupDraftContent;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly purposeCode: "STORE_SETUP_DRAFT";
  readonly dataClassification: "ConfigurationMetadata";
}
export type StoreSetupDraftV2 = StoreSetupDraft &
  Readonly<{
    profile: "StoreSetupDraftV2";
    content: StoreSetupDraftContent &
      Readonly<{ feeContexts: StoreSetupValue<readonly StoreSetupFeeContext[]> }>;
  }>;
export interface StoreSetupActualScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly defaultLocale: string;
  readonly currencyCode: "CAD";
  readonly baseConfigurationReference: string | null;
}
/** Copy before invoking existing parsers; no getter, sparse array or PII-bearing
 * unknown key can become a setup fact. Bounds include the existing 366 exceptions. */
function copy(value: unknown): unknown {
  let budget = 100000;
  const visit = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : fail();
    if (typeof v === "string") return v.length <= 4096 ? v : fail();
    if (!v || typeof v !== "object") return fail();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        v.length > 10000 ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      return Array.from({ length: v.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d?.enumerable || !("value" in d)) return fail();
        return visit(d.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(v) !== Object.prototype || Reflect.ownKeys(v).length > 64)
      return fail();
    return Object.fromEntries(
      Reflect.ownKeys(v).map((key) => {
        if (typeof key !== "string") return fail();
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d?.enumerable || !("value" in d)) return fail();
        return [key, visit(d.value, depth + 1)];
      }),
    );
  };
  return visit(value, 0);
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
    return fail();
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 2147483647
    ? value
    : fail();
}
function locale(value: unknown): string {
  return typeof value === "string" &&
    value.trim() === value &&
    /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})$/u.test(value)
    ? value
    : fail();
}
function localTime(value: unknown): string {
  return typeof value === "string" &&
    value.length === 8 &&
    /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/u.test(value)
    ? value
    : fail();
}
function timeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || value.trim() !== value) return fail();
  try {
    if (new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone !== value)
      return fail();
  } catch {
    return fail();
  }
  return value;
}
function reference(value: unknown) {
  if (typeof value !== "string" || value.length !== 36) return fail();
  return parseStoreAdministrationReference(value);
}
const nullableReference = (value: unknown) => (value === null ? null : reference(value));
function configured<T>(value: unknown, parse: (value: unknown) => T): StoreSetupValue<T> {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getOwnPropertyDescriptor(value, "state")?.value === "Unconfigured"
  ) {
    closed(value, ["state"]);
    return Object.freeze({ state: "Unconfigured" });
  }
  const r = closed(value, ["state", "value"]);
  if (r.state !== "Configured") return fail();
  return Object.freeze({ state: "Configured", value: parse(r.value) });
}
export function parseStoreSetupFeeContexts(value: unknown): readonly StoreSetupFeeContext[] {
  try {
    return parseStoreFeeContexts(value);
  } catch {
    return fail();
  }
}
/** Partial structural parsing does not perform external reference validation. */
export function parseStoreSetupDraftContent(value: unknown): StoreSetupDraftContent {
  const copied = copy(value);
  const hasFees =
    copied !== null && typeof copied === "object" && Object.hasOwn(copied, "feeContexts");
  const r = closed(
    copied,
    hasFees ? [...storeSetupDraftContentFields, "feeContexts"] : storeSetupDraftContentFields,
  );
  const content: StoreSetupDraftContent = {
    ...(hasFees ? { feeContexts: configured(r.feeContexts, parseStoreSetupFeeContexts) } : {}),
    source: configured(r.source, (v) =>
      v === "BrandInherited" || v === "StoreOverride" ? v : fail(),
    ),
    brandBaseVersionReference: configured(r.brandBaseVersionReference, reference),
    timeZone: configured(r.timeZone, timeZone),
    businessDayStartLocalTime: configured(r.businessDayStartLocalTime, localTime),
    addressReference: configured(r.addressReference, reference),
    contactReference: configured(r.contactReference, reference),
    receiptReference: configured(r.receiptReference, reference),
    taxConfigurationReference: configured(r.taxConfigurationReference, reference),
    paymentConfigurationReference: configured(r.paymentConfigurationReference, reference),
    capacityConfigurationReference: configured(r.capacityConfigurationReference, nullableReference),
    enabledServiceModes: configured(r.enabledServiceModes, (v) => {
      if (!Array.isArray(v) || v.length < 1 || v.length > 3 || new Set(v).size !== v.length)
        return fail();
      const modes: readonly StoreAdministrationServiceMode[] = ["DineIn", "Pickup", "Delivery"];
      if (v.some((mode) => !modes.includes(mode))) return fail();
      return Object.freeze(modes.filter((mode) => v.includes(mode)));
    }),
    weeklySchedule: configured(r.weeklySchedule, parseStoreWeeklyServiceSchedule),
    exceptions: configured(r.exceptions, parseStoreServiceExceptions),
    effectiveFrom: configured(r.effectiveFrom, parseCanonicalInstant),
    effectiveUntil: configured(r.effectiveUntil, (v) =>
      v === null ? null : parseCanonicalInstant(v),
    ),
  };
  if (
    content.effectiveFrom.state === "Configured" &&
    content.effectiveUntil.state === "Configured" &&
    content.effectiveUntil.value !== null &&
    content.effectiveUntil.value <= content.effectiveFrom.value
  )
    return fail("STORE_SETUP_STATE_INVALID");
  return Object.freeze(content);
}
export function createUnconfiguredStoreSetupDraftContent(): StoreSetupDraftContent {
  return parseStoreSetupDraftContent(
    Object.fromEntries(
      storeSetupDraftContentFields.map((field) => [field, { state: "Unconfigured" }]),
    ),
  );
}
export function createUnconfiguredStoreSetupDraftContentV2(): StoreSetupDraftContent {
  return parseStoreSetupDraftContent({
    ...createUnconfiguredStoreSetupDraftContent(),
    feeContexts: { state: "Unconfigured" },
  });
}
export function parseStoreSetupDraft(value: unknown): StoreSetupDraft {
  const r = closed(copy(value), [
    "profile",
    "setupDraftReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "revision",
    "authoredByReference",
    "defaultLocale",
    "currencyCode",
    "baseConfigurationReference",
    "content",
    "createdAt",
    "updatedAt",
    "purposeCode",
    "dataClassification",
  ]);
  if (
    (r.profile !== "StoreSetupDraftV1" && r.profile !== "StoreSetupDraftV2") ||
    r.currencyCode !== "CAD" ||
    r.purposeCode !== "STORE_SETUP_DRAFT" ||
    r.dataClassification !== "ConfigurationMetadata"
  )
    return fail();
  const createdAt = parseCanonicalInstant(r.createdAt),
    updatedAt = parseCanonicalInstant(r.updatedAt);
  if (updatedAt < createdAt) return fail("STORE_SETUP_STATE_INVALID");
  const content = parseStoreSetupDraftContent(r.content);
  if ((r.profile === "StoreSetupDraftV2") !== Object.hasOwn(content, "feeContexts")) return fail();
  return Object.freeze({
    profile: r.profile,
    setupDraftReference: reference(r.setupDraftReference),
    tenantReference: parsePlatformTenantReference(reference(r.tenantReference)),
    brandReference: parseBrandReference(reference(r.brandReference)),
    storeReference: parseStoreReference(reference(r.storeReference)),
    revision: positive(r.revision),
    authoredByReference: reference(r.authoredByReference),
    defaultLocale: locale(r.defaultLocale),
    currencyCode: "CAD",
    baseConfigurationReference: nullableReference(r.baseConfigurationReference),
    content,
    createdAt,
    updatedAt,
    purposeCode: "STORE_SETUP_DRAFT",
    dataClassification: "ConfigurationMetadata",
  });
}
function scope(value: StoreSetupActualScope): StoreSetupActualScope {
  const r = closed(copy(value), [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "defaultLocale",
    "currencyCode",
    "baseConfigurationReference",
  ]);
  if (r.currencyCode !== "CAD") return fail("STORE_SETUP_SCOPE_MISMATCH");
  return Object.freeze({
    tenantReference: parsePlatformTenantReference(reference(r.tenantReference)),
    brandReference: parseBrandReference(reference(r.brandReference)),
    storeReference: parseStoreReference(reference(r.storeReference)),
    actorReference: reference(r.actorReference),
    defaultLocale: locale(r.defaultLocale),
    currencyCode: "CAD",
    baseConfigurationReference: nullableReference(r.baseConfigurationReference),
  });
}
function assertScope(draft: StoreSetupDraft, actual: StoreSetupActualScope): void {
  if (
    draft.tenantReference !== actual.tenantReference ||
    draft.brandReference !== actual.brandReference ||
    draft.storeReference !== actual.storeReference ||
    draft.defaultLocale !== actual.defaultLocale ||
    draft.currencyCode !== actual.currencyCode ||
    draft.baseConfigurationReference !== actual.baseConfigurationReference
  )
    return fail("STORE_SETUP_SCOPE_MISMATCH");
}
/** Actual source acquisition, IAM and server metadata allocation remain the service's responsibility. */
export function createStoreSetupDraft(
  value: unknown,
  actualScope: StoreSetupActualScope,
): StoreSetupDraft {
  const draft = parseStoreSetupDraft(value),
    actual = scope(actualScope);
  assertScope(draft, actual);
  if (draft.revision !== 1 || draft.createdAt !== draft.updatedAt)
    return fail("STORE_SETUP_STATE_INVALID");
  if (draft.authoredByReference !== actual.actorReference)
    return fail("STORE_SETUP_SCOPE_MISMATCH");
  return draft;
}
/** Whole closed content replacement for a step save. Current permission and persistence CAS are separate. */
export function replaceStoreSetupDraftContent(
  value: unknown,
  content: unknown,
  actualScope: StoreSetupActualScope,
  serverMetadata: Readonly<{ expectedRevision: number; observedAt: string }>,
): StoreSetupDraft {
  const draft = parseStoreSetupDraft(value),
    actual = scope(actualScope),
    metadata = closed(copy(serverMetadata), ["expectedRevision", "observedAt"]);
  assertScope(draft, actual);
  if (positive(metadata.expectedRevision) !== draft.revision)
    return fail("STORE_SETUP_VERSION_CONFLICT");
  const observedAt = parseCanonicalInstant(metadata.observedAt);
  if (observedAt < draft.updatedAt || draft.revision === 2147483647)
    return fail("STORE_SETUP_STATE_INVALID");
  const parsedContent = parseStoreSetupDraftContent(content);
  if (draft.profile === "StoreSetupDraftV2" && parsedContent.feeContexts === undefined)
    return fail("STORE_SETUP_STATE_INVALID");
  return parseStoreSetupDraft({
    ...draft,
    profile: parsedContent.feeContexts === undefined ? "StoreSetupDraftV1" : "StoreSetupDraftV2",
    revision: draft.revision + 1,
    authoredByReference: actual.actorReference,
    content: parsedContent,
    updatedAt: observedAt,
  });
}
export function assessStoreSetupDraftCompleteness(
  value: unknown,
): Readonly<{ missingPaths: readonly string[]; businessReferenceValidation: "NotEvaluated" }> {
  const draft = parseStoreSetupDraft(value);
  return Object.freeze({
    missingPaths: Object.freeze(
      storeSetupDraftContentFields
        .filter((field) => draft.content[field].state === "Unconfigured")
        .map((field) => "content." + field)
        .concat(
          draft.profile === "StoreSetupDraftV2"
            ? draft.content.feeContexts?.state === "Configured"
              ? draft.content.feeContexts.value
                  .filter((entry) => entry.state === "Unconfigured")
                  .map((entry) => "content.feeContexts." + entry.chargeType)
              : ["content.feeContexts"]
            : [],
        ),
    ),
    businessReferenceValidation: "NotEvaluated",
  });
}
export interface StoreSetupMaterializationMetadata {
  readonly configurationReference: string;
  readonly configurationVersion: number;
  readonly reasonCode: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** Completeness is structural only: the existing services must still hold actual
 * references, policy, review and live gate evidence before Submit/Publish. */
function materializeConfiguration(
  value: unknown,
  actualScope: StoreSetupActualScope,
  serverMetadata: StoreSetupMaterializationMetadata,
  references?: { canonicalize(value: unknown): string; hashIntent(value: string): string },
): StoreConfigurationVersion {
  const draft = parseStoreSetupDraft(value),
    actual = scope(actualScope),
    metadata = closed(copy(serverMetadata), [
      "configurationReference",
      "configurationVersion",
      "reasonCode",
      "createdAt",
      "updatedAt",
    ]);
  assertScope(draft, actual);
  if (
    (draft.profile === "StoreSetupDraftV2" && references === undefined) ||
    assessStoreSetupDraftCompleteness(draft).missingPaths.length !== 0
  )
    return fail("STORE_SETUP_INCOMPLETE");
  const resolved = Object.fromEntries(
    storeSetupDraftContentFields.map((field) => {
      const part = draft.content[field];
      if (part.state !== "Configured") return fail("STORE_SETUP_INCOMPLETE");
      return [field, part.value];
    }),
  );
  const createdAt = parseCanonicalInstant(metadata.createdAt),
    updatedAt = parseCanonicalInstant(metadata.updatedAt);
  if (createdAt < draft.updatedAt || updatedAt < createdAt)
    return fail("STORE_SETUP_STATE_INVALID");
  let setupBasis;
  if (references !== undefined) {
    closed(references, ["canonicalize", "hashIntent"]);
    const canonicalPort = Object.getOwnPropertyDescriptor(references, "canonicalize"),
      hashPort = Object.getOwnPropertyDescriptor(references, "hashIntent");
    if (
      !canonicalPort?.enumerable ||
      !("value" in canonicalPort) ||
      !hashPort?.enumerable ||
      !("value" in hashPort) ||
      typeof canonicalPort.value !== "function" ||
      typeof hashPort.value !== "function" ||
      draft.profile !== "StoreSetupDraftV2" ||
      draft.content.feeContexts?.state !== "Configured"
    )
      return fail("STORE_SETUP_INCOMPLETE");
    const canonicalize = references.canonicalize,
      hashIntent = references.hashIntent;
    const ordered = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(ordered)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b, "en"))
                .map(([key, item]) => [key, ordered(item)]),
            )
          : v;
    let snapshotDigest: unknown;
    try {
      const text: unknown = canonicalize.call(references, draft);
      if (typeof text !== "string" || text.length > 2097152) return fail();
      const parsed = copy(JSON.parse(text));
      if (
        JSON.stringify(ordered(parsed)) !== JSON.stringify(ordered(draft)) ||
        canonicalize.call(references, parsed) !== text
      )
        return fail();
      snapshotDigest = hashIntent.call(references, text);
    } catch {
      return fail();
    }
    if (
      Object.getOwnPropertyDescriptor(references, "canonicalize")?.value !== canonicalize ||
      Object.getOwnPropertyDescriptor(references, "hashIntent")?.value !== hashIntent ||
      typeof snapshotDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(snapshotDigest)
    )
      return fail();
    setupBasis = {
      profile: "StoreSetupConfigurationBasisV2",
      tenantReference: draft.tenantReference,
      setupDraftReference: draft.setupDraftReference,
      sourceRevision: draft.revision,
      sourceSnapshotDigest: snapshotDigest,
      feeContexts: draft.content.feeContexts.value,
    };
  }
  return createStoreConfigurationVersion({
    ...resolved,
    ...(setupBasis === undefined ? {} : { setupBasis }),
    configurationReference: reference(metadata.configurationReference),
    configurationVersion: positive(metadata.configurationVersion),
    brandReference: actual.brandReference,
    storeReference: actual.storeReference,
    defaultLocale: actual.defaultLocale,
    currencyCode: actual.currencyCode,
    lifecycle: "Draft",
    supersedesConfigurationReference: draft.baseConfigurationReference,
    reasonCode: metadata.reasonCode,
    authoredByReference: actual.actorReference,
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    liveGateEvidenceReference: null,
    createdAt,
    updatedAt,
    dataClassification: "ConfigurationMetadata",
  });
}

export function materializeStoreSetupConfigurationVersion(
  value: unknown,
  actualScope: StoreSetupActualScope,
  serverMetadata: StoreSetupMaterializationMetadata,
): StoreConfigurationVersion {
  return materializeConfiguration(value, actualScope, serverMetadata);
}
export function materializeStoreSetupConfigurationVersionV2(
  value: unknown,
  actualScope: StoreSetupActualScope,
  serverMetadata: StoreSetupMaterializationMetadata,
  references: { canonicalize(value: unknown): string; hashIntent(value: string): string },
): StoreConfigurationVersion {
  return materializeConfiguration(value, actualScope, serverMetadata, references);
}
