import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePublishingProductPublicationPolicy,
  type PublishingProductPublicationPolicy,
} from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
} from "./product.js";
import { productPublicationCheckCodes } from "./product-publication.js";
import type { ProductPublicationCheckCode } from "../domain/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  parseProductPublicationVersionV2,
  type ProductPublicationValidationV2,
} from "./product-publication-v2.js";
import {
  calculateCatalogProductPublicationWarningBindingDigest,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationWarningBinding,
  type CatalogProductPublicationValidationDetails,
  type CatalogProductPublicationWarningBinding,
} from "./product-publication-validation-report.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(r, key))
  )
    return fail();
  return r as Record<string, unknown>;
}
// Parsed fields contain closed ASCII identifiers/codes/instants. Match the
// PostgreSQL jsonb::text budget including its comma/colon spaces.
function persistedReceiptBytes(value: unknown): number {
  if (Array.isArray(value))
    return (
      2 +
      Math.max(0, value.length - 1) * 2 +
      value.reduce((n, v) => n + persistedReceiptBytes(v), 0)
    );
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      2 +
      Math.max(0, entries.length - 1) * 2 +
      entries.reduce(
        (n, [key, v]) => n + persistedReceiptBytes(key) + 2 + persistedReceiptBytes(v),
        0,
      )
    );
  }
  const text = JSON.stringify(value);
  if (text === undefined) return fail();
  return new TextEncoder().encode(text).length;
}
function digest(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(v.slice(7));
}
function integer(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 2147483647) return fail();
  return v;
}
function warningCodes(value: unknown): readonly ProductPublicationCheckCode[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return fail();
  const codes = value
    .map((v) => {
      if (
        typeof v !== "string" ||
        !productPublicationCheckCodes.includes(v as ProductPublicationCheckCode) ||
        v === "HardErrorsCleared"
      )
        return fail();
      return v as ProductPublicationCheckCode;
    })
    .sort();
  if (new Set(codes).size !== codes.length) return fail();
  return Object.freeze(codes);
}
function warnings(
  validation: ProductPublicationValidationV2,
): readonly ProductPublicationCheckCode[] {
  if (validation.checks.some((c) => c.outcome === "HardError")) return fail();
  return warningCodes(validation.checks.filter((c) => c.outcome === "Warning").map((c) => c.code));
}
export interface CatalogProductPublicationWarningAcknowledgementCommand {
  readonly profile: "CatalogProductPublicationWarningAcknowledgementCommandV1";
  readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT";
  readonly action: "AcknowledgeProductPublicationWarnings";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User";
  readonly operationReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly expectedProductAggregateVersion: number;
  readonly reportOperationReference: string;
  readonly reportDigest: string;
  readonly warningBindingDigest: string;
  readonly warningCodes: readonly ProductPublicationCheckCode[];
  readonly reasonCode: string;
  readonly occurredAt: string;
}
const commandFields = [
  "profile",
  "purposeCode",
  "action",
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "operationReference",
  "productReference",
  "versionReference",
  "expectedProductAggregateVersion",
  "reportOperationReference",
  "reportDigest",
  "warningBindingDigest",
  "warningCodes",
  "reasonCode",
  "occurredAt",
] as const;
/** A distinct User command. An ordinary publication reason is never consent. */
export function parseCatalogProductPublicationWarningAcknowledgementCommand(
  value: unknown,
): CatalogProductPublicationWarningAcknowledgementCommand {
  const r = closed(value, commandFields),
    reasonCode = parseCatalogCode(r.reasonCode);
  if (
    r.profile !== "CatalogProductPublicationWarningAcknowledgementCommandV1" ||
    r.purposeCode !== "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT" ||
    r.action !== "AcknowledgeProductPublicationWarnings" ||
    r.actorKind !== "User" ||
    reasonCode !== r.reasonCode
  )
    return fail();
  const operationReference = parseCatalogReference(r.operationReference),
    reportOperationReference = parseCatalogReference(r.reportOperationReference);
  if (operationReference === reportOperationReference) return fail();
  return Object.freeze({
    profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    action: "AcknowledgeProductPublicationWarnings",
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    actorReference: parseCatalogReference(r.actorReference),
    actorKind: "User",
    operationReference,
    productReference: parseCatalogReference(r.productReference),
    versionReference: parseCatalogReference(r.versionReference),
    expectedProductAggregateVersion: integer(r.expectedProductAggregateVersion),
    reportOperationReference,
    reportDigest: digest(r.reportDigest),
    warningBindingDigest: digest(r.warningBindingDigest),
    warningCodes: warningCodes(r.warningCodes),
    reasonCode,
    occurredAt: parseCatalogInstant(r.occurredAt),
  });
}
export interface CatalogProductPublicationWarningAcknowledgementObservation {
  readonly profile: "CatalogProductPublicationWarningAcknowledgementObservationV1";
  readonly acknowledgementOperationReference: string;
  readonly acknowledgementIntentDigest: string;
  readonly actorReference: string;
  readonly binding: CatalogProductPublicationWarningBinding;
  readonly productAggregateVersion: number;
  readonly validation: ProductPublicationValidationV2;
  readonly details: CatalogProductPublicationValidationDetails;
  readonly policy: PublishingProductPublicationPolicy;
  readonly warningBindingDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly digest: string;
}
const observationFields = [
  "profile",
  "acknowledgementOperationReference",
  "acknowledgementIntentDigest",
  "actorReference",
  "binding",
  "productAggregateVersion",
  "validation",
  "details",
  "policy",
  "warningBindingDigest",
  "observedAt",
  "validUntil",
  "digest",
] as const;
function policyBinding(
  policy: PublishingProductPublicationPolicy,
  binding: CatalogProductPublicationWarningBinding,
  validation: ProductPublicationValidationV2,
  observedAt: string,
  validUntil: string,
) {
  if (
    policy.tenantReference !== binding.tenantReference ||
    policy.brandReference !== binding.brandReference ||
    policy.policyReference !== binding.policyReference ||
    policy.policyVersion !== binding.policyVersion ||
    policy.approvalPolicy !== validation.approvalPolicy ||
    !policy.warningOverrideAllowed ||
    policy.effectiveFrom > observedAt ||
    (policy.effectiveUntil !== null && policy.effectiveUntil < validUntil)
  )
    return fail();
}
export function parseCatalogProductPublicationWarningAcknowledgementObservation(
  value: unknown,
): CatalogProductPublicationWarningAcknowledgementObservation {
  const r = closed(value, observationFields),
    binding = parseCatalogProductPublicationWarningBinding(r.binding),
    validation = parseProductPublicationValidationV2(r.validation),
    details = parseCatalogProductPublicationValidationDetails(r.details),
    policy = parsePublishingProductPublicationPolicy(r.policy),
    warningBindingDigest = calculateCatalogProductPublicationWarningBindingDigest(
      binding,
      validation,
      details,
    ),
    observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil),
    productAggregateVersion = integer(r.productAggregateVersion);
  warnings(validation);
  if (
    r.profile !== "CatalogProductPublicationWarningAcknowledgementObservationV1" ||
    details.coverage !== "Complete" ||
    warningBindingDigest === null ||
    r.warningBindingDigest !== warningBindingDigest ||
    productAggregateVersion !== validation.productAggregateVersion ||
    validation.checkedAt > observedAt ||
    validation.validUntil < validUntil ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
    details.sources.some((s) => s.observedAt > observedAt)
  )
    return fail();
  policyBinding(policy, binding, validation, observedAt, validUntil);
  const body = {
    profile: "CatalogProductPublicationWarningAcknowledgementObservationV1" as const,
    acknowledgementOperationReference: parseCatalogReference(r.acknowledgementOperationReference),
    acknowledgementIntentDigest: digest(r.acknowledgementIntentDigest),
    actorReference: parseCatalogReference(r.actorReference),
    binding,
    productAggregateVersion,
    validation,
    details,
    policy,
    warningBindingDigest,
    observedAt,
    validUntil,
  };
  if (digest(r.digest) !== hash(body)) return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}
