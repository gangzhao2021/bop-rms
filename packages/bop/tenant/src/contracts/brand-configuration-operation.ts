import {
  parseBrandReference,
  parseCanonicalInstant,
  parseOrganizationVersion,
} from "../domain/brand-store.js";
import { parsePlatformTenantReference } from "./platform-tenant-administration.js";
import {
  parseBrandAdministrationReference,
  parseBrandConfigurationEditableContent,
  brandConfigurationEditableFields,
  type BrandConfigurationEditableContent,
  type BrandConfigurationVersion,
} from "./brand-administration.js";
import {
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContent,
} from "./brand-configuration-content-source.js";

export const brandConfigurationCommands = [
  "SaveConfigurationDraft",
  "SubmitConfiguration",
  "ApproveConfiguration",
  "PublishConfiguration",
] as const;
export type BrandConfigurationCommandName = (typeof brandConfigurationCommands)[number];
export class BrandConfigurationOperationError extends Error {
  constructor(
    readonly code:
      | "BRAND_CONFIGURATION_INPUT_INVALID"
      | "BRAND_CONFIGURATION_PERMISSION_DENIED"
      | "BRAND_CONFIGURATION_VERSION_CONFLICT"
      | "BRAND_CONFIGURATION_OPERATION_INTENT_CONFLICT"
      | "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Brand configuration operation is unavailable");
    this.name = "BrandConfigurationOperationError";
  }
}
export interface BrandConfigurationActorScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
}
export interface BrandConfigurationHead {
  readonly revision: number;
  readonly configurationVersionReference: string;
  readonly sourceDigest: string;
}
interface Identity extends BrandConfigurationActorScope {
  readonly command: BrandConfigurationCommandName;
  readonly operationReference: string;
  readonly expectedBrandVersion: number;
  readonly expectedHead: BrandConfigurationHead | null;
  readonly purposeCode: "BRAND_CONFIGURATION";
}
/** Stable original input: editable values for Save; scalar head pins and null
 * configuration for lifecycle actions. IDs/Core metadata are allocated after lookup. */
export interface BrandConfigurationCommand extends Identity {
  readonly profile: "TenantBrandConfigurationCommandV1";
  readonly configuration: BrandConfigurationEditableContent | null;
  readonly reviewValidUntil: string | null;
}
export interface BrandConfigurationResolve extends Identity {
  readonly profile: "TenantBrandConfigurationResolveV1";
  readonly intentDigest: string;
}
export interface BrandConfigurationPublishingBinding {
  readonly familyReference: string;
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly mutationOperationReference: string;
  readonly validationEvidenceReference: string;
  readonly approvalEvidenceReference: string | null;
  readonly publicationReference: string | null;
}
export interface BrandConfigurationRevision extends BrandConfigurationActorScope {
  readonly profile: "TenantBrandConfigurationRevisionV1";
  readonly revision: number;
  readonly brandVersion: number;
  readonly command: BrandConfigurationCommandName;
  readonly operationReference: string;
  readonly configuration: BrandConfigurationVersion;
  readonly submittedByReference: string | null;
  readonly publishing: BrandConfigurationPublishingBinding | null;
  readonly contentDigest: string;
  readonly sourceDigest: string;
  readonly auditReference: string;
  readonly createdAt: string;
  readonly recordedAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}
