import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingOptionPricePublicationPolicy,
  publishingOptionPricePublicationPolicyDigest,
  createPublishingReleaseRecord,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parseIndependentPublishingApprovalRequest,
  optionPricePolicyConfigurationType,
  optionPriceRuleConfigurationType,
  optionPriceRulePublicationPurpose,
} from "@bop/publishing";
import { CatalogError, copyCategoryPersistenceValue, parseCatalogInstant } from "@rms/catalog";
import {
  OptionPriceAuthoringError,
  parsePricingReference,
  optionPriceIntentDigest,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringState,
  type OptionPriceAuthoringStoreOptions,
  type OptionPricePublicationAuthorization,
} from "@rms/pricing";
import type { CurrentPublishedOptionSetGraphOptions } from "./current-published-option-set-graph.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";

/** Expected evidence inventory, not a statement that any check ran. The actual
 * Submit producer must construct all four reports from its held owner facts. */
export const optionPricePublicationReviewCheckCodes = Object.freeze([
  "OPTION_PRICE_DRAFT_CONTENT",
  "OPTION_PRICE_CURRENT_CONTEXT",
  "OPTION_PRICE_CURRENCY",
  "OPTION_PRICE_PUBLICATION_CONFLICTS",
] as const);
export interface MerchantOptionPricePublicationAuthorityOptions extends Omit<
  CurrentPublishedOptionSetGraphOptions,
  "events"
> {
  readonly originalObservedAt: string;
  readonly operationReference: string;
  readonly ruleReference: string;
  readonly expectedAggregateVersion: number;
  readonly publicationPolicyFamilyReference: string;
}
type Input = Parameters<
  NonNullable<OptionPriceAuthoringStoreOptions["publicationSource"]>["withCurrentAuthorization"]
