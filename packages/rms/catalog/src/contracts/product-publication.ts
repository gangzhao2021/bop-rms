import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogHash,
  parseCatalogCode,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  productPublicationActions,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  planProductPublicationVersion,
  resolveProductPublicationVersion,
  type ProductPublicationCommand,
  type ProductPublicationScope,
  type ProductPublicationPeriod,
  type ProductPublicationValidation,
  type ProductPublicationApproval,
  type ProductPublicationVersion,
  type ProductPublicationFacts,
  type ProductPublicationContext,
} from "../domain/product-publication.js";
export type {
  ProductPublicationAction,
  ProductPublicationCommand,
  ProductPublicationScope,
  ProductPublicationScopeLevel,
  ProductPublicationPeriod,
  ProductPublicationValidation,
  ProductPublicationApproval,
  ProductPublicationVersion,
  ProductPublicationFacts,
  ProductPublicationContext,
} from "../domain/product-publication.js";
export { productPublicationActions, productPublicationCheckCodes, productPublicationScopeLevels };
const invalid = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return invalid();
  return value as T;
}
function integer(value: unknown, minimum = 1): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 2147483647
  )
    return invalid();
  return value;
}
const ref = (v: unknown) => parseCatalogReference(v);
const nullableRef = (v: unknown) => (v === null ? null : ref(v));
const instant = (v: unknown) => parseCatalogInstant(v);
const nullableInstant = (v: unknown) => (v === null ? null : instant(v));
function digest(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("sha256:")) return invalid();
  return "sha256:" + parseCatalogHash(v.slice(7));
}
function code(v: unknown): string {
  const parsed = parseCatalogCode(v);
  if (parsed !== v) return invalid();
  return parsed;
}
function hash(v: unknown): string {
  return "sha256:" + sha256Hex(canonicalizeRfc8785(v));
}
function unique<T>(value: unknown, parse: (v: unknown) => T, maximum: number): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const parsed = value.map(parse);
  if (new Set(parsed).size !== parsed.length) return invalid();
  return Object.freeze(parsed);
}
function scopes(value: unknown): readonly ProductPublicationScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) return invalid();
  const result = value
    .map((v) => {
      const r = exact(v, ["level", "reference", "channelCodes", "orderTypeCodes"]),
        level = enumeration(r.level, productPublicationScopeLevels);
      const reference =
        level === "Brand"
          ? r.reference === null
            ? null
            : invalid()
          : level === "Channel" || level === "OrderType"
            ? code(r.reference)
            : ref(r.reference);
      const channelCodes = Object.freeze([...unique(r.channelCodes, code, 100)].sort()),
        orderTypeCodes = Object.freeze([...unique(r.orderTypeCodes, code, 100)].sort());
      if (
        level === "Channel" &&
        channelCodes.length > 0 &&
        (channelCodes.length !== 1 || channelCodes[0] !== reference)
      )
        return invalid();
      if (
        level === "OrderType" &&
        orderTypeCodes.length > 0 &&
        (orderTypeCodes.length !== 1 || orderTypeCodes[0] !== reference)
      )
        return invalid();
      return Object.freeze({ level, reference, channelCodes, orderTypeCodes });
    })
    .sort((a, b) => canonicalizeRfc8785(a).localeCompare(canonicalizeRfc8785(b), "en"));
  if (new Set(result.map(canonicalizeRfc8785)).size !== result.length) return invalid();
  return Object.freeze(result);
}
function period(value: unknown): ProductPublicationPeriod {
  try {
    return createEffectivePeriod(value as EffectivePeriod);
  } catch {
    return invalid();
  }
}
const commandKeys = [
  "purposeCode",
  "tenantReference",
  "brandReference",
  "actorReference",
  "actorKind",
  "operationReference",
  "productReference",
  "versionReference",
  "expectedProductAggregateVersion",
  "expectedPublicationVersion",
  "action",
  "contentDigest",
  "configurationDigest",
  "scopeSet",
  "effectivePeriod",
  "scheduleReference",
  "replacementVersionReference",
  "successorDraftVersionReference",
  "occurredAt",
  "reasonCode",
];
function command(value: unknown): ProductPublicationCommand {
  const r = exact(value, commandKeys);
  if (r.purposeCode !== "CATALOG_PRODUCT_VERSION_PUBLICATION") return invalid();
  const action = enumeration(r.action, productPublicationActions),
    actorKind = enumeration(r.actorKind, ["User", "System"] as const);
  const scheduleReference = nullableRef(r.scheduleReference),
    replacementVersionReference = nullableRef(r.replacementVersionReference),
    successorDraftVersionReference = nullableRef(r.successorDraftVersionReference);
  const scheduled = [
      "SchedulePublish",
      "ReschedulePublish",
      "CancelScheduledPublish",
      "ActivateScheduled",
    ].includes(action),
    publishing = action === "Publish" || action === "ActivateScheduled";
  if (
    scheduled !== (scheduleReference !== null) ||
    (action === "Supersede") !== (replacementVersionReference !== null) ||
    publishing !== (successorDraftVersionReference !== null) ||
    (actorKind === "System") !== (action === "ActivateScheduled" || action === "Supersede")
  )
    return invalid();
  const versionReference = ref(r.versionReference);
  if (
    successorDraftVersionReference === versionReference ||
    replacementVersionReference === versionReference
  )
    return invalid();
  return Object.freeze({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    actorReference: ref(r.actorReference),
    actorKind,
    operationReference: ref(r.operationReference),
    productReference: ref(r.productReference),
    versionReference,
    expectedProductAggregateVersion: integer(r.expectedProductAggregateVersion),
    expectedPublicationVersion: integer(r.expectedPublicationVersion, 0),
    action,
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    scopeSet: scopes(r.scopeSet),
    effectivePeriod: period(r.effectivePeriod),
    scheduleReference,
    replacementVersionReference,
    successorDraftVersionReference,
    occurredAt: instant(r.occurredAt),
    reasonCode: code(r.reasonCode),
  });
}
export function parseProductPublicationCommand(value: unknown): ProductPublicationCommand {
  return command(copyCategoryPersistenceValue(value));
}
function validation(value: unknown): ProductPublicationValidation {
  const r = exact(value, [
    "evidenceReference",
    "productAggregateVersion",
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "policyReference",
    "policyVersion",
    "approvalPolicy",
    "checks",
    "warningAcknowledgement",
    "checkedAt",
    "validUntil",
  ]);
  if (!Array.isArray(r.checks) || r.checks.length !== productPublicationCheckCodes.length)
    return invalid();
  const checks = r.checks
    .map((v) => {
      const c = exact(v, ["code", "outcome"]);
      return Object.freeze({
        code: enumeration(c.code, productPublicationCheckCodes),
        outcome: enumeration(c.outcome, ["Pass", "HardError", "Warning"] as const),
      });
    })
    .sort((a, b) => a.code.localeCompare(b.code, "en"));
  if (new Set(checks.map((c) => c.code)).size !== productPublicationCheckCodes.length)
    return invalid();
  const hardErrorSummary = checks.find((c) => c.code === "HardErrorsCleared");
  const hasHardError = checks.some(
    (c) => c.code !== "HardErrorsCleared" && c.outcome === "HardError",
  );
  if (hardErrorSummary?.outcome !== (hasHardError ? "HardError" : "Pass")) return invalid();
  const a =
    r.warningAcknowledgement === null
      ? null
      : exact(r.warningAcknowledgement, ["actorReference", "reasonCode", "warningCodes"]);
  const warningAcknowledgement =
    a === null
      ? null
      : Object.freeze({
          actorReference: ref(a.actorReference),
          reasonCode: code(a.reasonCode),
          warningCodes: Object.freeze(
            [
              ...unique(a.warningCodes, (v) => enumeration(v, productPublicationCheckCodes), 12),
            ].sort(),
          ),
        });
  const warnings = checks.filter((c) => c.outcome === "Warning").map((c) => c.code);
  if (
    warningAcknowledgement !== null &&
    (warnings.length === 0 ||
      canonicalizeRfc8785(warnings) !== canonicalizeRfc8785(warningAcknowledgement.warningCodes))
  )
    return invalid();
  const checkedAt = instant(r.checkedAt),
    validUntil = instant(r.validUntil);
  if (validUntil <= checkedAt) return invalid();
  return Object.freeze({
    evidenceReference: ref(r.evidenceReference),
    productAggregateVersion: integer(r.productAggregateVersion),
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    scopeDigest: digest(r.scopeDigest),
    periodDigest: digest(r.periodDigest),
    policyReference: ref(r.policyReference),
    policyVersion: integer(r.policyVersion),
    approvalPolicy: enumeration(r.approvalPolicy, ["Required", "NotRequired"] as const),
    checks: Object.freeze(checks),
    warningAcknowledgement,
    checkedAt,
    validUntil,
  });
}
export function parseProductPublicationValidation(value: unknown): ProductPublicationValidation {
  return validation(copyCategoryPersistenceValue(value));
}
function approval(value: unknown): ProductPublicationApproval {
  const r = exact(value, [
    "evidenceReference",
    "reviewReference",
    "reviewVersion",
    "requestedByActorReference",
    "approvedByActorReference",
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "policyReference",
    "policyVersion",
    "approvedAt",
    "validUntil",
  ]);
  const approvedAt = instant(r.approvedAt),
    validUntil = instant(r.validUntil),
    requestedByActorReference = ref(r.requestedByActorReference),
    approvedByActorReference = ref(r.approvedByActorReference);
  if (validUntil <= approvedAt || requestedByActorReference === approvedByActorReference)
    return invalid();
  return Object.freeze({
    evidenceReference: ref(r.evidenceReference),
    reviewReference: ref(r.reviewReference),
    reviewVersion: integer(r.reviewVersion),
    requestedByActorReference,
    approvedByActorReference,
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    scopeDigest: digest(r.scopeDigest),
    periodDigest: digest(r.periodDigest),
    policyReference: ref(r.policyReference),
    policyVersion: integer(r.policyVersion),
    approvedAt,
    validUntil,
  });
}
export function parseProductPublicationApproval(value: unknown): ProductPublicationApproval {
  return approval(copyCategoryPersistenceValue(value));
}
const versionKeys = [
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "publicationVersion",
  "productAggregateVersion",
  "state",
  "contentDigest",
  "configurationDigest",
  "scopeSet",
  "scopeDigest",
  "effectivePeriod",
  "periodDigest",
  "validationEvidenceReference",
  "validationDecision",
  "policyReference",
  "policyVersion",
  "approvalPolicy",
  "reviewReference",
  "reviewVersion",
  "submittedByActorReference",
  "approvalEvidenceReference",
  "scheduleReference",
  "scheduleVersion",
  "publishedAt",
  "supersededAt",
  "supersededByVersionReference",
  "successorDraftVersionReference",
  "operationReference",
  "intentDigest",
  "actorReference",
  "actorKind",
  "occurredAt",
  "reasonCode",
];
function version(value: unknown): ProductPublicationVersion {
  const r = exact(value, versionKeys),
    scopeSet = scopes(r.scopeSet),
    effectivePeriod = period(r.effectivePeriod),
    scopeDigest = digest(r.scopeDigest),
    periodDigest = digest(r.periodDigest);
  if (scopeDigest !== hash(scopeSet) || periodDigest !== hash(effectivePeriod)) return invalid();
  const state = enumeration(r.state, [
      "Draft",
      "InReview",
      "Approved",
      "Scheduled",
      "Published",
      "Superseded",
    ] as const),
    reviewReference = nullableRef(r.reviewReference),
    reviewVersion = r.reviewVersion === null ? null : integer(r.reviewVersion),
    submittedByActorReference = nullableRef(r.submittedByActorReference),
    approvalEvidenceReference = nullableRef(r.approvalEvidenceReference),
    approvalPolicy = enumeration(r.approvalPolicy, ["Required", "NotRequired"] as const),
    scheduleReference = nullableRef(r.scheduleReference),
    scheduleVersion = integer(r.scheduleVersion, 0),
    publicationVersion = integer(r.publicationVersion),
    publishedAt = nullableInstant(r.publishedAt),
    supersededAt = nullableInstant(r.supersededAt),
    supersededByVersionReference = nullableRef(r.supersededByVersionReference),
    successorDraftVersionReference = nullableRef(r.successorDraftVersionReference),
    versionReference = ref(r.versionReference),
    occurredAt = instant(r.occurredAt);
  const published = state === "Published" || state === "Superseded";
  if ((state === "Draft" || state === "InReview") && approvalEvidenceReference !== null)
    return invalid();
  if (state === "Approved" && approvalPolicy !== "Required") return invalid();
  if (
    (state === "Approved" || state === "Scheduled" || published) &&
    r.validationDecision !== "Pass"
  )
    return invalid();
  if (r.actorKind === "System" && !published) return invalid();
  if (
    (state === "Draft") !== (reviewReference === null) ||
    (reviewReference === null) !== (reviewVersion === null) ||
    (reviewReference === null) !== (submittedByActorReference === null) ||
    (reviewVersion !== null && reviewVersion > publicationVersion) ||
    (scheduleReference === null) !== (scheduleVersion === 0) ||
    (state === "Scheduled" && scheduleReference === null) ||
    published !== (publishedAt !== null) ||
    published !== (successorDraftVersionReference !== null) ||
    (state === "Superseded") !== (supersededAt !== null) ||
    (state === "Superseded") !== (supersededByVersionReference !== null) ||
    successorDraftVersionReference === versionReference ||
    supersededByVersionReference === versionReference ||
    (publishedAt !== null &&
      (publishedAt > occurredAt ||
        effectivePeriod.effectiveFrom.instant > publishedAt ||
        (effectivePeriod.effectiveUntil !== null &&
          publishedAt >= effectivePeriod.effectiveUntil.instant))) ||
    (supersededAt !== null &&
      (supersededAt > occurredAt || publishedAt === null || supersededAt < publishedAt)) ||
    (state === "Approved" && approvalEvidenceReference === null) ||
    (approvalPolicy === "Required" &&
      ["Scheduled", "Published", "Superseded"].includes(state) &&
      approvalEvidenceReference === null)
  )
    return invalid();
  return Object.freeze({
    tenantReference: ref(r.tenantReference),
    brandReference: ref(r.brandReference),
    productReference: ref(r.productReference),
    versionReference,
    publicationVersion,
    productAggregateVersion: integer(r.productAggregateVersion),
    state,
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    scopeSet,
    scopeDigest,
    effectivePeriod,
    periodDigest,
    validationEvidenceReference: ref(r.validationEvidenceReference),
    validationDecision: enumeration(r.validationDecision, [
      "Pass",
      "HardError",
      "WarningAcknowledgementRequired",
    ] as const),
    policyReference: ref(r.policyReference),
    policyVersion: integer(r.policyVersion),
    approvalPolicy,
    reviewReference,
    reviewVersion,
    submittedByActorReference,
    approvalEvidenceReference,
    scheduleReference,
    scheduleVersion,
    publishedAt,
    supersededAt,
    supersededByVersionReference,
    successorDraftVersionReference,
    operationReference: ref(r.operationReference),
    intentDigest: digest(r.intentDigest),
    actorReference: ref(r.actorReference),
    actorKind: enumeration(r.actorKind, ["User", "System"] as const),
    occurredAt,
    reasonCode: code(r.reasonCode),
  });
}
export function parseProductPublicationVersion(value: unknown): ProductPublicationVersion {
  return version(copyCategoryPersistenceValue(value));
}
function facts(value: unknown): ProductPublicationFacts {
  const r = exact(value, [
      "now",
      "productAggregateVersion",
      "contentDigest",
      "configurationDigest",
      "scopeDigest",
      "periodDigest",
      "validation",
      "approval",
      "reviewReference",
      "replacement",
    ]),
    replacement =
      r.replacement === null
        ? null
        : exact(r.replacement, [
            "productReference",
            "versionReference",
            "scopeDigest",
            "state",
            "publishedAt",
          ]);
  return Object.freeze({
    now: instant(r.now),
    productAggregateVersion: integer(r.productAggregateVersion),
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    scopeDigest: digest(r.scopeDigest),
    periodDigest: digest(r.periodDigest),
    validation: validation(r.validation),
    approval: r.approval === null ? null : approval(r.approval),
    reviewReference: nullableRef(r.reviewReference),
    replacement:
      replacement === null
        ? null
        : Object.freeze({
            productReference: ref(replacement.productReference),
            versionReference: ref(replacement.versionReference),
            scopeDigest: digest(replacement.scopeDigest),
            state: enumeration(replacement.state, ["Published"] as const),
            publishedAt: instant(replacement.publishedAt),
          }),
  });
}
/** Owning application must acquire authority and current source leases before this
 * contract is used. Parsing a supplied receipt is not permission or verification. */