function bindObservation(
  command: CatalogProductPublicationWarningAcknowledgementCommand,
  observation: CatalogProductPublicationWarningAcknowledgementObservation,
) {
  const b = observation.binding;
  if (
    observation.acknowledgementOperationReference !== command.operationReference ||
    observation.acknowledgementIntentDigest !== hash(command) ||
    observation.actorReference !== command.actorReference ||
    observation.productAggregateVersion !== command.expectedProductAggregateVersion ||
    b.tenantReference !== command.tenantReference ||
    b.brandReference !== command.brandReference ||
    b.productReference !== command.productReference ||
    b.versionReference !== command.versionReference ||
    observation.warningBindingDigest !== command.warningBindingDigest ||
    !equal(warnings(observation.validation), command.warningCodes) ||
    command.occurredAt > observation.observedAt
  )
    return fail();
}
/** A held producer supplies actual Ack-specific facts. This does not relabel an
 * Ack as Validate, perform source acquisition, or establish transaction authority. */
export function buildCatalogProductPublicationWarningAcknowledgementObservation(
  value: unknown,
): CatalogProductPublicationWarningAcknowledgementObservation {
  const r = closed(value, [
      "command",
      "binding",
      "validation",
      "details",
      "policy",
      "observedAt",
      "validUntil",
    ]),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand(r.command),
    binding = parseCatalogProductPublicationWarningBinding(r.binding),
    validation = parseProductPublicationValidationV2(r.validation),
    details = parseCatalogProductPublicationValidationDetails(r.details);
  const body = {
    profile: "CatalogProductPublicationWarningAcknowledgementObservationV1" as const,
    acknowledgementOperationReference: command.operationReference,
    acknowledgementIntentDigest: hash(command),
    actorReference: command.actorReference,
    binding,
    productAggregateVersion: command.expectedProductAggregateVersion,
    validation,
    details,
    policy: parsePublishingProductPublicationPolicy(r.policy),
    warningBindingDigest: calculateCatalogProductPublicationWarningBindingDigest(
      binding,
      validation,
      details,
    ),
    observedAt: parseCatalogInstant(r.observedAt),
    validUntil: parseCatalogInstant(r.validUntil),
  };
  const observation = parseCatalogProductPublicationWarningAcknowledgementObservation({
    ...body,
    digest: hash(body),
  });
  bindObservation(command, observation);
  return observation;
}
export interface CatalogProductPublicationWarningAcknowledgementReceipt {
  readonly profile: "CatalogProductPublicationWarningAcknowledgementReceiptV1";
  readonly command: CatalogProductPublicationWarningAcknowledgementCommand;
  readonly originalIntentDigest: string;
  readonly observation: CatalogProductPublicationWarningAcknowledgementObservation;
  readonly recordedAt: string;
  readonly digest: string;
}
export function parseCatalogProductPublicationWarningAcknowledgementReceipt(
  value: unknown,
): CatalogProductPublicationWarningAcknowledgementReceipt {
  const r = closed(value, [
      "profile",
      "command",
      "originalIntentDigest",
      "observation",
      "recordedAt",
      "digest",
    ]),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand(r.command),
    observation = parseCatalogProductPublicationWarningAcknowledgementObservation(r.observation),
    recordedAt = parseCatalogInstant(r.recordedAt);
  bindObservation(command, observation);
  if (
    r.profile !== "CatalogProductPublicationWarningAcknowledgementReceiptV1" ||
    r.originalIntentDigest !== hash(command) ||
    recordedAt < observation.observedAt ||
    recordedAt >= observation.validUntil
  )
    return fail();
  const body = {
    profile: "CatalogProductPublicationWarningAcknowledgementReceiptV1" as const,
    command,
    originalIntentDigest: hash(command),
    observation,
    recordedAt,
  };
  if (digest(r.digest) !== hash(body)) return fail();
  const receipt = Object.freeze({ ...body, digest: hash(body) });
  if (persistedReceiptBytes(receipt) > 2_097_152) return fail();
  return receipt;
}
/** The displayed report may be old. Only the current observation must be fresh
 * for this write, and its complete semantic warning/reference identity must match. */
