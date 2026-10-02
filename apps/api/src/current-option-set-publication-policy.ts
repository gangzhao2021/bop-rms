import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  createPublishingReleaseRecord,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingOptionSetPublicationPolicy,
  publishingOptionSetPublicationPolicyDigest,
  optionSetPolicyConfigurationType,
  type PublishingTransaction,
  type PublishingOptionSetPublicationPolicy,
} from "@bop/publishing";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
} from "@rms/catalog";

export const currentOptionSetPolicyFields = Object.freeze([
  "optionSetPublicationPolicy",
  "scopeOrder",
  "approvalPolicy",
  "warningOverrideAllowed",
  "requiredLocales",
  "mediaRequirement",
  "effectivePeriod",
] as const);

export interface CurrentOptionSetPolicyAuthority {
  holdUntilTransactionCompletes(
    tx: PublishingTransaction,
    input: Readonly<{
      tenantReference: string;
      brandReference: string;
      actorReference: string;
      actorKind: "User" | "System";
      permission: "catalog.manage";
      action: "catalog.option_set.publish";
      purposeCode: "CATALOG_OPTION_SET_PUBLICATION";
      optionSetReference: string;
      policyReference: string;
      policyVersion: number;
      requiredFields: typeof currentOptionSetPolicyFields;
      observedAt: string;
    }>,
  ): Promise<Readonly<{ observedAt: string; validUntil: string }>>;
}

export interface CurrentOptionSetPublicationPolicy {
  readonly profile: "CurrentOptionSetPublicationPolicyV1";
  readonly content: PublishingOptionSetPublicationPolicy;
  readonly currentPublicationReference: string;
  readonly optionSetReference: string;
  readonly originalObservedAt: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly publishValidation: "Incomplete";
  readonly eligibility: "NotEvaluated";
}

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};

/** Current owning policy only. Caller must retain its transaction, current field
 * authority and every other Option publication prerequisite through COMMIT. */
