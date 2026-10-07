import { assertProductPublicationOperationNotAbandoned } from "./product-publication-resolution-store.js";
import {
  buildCatalogProductScopeJournal,
  parseCatalogProductScopeJournal,
  type CatalogProductScopeJournal,
} from "../../contracts/product-scope-journal.js";
import {
  holdProductEditorContent,
  type ProductEditorContentAuthority,
} from "../../application/product-editor-content-authority.js";
import { canonicalizeRfc8785, sha256Hex, type AppendAuditRecordInput } from "@bop/audit";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import { bindCatalogProductValidationToPolicyV2 } from "../../contracts/product-validation-policy.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
  type ProductAggregate,
} from "../../contracts/product.js";
import { copyCategoryPersistenceValue } from "../../contracts/category-persistence.js";
import { buildCatalogProductApprovalReceipt } from "../../contracts/product-approval-receipt.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  planCatalogProductPublication,
  recoverCatalogProductPublication,
  type ProductPublicationCommand,
  type ProductPublicationVersion,
  type ProductPublicationFacts,
} from "../../contracts/product-publication.js";
import {
  deriveCatalogProductPublicationContentIdentity,
  createCatalogProductPublicationMaterialization,
  createCatalogProductPublicationMaterializationV2,
  parseCatalogProductPublicationContent,
  type CatalogProductPublicationContent,
} from "../../contracts/product-publication-content.js";
import { productDraftBaselineReferencedFields } from "../../contracts/product-draft-baseline.js";
import {
  productSnapshotSelectSql,
  type ProductLifecycleTransaction,
} from "./product-lifecycle-store.js";
import {
  holdProductSourceBarrier,
  appendProductPublicationCommitArtifacts,
  appendProductPublicationCommitArtifactsV2,
} from "./product-source-producer.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationVersionV2,
  parseProductPublicationValidationV2,
  parseProductPublicationApprovalV2,
  planCatalogProductPublicationV2,
  recoverCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
  type ProductPublicationVersionV2,
  type ProductPublicationFactsV2,
} from "../../contracts/product-publication-v2.js";
import {
  bindCatalogProductReviewForApprovalV2,
  createCatalogProductApprovalDecisionV2,
  buildCatalogProductApprovalReceiptV2,
  bindCatalogProductApprovalReceiptV2,
  bindCatalogProductApprovalToCurrentPolicyV2,
  parseCatalogApprovalValiditySecondsV2,
  productApprovalReviewFieldsV2,
  productApprovalSourceFieldsV2,
} from "../../contracts/product-approval-v2.js";
import {
  buildCatalogProductScopeRetirementHeader,
  type CatalogProductScopeRetirementHeader,
} from "../../contracts/product-scope-retirement.js";
import {
  catalogProductRetirementSourceHeadDigest,
  type CatalogProductRetirementCoverage,
} from "../../contracts/product-publication-source-v2.js";
import { planProductSelectorOverlaps } from "../../domain/product-scope-overlap.js";
import {
  assertProductPublicationV1Compatible,
  loadProductRetirementCoverage,
  appendProductScopeRetirementHeader,
  recoverProductScopeRetirementHeader,
  readProductApprovalReceiptV2,
} from "./product-scope-retirement-store.js";
import {
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
  type CatalogProductPublicationValidationDetails,
} from "../../contracts/product-publication-validation-report.js";
import { assessCatalogProductPublicationWarningAcknowledgement } from "../../contracts/product-publication-warning-acknowledgement.js";
import {
  assertCatalogProductPublicationReferenceContinuity,
  productPublicationReferenceBaselineActions,
} from "../../contracts/product-publication-reference-continuity.js";
import { readLatestProductPublicationWarningAcknowledgement } from "./product-publication-warning-acknowledgement-record.js";
import {
  appendProductPublicationValidationReport,
  recoverProductPublicationValidationReport,
  type ProductPublicationValidationReportCoverage,
} from "./product-publication-validation-report-store.js";
export const productPublicationWriteFields = Object.freeze([
  ...productDraftBaselineReferencedFields,
  "publicationVersion",
  "publicationState",
  "scopeSet",
  "effectivePeriod",
  "validation",
  "policy",
  "review",
  "approval",
  "schedule",
  "publicationContent",
  "operationHistory",
  "scopeJournal",
] as const);
export interface ProductPublicationWriteResult {
  readonly status: "Applied" | "Replayed";
  readonly publication: ProductPublicationVersion;
  readonly aggregate: ProductAggregate;
  readonly content: CatalogProductPublicationContent | null;
  readonly scopeJournal: CatalogProductScopeJournal | null;
  readonly scopeJournalStatus: "Recorded" | "NotRecorded" | "NotApplicable";
}
export interface ProductPublicationStoreOptions {
  readonly editorContentAuthority?: ProductEditorContentAuthority;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T>;
  };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: ProductPublicationCommand;
        readonly requiredPermissions: readonly string[];
        readonly requiredFields: typeof productPublicationWriteFields;
        readonly requiredScope: "FullBrandScope";
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly sources: {
    /** Must hold actual current Publishing policy evidence and its permissions
     * through outer COMMIT. Missing source refuses Publish/ActivateScheduled.
     * This port is not itself a policy producer. */
    withHeldScopePolicy?<T>(
      tx: ProductLifecycleTransaction,
      input: {
        readonly publication: ProductPublicationVersion;
        readonly observedAt: string;
      },
      work: (policy: unknown) => Promise<T>,
    ): Promise<T>;

    withHeldCurrentFacts<T>(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: ProductPublicationCommand;
        readonly aggregate: ProductAggregate;
        readonly current: ProductPublicationVersion | null;
        readonly content: CatalogProductPublicationContent | null;
        readonly observedAt: string;
      },
      work: (facts: ProductPublicationFacts) => Promise<T>,
    ): Promise<T>;
  };
  readonly audit: {
    create(
      publication: ProductPublicationVersion,
      action: ProductPublicationCommand["action"],
    ): AppendAuditRecordInput;
  };
}
export const productPublicationWriteFieldsV2 = Object.freeze([
  ...new Set([
    ...productPublicationWriteFields,
    ...productApprovalReviewFieldsV2,
    ...productApprovalSourceFieldsV2,
    "replacementIntent",
    "replacementIntentDigest",
    "publicationHistory",
    "scopeRetirementHeader",
    "scopeRetirements",
    "validationReport",
    "warningAcknowledgementReceipt",
  ]),
]);
export interface ProductPublicationWriteResultV2 {
  readonly status: "Applied" | "Replayed";
  readonly publication: ProductPublicationVersionV2;
  readonly aggregate: ProductAggregate;
  readonly content: CatalogProductPublicationContent | null;
  readonly scopeRetirementHeader: CatalogProductScopeRetirementHeader;
  readonly validationReport: ProductPublicationValidationReportCoverage;
}
export interface ProductPublicationStoreOptionsV2 extends Omit<
  ProductPublicationStoreOptions,
  "authority" | "sources" | "audit"
