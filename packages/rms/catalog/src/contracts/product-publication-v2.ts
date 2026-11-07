import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogCode,
} from "./product.js";
import {
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  type ProductPublicationCheckCode,
  type ProductPublicationScope,
  type ProductPublicationPeriod,
} from "../domain/product-publication.js";
import { planProductPublicationVersionV2 } from "../domain/product-publication-v2.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationApproval,
  type ProductPublicationCommand,
  type ProductPublicationValidation,
  type ProductPublicationApproval,
  type ProductPublicationVersion,
  type ProductPublicationFacts,
} from "./product-publication.js";
import {
  parseCatalogProductPublicationReplacementIntent,
  type CatalogProductPublicationReplacementIntent,
} from "./product-scope-replacement-intent.js";

const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_INPUT_INVALID",
): never => {
  throw new CatalogError(code);
};
function digest(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("sha256:")) return fail();
  return "sha256:" + parseCatalogHash(value.slice(7));
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail();
  return value as T;
}
function integer(value: unknown, minimum = 1): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 2147483647
  )
    return fail();
  return value;
}
const ref = (v: unknown) => parseCatalogReference(v);
const nullableRef = (v: unknown) => (v === null ? null : ref(v));
const instant = (v: unknown) => parseCatalogInstant(v);
const nullableInstant = (v: unknown) => (v === null ? null : instant(v));
function code(v: unknown): string {
  const parsed = parseCatalogCode(v);
  if (parsed !== v) return fail();
  return parsed;
}
function unique<T>(value: unknown, parse: (v: unknown) => T, maximum: number): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  const parsed = value.map(parse);
  if (new Set(parsed).size !== parsed.length) return fail();
  return Object.freeze(parsed);
}
function scopes(value: unknown): readonly ProductPublicationScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) return fail();
  const result = value
    .map((v) => {
      const r = record(v, ["level", "reference", "channelCodes", "orderTypeCodes"]),
        level = enumeration(r.level, productPublicationScopeLevels);
      const reference =
        level === "Brand"
          ? r.reference === null
            ? null
            : fail()
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
        return fail();
      if (
        level === "OrderType" &&
        orderTypeCodes.length > 0 &&
        (orderTypeCodes.length !== 1 || orderTypeCodes[0] !== reference)
      )
        return fail();
      return Object.freeze({ level, reference, channelCodes, orderTypeCodes });
    })
    .sort((a, b) => canonicalizeRfc8785(a).localeCompare(canonicalizeRfc8785(b), "en"));
  if (new Set(result.map(canonicalizeRfc8785)).size !== result.length) return fail();
  return Object.freeze(result);
}
function period(value: unknown): ProductPublicationPeriod {
  try {
    return createEffectivePeriod(value as EffectivePeriod);
  } catch {
    return fail();
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
] as const;
const validationKeys = [
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
] as const;
const approvalKeys = [
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
] as const;
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
] as const;
const factsKeys = [
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
] as const;
const intentKeys = ["profile", "replacementIntent", "replacementIntentDigest"] as const;
const evidenceKeys = ["profile", "replacementIntentDigest"] as const;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const safe = copyCategoryPersistenceValue(value);
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) return fail();
  if (Object.keys(safe).length !== keys.length || keys.some((key) => !Object.hasOwn(safe, key)))
    return fail();
  return safe as Record<string, unknown>;
}
/** Projection is private to explicit V2 entry points, after their closed parser.
 * It must never be used to admit V2 input to a V1 writer or source. */
function base(value: object, keys: readonly string[]) {
  const r = value as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, r[key]]));
}
function binding(
  r: Record<string, unknown>,
  publication: Pick<
    ProductPublicationCommand,
    "versionReference" | "scopeSet" | "operationReference" | "successorDraftVersionReference"
  >,
) {
  const replacementIntent = parseCatalogProductPublicationReplacementIntent(r.replacementIntent),
    replacementIntentDigest = digest(r.replacementIntentDigest),
    selector = publication.scopeSet[0];
  if (replacementIntentDigest !== replacementIntent.digest) return fail();
  if (replacementIntent.mode === "None") return { replacementIntent, replacementIntentDigest };
  if (
    replacementIntent.previousVersionReference === publication.versionReference ||
    replacementIntent.previousPublicationOperationReference === publication.operationReference ||
    replacementIntent.previousVersionReference === publication.successorDraftVersionReference ||
    publication.scopeSet.length !== 1 ||
    selector?.level !== "Store" ||
    hash(selector) !== replacementIntent.previousSelectorDigest
  )
    return fail();
  return { replacementIntent, replacementIntentDigest };
}
export type ProductPublicationCommandV2 = ProductPublicationCommand & {
  readonly profile: "CatalogProductPublicationCommandV2";
  readonly replacementIntent: CatalogProductPublicationReplacementIntent;
  readonly replacementIntentDigest: string;
};
export type ProductPublicationValidationV2 = Omit<ProductPublicationValidation, "checks"> & {
  readonly checks: readonly {
    readonly code: ProductPublicationCheckCode;
    readonly outcome: "Pass" | "HardError" | "Warning" | "Pending";
  }[];
  readonly profile: "CatalogProductPublicationValidationV2";
  readonly replacementIntentDigest: string;
};
export type ProductPublicationApprovalV2 = ProductPublicationApproval & {
  readonly profile: "CatalogProductPublicationApprovalV2";
  readonly replacementIntentDigest: string;
};
export type ProductPublicationVersionV2 = Omit<ProductPublicationVersion, "validationDecision"> & {
  readonly validationDecision: ProductPublicationVersion["validationDecision"] | "ApprovalPending";
  readonly profile: "CatalogProductPublicationVersionV2";
  readonly replacementIntent: CatalogProductPublicationReplacementIntent;
  readonly replacementIntentDigest: string;
};
export type ProductPublicationFactsV2 = Omit<
  ProductPublicationFacts,
  "validation" | "approval" | "replacement"
