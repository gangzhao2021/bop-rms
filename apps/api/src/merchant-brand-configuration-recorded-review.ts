import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  BrandConfigurationOperationError,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  parseCanonicalInstant,
  tenantBrandConfigurationContentDigest,
  type BrandConfigurationActorScope,
  type BrandConfigurationCurrent,
  type BrandConfigurationHistory,
  type BrandConfigurationRevision,
  type BrandConfigurationAuthoringTransaction,
} from "@bop/tenant";
import { createPostgresPublishingMutationStore, createPublishingScope } from "@bop/publishing";

export interface MerchantBrandConfigurationRecordedReview {
  readonly profile: "MerchantBrandConfigurationRecordedReviewV1";
  readonly configurationVersionReference: string;
  readonly configurationSourceDigest: string;
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly recordedState: "PendingApproval" | "Approved" | "Published";
  readonly validationEvidenceReference: string;
  readonly submittedByReference: string;
  readonly submittedAt: string;
  /** Original Publishing validation bound, never the current authorization lease. */
  readonly reviewValidUntil: string;
}
export interface MerchantBrandConfigurationCurrent extends BrandConfigurationCurrent {
  readonly recordedReview: MerchantBrandConfigurationRecordedReview | null;
}
const fail = (): never => {
  throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
};
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const currentKeys = [
  "profile",
  "tenantReference",
  "brandReference",
  "actorReference",
  "current",
  "observedAt",
  "validUntil",
  "currentPublication",
] as const;
const reviewKeys = [
  "profile",
  "configurationVersionReference",
  "configurationSourceDigest",
  "lifecycleReference",
  "lifecycleVersion",
  "recordedState",
  "validationEvidenceReference",
  "submittedByReference",
  "submittedAt",
  "reviewValidUntil",
] as const;
function currentPacket(value: unknown, scope: BrandConfigurationActorScope, now: string) {
  const result = parseBrandConfigurationCurrent(value),
    at = parseCanonicalInstant(now);
  if (
    result.tenantReference !== scope.tenantReference ||
    result.brandReference !== scope.brandReference ||
    result.actorReference !== scope.actorReference ||
    scope.tenantReference !== scope.brandReference ||
    result.observedAt > at ||
    result.validUntil <= at ||
    Date.parse(result.validUntil) - Date.parse(result.observedAt) > 5000
  )
    return fail();
  return result;
}
function reviewPacket(value: unknown, current: BrandConfigurationCurrent) {
  const revision = current.current;
  if (!revision || revision.configuration.lifecycle === "Draft") {
    if (value !== null) return fail();
    return null;
  }
  const r = readClosedRecord(value, reviewKeys),
    binding = revision.publishing;
  const submittedAt = parseCanonicalInstant(r.submittedAt),
    until = parseCanonicalInstant(r.reviewValidUntil);
  if (
    !binding ||
    binding.familyReference !== current.brandReference ||
    binding.mutationOperationReference !== revision.operationReference ||
    r.profile !== "MerchantBrandConfigurationRecordedReviewV1" ||
    r.configurationVersionReference !== revision.configuration.configurationVersionReference ||
    r.configurationSourceDigest !== revision.sourceDigest ||
    r.lifecycleReference !== binding.lifecycleReference ||
    r.lifecycleVersion !== binding.lifecycleVersion ||
    r.recordedState !== revision.configuration.lifecycle ||
    !["PendingApproval", "Approved", "Published"].includes(String(r.recordedState)) ||
    r.validationEvidenceReference !== binding.validationEvidenceReference ||
    r.submittedByReference !== revision.submittedByReference ||
    revision.submittedByReference === null ||
    submittedAt < revision.configuration.createdAt ||
    submittedAt > revision.recordedAt ||
    submittedAt > current.observedAt ||
    until <= submittedAt ||
    (revision.configuration.effectiveUntil !== null &&
      until > revision.configuration.effectiveUntil)
  )
    return fail();
  return Object.freeze({
    ...r,
    submittedAt,
    reviewValidUntil: until,
  }) as unknown as MerchantBrandConfigurationRecordedReview;
}
/** Separate the API extension before the immutable owning parser. The caller
 * supplies the authenticated scope and current response-observation clock. */
export function parseMerchantBrandConfigurationCurrent(
  value: unknown,
  scope: BrandConfigurationActorScope,
  observedAt: string,
): MerchantBrandConfigurationCurrent {
  try {
    const r = readClosedRecord(value, [...currentKeys, "recordedReview"]);
    const owner = Object.fromEntries(currentKeys.map((key) => [key, r[key]]));
    const current = currentPacket(owner, scope, observedAt);
    return Object.freeze({ ...current, recordedReview: reviewPacket(r.recordedReview, current) });
  } catch {
    return fail();
  }
}

/** Borrow the actual authorized outer transaction. Tenant retains current/history
 * fences; Publishing retains its own SHARE/operation fences. This is recorded
 * review metadata, not permission, current qualification or publication admission. */