> {
  readonly maximumApprovalValiditySeconds: number;
  /** Server-only outer UoW integration. The host invokes every async guard, then
   * every synchronous final assertion without an await before returning to the
   * transaction runner. The writer retains its original source/receipt deadline. */
  readonly registerBeforeCommit?: (
    tx: ProductLifecycleTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: ProductPublicationCommandV2;
        readonly requiredPermissions: readonly string[];
        readonly requiredFields: typeof productPublicationWriteFieldsV2;
        readonly requiredScope: "FullBrandScope";
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
  readonly sources: {
    withCurrentPolicy<T>(
      tx: ProductLifecycleTransaction,
      input: {
        readonly policyReference: string;
        readonly policyVersion: number;
        readonly observedAt: string;
      },
      work: (policy: unknown) => Promise<T>,
    ): Promise<T>;
    withHeldCurrentFacts<T>(
      tx: ProductLifecycleTransaction,
      input: {
        readonly command: ProductPublicationCommandV2;
        readonly aggregate: ProductAggregate;
        readonly current: ProductPublicationVersionV2 | null;
        readonly content: CatalogProductPublicationContent | null;
        readonly observedAt: string;
      },
      work: (facts: ProductPublicationFactsV2, details?: unknown) => Promise<T>,
    ): Promise<T>;
  };
  readonly audit: {
    create(
      publication: ProductPublicationVersionV2,
      action: ProductPublicationCommandV2["action"],
    ): AppendAuditRecordInput;
  };
}
type PublicationKernelResult = ProductPublicationWriteResult | ProductPublicationWriteResultV2;
type PublicationKernelVersion = ProductPublicationVersion | ProductPublicationVersionV2;
interface PublicationKernelOptions extends Omit<
  ProductPublicationStoreOptions,
  "sources" | "audit"
> {
  readonly sources: {
    withHeldCurrentFacts<T>(
      tx: ProductLifecycleTransaction,
      input: Omit<
        Parameters<ProductPublicationStoreOptions["sources"]["withHeldCurrentFacts"]>[1],
        "current"
      > & {
        readonly current: PublicationKernelVersion | null;
      },
      work: (facts: unknown, details?: unknown) => Promise<T>,
    ): Promise<T>;
    readonly withHeldScopePolicy?: ProductPublicationStoreOptions["sources"]["withHeldScopePolicy"];
  };
  readonly audit: {
    create(
      publication: PublicationKernelVersion,
      action: ProductPublicationCommand["action"],
    ): AppendAuditRecordInput;
  };
}
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (left: unknown, right: unknown) =>
  canonicalizeRfc8785(left) === canonicalizeRfc8785(right);
function fail(
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never {
  throw new CatalogError(code);
}
function permission(c: ProductPublicationCommand): readonly string[] {
  return Object.freeze([
    "catalog.product.read",
    c.action === "Validate"
      ? "catalog.product.validate"
      : c.action === "SubmitReview"
        ? "catalog.product.submit"
        : c.action === "Approve" || c.action === "Reject"
          ? "catalog.product.approve"
          : "catalog.product.publish",
  ]);
}
function count(result: { rowCount?: number | null }, expected = 1) {
  if (result.rowCount !== expected) return fail();
}
async function withV2PublicationFacts(
  tx: ProductLifecycleTransaction,
  options: ProductPublicationStoreOptionsV2,
  command: ProductPublicationCommandV2,
  current: ProductPublicationVersionV2 | null,
  root: ProductAggregate,
  supplied: ProductPublicationFactsV2,
  details: CatalogProductPublicationValidationDetails | null,
  observedAt: string,
  now: () => string,
  retainDeadline: (deadline: string) => void,
  work: (
    facts: ProductPublicationFactsV2,
    coverage: CatalogProductRetirementCoverage,
    policy: ReturnType<typeof parsePublishingProductPublicationPolicy>,
  ) => Promise<PublicationKernelResult>,
): Promise<PublicationKernelResult> {
  const validation = parseProductPublicationValidationV2(supplied.validation);
  // Current facts describe checks; only an owning persisted receipt can supply
  // human consent. This applies to every new V2 action, including cancellation.
  if (validation.warningAcknowledgement !== null) return fail();
  const coverage = await loadProductRetirementCoverage(tx, {
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    productReference: command.productReference,
    expectedAggregateVersion: root.aggregateVersion,
    observedAt,
  });
  if (
    !equal(
      coverage.latest.find((p) => p.versionReference === command.versionReference) ?? null,
      current,
    )
  )
    return fail();
  let referenceDeadline: string | null = null;
  if (productPublicationReferenceBaselineActions.some((action) => action === command.action)) {
    if (current === null) return fail("CATALOG_LIFECYCLE_CONFLICT");
    const baseline = await recoverProductPublicationValidationReport(tx, current);
    referenceDeadline = assertCatalogProductPublicationReferenceContinuity({
      command,
      current,
      report: baseline.report,
      validation,
      details,
      observedAt,
      now: now(),
    });
  }
  let calls = 0,
    outcome: PublicationKernelResult | undefined;
  const result = await options.sources.withCurrentPolicy(
    tx,
    {
      policyReference: validation.policyReference,
      policyVersion: validation.policyVersion,
      observedAt,
    },
    async (policyValue) => {
      if (++calls !== 1) return fail();
      const raw = copyCategoryPersistenceValue(policyValue);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
      const q = raw as Record<string, unknown>,
        keys = ["content", "currentPublicationReference", "observedAt", "validUntil"];
      if (Object.keys(q).length !== keys.length || keys.some((key) => !Object.hasOwn(q, key)))
        return fail();
      const policy = parsePublishingProductPublicationPolicy(q.content),
        policyUntil = parseCatalogInstant(q.validUntil);
      parseCatalogReference(q.currentPublicationReference);
      if (
        q.observedAt !== observedAt ||
        policy.tenantReference !== command.tenantReference ||
        policy.brandReference !== command.brandReference ||
        policy.policyReference !== validation.policyReference ||
        policy.policyVersion !== validation.policyVersion ||
        policy.approvalPolicy !== validation.approvalPolicy ||
        policy.effectiveFrom > observedAt ||
        policyUntil <= observedAt ||
        policyUntil > new Date(Date.parse(observedAt) + 30000).toISOString() ||
        (policy.effectiveUntil !== null && policyUntil > parseCatalogInstant(policy.effectiveUntil))
      )
        return fail();
      bindCatalogProductValidationToPolicyV2(command, validation, policy);
      const deadlines = [
        policyUntil,
        validation.validUntil,
        new Date(Date.parse(observedAt) + 5000).toISOString(),
        ...(referenceDeadline === null ? [] : [referenceDeadline]),
      ];
      let approval: ProductPublicationFactsV2["approval"] = null;
      if (command.action === "Approve") {
        if (!current) return fail();
        const review = bindCatalogProductReviewForApprovalV2(command, current, observedAt),
          decision = createCatalogProductApprovalDecisionV2(
            command,
            review,
            raw,
            observedAt,
            options.maximumApprovalValiditySeconds,
          );
        approval = decision.approval;
        deadlines.push(decision.validUntil);
      } else if (
        policy.approvalPolicy === "Required" &&
        ["Publish", "SchedulePublish", "ActivateScheduled", "ReschedulePublish"].includes(
          command.action,
        )
      ) {
        // A changed timing review has no owning receipt producer yet. Cancel and
        // legally revalidate/review/approve before scheduling the new period.
        if (command.action === "ReschedulePublish" || !current)
          return fail("CATALOG_LIFECYCLE_CONFLICT");
        const receipt = await readProductApprovalReceiptV2(tx, current),
          approved = coverage.history.find(
            (entry) =>
              entry.publicationAction === "Approve" &&
              entry.publication.operationReference === receipt.approvalOperationReference,
          )?.publication,
          review = coverage.history.find(
            (entry) =>
              entry.publicationAction === "SubmitReview" &&
              entry.publication.versionReference === current.versionReference &&
              entry.publication.publicationVersion === receipt.approval.reviewVersion,
          )?.publication,
          request = {
            profile: "CatalogProductApprovalRequestV2",
            productReference: command.productReference,
            versionReference: command.versionReference,
            expectedAggregateVersion: command.expectedProductAggregateVersion,
            expectedPublicationVersion: command.expectedPublicationVersion,
            contentDigest: command.contentDigest,
            configurationDigest: command.configurationDigest,
            scopeDigest: hash(command.scopeSet),
            periodDigest: hash(command.effectivePeriod),
            policyReference: validation.policyReference,
            policyVersion: validation.policyVersion,
            originalIntentDigest: hash(command),
            replacementIntentDigest: command.replacementIntentDigest,
            observedAt,
            validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
          },
          bound = bindCatalogProductApprovalReceiptV2(
            receipt,
            approved,
            review,
            current,
            request,
            observedAt,
          ),
          currentPolicy = bindCatalogProductApprovalToCurrentPolicyV2(
            bound,
            raw,
            request,
            observedAt,
          );
        approval = currentPolicy.receipt.approval;
        deadlines.push(currentPolicy.validUntil);
      }
      if (
        supplied.approval !== null &&
        (approval === null ||
          !equal(parseProductPublicationApprovalV2(supplied.approval), approval))
      )
        return fail();
      const approvalOutcome = validation.checks.find(
        (check) => check.code === "ApprovalPolicy",
      )?.outcome;
      let resolvedValidation = validation;
      if (policy.approvalPolicy === "Required") {
        if (command.action === "Validate" || command.action === "SubmitReview") {
          if (approvalOutcome !== "Pending" || approval !== null || supplied.approval !== null)
            return fail("CATALOG_LIFECYCLE_CONFLICT");
        } else if (approval !== null) {
          // Only the actual independently bound owning decision/receipt above
          // can promote approval. Never clear a separate negative assertion.
          if (approvalOutcome !== "Pending" && approvalOutcome !== "Pass") return fail();
          resolvedValidation = parseProductPublicationValidationV2({
            ...validation,
            checks: validation.checks.map((check) =>
              check.code === "ApprovalPolicy" ? { code: check.code, outcome: "Pass" } : check,
            ),
          });
        } else if (
          (command.action === "Reject" || command.action === "CancelScheduledPublish") &&
          approvalOutcome === "Pass"
        ) {
          resolvedValidation = parseProductPublicationValidationV2({
            ...validation,
            checks: validation.checks.map((check) =>
              check.code === "ApprovalPolicy" ? { code: check.code, outcome: "Pending" } : check,
            ),
          });
        }
      }
      const deadline = deadlines.sort()[0] ?? fail();
      retainDeadline(deadline);
      const checkedAt = parseCatalogInstant(now());
      if (checkedAt < observedAt || checkedAt >= deadline) return fail();
      if (
        command.action !== "Reject" &&
        command.action !== "CancelScheduledPublish" &&
        details?.coverage === "Complete" &&
        policy.warningOverrideAllowed &&
        resolvedValidation.checks.some((check) => check.outcome === "Warning") &&
        !resolvedValidation.checks.some((check) => check.outcome === "HardError")
      ) {
        const actorReference =
          command.actorKind === "User"
            ? command.actorReference
            : current?.submittedByActorReference;
        if (!actorReference) return fail();
        const receipt = await readLatestProductPublicationWarningAcknowledgement(tx, {
          tenantReference: command.tenantReference,
          brandReference: command.brandReference,
          productReference: command.productReference,
          versionReference: command.versionReference,
          actorReference,
        });
        const receiptAt = parseCatalogInstant(now());
        if (receiptAt < checkedAt || receiptAt >= deadline) return fail();
        if (receipt !== null) {
          const assessment = assessCatalogProductPublicationWarningAcknowledgement({
            receipt,
            command,
            current,
            validation: resolvedValidation,
            details,
            policy,
            now: receiptAt,
          });
          // A valid but stale receipt leaves the actual Warning unacknowledged.
          // Corrupt receipt/source/policy data throws; no older receipt is tried.
          resolvedValidation = assessment.validation;
        }
      }
      outcome = await work(
        { ...supplied, validation: resolvedValidation, approval },
        coverage,
        policy,
      );
      const completedAt = parseCatalogInstant(now());
      if (completedAt < observedAt || completedAt >= deadline) return fail();
      return outcome;
    },
  );
  if (calls !== 1 || !outcome || result !== outcome) return fail();
  return outcome;
}
function assertV2PublicationScope(
  command: ProductPublicationCommandV2,
  publication: ProductPublicationVersionV2,
  coverage: CatalogProductRetirementCoverage,
  policy: ReturnType<typeof parsePublishingProductPublicationPolicy>,
): void {
  if (command.action === "Reject" || command.action === "CancelScheduledPublish") return;
  const intent = publication.replacementIntent,
    at = publication.occurredAt;
  if (intent.mode !== "None") {
    const previousValue = coverage.latest.find(
        (p) => p.versionReference === intent.previousVersionReference,
      ),
      previous =
        previousValue && "profile" in previousValue
          ? parseProductPublicationVersionV2(previousValue)
          : parseProductPublicationVersion(previousValue),
      selected = previous.scopeSet[intent.previousSelectorIndex],
      incoming = publication.scopeSet[0];
    if (
      previous.state !== "Published" ||
      previous.operationReference !== intent.previousPublicationOperationReference ||
      previous.publicationVersion !== intent.expectedPreviousPublicationVersion ||
      previous.intentDigest !== intent.previousIntentDigest ||
      previous.scopeDigest !== intent.previousScopeDigest ||
      previous.periodDigest !== intent.previousPeriodDigest ||
      previous.productAggregateVersion >= publication.productAggregateVersion ||
      previous.occurredAt > at ||
      previous.publishedAt === null ||
      previous.publishedAt > at ||
      previous.effectivePeriod.effectiveFrom.instant > at ||
      (previous.effectivePeriod.effectiveUntil !== null &&
        previous.effectivePeriod.effectiveUntil.instant <= at) ||
      previous.scopeSet.length < 1 ||
      previous.scopeSet.some((scope) => scope.level !== "Store") ||
      new Set(previous.scopeSet.map((scope) => scope.reference)).size !==
        previous.scopeSet.length ||
      !selected ||
      !incoming ||
      hash(selected) !== intent.previousSelectorDigest ||
      !equal(selected, incoming) ||
      coverage.headers.some((h) =>
        h.retirements.some(
          (row) =>
            row.replacementIntent.previousPublicationOperationReference ===
              previous.operationReference &&
            row.replacementIntent.previousSelectorIndex === intent.previousSelectorIndex,
        ),
      )
    )
      return fail("CATALOG_LIFECYCLE_CONFLICT");
  }
  if (
    coverage.latest.reduce((sum, p) => sum + p.scopeSet.length, 0) * publication.scopeSet.length >
    10000
  )
    return fail();
  const intersects = (a: readonly string[], b: readonly string[]) =>
    a.length === 0 || b.length === 0 || a.some((value) => b.includes(value));
  const selectorsOverlap = (
    a: ProductPublicationVersionV2["scopeSet"][number],
    b: ProductPublicationVersionV2["scopeSet"][number],
  ) => {
    const codes = (scope: typeof a, dimension: "Channel" | "OrderType") =>
      scope.level === dimension && scope.reference !== null
        ? [scope.reference]
        : dimension === "Channel"
          ? scope.channelCodes
          : scope.orderTypeCodes;
    if (
      !intersects(codes(a, "Channel"), codes(b, "Channel")) ||
      !intersects(codes(a, "OrderType"), codes(b, "OrderType")) ||
      (a.level === "Store" && b.level === "Store" && a.reference !== b.reference)
    )
      return false;
    if ([a.level, b.level].some((level) => level === "Region" || level === "StoreGroup"))
      return fail("CATALOG_LIFECYCLE_CONFLICT");
    return policy.scopeOrder.indexOf(a.level) === policy.scopeOrder.indexOf(b.level);
  };
  // An undisposed future schedule reserves its same-rank Store selector. No
  // actual retirement exists yet, so it cannot be treated as absent coverage.
  for (const candidate of coverage.latest) {
    if (
      candidate.versionReference === publication.versionReference ||
      candidate.state !== "Scheduled"
    )
      continue;
    const from =
        [
          at,
          publication.effectivePeriod.effectiveFrom.instant,
          candidate.effectivePeriod.effectiveFrom.instant,
        ]
          .sort()
          .at(-1) ?? fail(),
      ends = [
        publication.effectivePeriod.effectiveUntil?.instant,
        candidate.effectivePeriod.effectiveUntil?.instant,
      ]
        .filter((v): v is string => v !== undefined)
        .sort();
    if (ends[0] !== undefined && ends[0] <= from) continue;
    for (const scope of candidate.scopeSet)
      for (const incoming of publication.scopeSet)
        if (selectorsOverlap(scope, incoming)) return fail("CATALOG_LIFECYCLE_CONFLICT");
  }
  if (publication.state === "Scheduled") {
    for (const candidate of coverage.latest) {
      if (
        candidate.versionReference === publication.versionReference ||
        !["Published", "Superseded"].includes(candidate.state) ||
        candidate.publishedAt === null
      )
        continue;
      const from =
          [
            at,
            publication.effectivePeriod.effectiveFrom.instant,
            candidate.effectivePeriod.effectiveFrom.instant,
            candidate.publishedAt,
          ]
            .sort()
            .at(-1) ?? fail(),
        ends = [
          publication.effectivePeriod.effectiveUntil?.instant,
          candidate.effectivePeriod.effectiveUntil?.instant,
          candidate.supersededAt ?? undefined,
        ]
          .filter((v): v is string => v !== undefined)
          .sort();
      if (ends[0] !== undefined && ends[0] <= from) continue;
      for (const [index, scope] of candidate.scopeSet.entries()) {
        if (!publication.scopeSet.some((incoming) => selectorsOverlap(scope, incoming))) continue;
        const target =
            intent.mode !== "None" &&
            candidate.operationReference === intent.previousPublicationOperationReference &&
            index === intent.previousSelectorIndex,
          retired = coverage.headers.some((h) =>
            h.retirements.some(
              (row) =>
                row.replacementIntent.previousVersionReference === candidate.versionReference &&
                row.replacementIntent.previousSelectorIndex === index &&
                row.retiredAt <= at,
            ),
          );
        if (!target && !retired) return fail("CATALOG_LIFECYCLE_CONFLICT");
      }
    }
  }
  if (publication.state !== "Published") return;
  const plan = planProductSelectorOverlaps({
    incoming: publication,
    existing: coverage.latest.filter(
      (p) =>
        p.versionReference !== publication.versionReference &&
        (p.state === "Published" || p.state === "Superseded"),
    ),
    scopeOrder: policy.scopeOrder,
    observedAt: at,
  });
  if (plan.analysis !== "CompleteSelectorAnalysis") return fail("CATALOG_LIFECYCLE_CONFLICT");
  for (const overlap of plan.overlaps) {
    const target =
        intent.mode !== "None" &&
        overlap.previousOperationReference === intent.previousPublicationOperationReference &&
        overlap.previousSelectorIndex === intent.previousSelectorIndex,
      retired = coverage.headers.some((h) =>
        h.retirements.some(
          (row) =>
            row.replacementIntent.previousVersionReference === overlap.previousVersionReference &&
            row.replacementIntent.previousSelectorIndex === overlap.previousSelectorIndex &&
            row.retiredAt <= at,
        ),
      );
    if (!target && !retired && overlap.relation === "EqualPrecedenceOverlap")
      return fail("CATALOG_LIFECYCLE_CONFLICT");
  }
}
/** Configured server ports own current authority/policy/topology/approval facts.
 * Unconfigured normal runtime refuses; this factory does not create permissions. */
export function createPostgresProductPublicationStore(options: ProductPublicationStoreOptions) {
  if (
    typeof options.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.audit?.create !== "function" ||
    (options.sources.withHeldScopePolicy !== undefined &&
      typeof options.sources.withHeldScopePolicy !== "function")
  )
    return fail();
  const heldFacts = options.sources.withHeldCurrentFacts.bind(options.sources),
    createAudit = options.audit.create.bind(options.audit),
    kernel = createPublicationStoreKernel({
      ...options,
      sources: {
        ...(options.sources.withHeldScopePolicy === undefined
          ? {}
          : {
              withHeldScopePolicy: options.sources.withHeldScopePolicy.bind(options.sources),
            }),
        withHeldCurrentFacts: (tx, input, work) =>
          heldFacts(
            tx,
            {
              ...input,
              current:
                input.current === null ? null : parseProductPublicationVersion(input.current),
            },
            work,
          ),
      },
      audit: {
        create: (publication, action) =>
          createAudit(parseProductPublicationVersion(publication), action),
      },
    });
  return Object.freeze({
    execute: (value: unknown) => kernel.execute(value) as Promise<ProductPublicationWriteResult>,
  });
}
/** Explicit closed V2 entry. This fixed adapter preserves full parsed V2 values;
 * it never projects them into, or invokes, the public V1 writer. */
export function createPostgresProductPublicationStoreV2(options: ProductPublicationStoreOptionsV2) {
  if (
    typeof options.sources?.withCurrentPolicy !== "function" ||
    typeof options.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.audit?.create !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    (options.registerBeforeCommit !== undefined &&
      typeof options.registerBeforeCommit !== "function") ||
    (options.editorContentAuthority !== undefined &&
      typeof options.editorContentAuthority.holdUntilTransactionCompletes !== "function")
  )
    return fail();
  const fixed: ProductPublicationStoreOptionsV2 = Object.freeze({
    tenantReference: options.tenantReference,
    brandReference: options.brandReference,
    actorReference: options.actorReference,
    actorKind: options.actorKind,
    maximumApprovalValiditySeconds: parseCatalogApprovalValiditySecondsV2(
      options.maximumApprovalValiditySeconds,
    ),
    ...(options.registerBeforeCommit === undefined
      ? {}
      : {
          registerBeforeCommit: options.registerBeforeCommit.bind(options),
        }),
    clock: Object.freeze({ now: options.clock.now.bind(options.clock) }),
    transactions: Object.freeze({ run: options.transactions.run.bind(options.transactions) }),
    authority: Object.freeze({
      holdUntilTransactionCompletes: options.authority.holdUntilTransactionCompletes.bind(
        options.authority,
      ),
    }),
    sources: Object.freeze({
      withHeldCurrentFacts: options.sources.withHeldCurrentFacts.bind(options.sources),
      withCurrentPolicy: options.sources.withCurrentPolicy.bind(options.sources),
    }),
    audit: Object.freeze({ create: options.audit.create.bind(options.audit) }),
    ...(options.editorContentAuthority === undefined
      ? {}
      : {
          editorContentAuthority: Object.freeze({
            holdUntilTransactionCompletes:
              options.editorContentAuthority.holdUntilTransactionCompletes.bind(
                options.editorContentAuthority,
              ),
          }),
        }),
  });
  const kernel = createPublicationStoreKernel(
    {
      ...fixed,
      authority: {
        holdUntilTransactionCompletes: (tx, input) =>
          fixed.authority.holdUntilTransactionCompletes(tx, {
            ...input,
            command: parseProductPublicationCommandV2(input.command),
            requiredFields: productPublicationWriteFieldsV2,
          }),
      },
      sources: {
        withHeldCurrentFacts: (tx, input, work) =>
          fixed.sources.withHeldCurrentFacts(
            tx,
            {
              ...input,
              command: parseProductPublicationCommandV2(input.command),
              current:
                input.current === null ? null : parseProductPublicationVersionV2(input.current),
            },
            work,
          ),
      },
      audit: {
        create: (p, action) => fixed.audit.create(parseProductPublicationVersionV2(p), action),
      },
    },
    fixed,
  );
  return Object.freeze({
    execute: (value: unknown) => kernel.execute(value) as Promise<ProductPublicationWriteResultV2>,
  });
}
function createPublicationStoreKernel(
  options: PublicationKernelOptions,
  v2Options?: ProductPublicationStoreOptionsV2,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    kind = options.actorKind;
  if (
    (kind !== "User" && kind !== "System") ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.audit?.create !== "function"
  )
    return fail();
  const run = options.transactions.run.bind(options.transactions),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    sources = options.sources.withHeldCurrentFacts.bind(options.sources),
    audit = options.audit.create.bind(options.audit),
    readClock = options.clock.now.bind(options.clock);
  return Object.freeze({
    async execute(value: unknown): Promise<PublicationKernelResult> {
      let latestTime: string | undefined,
        invalidClock = false;
      const now = () => {
        if (!v2Options) return readClock();
        try {
          const at = parseCatalogInstant(readClock());
          if (invalidClock || (latestTime !== undefined && at < latestTime)) return fail();
          latestTime = at;
          return at;
        } catch {
          invalidClock = true;
          return fail();
        }
      };
      const c = v2Options
        ? parseProductPublicationCommandV2(value)
        : parseProductPublicationCommand(value);
      if (
        c.tenantReference !== tenant ||
        c.brandReference !== brand ||
        c.actorReference !== actor ||
        c.actorKind !== kind
      )
        return fail("CATALOG_PERMISSION_DENIED");
      let invocations = 0,
        completed: PublicationKernelResult | undefined;
      try {
        const result = await run(async (tx) => {
          if (++invocations !== 1) return fail();
          let guardRegistered = false;
          const authorize = async () => {
            await hold(
              tx,
              Object.freeze({
                command: c,
                requiredPermissions: v2Options
                  ? Object.freeze([
                      ...permission(c),
                      "catalog.product.history.read",
                      "catalog.product.approval.read",
                    ])
                  : permission(c),
                requiredFields: productPublicationWriteFields,
                requiredScope: "FullBrandScope",
                observedAt: parseCatalogInstant(now()),
              }),
            );
            if (v2Options) now();
          };
          const registerOuterGuard = async (
            lease: { readonly observedAt: string; readonly validUntil: string } | null,
          ) => {
            if (!v2Options?.registerBeforeCommit) return;
            if (guardRegistered) return fail();
            guardRegistered = true;
            const query = tx.query;
            let failed = false;
            const check = () => {
              const at = parseCatalogInstant(now());
              if (
                failed ||
                tx.query !== query ||
                (lease !== null && (at < lease.observedAt || at >= lease.validUntil))
              )
                return fail();
            };
            const guard = async () => {
              try {
                check();
                await authorize();
                check();
              } catch (error) {
                failed = true;
                if (error instanceof CatalogError) throw error;
                return fail();
              }
            };
            if ((await v2Options.registerBeforeCommit(tx, guard, check)) !== undefined)
              return fail();
          };
          await authorize();
          const isolation = await tx.query<{ isolation: string }>(
            "SELECT current_setting('transaction_isolation') AS isolation",
            [],
          );
          if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== "read committed")
            return fail();
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          await holdProductSourceBarrier(tx, brand);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogProductOperation:" + brand + ":" + c.operationReference,
          ]);
          // Any existing operation must be this exact publication intent; never infer a
          // historical result from today's Draft or treat a legacy operation as absent.
          const old = await tx.query<{
            action_code: string;
            publication: unknown;
            aggregate: unknown;
            content: unknown;
            journal: unknown;
          }>(
            "SELECT o.action_code,r.snapshot_json publication,s.snapshot_json aggregate,CASE WHEN r.state IN ('Published','Superseded') THEN f.snapshot_json ELSE NULL END content,j.snapshot_json journal FROM rms_catalog.product_operation_record o LEFT JOIN rms_catalog.product_scope_journal j ON j.operation_id=o.operation_id AND j.tenant_id=$1 LEFT JOIN rms_catalog.product_publication_revision r ON r.operation_id=o.operation_id AND r.tenant_id=$1 LEFT JOIN rms_catalog.product_operation_snapshot s ON s.operation_id=o.operation_id LEFT JOIN rms_catalog.product_publication_content f ON f.product_version_id=r.product_version_id AND f.tenant_id=$1 WHERE o.brand_id=$2 AND o.operation_id=$3",
            [tenant, brand, c.operationReference],
          );
          if (old.rows.length > 0) {
            const row = old.rows[0];
            if (
              old.rows.length !== 1 ||
              !row ||
              row.action_code !== "ProductPublication" ||
              row.publication === null
            )
              return fail("CATALOG_IDEMPOTENCY_CONFLICT");
            const p = v2Options
                ? recoverCatalogProductPublicationV2(c, row.publication)
                : recoverCatalogProductPublication(c, row.publication),
              root = parseProductAggregate(copyCategoryPersistenceValue(row.aggregate)),
              content =
                row.content === null ? null : parseCatalogProductPublicationContent(row.content);
            if (
              root.brandReference !== brand ||
              root.productReference !== c.productReference ||
              root.aggregateVersion !== p.productAggregateVersion + 1 ||
              root.updatedAt !== p.occurredAt ||
              ((p.state === "Published" || p.state === "Superseded") &&
                (!content ||
                  content.versionReference !== p.versionReference ||
                  content.contentDigest !== p.contentDigest ||
                  content.configurationDigest !== p.configurationDigest))
            )
              return fail();
            const scopeJournal =
              v2Options || row.journal === null
                ? null
                : parseCatalogProductScopeJournal(row.journal);
            if (
              scopeJournal &&
              canonicalizeRfc8785(scopeJournal.incoming) !== canonicalizeRfc8785(p)
            )
              return fail();
            await holdProductEditorContent(tx, options.editorContentAuthority, root, "Read");
            const scopeRetirementHeader = v2Options
              ? await recoverProductScopeRetirementHeader(tx, p, c.action)
              : null;
            const validationReport = v2Options
              ? await recoverProductPublicationValidationReport(tx, p)
              : null;
            if (v2Options && c.action === "Approve") {
              const receipt = await readProductApprovalReceiptV2(tx, p);
              if (!equal(buildCatalogProductApprovalReceiptV2(p, receipt.approval), receipt))
                return fail();
            }
            if (
              v2Options &&
              content &&
              (content.tenantReference !== tenant ||
                content.brandReference !== brand ||
                content.productReference !== c.productReference ||
                content.publicationOperationReference !== p.operationReference ||
                content.sourceAggregateVersion !== p.productAggregateVersion ||
                content.sealedAt !== p.occurredAt)
            )
              return fail();
            await authorize();
            // Original recovery needs current admission but no fresh facts,
            // policy or reconstructed approval expiry.
            if (v2Options) await registerOuterGuard(null);
            completed = v2Options
              ? Object.freeze({
                  status: "Replayed" as const,
                  publication: parseProductPublicationVersionV2(p),
                  aggregate: root,
                  content,
                  scopeRetirementHeader: scopeRetirementHeader ?? fail(),
                  validationReport: validationReport ?? fail(),
                })
              : Object.freeze({
                  status: "Replayed",
                  publication: parseProductPublicationVersion(p),
                  aggregate: root,
                  content,
                  scopeJournal,
                  scopeJournalStatus: scopeJournal
                    ? "Recorded"
                    : c.action === "Publish" || c.action === "ActivateScheduled"
                      ? "NotRecorded"
                      : "NotApplicable",
                });
            return completed;
          }
          await assertProductPublicationOperationNotAbandoned(
            tx,
            "CatalogProductOperation",
            brand,
            c.operationReference,
          );
          if (!v2Options)
            await assertProductPublicationV1Compatible(tx, tenant, brand, c.productReference);
          const locked = await tx.query(
            "SELECT product_id FROM rms_catalog.product WHERE brand_id=$1 AND product_id=$2 FOR UPDATE",
            [brand, c.productReference],
          );
          if (locked.rows.length !== 1) return fail("CATALOG_UNAVAILABLE");
          const loaded = await tx.query<{ snapshot: unknown; precise: boolean }>(
            productSnapshotSelectSql,
            [brand, c.productReference],
          );
          if (loaded.rows.length !== 1 || loaded.rows[0]?.precise !== true) return fail();
          const root = parseProductAggregate(copyCategoryPersistenceValue(loaded.rows[0].snapshot));
          await holdProductEditorContent(tx, options.editorContentAuthority, root, "Read");
          if (root.aggregateVersion !== c.expectedProductAggregateVersion)
            return fail("CATALOG_VERSION_CONFLICT");
          if (c.occurredAt < root.updatedAt && !(v2Options && c.action === "ActivateScheduled"))
            return fail("CATALOG_LIFECYCLE_CONFLICT");
          const rows = await tx.query<{ snapshot_json: unknown }>(
            "SELECT snapshot_json FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4 ORDER BY publication_version DESC LIMIT 1",
            [tenant, brand, c.productReference, c.versionReference],
          );
          if (rows.rows.length > 1) return fail();
          const current = rows.rows[0]
            ? v2Options
              ? parseProductPublicationVersionV2(rows.rows[0].snapshot_json)
              : parseProductPublicationVersion(rows.rows[0].snapshot_json)
            : null;
          let content: CatalogProductPublicationContent | null = null;
          if (c.action === "Supersede") {
            const frozen = await tx.query<{ snapshot_json: unknown }>(
              "SELECT snapshot_json FROM rms_catalog.product_publication_content WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 AND product_version_id=$4",
              [tenant, brand, c.productReference, c.versionReference],
            );
            if (frozen.rows.length !== 1) return fail();
            content = parseCatalogProductPublicationContent(frozen.rows[0]?.snapshot_json);
            if (
              c.contentDigest !== content.contentDigest ||
              c.configurationDigest !== content.configurationDigest
            )
              return fail("CATALOG_LIFECYCLE_CONFLICT");
          } else {
            const identity = deriveCatalogProductPublicationContentIdentity(root);
            if (
              root.draft.versionReference !== c.versionReference ||
              identity.contentDigest !== c.contentDigest ||
              identity.configurationDigest !== c.configurationDigest
            )
              return fail("CATALOG_LIFECYCLE_CONFLICT");
          }
          let sourceCalls = 0,
            sourceResult: PublicationKernelResult | undefined;
          const v2Lease: { validUntil: string | null } = { validUntil: null };
          await tx.query("SAVEPOINT catalog_product_publication", []);
          try {
            if (!v2Options)
              await holdProductEditorContent(
                tx,
                options.editorContentAuthority,
                root,
                c.action === "Supersede" ? "Read" : "Publish",
              );
            const observedAt = parseCatalogInstant(now());
            if (
              v2Options &&
              (observedAt < root.updatedAt || (current !== null && observedAt < current.occurredAt))
            )
              return fail("CATALOG_LIFECYCLE_CONFLICT");
            const held = await sources(
              tx,
              Object.freeze({ command: c, aggregate: root, current, content, observedAt }),
              async (factsValue, detailsValue) => {
                if (++sourceCalls !== 1) return fail();
                const capturedFacts = copyCategoryPersistenceValue(factsValue) as
                  ProductPublicationFacts | ProductPublicationFactsV2;
                // Detach the optional detailed evidence before any awaited policy
                // or approval acquisition. Absence remains explicitly ChecksOnly.
                const capturedDetails =
                  v2Options && detailsValue !== undefined && detailsValue !== null
                    ? parseCatalogProductPublicationValidationDetails(detailsValue)
                    : null;
                // V2's producer now holds the actual root/head reference proofs.
                // Complete their editor obligation before planning or any write;
                // initial/replay Read and the legacy V1 order remain unchanged.
                if (v2Options)
                  await holdProductEditorContent(
                    tx,
                    options.editorContentAuthority,
                    root,
                    "Publish",
                  );
                if (v2Options) now();
                if (capturedFacts.now !== observedAt) return fail();
                const planAndApply = async (
                  f: ProductPublicationFacts | ProductPublicationFactsV2,
                  coverage?: CatalogProductRetirementCoverage,
                  policy?: ReturnType<typeof parsePublishingProductPublicationPolicy>,
                ) => {
                  const p = v2Options
                    ? planCatalogProductPublicationV2(c, current, f)
                    : planCatalogProductPublication(c, current, f);
                  const publicationV2 = v2Options ? parseProductPublicationVersionV2(p) : null,
                    validationReport = publicationV2
                      ? buildCatalogProductPublicationValidationReport({
                          command: c,
                          publication: publicationV2,
                          validation: f.validation,
                          details: capturedDetails,
                          recordedAt: now(),
                        })
                      : null,
                    publicationIntent = publicationV2?.replacementIntent,
                    scopeRetirementHeader =
                      v2Options && coverage
                        ? buildCatalogProductScopeRetirementHeader({
                            publicationAction: c.action,
                            publication: p,
                            previousPublication:
                              p.state === "Published" &&
                              publicationIntent &&
                              publicationIntent.mode !== "None"
                                ? (coverage.latest.find(
                                    (candidate) =>
                                      candidate.versionReference ===
                                      publicationIntent.previousVersionReference,
                                  ) ?? fail())
                                : null,
                            observedSourceRevision: coverage.sourceRevision,
                            observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
                              tenantReference: coverage.tenantReference,
                              brandReference: coverage.brandReference,
                              productReference: coverage.productReference,
                              aggregateVersion: coverage.aggregateVersion,
                              sourceRevision: coverage.sourceRevision,
                              latest: coverage.latest,
                            }),
                          })
                        : null;
                  if (v2Options) {
                    if (!coverage || !policy || !scopeRetirementHeader) return fail();
                    assertV2PublicationScope(
                      parseProductPublicationCommandV2(c),
                      parseProductPublicationVersionV2(p),
                      coverage,
                      policy,
                    );
                  }
                  const apply = async (scopeJournal: CatalogProductScopeJournal | null) => {
                    let next: ProductAggregate;
                    if (p.state === "Published") {
                      const materialized = v2Options
                        ? createCatalogProductPublicationMaterializationV2(root, p)
                        : createCatalogProductPublicationMaterialization(root, p);
                      next = materialized.successor;
                      content = materialized.content;
                    } else
                      next = parseProductAggregate({
                        ...root,
                        aggregateVersion: root.aggregateVersion + 1,
                        updatedAt: p.occurredAt,
                      });
                    const changed = await tx.query(
                      "UPDATE rms_catalog.product SET aggregate_version=$4,updated_at=$5 WHERE brand_id=$1 AND product_id=$2 AND aggregate_version=$3",
                      [
                        brand,
                        c.productReference,
                        c.expectedProductAggregateVersion,
                        next.aggregateVersion,
                        next.updatedAt,
                      ],
                    );
                    count(changed);
                    count(
                      await tx.query(
                        "INSERT INTO rms_catalog.product_operation_record(operation_id,brand_id,product_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,'ProductPublication',$4,$5,$6)",
                        [
                          c.operationReference,
                          brand,
                          c.productReference,
                          p.intentDigest,
                          next.aggregateVersion,
                          p.occurredAt,
                        ],
                      ),
                    );
                    if (p.state === "Published") {
                      count(
                        await tx.query(
                          "UPDATE rms_catalog.product_version SET status='Frozen' WHERE brand_id=$1 AND product_id=$2 AND product_version_id=$3 AND status='Draft'",
                          [brand, c.productReference, c.versionReference],
                        ),
                      );
                      const d = next.draft;
                      count(
                        await tx.query(
                          "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,base_product_version_id,status,default_locale,localized_names_json,tax_classification_id,created_at,updated_at,category_classification_known,primary_category_id,editor_content_json) VALUES($1,$2,$3,$4,'Draft',$5,$6,$7,$8,$8,$9,$10,$11)",
                          [
                            d.versionReference,
                            c.productReference,
                            brand,
                            c.versionReference,
                            d.defaultLocale,
                            d.localizedNames,
                            d.taxClassificationReference,
                            p.occurredAt,
                            d.categoryClassification !== undefined,
                            d.categoryClassification?.primaryCategoryReference ?? null,
                            d.editorContent === undefined ? null : JSON.stringify(d.editorContent),
                          ],
                        ),
                      );
                      for (const category of d.categoryClassification?.categoryReferences ?? [])
                        count(
                          await tx.query(
                            "INSERT INTO rms_catalog.product_version_category_assignment(product_version_id,product_id,brand_id,category_id) VALUES($1,$2,$3,$4)",
                            [d.versionReference, c.productReference, brand, category],
                          ),
                        );
                    }
                    count(
                      await tx.query(
                        "INSERT INTO rms_catalog.product_publication_revision(operation_id,tenant_id,brand_id,product_id,product_version_id,publication_version,source_aggregate_version,result_aggregate_version,action_code,state,intent_digest,content_digest,configuration_digest,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
                        [
                          c.operationReference,
                          tenant,
                          brand,
                          c.productReference,
                          c.versionReference,
                          p.publicationVersion,
                          p.productAggregateVersion,
                          next.aggregateVersion,
                          c.action,
                          p.state,
                          p.intentDigest,
                          p.contentDigest,
                          p.configurationDigest,
                          p.occurredAt,
                          p,
                        ],
                      ),
                    );
                    if (validationReport)
                      await appendProductPublicationValidationReport(tx, validationReport);
                    if (c.action === "Approve") {
                      const receipt = v2Options
                        ? buildCatalogProductApprovalReceiptV2(p, f.approval)
                        : buildCatalogProductApprovalReceipt(p, f.approval);
                      count(
                        await tx.query(
                          "INSERT INTO rms_catalog.product_approval_receipt(operation_id,approval_id,tenant_id,brand_id,product_id,product_version_id,publication_version,result_aggregate_version,receipt_digest,snapshot_json,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)",
                          [
                            c.operationReference,
                            receipt.approval.evidenceReference,
                            tenant,
                            brand,
                            c.productReference,
                            c.versionReference,
                            p.publicationVersion,
                            next.aggregateVersion,
                            receipt.digest,
                            JSON.stringify(receipt),
                            p.occurredAt,
                          ],
                        ),
                      );
                    }
                    if (scopeJournal)
                      count(
                        await tx.query(
                          "INSERT INTO rms_catalog.product_scope_journal(operation_id,tenant_id,brand_id,product_id,source_aggregate_version,source_revision,intent_digest,journal_digest,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
                          [
                            c.operationReference,
                            tenant,
                            brand,
                            c.productReference,
                            p.productAggregateVersion,
                            scopeJournal.sourceRevision,
                            p.intentDigest,
                            scopeJournal.digest,
                            scopeJournal,
                          ],
                        ),
                      );
                    if (scopeRetirementHeader)
                      await appendProductScopeRetirementHeader(tx, scopeRetirementHeader);
                    if (p.state === "Published") {
                      if (!content) return fail();
                      count(
                        await tx.query(
                          "INSERT INTO rms_catalog.product_publication_content(product_version_id,tenant_id,brand_id,product_id,publication_operation_id,source_aggregate_version,content_digest,configuration_digest,sealed_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
                          [
                            c.versionReference,
                            tenant,
                            brand,
                            c.productReference,
                            c.operationReference,
                            p.productAggregateVersion,
                            p.contentDigest,
                            p.configurationDigest,
                            p.occurredAt,
                            content,
                          ],
                        ),
                      );
                      for (const sku of root.draft.skus)
                        count(
                          await tx.query(
                            "UPDATE rms_catalog.sku SET product_version_id=$4 WHERE brand_id=$1 AND product_id=$2 AND sku_id=$3 AND product_version_id=$5",
                            [
                              brand,
                              c.productReference,
                              sku.skuReference,
                              next.draft.versionReference,
                              c.versionReference,
                            ],
                          ),
                        );
                      for (const binding of root.draft.optionBindings)
                        count(
                          await tx.query(
                            "UPDATE rms_catalog.product_option_binding SET product_version_id=$4 WHERE brand_id=$1 AND product_id=$2 AND binding_id=$3 AND product_version_id=$5",
                            [
                              brand,
                              c.productReference,
                              binding.bindingReference,
                              next.draft.versionReference,
                              c.versionReference,
                            ],
                          ),
                        );
                    }
                    count(
                      await tx.query(
                        "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6)",
                        [
                          c.operationReference,
                          brand,
                          c.productReference,
                          next.aggregateVersion,
                          p.occurredAt,
                          next,
                        ],
                      ),
                    );
                    await (
                      v2Options
                        ? appendProductPublicationCommitArtifactsV2
                        : appendProductPublicationCommitArtifacts
                    )(tx, p, next, c.action, audit(p, c.action));
                    await holdProductEditorContent(
                      tx,
                      options.editorContentAuthority,
                      next,
                      "Read",
                    );
                    await authorize();
                    const readback = await tx.query<{ snapshot: unknown; precise: boolean }>(
                      productSnapshotSelectSql,
                      [brand, c.productReference],
                    );
                    if (
                      readback.rows.length !== 1 ||
                      readback.rows[0]?.precise !== true ||
                      canonicalizeRfc8785(
                        parseProductAggregate(
                          copyCategoryPersistenceValue(readback.rows[0].snapshot),
                        ),
                      ) !== canonicalizeRfc8785(next)
                    )
                      return fail();
                    sourceResult = v2Options
                      ? Object.freeze({
                          status: "Applied" as const,
                          publication: parseProductPublicationVersionV2(p),
                          aggregate: next,
                          content,
                          scopeRetirementHeader: scopeRetirementHeader ?? fail(),
                          validationReport: Object.freeze({
                            status: "Recorded" as const,
                            report: validationReport ?? fail(),
                          }),
                        })
                      : Object.freeze({
                          status: "Applied",
                          publication: parseProductPublicationVersion(p),
                          aggregate: next,
                          content,
                          scopeJournal,
                          scopeJournalStatus: scopeJournal ? "Recorded" : "NotApplicable",
                        });
                    return sourceResult;
                  };
                  if (v2Options) return apply(null);
                  if (p.state !== "Published") return apply(null);
                  const policySource = options.sources.withHeldScopePolicy;
                  if (typeof policySource !== "function") return fail();
                  let calls = 0,
                    outcome: PublicationKernelResult | undefined;
                  const policyResult = await policySource.call(
                    options.sources,
                    tx,
                    { publication: parseProductPublicationVersion(p), observedAt },
                    async (policyValue) => {
                      if (++calls !== 1) return fail();
                      const policy = copyCategoryPersistenceValue(policyValue);
                      if (!policy || typeof policy !== "object" || Array.isArray(policy))
                        return fail();
                      const q = policy as Record<string, unknown>;
                      const keys = [
                        "policyReference",
                        "policyVersion",
                        "policyEvidenceReference",
                        "scopeOrder",
                        "observedAt",
                        "validUntil",
                      ];
                      if (
                        Object.keys(q).length !== keys.length ||
                        keys.some((k) => !Object.hasOwn(q, k)) ||
                        q.policyReference !== p.policyReference ||
                        q.policyVersion !== p.policyVersion ||
                        q.observedAt !== observedAt
                      )
                        return fail();
                      const head = await tx.query<{ source_revision: string }>(
                        "SELECT source_revision::text FROM rms_catalog.product_source_head WHERE brand_id=$1",
                        [brand],
                      );
                      if (head.rows.length !== 1) return fail();
                      const budget = await tx.query<{ count: number; bytes: string }>(
                        "SELECT count(*)::int count,coalesce(sum(octet_length(snapshot_json::text)),0)::text bytes FROM (SELECT DISTINCT ON (product_version_id) snapshot_json FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 ORDER BY product_version_id,publication_version DESC) h",
                        [tenant, brand, c.productReference],
                      );
                      const limits = budget.rows[0];
                      if (
                        budget.rows.length !== 1 ||
                        !limits ||
                        limits.count > 1000 ||
                        BigInt(limits.bytes) > 1_048_576n
                      )
                        return fail();
                      const heads = await tx.query<{ snapshot_json: unknown; coherent: boolean }>(
                        "SELECT h.snapshot_json,(o.intent_digest=h.intent_digest AND o.result_aggregate_version=h.result_aggregate_version AND o.product_id=h.product_id AND o.action_code='ProductPublication' AND sc.operation_id IS NOT NULL AND sc.result_aggregate_version=h.result_aggregate_version AND sc.product_id=h.product_id AND sc.occurred_at=h.occurred_at AND sc.source_revision <= $4::bigint) coherent FROM (SELECT DISTINCT ON (product_version_id) * FROM rms_catalog.product_publication_revision WHERE tenant_id=$1 AND brand_id=$2 AND product_id=$3 ORDER BY product_version_id,publication_version DESC) h LEFT JOIN rms_catalog.product_operation_record o ON o.operation_id=h.operation_id AND o.brand_id=h.brand_id LEFT JOIN rms_catalog.product_source_commit sc ON sc.operation_id=h.operation_id AND sc.brand_id=h.brand_id ORDER BY h.product_version_id LIMIT 1001",
                        [tenant, brand, c.productReference, head.rows[0]?.source_revision],
                      );
                      if (
                        heads.rows.length !== limits.count ||
                        heads.rows.some((h) => h.coherent !== true)
                      )
                        return fail();
                      const journal = buildCatalogProductScopeJournal({
                        incoming: p,
                        latest: heads.rows.map((h) => h.snapshot_json),
                        sourceAggregateVersion: p.productAggregateVersion,
                        sourceRevision: head.rows[0]?.source_revision,
                        scopeOrder: q.scopeOrder,
                        policyEvidenceReference: q.policyEvidenceReference,
                        observedAt,
                        validUntil: q.validUntil,
                      });
                      outcome = await apply(journal);
                      if (parseCatalogInstant(now()) >= journal.validUntil) return fail();
                      return outcome;
                    },
                  );
                  if (calls !== 1 || !outcome || policyResult !== outcome) return fail();
                  return outcome;
                };
                if (!v2Options) return planAndApply(capturedFacts);
                return withV2PublicationFacts(
                  tx,
                  v2Options,
                  parseProductPublicationCommandV2(c),
                  current === null ? null : parseProductPublicationVersionV2(current),
                  root,
                  capturedFacts as ProductPublicationFactsV2,
                  capturedDetails,
                  observedAt,
                  now,
                  (deadline) => {
                    v2Lease.validUntil = deadline;
                  },
                  planAndApply,
                );
              },
            );
            if (sourceCalls !== 1 || !sourceResult || held !== sourceResult) return fail();
            await authorize();
            if (v2Options) {
              const completedAt = parseCatalogInstant(now());
              if (
                v2Lease.validUntil === null ||
                completedAt < observedAt ||
                completedAt >= v2Lease.validUntil
              )
                return fail();
              await registerOuterGuard({ observedAt, validUntil: v2Lease.validUntil });
            }
            await tx.query("RELEASE SAVEPOINT catalog_product_publication", []);
            completed = sourceResult;
            return completed;
          } catch (error) {
            await tx.query("ROLLBACK TO SAVEPOINT catalog_product_publication", []);
            await tx.query("RELEASE SAVEPOINT catalog_product_publication", []);
            throw error;
          }
        });
        if (invocations !== 1 || !completed || result !== completed) return fail();
        if (v2Options) now();
        return completed;
      } catch (error) {
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}