export function createCurrentOptionSetPublicationPolicySource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly authority: CurrentOptionSetPolicyAuthority;
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference),
    actorKind = options.actorKind;
  if (
    !["User", "System"].includes(actorKind) ||
    typeof options.clock?.now !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    failed = new WeakSet<object>(),
    active = new WeakSet<object>();
  return Object.freeze({
    context: Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      actorKind,
    }),
    async withCurrentPolicy<T>(
      tx: PublishingTransaction,
      value: unknown,
      work: (source: CurrentOptionSetPublicationPolicy) => Promise<T>,
    ): Promise<T> {
      let entered = false;
      try {
        if (
          !tx ||
          typeof tx !== "object" ||
          typeof tx.query !== "function" ||
          typeof work !== "function" ||
          failed.has(tx) ||
          active.has(tx)
        )
          return fail();
        active.add(tx);
        entered = true;
        const query = tx.query,
          sql = Object.freeze({ query: query.bind(tx) }),
          input = readClosedRecord(copyCategoryPersistenceValue(value), [
            "optionSetReference",
            "policyReference",
            "policyVersion",
            "observedAt",
          ]),
          optionSetReference = parseCatalogReference(input.optionSetReference),
          policyReference = parseCatalogReference(input.policyReference),
          policyVersion = input.policyVersion,
          observedAt = parseCatalogInstant(input.observedAt);
        if (
          typeof policyVersion !== "number" ||
          !Number.isSafeInteger(policyVersion) ||
          policyVersion < 1 ||
          policyVersion > 2147483647
        )
          return fail();
        let deadline = Date.parse(observedAt) + 30000,
          latest = observedAt;
        const check = () => {
          const at = parseCatalogInstant(now());
          if (failed.has(tx) || tx.query !== query || at < latest || Date.parse(at) >= deadline)
            return fail();
          latest = at;
          return at;
        };
        const authorize = async () => {
          const at = check();
          const lease = readClosedRecord(
              copyCategoryPersistenceValue(
                await hold(
                  tx,
                  Object.freeze({
                    tenantReference: tenant,
                    brandReference: brand,
                    actorReference: actor,
                    actorKind,
                    permission: "catalog.manage" as const,
                    action: "catalog.option_set.publish" as const,
                    purposeCode: "CATALOG_OPTION_SET_PUBLICATION" as const,
                    optionSetReference,
                    policyReference,
                    policyVersion,
                    requiredFields: currentOptionSetPolicyFields,
                    observedAt: at,
                  }),
                ),
              ),
              ["observedAt", "validUntil"],
            ),
            start = parseCatalogInstant(lease.observedAt),
            until = parseCatalogInstant(lease.validUntil);
          if (start !== at || until <= at || Date.parse(until) - Date.parse(at) > 30000)
            return fail();
          deadline = Math.min(deadline, Date.parse(until));
          check();
        };
        await authorize();
        const owner = createPostgresPublishingMutationStore(
            { run: (callback) => callback(sql) },
            tenant,
            createPublishingScope({ kind: "Brand", brandReference: brand, storeReference: null }),
          ),
          read = owner.resolveCurrentOptionSetPublicationPolicy.bind(owner);
        const observe = async () => {
          const at = check(),
            result = readClosedRecord(
              copyCategoryPersistenceValue(
                await read({ policyReference, policyVersion, observedAt: at }),
              ),
              ["content", "current", "observedAt"],
            ),
            content = parsePublishingOptionSetPublicationPolicy(result.content),
            current = readClosedRecord(result.current, [
              "release",
              "lifecycle",
              "validationEvidence",
              "approvalEvidence",
              "auditReference",
              "observedAt",
            ]),
            release = createPublishingReleaseRecord(
              current.release as Parameters<typeof createPublishingReleaseRecord>[0],
            ),
            lifecycle = createPublishingLifecycleRecord(
              current.lifecycle as Parameters<typeof createPublishingLifecycleRecord>[0],
            ),
            validation = createPublishingValidationEvidence(
              current.validationEvidence as Parameters<
                typeof createPublishingValidationEvidence
              >[0],
            ),
            approval = createPublishingApprovalEvidence(
              current.approvalEvidence as Parameters<typeof createPublishingApprovalEvidence>[0],
            ),
            auditReference = parseCatalogReference(current.auditReference),
            fingerprint = publishingOptionSetPublicationPolicyDigest(content);
          if (
            result.observedAt !== at ||
            current.observedAt !== at ||
            String(content.tenantReference) !== tenant ||
            String(content.brandReference) !== brand ||
            String(content.policyReference) !== policyReference ||
            content.policyVersion !== policyVersion ||
            Date.parse(content.effectiveFrom) > Date.parse(at) ||
            (content.effectiveUntil !== null &&
              Date.parse(content.effectiveUntil) <= Date.parse(at)) ||
            release.familyReference !== content.familyReference ||
            String(release.snapshotReference) !== policyReference ||
            release.snapshotDigest !== fingerprint ||
            release.configurationType !== optionSetPolicyConfigurationType ||
            release.purposeCode !== optionSetPolicyConfigurationType ||
            release.scope.kind !== "Brand" ||
            String(release.scope.brandReference) !== brand ||
            Date.parse(release.createdAt) > Date.parse(at) ||
            lifecycle.state !== "Published" ||
            lifecycle.lifecycleId !== release.sourceLifecycleId ||
            lifecycle.familyReference !== release.familyReference ||
            lifecycle.configurationType !== release.configurationType ||
            lifecycle.purposeCode !== release.purposeCode ||
            String(lifecycle.snapshotReference) !== policyReference ||
            lifecycle.snapshotDigest !== fingerprint ||
            lifecycle.scope.kind !== "Brand" ||
            String(lifecycle.scope.brandReference) !== brand ||
            Date.parse(lifecycle.changedAt) > Date.parse(at) ||
            validation.checkedAt > release.createdAt ||
            approval.approvedAt > release.createdAt ||
            validation.evidenceReference !== lifecycle.validationEvidenceReference ||
            approval.evidenceReference !== lifecycle.approvalEvidenceReference ||
            approval.reviewLifecycleId !== lifecycle.lifecycleId ||
            approval.reviewVersion + 2 !== lifecycle.version ||
            [validation, approval].some(
              (e) =>
                String(e.snapshotReference) !== policyReference ||
                e.snapshotDigest !== fingerprint ||
                e.scope.kind !== "Brand" ||
                String(e.scope.brandReference) !== brand ||
                e.validUntil <= release.createdAt,
            )
          )
            return fail();
          if (content.effectiveUntil !== null)
            deadline = Math.min(deadline, Date.parse(content.effectiveUntil));
          check();
          return Object.freeze({
            content,
            observedAt: at,
            publication: release.releaseId,
            identity: canonicalizeRfc8785({
              content,
              release,
              lifecycle,
              validation,
              approval,
              auditReference,
            }),
          });
        };
        const initial = await observe();
        const deliveredUntil = deadline;
        const result = await work(
          Object.freeze({
            profile: "CurrentOptionSetPublicationPolicyV1" as const,
            content: initial.content,
            currentPublicationReference: initial.publication,
            optionSetReference,
            originalObservedAt: observedAt,
            observedAt: initial.observedAt,
            validUntil: new Date(deliveredUntil).toISOString(),
            publishValidation: "Incomplete" as const,
            eligibility: "NotEvaluated" as const,
          }),
        );
        check();
        await authorize();
        const final = await observe();
        if (final.identity !== initial.identity || deadline < deliveredUntil) return fail();
        check();
        return result;
      } catch {
        if (tx && typeof tx === "object") failed.add(tx);
        return fail();
      } finally {
        if (entered) active.delete(tx);
      }
    },
  });
}