export function buildCatalogProductPublicationWarningAcknowledgementReceipt(
  value: unknown,
): CatalogProductPublicationWarningAcknowledgementReceipt {
  const r = closed(value, ["command", "report", "observation", "recordedAt"]),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand(r.command),
    report = parseCatalogProductPublicationValidationReport(r.report),
    observation = parseCatalogProductPublicationWarningAcknowledgementObservation(r.observation),
    recordedAt = parseCatalogInstant(r.recordedAt);
  if (
    report.details.coverage !== "Complete" ||
    report.warningBindingDigest === null ||
    report.digest !== command.reportDigest ||
    report.operationReference !== command.reportOperationReference ||
    report.warningBindingDigest !== command.warningBindingDigest ||
    !equal(report.binding, observation.binding) ||
    !equal(warnings(report.validation), command.warningCodes) ||
    report.recordedAt > command.occurredAt ||
    report.resultAggregateVersion > command.expectedProductAggregateVersion
  )
    return fail();
  const body = {
    profile: "CatalogProductPublicationWarningAcknowledgementReceiptV1" as const,
    command,
    originalIntentDigest: hash(command),
    observation,
    recordedAt,
  };
  return parseCatalogProductPublicationWarningAcknowledgementReceipt({
    ...body,
    digest: hash(body),
  });
}
/** Fresh publication facts are re-bound for every new operation. A receipt never
 * refreshes a source lease, clears a HardError, resolves Pending, or grants policy.
 * The supplied policy must be actually held by the caller; parsing grants no authority. */