>[1];
const stateFromActualOwner = (value: unknown) => {
  const r = readClosedRecord(value, [
    "profile",
    "brandReference",
    "ruleReference",
    "bindingReference",
    "optionReference",
    "aggregateVersion",
    "createdAt",
    "createdByActorReference",
    "updatedAt",
    "draftAuthorActorReference",
    "draft",
    "currentPublished",
    "latestVersion",
  ]);
  const wire = (value: unknown): unknown => {
    if (value === null) return null;
    const snapshot = readClosedRecord(value, [
      "ruleReference",
      "versionReference",
      "snapshotDigest",
      "brandReference",
      "bindingReference",
      "optionReference",
      "skuReference",
      "scopeKind",
      "scopeReference",
      "channelCode",
      "orderType",
      "lifecycle",
      "currencyMetadata",
      "unitAmount",
      "includedQuantity",
      "quantityBasis",
      "effectivePeriod",
      "createdAt",
    ]);
    const money = readClosedRecord(snapshot.unitAmount, ["amountMinor", "currencyCode"]);
    if (typeof money.amountMinor !== "bigint")
      throw new OptionPriceAuthoringError("OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
    return copyCategoryPersistenceValue({
      ...snapshot,
      unitAmount: { amountMinor: money.amountMinor.toString(), currencyCode: money.currencyCode },
    });
  };
  return parseOptionPriceAuthoringState(
    copyCategoryPersistenceValue({
      ...r,
      draft: wire(r.draft),
      currentPublished: wire(r.currentPublished),
      latestVersion: wire(r.latestVersion),
    }),
  );
};
/** Server-only producer. The actual Pricing store supplies its parsed original
 * Draft and intent inside the same borrowed host; no HTTP evidence is accepted. */
export function createMerchantOptionPricePublicationAuthority(
  options: MerchantOptionPricePublicationAuthorityOptions,
) {
  const tx = options.transaction,
    queryPort = tx.query,
    clockOwner = options.clock,
    clockPort = clockOwner.now,
    authOwner = options.currentAuthorization,
    assertPort = authOwner.assertCurrent,
    authLeasePort = authOwner.leaseDeadline,
    capOwner = options.capability,
    combinedPort = capOwner.holdUntilCommitWithDecisions,
    capLeasePort = capOwner.leaseDeadline,
    registerPort = options.registerBeforeCommit;
  const tenant = String(parsePricingReference(options.tenantReference)),
    brand = String(parsePricingReference(options.brandReference)),
    store = String(parsePricingReference(options.storeReference)),
    actor = String(parsePricingReference(options.actorReference)),
    session = String(parsePricingReference(options.sessionReference)),
    operation = String(parsePricingReference(options.operationReference)),
    rule = String(parsePricingReference(options.ruleReference)),
    family = String(parsePricingReference(options.publicationPolicyFamilyReference)),
    started = parseCatalogInstant(options.originalObservedAt),
    originalUntil = parseCatalogInstant(options.originalValidUntil),
    expected = options.expectedAggregateVersion;
  let deadline: string = originalUntil,
    latest: string = started,
    failed = false,
    active = false,
    entered = false,
    ready = false,
    guardCalls = 0,
    guardComplete = false,
    finals = 0;
  const fail = (
    code: ConstructorParameters<
      typeof OptionPriceAuthoringError
    >[0] = "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
  ): never => {
    failed = true;
    throw new OptionPriceAuthoringError(code);
  };
  if (
    typeof queryPort !== "function" ||
    typeof clockPort !== "function" ||
    typeof assertPort !== "function" ||
    typeof authLeasePort !== "function" ||
    typeof combinedPort !== "function" ||
    typeof capLeasePort !== "function" ||
    typeof registerPort !== "function" ||
    !Number.isSafeInteger(expected) ||
    expected < 1 ||
    expected > 2147483647 ||
    originalUntil <= started ||
    Date.parse(originalUntil) - Date.parse(started) > 5000
  )
    return fail();
  const check = () => {
    if (
      failed ||
      finals ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.clock !== clockOwner ||
      clockOwner.now !== clockPort ||
      options.currentAuthorization !== authOwner ||
      authOwner.assertCurrent !== assertPort ||
      authOwner.leaseDeadline !== authLeasePort ||
      options.capability !== capOwner ||
      capOwner.holdUntilCommitWithDecisions !== combinedPort ||
      capOwner.leaseDeadline !== capLeasePort ||
      options.registerBeforeCommit !== registerPort ||
      options.tenantReference !== tenant ||
      options.brandReference !== brand ||
      options.storeReference !== store ||
      options.actorReference !== actor ||
      options.sessionReference !== session ||
      options.operationReference !== operation ||
      options.ruleReference !== rule ||
      options.expectedAggregateVersion !== expected ||
      options.publicationPolicyFamilyReference !== family ||
      options.originalObservedAt !== started ||
      options.originalValidUntil !== originalUntil
    )
      return fail();
    assertPort.call(authOwner);
    const at = parseCatalogInstant(clockPort.call(clockOwner));
    if (at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  };
  const tighten = (value: string) => {
    const until = parseCatalogInstant(value);
    if (until < deadline) deadline = until;
    check();
  };
  const query = async <Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
    const at = check(),
      remaining = Math.floor(Date.parse(deadline) - Date.parse(at));
    if (remaining < 1) return fail();
    await queryPort.call(
      tx,
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
      [String(remaining)],
    );
    check();
    const result = await tx.query<Row>(sql, values);
    check();
    return result;
  };
  const hold = async () => {
    check();
    const actions = Object.freeze(["pricing.price-book.manage"]),
      evidence = await combinedPort.call(capOwner, actions);
    check();
    if (
      !Array.isArray(evidence) ||
      !Object.isFrozen(evidence) ||
      Object.getPrototypeOf(evidence) !== Array.prototype ||
      evidence.length !== actions.length ||
      Reflect.ownKeys(evidence).length !== actions.length + 1
    )
      return fail();
    for (let i = 0; i < evidence.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(evidence, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor) || !Object.isFrozen(descriptor.value))
        return fail();
      const rawAudit = Object.getOwnPropertyDescriptor(descriptor.value, "audit");
      if (!rawAudit || !("value" in rawAudit) || !Object.isFrozen(rawAudit.value)) return fail();
      const d = readClosedRecord(copyCategoryPersistenceValue(descriptor.value), [
          "effect",
          "reason",
          "source",
          "action",
          "scopeKind",
          "policySnapshotReference",
          "policyVersion",
          "audit",
        ]),
        a = readClosedRecord(d.audit, ["effect", "reason", "source"]);
      if (
        d.action !== actions[i] ||
        d.effect !== "Allow" ||
        d.scopeKind !== "Brand" ||
        ((d.reason !== "ROLE_PERMISSION" || d.source !== "RolePermission") &&
          (d.reason !== "EXPLICIT_ALLOW" || d.source !== "ExplicitAllow")) ||
        a.effect !== d.effect ||
        a.reason !== d.reason ||
        a.source !== d.source
      )
        return fail("OPTION_PRICE_PERMISSION_DENIED");
      parseBusinessAction(d.action);
      parsePolicyReference(d.policySnapshotReference);
      parsePolicyVersion(d.policyVersion);
    }
    tighten(authLeasePort.call(authOwner));
    tighten(capLeasePort.call(capOwner));
    await query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      [tenant, brand],
    );
  };
  const restoreStore = () => query("SELECT set_config('bop.store_id',$1,true)", [store]);
  // Every owning SQL read uses a captured, deadline-bound query, never a second UoW.
  const borrowed = Object.freeze({ query });
  const owner = createPostgresPublishingMutationStore(
    { run: (work) => work(borrowed) },
    tenant,
    createPublishingScope({ kind: "Brand", brandReference: brand, storeReference: null }),
  );
  let reread: (() => Promise<void>) | undefined;
  let bound: Input | undefined;
  const acquire = async (): Promise<{
    packet: OptionPricePublicationAuthorization;
    stable: unknown;
  }> => {
    if (!bound) return fail();
    await hold();
    const draft = bound.state.draft,
      author = bound.state.draftAuthorActorReference;
    if (!draft || !author) return fail();
    const policySource = await owner.resolveCurrentOptionPricePublicationPolicy({
      familyReference: family,
      observedAt: check(),
    });
    check();
    const received = readClosedRecord(copyCategoryPersistenceValue(policySource), [
        "content",
        "current",
        "observedAt",
      ]),
      current = readClosedRecord(received.current, [
        "release",
        "lifecycle",
        "validationEvidence",
        "approvalEvidence",
        "auditReference",
        "observedAt",
      ]);
    const policy = parsePublishingOptionPricePublicationPolicy(received.content),
      policyRelease = createPublishingReleaseRecord(policySource.current.release),
      lifecycle = createPublishingLifecycleRecord(policySource.current.lifecycle),
      validation = createPublishingValidationEvidence(policySource.current.validationEvidence),
      governanceApproval = createPublishingApprovalEvidence(policySource.current.approvalEvidence),
      policyDigest = publishingOptionPricePublicationPolicyDigest(policy);
    for (const scoped of [policyRelease, lifecycle, validation, governanceApproval])
      if (
        scoped.scope.kind !== "Brand" ||
        String(scoped.scope.brandReference) !== brand ||
        scoped.scope.storeReference !== null ||
        String(scoped.snapshotReference) !== String(policy.policyReference) ||
        String(scoped.snapshotDigest) !== policyDigest
      )
        return fail();
    parsePricingReference(current.auditReference);
    if (
      current.observedAt !== received.observedAt ||
      String(policy.tenantReference) !== tenant ||
      String(policy.brandReference) !== brand ||
      String(policy.familyReference) !== family ||
      String(policySource.observedAt) > check() ||
      String(policySource.observedAt) < started ||
      policyRelease.configurationType !== optionPricePolicyConfigurationType ||
      policyRelease.purposeCode !== optionPricePolicyConfigurationType ||
      lifecycle.configurationType !== optionPricePolicyConfigurationType ||
      lifecycle.purposeCode !== optionPricePolicyConfigurationType ||
      policyRelease.familyReference !== policy.familyReference ||
      policyRelease.sourceLifecycleId !== lifecycle.lifecycleId ||
      lifecycle.state !== "Published" ||
      lifecycle.familyReference !== policy.familyReference ||
      lifecycle.validationEvidenceReference !== validation.evidenceReference ||
      lifecycle.approvalEvidenceReference !== governanceApproval.evidenceReference ||
      String(policyRelease.createdAt) > check() ||
      String(policy.effectiveFrom) > check() ||
      (policy.effectiveUntil !== null && String(policy.effectiveUntil) <= check())
    )
      return fail();
    if (policy.effectiveUntil !== null) tighten(policy.effectiveUntil);
    let approvalEvidenceReference: string | null = null,
      approvedActorReference: string | null = null,
      approvalStable: unknown = null;
    if (policy.approvalPolicy === "Required") {
      // The public owner bounds failures thrown inside its work callback.
      // Acquire only its actual packet there; composition decisions belong
      // outside that boundary while the same transaction locks remain held.
      const history = await owner.withOptionPriceReview(
        { familyReference: rule, mode: "Read" },
        (held) =>
          held.readForDraft({
            snapshotReference: draft.versionReference,
            snapshotDigest: draft.snapshotDigest,
            observedAt: check(),
          }),
      );
      check();
      if (
        String(history.observedAt) < started ||
        String(history.observedAt) > check() ||
        history.outcome !== "Recorded" ||
        !history.review ||
        !history.approval ||
        history.latest.next.state !== "Approved" ||
        history.latest.operation !== "Approve" ||
        history.latest.idempotencyKey !== history.approval.idempotencyKey ||
        history.latest.next.version !== history.approval.next.version ||
        history.latest.next.lifecycleId !== history.approval.next.lifecycleId ||
        String(history.familyReference) !== rule ||
        String(history.snapshotReference) !== String(draft.versionReference) ||
        String(history.snapshotDigest) !== String(draft.snapshotDigest)
      )
        return fail("OPTION_PRICE_APPROVAL_REQUIRED");
      const approved = await owner.resolveCurrentIndependentApproval(
        parseIndependentPublishingApprovalRequest({
          familyReference: rule,
          lifecycleReference: history.latest.next.lifecycleId,
          configurationType: optionPriceRuleConfigurationType,
          purposeCode: optionPriceRulePublicationPurpose,
          snapshotReference: draft.versionReference,
          snapshotDigest: draft.snapshotDigest,
          requiredCheckCodes: optionPricePublicationReviewCheckCodes,
          observedAt: check(),
        }),
      );
      check();
      const approvalRecord = readClosedRecord(copyCategoryPersistenceValue(approved), [
        "profile",
        "tenantReference",
        "scope",
        "familyReference",
        "lifecycleReference",
        "configurationType",
        "purposeCode",
        "snapshotReference",
        "snapshotDigest",
        "approvedLifecycleVersion",
        "reviewVersion",
        "draftOperationReference",
        "reviewOperationReference",
        "approvalOperationReference",
        "requestedByActorReference",
        "approvedByActorReference",
        "validationEvidenceReference",
        "approvalEvidenceReference",
        "validationCheckCodes",
        "observedAt",
        "validUntil",
        "sourceDigest",
        "recordedIndependence",
        "currentValidation",
        "referenceEligibility",
        "eligibility",
        "digest",
      ]);
      const { digest: reportDigest, ...reportBody } = approvalRecord;
      if (
        approved.profile !== "CurrentIndependentPublishingApprovalV1" ||
        reportDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(reportBody)) ||
        approved.configurationType !== optionPriceRuleConfigurationType ||
        approved.purposeCode !== optionPriceRulePublicationPurpose ||
        approved.lifecycleReference !== history.latest.next.lifecycleId ||
        approved.reviewVersion !== history.review.next.version ||
        approved.draftOperationReference !== history.draft.idempotencyKey ||
        approved.validationEvidenceReference !==
          history.review.validationEvidence?.evidenceReference ||
        approved.currentValidation !== "NotEvaluated" ||
        approved.referenceEligibility !== "NotEvaluated" ||
        approved.eligibility !== "NotEvaluated"
      )
        return fail("OPTION_PRICE_APPROVAL_REQUIRED");
      if (
        String(approved.observedAt) < started ||
        String(approved.observedAt) > check() ||
        approved.tenantReference !== tenant ||
        approved.scope.kind !== "Brand" ||
        String(approved.scope.brandReference) !== brand ||
        approved.scope.storeReference !== null ||
        String(approved.familyReference) !== rule ||
        String(approved.snapshotReference) !== String(draft.versionReference) ||
        String(approved.snapshotDigest) !== String(draft.snapshotDigest) ||
        approved.recordedIndependence !== "Verified" ||
        canonicalizeRfc8785([...approved.validationCheckCodes].sort()) !==
          canonicalizeRfc8785([...optionPricePublicationReviewCheckCodes].sort()) ||
        String(approved.approvedByActorReference) === String(author) ||
        approved.approvedByActorReference === approved.requestedByActorReference ||
        approved.approvedLifecycleVersion !== history.latest.next.version ||
        history.review.audit.actor.type !== "User" ||
        history.approval.audit.actor.type !== "User" ||
        approved.requestedByActorReference !== history.review.audit.actor.reference ||
        approved.approvedByActorReference !== history.approval.audit.actor.reference ||
        approved.approvalOperationReference !== history.approval.idempotencyKey ||
        approved.reviewOperationReference !== history.review.idempotencyKey ||
        approved.approvalEvidenceReference !== history.approval.approvalEvidence?.evidenceReference
      )
        return fail("OPTION_PRICE_APPROVAL_REQUIRED");
      tighten(approved.validUntil);
      approvalEvidenceReference = String(approved.approvalEvidenceReference);
      approvedActorReference = String(approved.approvedByActorReference);
      const { observedAt, validUntil, digest, ...recorded } = approved;
      void observedAt;
      void validUntil;
      void digest;
      approvalStable = recorded;
      check();
    }
    const observedAt = check();
    const packet: OptionPricePublicationAuthorization = Object.freeze({
      policy: Object.freeze({ ...policy }),
      currentPolicyPublicationReference: String(policyRelease.releaseId),
      draftVersionReference: String(draft.versionReference),
      draftSnapshotDigest: String(draft.snapshotDigest),
      draftAuthorActorReference: String(author),
      approvalEvidenceReference,
      approvedActorReference,
      observedAt,
      validUntil: deadline,
    });
    const stable = {
      policy,
      release: policyRelease,
      lifecycle,
      validation,
      approval: governanceApproval,
      auditReference: current.auditReference,
      approvalStable,
    };
    await hold();
    await restoreStore();
    check();
    return { packet: Object.freeze({ ...packet, validUntil: deadline }), stable };
  };
  return Object.freeze({
    async withCurrentAuthorization<T>(
      actual: Parameters<
        NonNullable<
          OptionPriceAuthoringStoreOptions["publicationSource"]
        >["withCurrentAuthorization"]
      >[0],
      input: Input,
      work: (packet: OptionPricePublicationAuthorization) => Promise<T>,
    ): Promise<T> {
      if (entered || active || actual !== tx || typeof work !== "function") return fail();
      entered = true;
      active = true;
      try {
        if (
          (await registerPort(
            tx,
            async () => {
              if (active || !ready || ++guardCalls !== 1 || !reread) return fail();
              await reread();
              check();
              guardComplete = true;
            },
            () => {
              if (active || !ready || guardCalls !== 1 || !guardComplete || finals !== 0)
                return fail();
              check();
              finals = 1;
            },
          )) !== undefined
        )
          return fail();
        const r = readClosedRecord(input, [
            "command",
            "originalIntentDigest",
            "state",
            "originalObservedAt",
            "validUntil",
          ]),
          command = parseOptionPriceAuthoringCommand(copyCategoryPersistenceValue(r.command)),
          state = stateFromActualOwner(r.state);
        if (
          command.action !== "Publish" ||
          String(command.operationReference) !== operation ||
          String(command.ruleReference) !== rule ||
          command.expectedAggregateVersion !== expected ||
          state.aggregateVersion !== expected ||
          String(state.ruleReference) !== rule ||
          String(state.brandReference) !== brand ||
          !state.draft ||
          !state.draftAuthorActorReference ||
          r.originalIntentDigest !== optionPriceIntentDigest(command) ||
          r.originalObservedAt !== started ||
          typeof r.validUntil !== "string" ||
          r.validUntil > originalUntil
        )
          return fail();
        bound = Object.freeze({
          command,
          originalIntentDigest: optionPriceIntentDigest(command),
          state,
          originalObservedAt: started,
          validUntil: r.validUntil,
        });
        tighten(r.validUntil);
        const acquired = await acquire();
        const original = canonicalizeRfc8785(acquired.stable);
        reread = async () => {
          const current = await acquire();
          if (canonicalizeRfc8785(current.stable) !== original) return fail();
        };
        const result = await work(acquired.packet);
        check();
        await reread();
        check();
        ready = true;
        return result;
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          return fail("OPTION_PRICE_PERMISSION_DENIED");
        if (
          error instanceof OptionPriceAuthoringError ||
          error instanceof MerchantProductWriteFeatureDisabled
        )
          throw error;
        return fail();
      } finally {
        active = false;
      }
    },
    assertFinalized() {
      if (failed || active || !ready || guardCalls !== 1 || !guardComplete || finals !== 1)
        return fail();
      const at = parseCatalogInstant(clockPort.call(clockOwner));
      if (
        at < latest ||
        at >= deadline ||
        options.transaction !== tx ||
        tx.query !== queryPort ||
        options.clock !== clockOwner ||
        clockOwner.now !== clockPort ||
        options.currentAuthorization !== authOwner ||
        authOwner.assertCurrent !== assertPort ||
        authOwner.leaseDeadline !== authLeasePort ||
        options.capability !== capOwner ||
        capOwner.holdUntilCommitWithDecisions !== combinedPort ||
        capOwner.leaseDeadline !== capLeasePort ||
        options.registerBeforeCommit !== registerPort ||
        options.tenantReference !== tenant ||
        options.brandReference !== brand ||
        options.storeReference !== store ||
        options.actorReference !== actor ||
        options.sessionReference !== session ||
        options.operationReference !== operation ||
        options.ruleReference !== rule ||
        options.expectedAggregateVersion !== expected ||
        options.publicationPolicyFamilyReference !== family ||
        options.originalObservedAt !== started ||
        options.originalValidUntil !== originalUntil
      )
        return fail();
      assertPort.call(authOwner);
      return deadline;
    },
  });
}