export interface BrandConfigurationReceipt extends Identity {
  readonly profile: "TenantBrandConfigurationOperationV1";
  readonly intentDigest: string;
  readonly originalCommand: BrandConfigurationCommand | null;
  readonly outcome: "Committed" | "Abandoned";
  readonly snapshot: BrandConfigurationRevision | null;
  readonly auditReference: string;
  readonly occurredAt: string;
  readonly dataClassification: "ConfigurationMetadata";
}
export interface BrandConfigurationCurrent extends BrandConfigurationActorScope {
  readonly profile: "TenantBrandConfigurationCurrentV1";
  readonly current: BrandConfigurationRevision | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly currentPublication: "NotEvaluated";
}
export interface BrandConfigurationHistory extends BrandConfigurationActorScope {
  readonly profile: "TenantBrandConfigurationHistoryV1";
  readonly beforeRevision: number | null;
  readonly entries: readonly BrandConfigurationRevision[];
  readonly nextBeforeRevision: number | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly currentPublication: "NotEvaluated";
}
export interface BrandConfigurationDigestReferences {
  canonicalize(value: unknown): string;
  hashIntent(canonical: string): string;
}
export const brandConfigurationOperationRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "actorReference",
  "command",
  "operationReference",
  "expectedBrandVersion",
  "expectedHead",
  "configuration",
  "reviewValidUntil",
  "submittedByReference",
  "publishing",
  "contentDigest",
  "sourceDigest",
  "auditReference",
  "occurredAt",
] as const);
const scopeKeys = ["tenantReference", "brandReference", "actorReference"] as const;
const identityKeys = [
  ...scopeKeys,
  "command",
  "operationReference",
  "expectedBrandVersion",
  "expectedHead",
  "purposeCode",
];
const revisionKeys = [
  "profile",
  ...scopeKeys,
  "revision",
  "brandVersion",
  "command",
  "operationReference",
  "configuration",
  "submittedByReference",
  "publishing",
  "contentDigest",
  "sourceDigest",
  "auditReference",
  "createdAt",
  "recordedAt",
  "dataClassification",
];
const fail: () => never = () => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_INPUT_INVALID");
};
const safe = <T>(work: () => T): T => {
  try {
    return work();
  } catch {
    return fail();
  }
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
/** Validate and detach before invoking legacy value validators; no getter may
 * reach the legacy 22-field parser. Limits protect small metadata documents. */
function detached(value: unknown, maximum = 131072): unknown {
  let nodes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 20) return fail();
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : fail();
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail();
      return Object.freeze(
        Array.from({ length: v.length }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !("value" in d)) return fail();
          return copy(d.value, depth + 1);
        }),
      );
    }
    if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return fail();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== "string" || key === "__proto__") return fail();
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      result[key] = copy(d.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > maximum) return fail();
  return result;
}
function scope(r: Record<string, unknown>): BrandConfigurationActorScope {
  return Object.freeze({
    tenantReference: parsePlatformTenantReference(r.tenantReference),
    brandReference: parseBrandReference(r.brandReference),
    actorReference: parseBrandAdministrationReference(r.actorReference),
  });
}
function integer(value: unknown, min = 1, max = 2147483647): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fail();
}
function digest(value: unknown): string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : fail();
}
function command(value: unknown): BrandConfigurationCommandName {
  if (
    value === "SaveConfigurationDraft" ||
    value === "SubmitConfiguration" ||
    value === "ApproveConfiguration" ||
    value === "PublishConfiguration"
  )
    return value;
  return fail();
}
function head(value: unknown): BrandConfigurationHead | null {
  if (value === null) return null;
  const r = record(value, ["revision", "configurationVersionReference", "sourceDigest"]);
  return Object.freeze({
    revision: integer(r.revision, 1, 2147483646),
    configurationVersionReference: parseBrandAdministrationReference(
      r.configurationVersionReference,
    ),
    sourceDigest: digest(r.sourceDigest),
  });
}
function identity(r: Record<string, unknown>): Identity {
  const h = head(r.expectedHead),
    c = command(r.command);
  if (r.purposeCode !== "BRAND_CONFIGURATION" || (h === null && c !== "SaveConfigurationDraft"))
    return fail();
  return Object.freeze({
    ...scope(r),
    command: c,
    operationReference: parseBrandAdministrationReference(r.operationReference),
    expectedBrandVersion: parseOrganizationVersion(r.expectedBrandVersion),
    expectedHead: h,
    purposeCode: "BRAND_CONFIGURATION",
  });
}
export function parseBrandConfigurationCommand(value: unknown): BrandConfigurationCommand {
  return safe(() => {
    const r = record(detached(value), [
        "profile",
        ...identityKeys,
        "configuration",
        "reviewValidUntil",
      ]),
      i = identity(r);
    if (r.profile !== "TenantBrandConfigurationCommandV1") return fail();
    const configuration =
      i.command === "SaveConfigurationDraft"
        ? parseBrandConfigurationEditableContent(r.configuration)
        : null;
    if (i.command !== "SaveConfigurationDraft" && r.configuration !== null) return fail();
    const reviewValidUntil =
      i.command === "SubmitConfiguration" ? parseCanonicalInstant(r.reviewValidUntil) : null;
    if (i.command !== "SubmitConfiguration" && r.reviewValidUntil !== null) return fail();
    return Object.freeze({
      profile: "TenantBrandConfigurationCommandV1",
      ...i,
      configuration,
      reviewValidUntil,
    });
  });
}
export function parseBrandConfigurationResolve(value: unknown): BrandConfigurationResolve {
  return safe(() => {
    const r = record(detached(value), ["profile", ...identityKeys, "intentDigest"]);
    if (r.profile !== "TenantBrandConfigurationResolveV1") return fail();
    return Object.freeze({
      profile: "TenantBrandConfigurationResolveV1",
      ...identity(r),
      intentDigest: digest(r.intentDigest),
    });
  });
}
function binding(value: unknown): BrandConfigurationPublishingBinding | null {
  if (value === null) return null;
  const r = record(value, [
    "familyReference",
    "lifecycleReference",
    "lifecycleVersion",
    "mutationOperationReference",
    "validationEvidenceReference",
    "approvalEvidenceReference",
    "publicationReference",
  ]);
  return Object.freeze({
    familyReference: parseBrandAdministrationReference(r.familyReference),
    lifecycleReference: parseBrandAdministrationReference(r.lifecycleReference),
    lifecycleVersion: integer(r.lifecycleVersion, 2),
    mutationOperationReference: parseBrandAdministrationReference(r.mutationOperationReference),
    validationEvidenceReference: parseBrandAdministrationReference(r.validationEvidenceReference),
    approvalEvidenceReference:
      r.approvalEvidenceReference === null
        ? null
        : parseBrandAdministrationReference(r.approvalEvidenceReference),
    publicationReference:
      r.publicationReference === null
        ? null
        : parseBrandAdministrationReference(r.publicationReference),
  });
}
export function parseBrandConfigurationRevision(value: unknown): BrandConfigurationRevision {
  return safe(() => {
    const r = record(detached(value), revisionKeys),
      s = scope(r),
      c = parseTenantRecordedBrandConfiguration(r.configuration),
      action = command(r.command),
      p = binding(r.publishing),
      submitted =
        r.submittedByReference === null
          ? null
          : parseBrandAdministrationReference(r.submittedByReference),
      revision = integer(r.revision),
      createdAt = parseCanonicalInstant(r.createdAt),
      recordedAt = parseCanonicalInstant(r.recordedAt);
    const state = {
      SaveConfigurationDraft: "Draft",
      SubmitConfiguration: "PendingApproval",
      ApproveConfiguration: "Approved",
      PublishConfiguration: "Published",
    }[action];
    if (
      r.profile !== "TenantBrandConfigurationRevisionV1" ||
      r.dataClassification !== "ConfigurationMetadata" ||
      c.brandReference !== s.brandReference ||
      c.lifecycle !== state ||
      c.updatedAt !== recordedAt ||
      createdAt > recordedAt ||
      (revision === 1 && createdAt !== recordedAt) ||
      (action === "SaveConfigurationDraft" &&
        (p !== null || submitted !== null || c.authoredByReference !== s.actorReference)) ||
      (action !== "SaveConfigurationDraft" && (p === null || submitted === null)) ||
      (action === "SubmitConfiguration" && submitted !== s.actorReference) ||
      (action === "ApproveConfiguration" &&
        (s.actorReference === submitted ||
          s.actorReference === c.authoredByReference ||
          c.approvedByReference !== s.actorReference)) ||
      (p !== null &&
        (p.approvalEvidenceReference !== c.approvalEvidenceReference ||
          p.publicationReference !== c.publicationReference ||
          (action === "SubmitConfiguration" && p.lifecycleVersion < 2) ||
          (action === "ApproveConfiguration" && p.lifecycleVersion < 3) ||
          (action === "PublishConfiguration" && p.lifecycleVersion < 4)))
    )
      return fail();
    return Object.freeze({
      profile: "TenantBrandConfigurationRevisionV1",
      ...s,
      revision,
      brandVersion: parseOrganizationVersion(r.brandVersion),
      command: action,
      operationReference: parseBrandAdministrationReference(r.operationReference),
      configuration: c,
      submittedByReference: submitted,
      publishing: p,
      contentDigest: digest(r.contentDigest),
      sourceDigest: digest(r.sourceDigest),
      auditReference: parseBrandAdministrationReference(r.auditReference),
      createdAt,
      recordedAt,
      dataClassification: "ConfigurationMetadata",
    });
  });
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function parseBrandConfigurationReceipt(value: unknown): BrandConfigurationReceipt {
  return safe(() => {
    const r = record(detached(value), [
        "profile",
        ...identityKeys,
        "intentDigest",
        "originalCommand",
        "outcome",
        "snapshot",
        "auditReference",
        "occurredAt",
        "dataClassification",
      ]),
      i = identity(r),
      original =
        r.originalCommand === null ? null : parseBrandConfigurationCommand(r.originalCommand),
      snapshot = r.snapshot === null ? null : parseBrandConfigurationRevision(r.snapshot),
      auditReference = parseBrandAdministrationReference(r.auditReference),
      occurredAt = parseCanonicalInstant(r.occurredAt);
    if (
      r.profile !== "TenantBrandConfigurationOperationV1" ||
      r.dataClassification !== "ConfigurationMetadata" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned") ||
      (r.outcome === "Committed") !== (original !== null && snapshot !== null) ||
      (r.outcome === "Abandoned" && (original !== null || snapshot !== null))
    )
      return fail();
    if (original && snapshot) {
      const expected = i.expectedHead?.revision ?? 0;
      if (
        identityKeys.some(
          (k) =>
            !same(
              Object.getOwnPropertyDescriptor(original, k)?.value,
              Object.getOwnPropertyDescriptor(i, k)?.value,
            ),
        ) ||
        snapshot.tenantReference !== i.tenantReference ||
        snapshot.brandReference !== i.brandReference ||
        snapshot.actorReference !== i.actorReference ||
        snapshot.command !== i.command ||
        snapshot.operationReference !== i.operationReference ||
        snapshot.brandVersion !== i.expectedBrandVersion ||
        snapshot.revision !== expected + 1 ||
        snapshot.auditReference !== auditReference ||
        snapshot.recordedAt !== occurredAt ||
        (original.configuration !== null &&
          !same(
            original.configuration,
            parseBrandConfigurationEditableContent(
              Object.fromEntries(
                brandConfigurationEditableFields.map((key) => [
                  key,
                  Object.getOwnPropertyDescriptor(snapshot.configuration, key)?.value,
                ]),
              ),
            ),
          ))
      )
        return fail();
      if (
        original.command === "SubmitConfiguration" &&
        (original.reviewValidUntil === null ||
          snapshot.recordedAt >= original.reviewValidUntil ||
          (snapshot.configuration.effectiveUntil !== null &&
            original.reviewValidUntil > snapshot.configuration.effectiveUntil))
      )
        return fail();
      if (
        i.expectedHead &&
        i.command !== "SaveConfigurationDraft" &&
        snapshot.configuration.configurationVersionReference !==
          i.expectedHead.configurationVersionReference
      )
        return fail();
      if (
        i.command === "SaveConfigurationDraft" &&
        i.expectedHead !== null &&
        (snapshot.configuration.configurationVersionReference ===
          i.expectedHead.configurationVersionReference ||
          snapshot.configuration.supersedesVersionReference !==
            i.expectedHead.configurationVersionReference)
      )
        return fail();
    }
    return Object.freeze({
      profile: "TenantBrandConfigurationOperationV1",
      ...i,
      intentDigest: digest(r.intentDigest),
      originalCommand: original,
      outcome: r.outcome,
      snapshot,
      auditReference,
      occurredAt,
      dataClassification: "ConfigurationMetadata",
    });
  });
}
function lease(r: Record<string, unknown>) {
  const observedAt = parseCanonicalInstant(r.observedAt),
    validUntil = parseCanonicalInstant(r.validUntil);
  if (
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    r.currentPublication !== "NotEvaluated"
  )
    return fail();
  return { observedAt, validUntil, currentPublication: "NotEvaluated" as const };
}
export function parseBrandConfigurationCurrent(value: unknown): BrandConfigurationCurrent {
  return safe(() => {
    const r = record(detached(value), [
        "profile",
        ...scopeKeys,
        "current",
        "observedAt",
        "validUntil",
        "currentPublication",
      ]),
      s = scope(r),
      time = lease(r),
      current = r.current === null ? null : parseBrandConfigurationRevision(r.current);
    if (
      r.profile !== "TenantBrandConfigurationCurrentV1" ||
      (current &&
        (current.tenantReference !== s.tenantReference ||
          current.brandReference !== s.brandReference ||
          current.recordedAt > time.observedAt))
    )
      return fail();
    return Object.freeze({ profile: "TenantBrandConfigurationCurrentV1", ...s, current, ...time });
  });
}
export function parseBrandConfigurationHistory(value: unknown): BrandConfigurationHistory {
  return safe(() => {
    const r = record(detached(value, 393216), [
        "profile",
        ...scopeKeys,
        "beforeRevision",
        "entries",
        "nextBeforeRevision",
        "observedAt",
        "validUntil",
        "currentPublication",
      ]),
      s = scope(r),
      time = lease(r),
      before = r.beforeRevision === null ? null : integer(r.beforeRevision),
      next = r.nextBeforeRevision === null ? null : integer(r.nextBeforeRevision);
    if (
      r.profile !== "TenantBrandConfigurationHistoryV1" ||
      !Array.isArray(r.entries) ||
      r.entries.length > 2
    )
      return fail();
    const entries = r.entries.map(parseBrandConfigurationRevision);
    if (
      entries.some(
        (e, index) =>
          e.tenantReference !== s.tenantReference ||
          e.brandReference !== s.brandReference ||
          e.recordedAt > time.observedAt ||
          (before !== null && e.revision >= before) ||
          (index > 0 && e.revision >= (entries[index - 1]?.revision ?? 0)),
      ) ||
      (next !== null && (entries.length !== 2 || next !== entries[1]?.revision))
    )
      return fail();
    return Object.freeze({
      profile: "TenantBrandConfigurationHistoryV1",
      ...s,
      beforeRevision: before,
      entries: Object.freeze(entries),
      nextBeforeRevision: next,
      ...time,
    });
  });
}
function hash(value: unknown, refs: BrandConfigurationDigestReferences) {
  const text = refs.canonicalize(value);
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 131072) return fail();
  return digest(refs.hashIntent(text));
}
export function brandConfigurationIntentDigest(
  value: unknown,
  refs: BrandConfigurationDigestReferences,
) {
  return safe(() => hash(parseBrandConfigurationCommand(value), refs));
}
export function createBrandConfigurationRevision(
  value: unknown,
  refs: BrandConfigurationDigestReferences,
): BrandConfigurationRevision {
  return safe(() => {
    const r = record(
      detached(value),
      revisionKeys.filter((k) => k !== "contentDigest" && k !== "sourceDigest"),
    );
    const configuration = parseTenantRecordedBrandConfiguration(r.configuration),
      contentDigest = hash(tenantBrandConfigurationContent(configuration), refs);
    const parsed = parseBrandConfigurationRevision({
      ...r,
      configuration,
      contentDigest,
      sourceDigest: "sha256:" + "0".repeat(64),
    });
    const { sourceDigest: omitted, ...preimage } = parsed;
    void omitted;
    return parseBrandConfigurationRevision({ ...parsed, sourceDigest: hash(preimage, refs) });
  });
}
export function assertBrandConfigurationRevisionDigests(
  value: unknown,
  refs: BrandConfigurationDigestReferences,
): BrandConfigurationRevision {
  return safe(() => {
    const parsed = parseBrandConfigurationRevision(value),
      { sourceDigest: omitted, ...preimage } = parsed;
    if (
      parsed.contentDigest !== hash(tenantBrandConfigurationContent(parsed.configuration), refs) ||
      omitted !== hash(preimage, refs)
    )
      return fail();
    return parsed;
  });
}