export async function readMerchantBrandConfigurationRecordedReview(options: {
  readonly transaction: BrandConfigurationAuthoringTransaction;
  readonly scope: BrandConfigurationActorScope;
  readonly current: BrandConfigurationCurrent;
  readonly readHistory: (input: {
    readonly beforeRevision: number;
  }) => Promise<BrandConfigurationHistory>;
  readonly assertCurrent: () => void;
  readonly now: () => string;
}) {
  try {
    const tx = options.transaction,
      query = tx.query,
      assertPort = options.assertCurrent,
      nowPort = options.now,
      historyPort = options.readHistory,
      fixed = Object.freeze({ ...options.scope }),
      packet = options.current;
    const check = () => {
      if (
        options.transaction !== tx ||
        tx.query !== query ||
        options.assertCurrent !== assertPort ||
        options.now !== nowPort ||
        options.readHistory !== historyPort ||
        !same(options.scope, fixed) ||
        options.current !== packet
      )
        return fail();
      assertPort();
      return parseCanonicalInstant(nowPort());
    };
    const current = currentPacket(packet, fixed, check()),
      target = current.current;
    if (!target || target.configuration.lifecycle === "Draft") {
      return Object.freeze({
        recordedReview: null,
        async recheck() {
          check();
        },
      });
    }
    let submitted: BrandConfigurationRevision = target;
    if (target.command !== "SubmitConfiguration") {
      const page = parseBrandConfigurationHistory(
        await historyPort({ beforeRevision: target.revision }),
      );
      check();
      if (
        page.tenantReference !== fixed.tenantReference ||
        page.brandReference !== fixed.brandReference ||
        page.actorReference !== fixed.actorReference ||
        page.beforeRevision !== target.revision ||
        page.observedAt < current.observedAt ||
        page.observedAt > check() ||
        page.validUntil > current.validUntil ||
        page.validUntil <= check()
      )
        return fail();
      const distance = target.command === "ApproveConfiguration" ? 1 : 2;
      const candidate = page.entries[distance - 1];
      if (
        !candidate ||
        page.entries.length < distance ||
        candidate.revision !== target.revision - distance ||
        candidate.command !== "SubmitConfiguration" ||
        (distance === 2 &&
          (page.entries[0]?.command !== "ApproveConfiguration" ||
            page.entries[0].revision !== target.revision - 1))
      )
        return fail();
      for (const prior of page.entries.slice(0, distance)) {
        if (
          prior.configuration.configurationVersionReference !==
            target.configuration.configurationVersionReference ||
          tenantBrandConfigurationContentDigest(prior.configuration) !==
            tenantBrandConfigurationContentDigest(target.configuration) ||
          prior.publishing?.lifecycleReference !== target.publishing?.lifecycleReference ||
          prior.publishing?.validationEvidenceReference !==
            target.publishing?.validationEvidenceReference ||
          prior.publishing?.familyReference !== fixed.brandReference ||
          prior.publishing?.mutationOperationReference !== prior.operationReference ||
          prior.submittedByReference !== target.submittedByReference ||
          prior.recordedAt > target.recordedAt
        )
          return fail();
        if (
          prior.command === "ApproveConfiguration" &&
          (prior.publishing?.lifecycleVersion !== 3 ||
            prior.configuration.approvedByReference !== target.configuration.approvedByReference ||
            prior.configuration.approvalEvidenceReference !==
              target.configuration.approvalEvidenceReference ||
            prior.publishing.approvalEvidenceReference !==
              target.publishing?.approvalEvidenceReference)
        )
          return fail();
      }
      submitted = candidate;
    }
    const binding = target.publishing,
      reviewBinding = submitted.publishing;
    if (
      !binding ||
      !reviewBinding ||
      binding.mutationOperationReference !== target.operationReference ||
      reviewBinding.mutationOperationReference !== submitted.operationReference ||
      submitted.submittedByReference !== submitted.actorReference ||
      reviewBinding.familyReference !== fixed.brandReference ||
      binding.familyReference !== fixed.brandReference ||
      reviewBinding.lifecycleVersion !== 2 ||
      binding.lifecycleVersion !==
        ({ PendingApproval: 2, Approved: 3, Published: 4 } as const)[
          target.configuration.lifecycle as "PendingApproval" | "Approved" | "Published"
        ]
    )
      return fail();
    const scope = createPublishingScope({
      kind: "Brand",
      brandReference: fixed.brandReference,
      storeReference: null,
    });
    const owner = createPostgresPublishingMutationStore(
      { run: (work) => work(tx) },
      fixed.tenantReference,
      scope,
    );
    const targetRevision = target,
      targetBinding = binding,
      submitBinding = reviewBinding;
    async function read() {
      const common = {
        familyReference: fixed.brandReference,
        lifecycleReference: targetBinding.lifecycleReference,
        configurationType: "BRAND_CONFIGURATION",
        purposeCode: "BRAND_CONFIGURATION",
        observedAt: check(),
      };
      const head = await owner.resolveCurrentLifecycleMutation(common);
      check();
      const original = await owner.resolveOperation({
        ...common,
        operationReference: submitBinding.mutationOperationReference,
        observedAt: check(),
      });
      check();
      const validation = original?.validationEvidence,
        semantic = tenantBrandConfigurationContentDigest(targetRevision.configuration);
      const expectedOperation =
        targetRevision.command === "SubmitConfiguration"
          ? "SubmitReview"
          : targetRevision.command === "ApproveConfiguration"
            ? "Approve"
            : "Publish";
      const expectedState =
        targetRevision.command === "SubmitConfiguration"
          ? "InReview"
          : targetRevision.command === "ApproveConfiguration"
            ? "Approved"
            : "Published";
      if (
        !head ||
        !original ||
        !validation ||
        head.operation !== expectedOperation ||
        head.next.state !== expectedState ||
        head.idempotencyKey !== targetBinding.mutationOperationReference ||
        head.next.version !== targetBinding.lifecycleVersion ||
        String(head.next.snapshotReference) !==
          String(targetRevision.configuration.configurationVersionReference) ||
        head.next.snapshotDigest !== semantic ||
        head.next.validationEvidenceReference !== targetBinding.validationEvidenceReference ||
        head.next.approvalEvidenceReference !== targetBinding.approvalEvidenceReference ||
        head.next.changedAt !== targetRevision.recordedAt ||
        head.audit.actor.type !== "User" ||
        head.audit.actor.reference !== targetRevision.actorReference ||
        original.operation !== "SubmitReview" ||
        original.next.state !== "InReview" ||
        original.next.version !== 2 ||
        original.idempotencyKey !== submitBinding.mutationOperationReference ||
        String(original.next.snapshotReference) !==
          String(targetRevision.configuration.configurationVersionReference) ||
        original.next.snapshotDigest !== semantic ||
        original.next.validationEvidenceReference !== targetBinding.validationEvidenceReference ||
        original.next.changedAt !== submitted.recordedAt ||
        original.audit.occurredAt !== submitted.recordedAt ||
        original.audit.actor.type !== "User" ||
        original.audit.actor.reference !== submitted.submittedByReference ||
        validation.evidenceReference !== targetBinding.validationEvidenceReference ||
        validation.snapshotReference !== original.next.snapshotReference ||
        validation.snapshotDigest !== semantic ||
        !same(validation.scope, scope) ||
        validation.result !== "Pass" ||
        validation.checkedAt > submitted.recordedAt ||
        validation.validUntil <= submitted.recordedAt ||
        (head.release?.releaseId ?? null) !== targetBinding.publicationReference
      )
        return fail();
      if (head.operation === "SubmitReview") {
        if (!same(head, original)) return fail();
      } else {
        const approval = head.approvalEvidence;
        if (
          !approval ||
          approval.evidenceReference !== targetBinding.approvalEvidenceReference ||
          approval.reviewLifecycleId !== targetBinding.lifecycleReference ||
          approval.reviewVersion !== 2 ||
          String(approval.snapshotReference) !==
            String(targetRevision.configuration.configurationVersionReference) ||
          approval.snapshotDigest !== semantic ||
          !same(approval.scope, scope) ||
          approval.decision !== "Accepted" ||
          targetRevision.configuration.approvedByReference === null ||
          String(approval.approvedActorReference) !==
            String(targetRevision.configuration.approvedByReference) ||
          approval.approvedActorReference === submitted.submittedByReference ||
          String(approval.approvedActorReference) ===
            String(targetRevision.configuration.authoredByReference) ||
          approval.approvedAt < submitted.recordedAt ||
          approval.approvedAt > targetRevision.recordedAt ||
          approval.validUntil <= approval.approvedAt ||
          approval.validUntil > validation.validUntil ||
          (head.operation === "Approve" && !same(head.current, original.next)) ||
          (head.operation === "Publish" &&
            (!same(head.validationEvidence, validation) ||
              validation.validUntil <= targetRevision.recordedAt ||
              approval.validUntil <= targetRevision.recordedAt))
        )
          return fail();
      }
      return reviewPacket(
        {
          profile: "MerchantBrandConfigurationRecordedReviewV1",
          configurationVersionReference: targetRevision.configuration.configurationVersionReference,
          configurationSourceDigest: targetRevision.sourceDigest,
          lifecycleReference: targetBinding.lifecycleReference,
          lifecycleVersion: targetBinding.lifecycleVersion,
          recordedState: targetRevision.configuration.lifecycle,
          validationEvidenceReference: targetBinding.validationEvidenceReference,
          submittedByReference: submitted.submittedByReference,
          submittedAt: submitted.recordedAt,
          reviewValidUntil: validation.validUntil,
        },
        current,
      );
    }
    const recordedReview = await read();
    return Object.freeze({
      recordedReview,
      async recheck() {
        if (!same(recordedReview, await read())) return fail();
        check();
      },
    });
  } catch {
    return fail();
  }
}
