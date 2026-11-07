import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { createPostgresPublishingMutationStore, createPublishingScope } from "@bop/publishing";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  createCatalogOptionSetContentReviewBinding,
  optionContentReviewValidationCodes,
} from "@rms/catalog";
import { createCurrentOptionSetDraftPolicySource } from "./current-option-set-draft-policy.js";
type Options = Parameters<typeof createCurrentOptionSetDraftPolicySource>[0];
type Tx = Parameters<
  ReturnType<typeof createCurrentOptionSetDraftPolicySource>["withCurrentAssessment"]
>[0];
type ReviewBinding = ReturnType<typeof createCatalogOptionSetContentReviewBinding>;
type Approval = Awaited<
  ReturnType<
    ReturnType<typeof createPostgresPublishingMutationStore>["resolveCurrentIndependentApproval"]
  >
>;
export type CurrentOptionSetDraftReview = Readonly<{
  profile: "CurrentOptionSetDraftReviewV1";
  reviewBinding: ReviewBinding;
  recordedApproval: Approval | null;
  limitedDecision: string;
  originalObservedAt: string;
  validUntil: string;
  digest: string;
  publishValidation: "Incomplete";
  currentValidation: "NotEvaluated";
  referenceEligibility: "NotEvaluated";
  eligibility: "NotEvaluated";
}>;
export const currentOptionSetApprovalFields = Object.freeze([
  "optionSetReference",
  "versionReference",
  "contentDigest",
  "configurationDigest",
  "policy",
  "review",
  "approval",
  "validation",
  "scopeSet",
  "effectivePeriod",
] as const);
export interface CurrentOptionSetApprovalAuthority {
  holdUntilTransactionCompletes(
    tx: Tx,
    input: Readonly<{
      tenantReference: string;
      brandReference: string;
      actorReference: string;
      actorKind: "User";
      permission: "catalog.manage";
      action: "catalog.option_set.publish";
      purposeCode: "CATALOG_OPTION_SET_PUBLICATION";
      requiredFields: typeof currentOptionSetApprovalFields;
      reviewBinding: ReviewBinding;
      reviewLifecycleReference: string;
      observedAt: string;
    }>,
  ): Promise<Readonly<{ observedAt: string; validUntil: string }>>;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Current actual Draft/policy plus exact recorded content-review independence.
 * Full reference/topology/current validation and publication admission remain separate. */
export function createCurrentOptionSetDraftApprovalSource(
  options: Options & { approvalAuthority: CurrentOptionSetApprovalAuthority },
) {
  const source = createCurrentOptionSetDraftPolicySource(options),
    tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  if (typeof options.approvalAuthority?.holdUntilTransactionCompletes !== "function") return fail();
  const now = options.clock.now.bind(options.clock),
    hold = options.approvalAuthority.holdUntilTransactionCompletes.bind(options.approvalAuthority),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  async function execute<T>(
    tx: Tx,
    value: unknown,
    consume: boolean,
    work: (v: CurrentOptionSetDraftReview) => Promise<T>,
  ): Promise<T> {
    let entered = false;
    try {
      if (
        !tx ||
        typeof tx !== "object" ||
        typeof tx.query !== "function" ||
        typeof work !== "function" ||
        active.has(tx) ||
        failed.has(tx)
      )
        return fail();
      active.add(tx);
      entered = true;
      const envelope = consume
          ? readClosedRecord(copyCategoryPersistenceValue(value), [
              "assessmentRequest",
              "reviewLifecycleReference",
              "expectedReviewBindingDigest",
            ])
          : null,
        request = readClosedRecord(
          copyCategoryPersistenceValue(envelope ? envelope.assessmentRequest : value),
          ["graphRequest", "policyRequest", "originalIntentDigest", "activationAt"],
        ),
        root = readClosedRecord(request.graphRequest, [
          "optionSetReference",
          "versionReference",
          "expectedAggregateVersion",
          "sourceDigest",
          "contentDigest",
          "configurationDigest",
          "observedAt",
          "validUntil",
        ]),
        originalObservedAt = parseCatalogInstant(root.observedAt),
        query = tx.query,
        sql = Object.freeze({ query: query.bind(tx) }),
        lifecycle = envelope ? parseCatalogReference(envelope.reviewLifecycleReference) : null;
      let until = parseCatalogInstant(root.validUntil),
        latest = originalObservedAt,
        calls = 0,
        complete = false,
        answer: T | undefined;
      if (until <= originalObservedAt || Date.parse(until) - Date.parse(originalObservedAt) > 30000)
        return fail();
      if (
        envelope &&
        (typeof envelope.expectedReviewBindingDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(envelope.expectedReviewBindingDigest))
      )
        return fail();
      const check = () => {
        const at = parseCatalogInstant(now());
        if (failed.has(tx) || tx.query !== query || at < latest || at >= until) return fail();
        latest = at;
        return at;
      };
      check();
      const result = await source.withCurrentAssessment(tx, request, async (supplied) => {
        if (
          ++calls !== 1 ||
          supplied.originalObservedAt !== originalObservedAt ||
          supplied.publishValidation !== "Incomplete" ||
          supplied.eligibility !== "NotEvaluated"
        )
          return fail();
        until = supplied.validUntil < until ? parseCatalogInstant(supplied.validUntil) : until;
        check();
        const a = supplied.assessment,
          r = supplied.currentRootEvidence,
          binding = createCatalogOptionSetContentReviewBinding({
            tenantReference: tenant,
            brandReference: brand,
            optionSetReference: r.optionSetReference,
            versionReference: r.versionReference,
            expectedAggregateVersion: r.aggregateVersion,
            sourceDigest: r.sourceDigest,
            contentDigest: r.contentDigest,
            configurationDigest: r.configurationDigest,
            graphDigest: r.graphDigest,
            policyReference: a.policyReference,
            policyVersion: a.policyVersion,
            policyContentDigest: a.policyContentDigest,
            currentPolicyPublicationReference: a.currentPolicyPublicationReference,
            originalIntentDigest: request.originalIntentDigest,
            activationAt: request.activationAt,
          });
        if (
          a.originalIntentDigest !== binding.originalIntentDigest ||
          a.graphDigest !== binding.graphDigest ||
          a.optionSetReference !== binding.optionSetReference ||
          a.versionReference !== binding.versionReference
        )
          return fail();
        let approval: Approval | null = null;
        if (lifecycle && envelope) {
          if (
            a.decision !== "PassForAssessedRules" ||
            binding.digest !== envelope.expectedReviewBindingDigest
          )
            return fail();
          const authorize = async () => {
            const at = check(),
              lease = readClosedRecord(
                copyCategoryPersistenceValue(
                  await hold(
                    tx,
                    Object.freeze({
                      tenantReference: tenant,
                      brandReference: brand,
                      actorReference: actor,
                      actorKind: "User" as const,
                      permission: "catalog.manage" as const,
                      action: "catalog.option_set.publish" as const,
                      purposeCode: "CATALOG_OPTION_SET_PUBLICATION" as const,
                      requiredFields: currentOptionSetApprovalFields,
                      reviewBinding: binding,
                      reviewLifecycleReference: lifecycle,
                      observedAt: at,
                    }),
                  ),
                ),
                ["observedAt", "validUntil"],
              ),
              end = parseCatalogInstant(lease.validUntil);
            if (lease.observedAt !== at || end <= at || Date.parse(end) - Date.parse(at) > 30000)
              return fail();
            until = end < until ? end : until;
            check();
          };
          const owner = createPostgresPublishingMutationStore(
              { run: (callback) => callback(sql) },
              tenant,
              createPublishingScope({ kind: "Brand", brandReference: brand, storeReference: null }),
            ),
            read = owner.resolveCurrentIndependentApproval.bind(owner),
            observe = async () => {
              const at = check(),
                p = await read({
                  familyReference: binding.optionSetReference,
                  lifecycleReference: lifecycle,
                  configurationType: "CATALOG_OPTION_SET",
                  purposeCode: "CATALOG_OPTION_SET_PUBLICATION",
                  snapshotReference: binding.versionReference,
                  snapshotDigest: binding.digest,
                  requiredCheckCodes: optionContentReviewValidationCodes,
                  observedAt: at,
                });
              if (
                p.profile !== "CurrentIndependentPublishingApprovalV1" ||
                String(p.tenantReference) !== tenant ||
                p.scope.kind !== "Brand" ||
                String(p.scope.brandReference) !== brand ||
                p.scope.storeReference !== null ||
                p.configurationType !== "CATALOG_OPTION_SET" ||
                p.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
                canonicalizeRfc8785(p.validationCheckCodes) !==
                  canonicalizeRfc8785(optionContentReviewValidationCodes) ||
                p.snapshotDigest !== binding.digest ||
                String(p.snapshotReference) !== binding.versionReference ||
                String(p.familyReference) !== binding.optionSetReference ||
                String(p.lifecycleReference) !== lifecycle ||
                p.recordedIndependence !== "Verified" ||
                p.currentValidation !== "NotEvaluated" ||
                p.referenceEligibility !== "NotEvaluated" ||
                p.eligibility !== "NotEvaluated" ||
                String(p.observedAt) !== at
              )
                return fail();
              const end = parseCatalogInstant(p.validUntil);
              if (end <= at) return fail();
              until = end < until ? end : until;
              check();
              return p;
            };
          await authorize();
          approval = await observe();
          const first = approval,
            deliveredUntil = until;
          const identity = (p: Approval) =>
            canonicalizeRfc8785({
              sourceDigest: p.sourceDigest,
              approvalOperationReference: p.approvalOperationReference,
              approvalEvidenceReference: p.approvalEvidenceReference,
              snapshotDigest: p.snapshotDigest,
              validUntil: p.validUntil,
            });
          const evidence = {
            profile: "CurrentOptionSetDraftReviewV1" as const,
            reviewBinding: binding,
            recordedApproval: approval,
            limitedDecision: a.decision,
            originalObservedAt,
            validUntil: until,
            publishValidation: "Incomplete" as const,
            currentValidation: "NotEvaluated" as const,
            referenceEligibility: "NotEvaluated" as const,
            eligibility: "NotEvaluated" as const,
          };
          answer = await work(
            Object.freeze({
              ...evidence,
              digest: "sha256:" + sha256Hex(canonicalizeRfc8785(evidence)),
            }),
          );
          check();
          await authorize();
          const last = await observe();
          if (identity(last) !== identity(first)) return fail();
          await authorize();
          if (until !== deliveredUntil) return fail();
          check();
        } else {
          const evidence = {
            profile: "CurrentOptionSetDraftReviewV1" as const,
            reviewBinding: binding,
            recordedApproval: approval,
            limitedDecision: a.decision,
            originalObservedAt,
            validUntil: until,
            publishValidation: "Incomplete" as const,
            currentValidation: "NotEvaluated" as const,
            referenceEligibility: "NotEvaluated" as const,
            eligibility: "NotEvaluated" as const,
          };
          answer = await work(
            Object.freeze({
              ...evidence,
              digest: "sha256:" + sha256Hex(canonicalizeRfc8785(evidence)),
            }),
          );
          check();
        }
        complete = true;
        return answer;
      });
      if (calls !== 1 || !complete || !Object.is(result, answer)) return fail();
      check();
      return result as T;
    } catch {
      if (tx && typeof tx === "object") failed.add(tx);
      return fail();
    } finally {
      if (entered) active.delete(tx);
    }
  }
  return Object.freeze({
    withCurrentReviewBinding: <T>(
      tx: Tx,
      value: unknown,
      work: (v: CurrentOptionSetDraftReview) => Promise<T>,
    ) => execute(tx, value, false, work),
    withCurrentApproval: <T>(
      tx: Tx,
      value: unknown,
      work: (v: CurrentOptionSetDraftReview) => Promise<T>,
    ) => execute(tx, value, true, work),
  });
}