> & {
  readonly validation: ProductPublicationValidationV2;
  readonly approval: ProductPublicationApprovalV2 | null;
  readonly replacement: null;
};

export function parseProductPublicationCommandV2(value: unknown): ProductPublicationCommandV2 {
  const r = record(value, [...commandKeys, ...intentKeys]);
  if (r.profile !== "CatalogProductPublicationCommandV2") return fail();
  const command = parseProductPublicationCommand(base(r, commandKeys));
  if (command.action === "Supersede") return fail();
  return Object.freeze({
    ...command,
    profile: "CatalogProductPublicationCommandV2",
    ...binding(r, command),
  });
}
export function parseProductPublicationValidationV2(
  value: unknown,
): ProductPublicationValidationV2 {
  const r = record(value, [...validationKeys, ...evidenceKeys]);
  if (r.profile !== "CatalogProductPublicationValidationV2") return fail();
  const approvalPolicy = enumeration(r.approvalPolicy, ["Required", "NotRequired"] as const);
  if (!Array.isArray(r.checks) || r.checks.length !== productPublicationCheckCodes.length)
    return fail();
  const checks = r.checks
    .map((v) => {
      const c = record(v, ["code", "outcome"]);
      return Object.freeze({
        code: enumeration(c.code, productPublicationCheckCodes),
        outcome: enumeration(c.outcome, ["Pass", "HardError", "Warning", "Pending"] as const),
      });
    })
    .sort((a, b) => a.code.localeCompare(b.code, "en"));
  if (new Set(checks.map((c) => c.code)).size !== productPublicationCheckCodes.length)
    return fail();
  if (
    checks.some(
      (check) =>
        check.outcome === "Pending" &&
        (check.code !== "ApprovalPolicy" || approvalPolicy !== "Required"),
    )
  )
    return fail();
  const hardErrorSummary = checks.find((c) => c.code === "HardErrorsCleared");
  const hasHardError = checks.some(
    (c) => c.code !== "HardErrorsCleared" && c.outcome === "HardError",
  );
  if (hardErrorSummary?.outcome !== (hasHardError ? "HardError" : "Pass")) return fail();
  const a =
    r.warningAcknowledgement === null
      ? null
      : record(r.warningAcknowledgement, ["actorReference", "reasonCode", "warningCodes"]);
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
    return fail();
  const checkedAt = instant(r.checkedAt),
    validUntil = instant(r.validUntil);
  if (validUntil <= checkedAt) return fail();
  return Object.freeze({
    profile: "CatalogProductPublicationValidationV2",
    replacementIntentDigest: digest(r.replacementIntentDigest),
    evidenceReference: ref(r.evidenceReference),
    productAggregateVersion: integer(r.productAggregateVersion),
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    scopeDigest: digest(r.scopeDigest),
    periodDigest: digest(r.periodDigest),
    policyReference: ref(r.policyReference),
    policyVersion: integer(r.policyVersion),
    approvalPolicy,
    checks: Object.freeze(checks),
    warningAcknowledgement,
    checkedAt,
    validUntil,
  });
}
export function parseProductPublicationApprovalV2(value: unknown): ProductPublicationApprovalV2 {
  const r = record(value, [...approvalKeys, ...evidenceKeys]);
  if (r.profile !== "CatalogProductPublicationApprovalV2") return fail();
  return Object.freeze({
    ...parseProductPublicationApproval(base(r, approvalKeys)),
    profile: "CatalogProductPublicationApprovalV2",
    replacementIntentDigest: digest(r.replacementIntentDigest),
  });
}
export function parseProductPublicationVersionV2(value: unknown): ProductPublicationVersionV2 {
  const r = record(value, [...versionKeys, ...intentKeys]);
  if (r.profile !== "CatalogProductPublicationVersionV2" || r.state === "Superseded") return fail();
  const scopeSet = scopes(r.scopeSet),
    effectivePeriod = period(r.effectivePeriod),
    scopeDigest = digest(r.scopeDigest),
    periodDigest = digest(r.periodDigest);
  if (scopeDigest !== hash(scopeSet) || periodDigest !== hash(effectivePeriod)) return fail();
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
  if (
    r.validationDecision === "ApprovalPending" &&
    (approvalPolicy !== "Required" || (state !== "Draft" && state !== "InReview"))
  )
    return fail();
  const published = state === "Published" || state === "Superseded";
  if ((state === "Draft" || state === "InReview") && approvalEvidenceReference !== null)
    return fail();
  if (state === "Approved" && approvalPolicy !== "Required") return fail();
  if (
    (state === "Approved" || state === "Scheduled" || published) &&
    r.validationDecision !== "Pass"
  )
    return fail();
  if (r.actorKind === "System" && !published) return fail();
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
    return fail();
  const parsed = Object.freeze({
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
      "ApprovalPending",
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
  return Object.freeze({
    ...parsed,
    profile: "CatalogProductPublicationVersionV2",
    ...binding(r, parsed),
  });
}
/** Pure lifecycle binding only. No V1 migration, owning current assessment,
 * selector retirement, System permission, persistence or sale eligibility. */
export function planCatalogProductPublicationV2(
  commandValue: unknown,
  currentValue: unknown,
  factsValue: unknown,
): ProductPublicationVersionV2 {
  const command = parseProductPublicationCommandV2(commandValue),
    current = currentValue === null ? null : parseProductPublicationVersionV2(currentValue),
    f = record(factsValue, factsKeys),
    validation = parseProductPublicationValidationV2(f.validation),
    approval = f.approval === null ? null : parseProductPublicationApprovalV2(f.approval),
    executionAt = parseCatalogInstant(f.now);
  if (
    command.occurredAt > executionAt ||
    (current !== null && command.occurredAt < current.occurredAt) ||
    f.replacement !== null ||
    validation.replacementIntentDigest !== command.replacementIntentDigest ||
    (approval !== null && approval.replacementIntentDigest !== command.replacementIntentDigest) ||
    (current !== null &&
      command.action !== "Validate" &&
      current.replacementIntentDigest !== command.replacementIntentDigest)
  )
    return fail("CATALOG_LIFECYCLE_CONFLICT");
  const facts: ProductPublicationFactsV2 = Object.freeze({
    now: executionAt,
    productAggregateVersion: integer(f.productAggregateVersion),
    contentDigest: digest(f.contentDigest),
    configurationDigest: digest(f.configurationDigest),
    scopeDigest: digest(f.scopeDigest),
    periodDigest: digest(f.periodDigest),
    validation,
    approval,
    reviewReference: nullableRef(f.reviewReference),
    replacement: null,
  });
  if (
    facts.scopeDigest !== hash(command.scopeSet) ||
    facts.periodDigest !== hash(command.effectivePeriod)
  )
    return fail("CATALOG_LIFECYCLE_CONFLICT");
  // Record the held observation, while hashing the unchanged complete original command.
  const planned = planProductPublicationVersionV2(
    { ...command, occurredAt: executionAt },
    current,
    facts,
    hash(command),
  );
  return parseProductPublicationVersionV2({
    ...planned,
    intentDigest: hash(command),
    profile: "CatalogProductPublicationVersionV2",
    replacementIntent: command.replacementIntent,
    replacementIntentDigest: command.replacementIntentDigest,
  });
}
/** A caller must first acquire the actual committed operation under current
 * authority. This returns its exact V2 result without today's mutable sources. */
export function recoverCatalogProductPublicationV2(
  commandValue: unknown,
  committedValue: unknown,
): ProductPublicationVersionV2 {
  const command = parseProductPublicationCommandV2(commandValue),
    committed = parseProductPublicationVersionV2(committedValue);
  if (
    committed.tenantReference !== command.tenantReference ||
    committed.brandReference !== command.brandReference ||
    committed.productReference !== command.productReference ||
    committed.versionReference !== command.versionReference ||
    committed.operationReference !== command.operationReference ||
    committed.intentDigest !== hash(command) ||
    committed.replacementIntentDigest !== command.replacementIntentDigest ||
    committed.publicationVersion !== command.expectedPublicationVersion + 1
  )
    return fail("CATALOG_IDEMPOTENCY_CONFLICT");
  return committed;
}
