import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseCanonicalInstant } from "@bop/tenant";
import { TaxConfigWorkflowError } from "../application/tax-config-service.js";
import {
  parsePricingReference,
  parsePricingDigest,
  type PricingReference,
  type PricingDigest,
} from "../domain/money-tax-contract.js";
import {
  parseTaxConfigAuthoringScope,
  parseTaxConfigAuthoringState,
  taxConfigAuthoringMaximumResultBytes,
  type TaxConfigAuthoringScope,
} from "./tax-config-authoring.js";
import { parseTaxConfigMaterialVersion } from "./tax-config-material.js";
import {
  parseTaxPublicationCandidate,
  assertTaxPublicationCandidateDraft,
  type TaxPublicationCandidate,
  type TaxPublicationCandidateContent,
  type TaxPublicationRegistrationMaterial,
} from "./tax-config-publication-candidate.js";

export interface TaxConfigCandidateCommand {
  readonly action: "PrepareCandidate";
  readonly operationReference: PricingReference;
  readonly configurationReference: PricingReference;
  readonly expectedDraft: TaxPublicationCandidateContent["baseDraft"];
  readonly registrationMaterial: TaxPublicationRegistrationMaterial;
}
export interface TaxConfigCandidateResolve extends TaxConfigCandidateCommand {
  readonly intentDigest: PricingDigest;
}
/** Actual immutable preparation, not professional qualification or authorization. */
export interface TaxConfigCandidateRecord {
  readonly profile: "TaxConfigCandidateRecordV1";
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly preparedByActorReference: PricingReference;
  readonly operationReference: PricingReference;
  readonly candidate: TaxPublicationCandidate;
  readonly auditReference: PricingReference;
  readonly eventReference: PricingReference;
  readonly preparedAt: string;
  readonly dataClassification: "Confidential";
  readonly status: "Recorded";
  readonly qualification: "NotEvaluated";
}
export interface TaxConfigCandidateOperation
  extends TaxConfigAuthoringScope, TaxConfigCandidateResolve {
  readonly profile: "TaxConfigCandidateOperationV1";
  readonly command: TaxConfigCandidateCommand | null;
  readonly outcome: "Committed" | "Abandoned";
  readonly result: TaxConfigCandidateRecord | null;
  readonly auditReference: PricingReference;
  readonly eventReference: PricingReference | null;
  readonly occurredAt: string;
}
export interface TaxConfigCandidateCurrent extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigCandidateCurrentV1";
  readonly configurationReference: PricingReference;
  readonly targetVersionReference: PricingReference | null;
  readonly record: TaxConfigCandidateRecord | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly qualification: "NotEvaluated";
}
/** Metadata only; no candidate rule body, professional report or material content. */
export interface TaxConfigCandidateSummary {
  readonly tenantReference: PricingReference;
  readonly brandReference: PricingReference;
  readonly storeReference: PricingReference;
  readonly configurationReference: PricingReference;
  readonly targetVersionReference: PricingReference;
  readonly targetAggregateVersion: number;
  readonly targetVersionNumber: number;
  readonly contentDigest: PricingDigest;
  readonly baseDraft: TaxPublicationCandidateContent["baseDraft"];
  readonly registrationMaterial: TaxPublicationRegistrationMaterial;
  readonly preparedByActorReference: PricingReference;
  readonly operationReference: PricingReference;
  readonly preparedAt: string;
  readonly status: "Recorded";
  readonly qualification: "NotEvaluated";
}
export interface TaxConfigCandidateRoster extends TaxConfigAuthoringScope {
  readonly profile: "TaxConfigCandidateRosterV1";
  readonly configurationReference: PricingReference;
  readonly afterCandidate: PricingReference | null;
  readonly entries: readonly TaxConfigCandidateSummary[];
  readonly nextAfterCandidate: PricingReference | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly qualification: "NotEvaluated";
}
export const taxConfigCandidateMaximumRecordBytes = taxConfigAuthoringMaximumResultBytes + 8192;
export const taxConfigCandidateRosterLimit = 20;
export const taxConfigCandidateRequiredFields = Object.freeze([
  "scope",
  "configurationReference",
  "originalOperation",
  "expectedDraft",
  "registrationMaterial",
  "candidate",
  "sourceRuleBindings",
  "contentDigest",
  "preparedByActorReference",
  "preparedAt",
  "audit",
  "event",
] as const);
const scopeKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
] as const;
const commandKeys = [
  "action",
  "operationReference",
  "configurationReference",
  "expectedDraft",
  "registrationMaterial",
] as const;
const baseKeys = [
  "versionReference",
  "snapshotDigest",
  "aggregateVersion",
  "versionNumber",
] as const;
const pinKeys = ["materialReference", "versionReference", "contentDigest"] as const;
const invalid = (): never => {
  throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
};
function normal<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((k) => typeof k !== "string" || !keys.includes(k))
  )
    return invalid();
  return Object.fromEntries(
    keys.map((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return invalid();
      return [key, d.value];
    }),
  );
}
function detached(value: unknown, maximumBytes: number): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 40000 || depth > 20) return invalid();
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return v.length <= 16384 ? v : invalid();
    if (typeof v === "number") return Number.isFinite(v) ? v : invalid();
    if (!v || typeof v !== "object" || seen.has(v)) return invalid();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 256 ||
          Reflect.ownKeys(v).length !== v.length + 1
        )
          return invalid();
        return Object.freeze(
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d?.enumerable || !("value" in d)) return invalid();
            return copy(d.value, depth + 1);
          }),
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype) return invalid();
      return Object.freeze(
        Object.fromEntries(
          Reflect.ownKeys(v).map((key) => {
            if (typeof key !== "string") return invalid();
            const d = Object.getOwnPropertyDescriptor(v, key);
            if (!d?.enumerable || !("value" in d)) return invalid();
            return [key, copy(d.value, depth + 1)];
          }),
        ),
      );
    } finally {
      seen.delete(v);
    }
  };
  const result = copy(value, 0);
  if (new TextEncoder().encode(canonicalizeRfc8785(result)).byteLength > maximumBytes)
    return invalid();
  return result;
}
const hash = (value: unknown) =>
  parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(value)));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const instant = (v: unknown) => String(parseCanonicalInstant(v));