export type CatalogProductPublicationWarningAcknowledgementAssessment =
  | { readonly status: "Applicable"; readonly validation: ProductPublicationValidationV2 }
  | { readonly status: "StaleSemantic"; readonly validation: ProductPublicationValidationV2 };

/** Only explicit semantic differences classify a valid receipt as stale. Missing
 * current evidence, malformed stored consent, foreign identity or expired held
 * facts remain errors; there is deliberately no catch-and-treat-as-absence path. */
export function assessCatalogProductPublicationWarningAcknowledgement(
  value: unknown,
): CatalogProductPublicationWarningAcknowledgementAssessment {
  const r = closed(value, [
      "receipt",
      "command",
      "current",
      "validation",
      "details",
      "policy",
      "now",
    ]),
    receipt = parseCatalogProductPublicationWarningAcknowledgementReceipt(r.receipt),
    command = parseProductPublicationCommandV2(r.command),
    current = r.current === null ? null : parseProductPublicationVersionV2(r.current),
    validation = parseProductPublicationValidationV2(r.validation),
    details = parseCatalogProductPublicationValidationDetails(r.details),
    policy = parsePublishingProductPublicationPolicy(r.policy),
    now = parseCatalogInstant(r.now),
    binding = parseCatalogProductPublicationWarningBinding({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      productReference: command.productReference,
      versionReference: command.versionReference,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeDigest: hash(command.scopeSet),
      periodDigest: hash(command.effectivePeriod),
      replacementIntentDigest: command.replacementIntentDigest,
      policyReference: validation.policyReference,
      policyVersion: validation.policyVersion,
    });
  if (
    (current === null && command.expectedPublicationVersion !== 0) ||
    (current !== null &&
      (current.tenantReference !== command.tenantReference ||
        current.brandReference !== command.brandReference ||
        current.productReference !== command.productReference ||
        current.versionReference !== command.versionReference ||
        current.publicationVersion !== command.expectedPublicationVersion ||
        current.productAggregateVersion > command.expectedProductAggregateVersion ||
        current.occurredAt > command.occurredAt))
  )
    return fail();
  const actorReference =
    command.actorKind === "User" ? command.actorReference : current?.submittedByActorReference;
  policyBinding(policy, binding, validation, now, validation.validUntil);
  if (
    !actorReference ||
    receipt.command.tenantReference !== command.tenantReference ||
    receipt.command.brandReference !== command.brandReference ||
    receipt.command.productReference !== command.productReference ||
    receipt.command.versionReference !== command.versionReference ||
    receipt.command.actorReference !== actorReference ||
    receipt.recordedAt > now ||
    command.occurredAt > now ||
    validation.productAggregateVersion !== command.expectedProductAggregateVersion ||
    validation.checkedAt > now ||
    validation.validUntil <= now ||
    command.expectedProductAggregateVersion < receipt.observation.productAggregateVersion ||
    details.coverage !== "Complete" ||
    details.sources.some((s) => s.observedAt > now)
  )
    return fail();
  const acknowledgement = Object.freeze({
    actorReference,
    reasonCode: receipt.command.reasonCode,
    warningCodes: receipt.command.warningCodes,
  });
  if (
    validation.warningAcknowledgement !== null &&
    !equal(validation.warningAcknowledgement, acknowledgement)
  )
    return fail();
  // These calculations validate full current check/findings/source coherence
  // before any semantic comparison can return a non-error stale result.
  const currentWarnings = warnings(validation),
    currentWarningBindingDigest = calculateCatalogProductPublicationWarningBindingDigest(
      binding,
      validation,
      details,
    );
  if (currentWarningBindingDigest === null) return fail();
  if (
    !equal(binding, receipt.observation.binding) ||
    !equal(currentWarnings, receipt.command.warningCodes) ||
    currentWarningBindingDigest !== receipt.command.warningBindingDigest
  )
    return Object.freeze({
      status: "StaleSemantic",
      validation: parseProductPublicationValidationV2({
        ...validation,
        warningAcknowledgement: null,
      }),
    });
  return Object.freeze({
    status: "Applicable",
    validation: parseProductPublicationValidationV2({
      ...validation,
      warningAcknowledgement: acknowledgement,
    }),
  });
}

/** Backwards-compatible strict surface: a stale receipt still refuses binding. */
export function bindCatalogProductPublicationWarningAcknowledgement(
  value: unknown,
): ProductPublicationValidationV2 {
  const result = assessCatalogProductPublicationWarningAcknowledgement(value);
  if (result.status !== "Applicable") return fail();
  return result.validation;
}