export function planCatalogProductPublication(
  commandValue: unknown,
  currentValue: unknown,
  factsValue: unknown,
): ProductPublicationVersion {
  const c = parseProductPublicationCommand(commandValue),
    current = currentValue === null ? null : parseProductPublicationVersion(currentValue),
    f = facts(copyCategoryPersistenceValue(factsValue));
  if (f.scopeDigest !== hash(c.scopeSet) || f.periodDigest !== hash(c.effectivePeriod))
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return parseProductPublicationVersion(planProductPublicationVersion(c, current, f, hash(c)));
}
/** Only for a known committed operation read by the owning store. Current caller
 * authority must precede replay; new current facts must not rewrite old results. */
export function recoverCatalogProductPublication(
  commandValue: unknown,
  committedValue: unknown,
): ProductPublicationVersion {
  const c = parseProductPublicationCommand(commandValue),
    committed = parseProductPublicationVersion(committedValue);
  if (
    committed.tenantReference !== c.tenantReference ||
    committed.brandReference !== c.brandReference ||
    committed.productReference !== c.productReference ||
    committed.versionReference !== c.versionReference ||
    committed.operationReference !== c.operationReference ||
    committed.intentDigest !== hash(c) ||
    committed.publicationVersion !== c.expectedPublicationVersion + 1
  )
    throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
  return committed;
}
export function resolveCatalogProductPublication(
  candidatesValue: unknown,
  contextValue: unknown,
  scopeOrderValue: unknown,
) {
  const copied = copyCategoryPersistenceValue({
      candidates: candidatesValue,
      context: contextValue,
      order: scopeOrderValue,
    }),
    r = exact(copied, ["candidates", "context", "order"]);
  if (!Array.isArray(r.candidates) || r.candidates.length > 1000) return invalid();
  const candidates = r.candidates.map(version),
    context = exact(r.context, [
      "storeReference",
      "storeGroupReferences",
      "regionReferences",
      "channelCode",
      "orderTypeCode",
      "at",
    ]),
    order = unique(r.order, (v) => enumeration(v, productPublicationScopeLevels), 6);
  if (order.length !== 6) return invalid();
  const parsed: ProductPublicationContext = Object.freeze({
    storeReference: ref(context.storeReference),
    storeGroupReferences: unique(context.storeGroupReferences, ref, 1000),
    regionReferences: unique(context.regionReferences, ref, 1000),
    channelCode: code(context.channelCode),
    orderTypeCode: code(context.orderTypeCode),
    at: instant(context.at),
  });
  const first = candidates[0];
  if (
    new Set(candidates.map((c) => c.versionReference)).size !== candidates.length ||
    candidates.some(
      (c) =>
        c.tenantReference !== first?.tenantReference ||
        c.brandReference !== first?.brandReference ||
        c.productReference !== first?.productReference,
    )
  )
    return invalid();
  return resolveProductPublicationVersion(candidates, parsed, order);
}