const optionalRef = (v: unknown) => (v === null ? null : parsePricingReference(v));
function positive(v: unknown, maximum = 2147483647): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > maximum) return invalid();
  return v;
}
function base(value: unknown): TaxConfigCandidateCommand["expectedDraft"] {
  const r = closed(value, baseKeys);
  return Object.freeze({
    versionReference: parsePricingReference(r.versionReference),
    snapshotDigest: parsePricingDigest(r.snapshotDigest),
    aggregateVersion: positive(r.aggregateVersion, 2147483646),
    versionNumber: positive(r.versionNumber, 2147483646),
  });
}
function pin(value: unknown): TaxPublicationRegistrationMaterial {
  const r = closed(value, pinKeys);
  return Object.freeze({
    materialReference: parsePricingReference(r.materialReference),
    versionReference: parsePricingReference(r.versionReference),
    contentDigest: parsePricingDigest(r.contentDigest),
  });
}
function scopeOf(r: Record<string, unknown>): TaxConfigAuthoringScope {
  return parseTaxConfigAuthoringScope(Object.fromEntries(scopeKeys.map((k) => [k, r[k]])));
}
function matchesScope(
  value: Pick<TaxConfigAuthoringScope, "tenantReference" | "brandReference" | "storeReference">,
  scope: Pick<TaxConfigAuthoringScope, "tenantReference" | "brandReference" | "storeReference">,
): void {
  if (
    value.tenantReference !== scope.tenantReference ||
    value.brandReference !== scope.brandReference ||
    value.storeReference !== scope.storeReference
  )
    return invalid();
}
function pins(r: Record<string, unknown>): TaxConfigCandidateCommand {
  if (r.action !== "PrepareCandidate") return invalid();
  return Object.freeze({
    action: "PrepareCandidate",
    operationReference: parsePricingReference(r.operationReference),
    configurationReference: parsePricingReference(r.configurationReference),
    expectedDraft: base(r.expectedDraft),
    registrationMaterial: pin(r.registrationMaterial),
  });
}
export function parseTaxConfigCandidateCommand(value: unknown): TaxConfigCandidateCommand {
  return normal(() => pins(closed(detached(value, 4096), commandKeys)));
}
export function parseTaxConfigCandidateResolve(value: unknown): TaxConfigCandidateResolve {
  return normal(() => {
    const r = closed(detached(value, 4096), [...commandKeys, "intentDigest"]);
    return Object.freeze({ ...pins(r), intentDigest: parsePricingDigest(r.intentDigest) });
  });
}
export function taxConfigCandidateIntentDigest(scope: unknown, command: unknown): PricingDigest {
  return hash({
    scope: parseTaxConfigAuthoringScope(scope),
    command: parseTaxConfigCandidateCommand(command),
  });
}
export function parseTaxConfigCandidateRecord(value: unknown): TaxConfigCandidateRecord {
  return normal(() => {
    const r = closed(detached(value, taxConfigCandidateMaximumRecordBytes), [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "preparedByActorReference",
      "operationReference",
      "candidate",
      "auditReference",
      "eventReference",
      "preparedAt",
      "dataClassification",
      "status",
      "qualification",
    ]);
    if (
      r.profile !== "TaxConfigCandidateRecordV1" ||
      r.dataClassification !== "Confidential" ||
      r.status !== "Recorded" ||
      r.qualification !== "NotEvaluated"
    )
      return invalid();
    const s = {
        tenantReference: parsePricingReference(r.tenantReference),
        brandReference: parsePricingReference(r.brandReference),
        storeReference: parsePricingReference(r.storeReference),
      },
      candidate = parseTaxPublicationCandidate(r.candidate);
    matchesScope(candidate.content, s);
    base(candidate.content.baseDraft);
    positive(candidate.content.targetAggregateVersion);
    positive(candidate.content.targetVersionNumber);
    return Object.freeze({
      profile: "TaxConfigCandidateRecordV1",
      ...s,
      preparedByActorReference: parsePricingReference(r.preparedByActorReference),
      operationReference: parsePricingReference(r.operationReference),
      candidate,
      auditReference: parsePricingReference(r.auditReference),
      eventReference: parsePricingReference(r.eventReference),
      preparedAt: instant(r.preparedAt),
      dataClassification: "Confidential",
      status: "Recorded",
      qualification: "NotEvaluated",
    });
  });
}
/** Compare complete actual owning packets; this helper neither acquires them nor authorizes alone. */
export function assertTaxConfigCandidateSources(
  recordValue: unknown,
  draftValue: unknown,
  registrationValue: unknown,
): TaxConfigCandidateRecord {
  return normal(() => {
    const record = parseTaxConfigCandidateRecord(recordValue),
      draft = parseTaxConfigAuthoringState(draftValue),
      registration = parseTaxConfigMaterialVersion(registrationValue),
      c = record.candidate.content;
    assertTaxPublicationCandidateDraft(record.candidate, draft);
    matchesScope(registration, record);
    if (
      registration.materialKind !== "RegistrationApplicability" ||
      registration.materialReference !== c.registrationMaterial.materialReference ||
      registration.versionReference !== c.registrationMaterial.versionReference ||
      registration.contentDigest !== c.registrationMaterial.contentDigest ||
      registration.recordedAt > record.preparedAt ||
      draft.snapshot.createdAt > record.preparedAt
    )
      return invalid();
    return record;
  });
}
export function createTaxConfigCandidateRecord(value: unknown): TaxConfigCandidateRecord {
  return normal(() => {
    const r = closed(value, [
        "scope",
        "command",
        "candidate",
        "draft",
        "registrationMaterial",
        "preparedAt",
        "auditReference",
        "eventReference",
      ]),
      scope = parseTaxConfigAuthoringScope(r.scope),
      command = parseTaxConfigCandidateCommand(r.command),
      candidate = parseTaxPublicationCandidate(r.candidate);
    matchesScope(candidate.content, scope);
    if (
      candidate.content.configurationReference !== command.configurationReference ||
      !equal(candidate.content.baseDraft, command.expectedDraft) ||
      !equal(candidate.content.registrationMaterial, command.registrationMaterial)
    )
      return invalid();
    const record = parseTaxConfigCandidateRecord({
      profile: "TaxConfigCandidateRecordV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      preparedByActorReference: scope.actorReference,
      operationReference: command.operationReference,
      candidate,
      auditReference: r.auditReference,
      eventReference: r.eventReference,
      preparedAt: r.preparedAt,
      dataClassification: "Confidential",
      status: "Recorded",
      qualification: "NotEvaluated",
    });
    return assertTaxConfigCandidateSources(record, r.draft, r.registrationMaterial);
  });
}
export function parseTaxConfigCandidateOperation(value: unknown): TaxConfigCandidateOperation {
  return normal(() => {
    const r = closed(detached(value, taxConfigCandidateMaximumRecordBytes + 8192), [
      "profile",
      ...scopeKeys,
      ...commandKeys,
      "command",
      "intentDigest",
      "outcome",
      "result",
      "auditReference",
      "eventReference",
      "occurredAt",
    ]);
    if (
      r.profile !== "TaxConfigCandidateOperationV1" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return invalid();
    const s = scopeOf(r),
      commandPins = pins(r),
      intentDigest = parsePricingDigest(r.intentDigest),
      occurredAt = instant(r.occurredAt),
      auditReference = parsePricingReference(r.auditReference),
      eventReference = optionalRef(r.eventReference);
    if (intentDigest !== taxConfigCandidateIntentDigest(s, commandPins)) return invalid();
    let command: TaxConfigCandidateCommand | null = null,
      result: TaxConfigCandidateRecord | null = null;
    if (r.outcome === "Abandoned") {
      if (r.command !== null || r.result !== null || eventReference !== null) return invalid();
    } else {
      command = parseTaxConfigCandidateCommand(r.command);
      result = parseTaxConfigCandidateRecord(r.result);
      matchesScope(result, s);
      if (
        !equal(command, commandPins) ||
        result.preparedByActorReference !== s.actorReference ||
        result.operationReference !== command.operationReference ||
        result.preparedAt !== occurredAt ||
        result.auditReference !== auditReference ||
        result.eventReference !== eventReference ||
        result.candidate.content.configurationReference !== command.configurationReference ||
        !equal(result.candidate.content.baseDraft, command.expectedDraft) ||
        !equal(result.candidate.content.registrationMaterial, command.registrationMaterial)
      )
        return invalid();
    }
    return Object.freeze({
      profile: "TaxConfigCandidateOperationV1",
      ...s,
      ...commandPins,
      command,
      intentDigest,
      outcome: r.outcome,
      result,
      auditReference,
      eventReference,
      occurredAt,
    });
  });
}
function observation(r: Record<string, unknown>) {
  const observedAt = instant(r.observedAt),
    validUntil = instant(r.validUntil);
  if (
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    r.qualification !== "NotEvaluated"
  )
    return invalid();
  return { observedAt, validUntil, qualification: "NotEvaluated" as const };
}
export function parseTaxConfigCandidateCurrent(value: unknown): TaxConfigCandidateCurrent {
  return normal(() => {
    const r = closed(detached(value, taxConfigCandidateMaximumRecordBytes + 4096), [
      "profile",
      ...scopeKeys,
      "configurationReference",
      "targetVersionReference",
      "record",
      "observedAt",
      "validUntil",
      "qualification",
    ]);
    if (r.profile !== "TaxConfigCandidateCurrentV1") return invalid();
    const s = scopeOf(r),
      configurationReference = parsePricingReference(r.configurationReference),
      targetVersionReference = optionalRef(r.targetVersionReference),
      record = r.record === null ? null : parseTaxConfigCandidateRecord(r.record),
      at = observation(r);
    if ((record === null) !== (targetVersionReference === null)) return invalid();
    if (record) {
      matchesScope(record, s);
      if (
        record.candidate.content.configurationReference !== configurationReference ||
        record.candidate.content.targetVersionReference !== targetVersionReference ||
        record.preparedAt > at.observedAt
      )
        return invalid();
    }
    return Object.freeze({
      profile: "TaxConfigCandidateCurrentV1",
      ...s,
      configurationReference,
      targetVersionReference,
      record,
      ...at,
    });
  });
}
export function parseTaxConfigCandidateSummary(value: unknown): TaxConfigCandidateSummary {
  return normal(() => {
    const r = closed(detached(value, 4096), [
      "tenantReference",
      "brandReference",
      "storeReference",
      "configurationReference",
      "targetVersionReference",
      "targetAggregateVersion",
      "targetVersionNumber",
      "contentDigest",
      "baseDraft",
      "registrationMaterial",
      "preparedByActorReference",
      "operationReference",
      "preparedAt",
      "status",
      "qualification",
    ]);
    if (r.status !== "Recorded" || r.qualification !== "NotEvaluated") return invalid();
    const targetVersionReference = parsePricingReference(r.targetVersionReference),
      baseDraft = base(r.baseDraft),
      registrationMaterial = pin(r.registrationMaterial),
      targetAggregateVersion = positive(r.targetAggregateVersion),
      targetVersionNumber = positive(r.targetVersionNumber);
    if (
      targetVersionReference === baseDraft.versionReference ||
      targetVersionReference === registrationMaterial.versionReference ||
      targetVersionReference === registrationMaterial.materialReference ||
      targetAggregateVersion !== baseDraft.aggregateVersion + 1 ||
      targetVersionNumber !== baseDraft.versionNumber + 1
    )
      return invalid();
    return Object.freeze({
      tenantReference: parsePricingReference(r.tenantReference),
      brandReference: parsePricingReference(r.brandReference),
      storeReference: parsePricingReference(r.storeReference),
      configurationReference: parsePricingReference(r.configurationReference),
      targetVersionReference,
      targetAggregateVersion,
      targetVersionNumber,
      contentDigest: parsePricingDigest(r.contentDigest),
      baseDraft,
      registrationMaterial,
      preparedByActorReference: parsePricingReference(r.preparedByActorReference),
      operationReference: parsePricingReference(r.operationReference),
      preparedAt: instant(r.preparedAt),
      status: "Recorded",
      qualification: "NotEvaluated",
    });
  });
}
export function parseTaxConfigCandidateRoster(value: unknown): TaxConfigCandidateRoster {
  return normal(() => {
    const r = closed(detached(value, 131072), [
      "profile",
      ...scopeKeys,
      "configurationReference",
      "afterCandidate",
      "entries",
      "nextAfterCandidate",
      "observedAt",
      "validUntil",
      "qualification",
    ]);
    if (
      r.profile !== "TaxConfigCandidateRosterV1" ||
      !Array.isArray(r.entries) ||
      r.entries.length > taxConfigCandidateRosterLimit
    )
      return invalid();
    const s = scopeOf(r),
      configurationReference = parsePricingReference(r.configurationReference),
      afterCandidate = optionalRef(r.afterCandidate),
      entries = Object.freeze(r.entries.map(parseTaxConfigCandidateSummary)),
      nextAfterCandidate = optionalRef(r.nextAfterCandidate),
      at = observation(r);
    let previous = afterCandidate;
    for (const entry of entries) {
      matchesScope(entry, s);
      if (
        entry.configurationReference !== configurationReference ||
        entry.preparedAt > at.observedAt ||
        (previous !== null && entry.targetVersionReference <= previous)
      )
        return invalid();
      previous = entry.targetVersionReference;
    }
    if (
      nextAfterCandidate !== null &&
      (entries.length !== taxConfigCandidateRosterLimit ||
        nextAfterCandidate !== entries.at(-1)?.targetVersionReference)
    )
      return invalid();
    return Object.freeze({
      profile: "TaxConfigCandidateRosterV1",
      ...s,
      configurationReference,
      afterCandidate,
      entries,
      nextAfterCandidate,
      ...at,
    });
  });
}
