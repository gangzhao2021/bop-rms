import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parseRecordedPublishingMutation,
  type CommitPublishingMutationInput,
  type PublishingTransaction,
} from "@bop/publishing";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  DigitalReceiptTemplateError,
  parseDeviceReference,
  parseDeviceInstant,
  type DigitalReceiptTemplateDraftActorScope,
} from "@rms/printing-device";

export interface ReceiptTemplateReviewRequest {
  readonly familyReference: string;
  readonly reviewLifecycleReference: string;
  readonly operationReference: string;
  readonly snapshotReference: string;
  readonly snapshotDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
/** Actual public Publishing head reader. The ordinary Submit service must supply
 * current real IAM authority and the same held transaction; no caller evidence
 * packet is accepted and no business-validity duration is invented here. */
export function createMerchantReceiptTemplateReviewSource(options: {
  readonly scope: DigitalReceiptTemplateDraftActorScope;
  readonly transaction: PublishingTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly holdCurrentAuthority: (
    tx: PublishingTransaction,
    input: Readonly<
      DigitalReceiptTemplateDraftActorScope &
        ReceiptTemplateReviewRequest & {
          permission: "publishing.review.submit";
          purposeCode: "RECEIPT_TEMPLATE_SUBMISSION";
        }
    >,
  ) => Promise<Readonly<{ validUntil: string }>>;
}) {
  const fail = (): never => {
    throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
  };
  const scopeOwner = options.scope,
    transaction = options.transaction,
    query = transaction.query,
    clockOwner = options.clock,
    clock = clockOwner.now,
    hold = options.holdCurrentAuthority;
  const rawScope = readClosedRecord(scopeOwner, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
  ]);
  const scope = Object.freeze({
    tenantReference: parseDeviceReference(rawScope.tenantReference),
    brandReference: parseDeviceReference(rawScope.brandReference),
    storeReference: parseDeviceReference(rawScope.storeReference),
    actorReference: parseDeviceReference(rawScope.actorReference),
  });
  const origin = parseDeviceInstant(options.originalObservedAt),
    originalUntil = parseDeviceInstant(options.originalValidUntil);
  let latest = origin,
    deadline = originalUntil,
    active = false;
  if (
    deadline <= origin ||
    Date.parse(deadline) - Date.parse(origin) > 5000 ||
    [query, clock, hold].some((p) => typeof p !== "function")
  )
    fail();
  const capture = () => {
    if (
      options.scope !== scopeOwner ||
      options.transaction !== transaction ||
      transaction.query !== query ||
      options.clock !== clockOwner ||
      clockOwner.now !== clock ||
      options.holdCurrentAuthority !== hold ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil ||
      Object.entries(scope).some(
        ([key, value]) => Object.getOwnPropertyDescriptor(scopeOwner, key)?.value !== value,
      )
    )
      fail();
  };
  const check = () => {
    capture();
    const now = parseDeviceInstant(clock.call(clockOwner));
    if (now < latest || now >= deadline) fail();
    latest = now;
    return now;
  };
  const owner = createPostgresPublishingMutationStore(
    {
      run: async (work) => {
        check();
        const result = await work(transaction);
        check();
        return result;
      },
    },
    scope.tenantReference,
    createPublishingScope({
      kind: "Store",
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    }),
  );
  return async function readPublishingReview(
    actual: PublishingTransaction,
    value: ReceiptTemplateReviewRequest,
  ): Promise<CommitPublishingMutationInput | null> {
    if (actual !== transaction || active) return fail();
    active = true;
    try {
      const r = readClosedRecord(value, [
        "familyReference",
        "reviewLifecycleReference",
        "operationReference",
        "snapshotReference",
        "snapshotDigest",
        "observedAt",
        "validUntil",
      ]);
      const request = Object.freeze({
        familyReference: parseDeviceReference(r.familyReference),
        reviewLifecycleReference: parseDeviceReference(r.reviewLifecycleReference),
        operationReference: parseDeviceReference(r.operationReference),
        snapshotReference: parseDeviceReference(r.snapshotReference),
        snapshotDigest: r.snapshotDigest,
        observedAt: parseDeviceInstant(r.observedAt),
        validUntil: parseDeviceInstant(r.validUntil),
      });
      if (
        typeof request.snapshotDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(request.snapshotDigest) ||
        request.observedAt < origin ||
        request.observedAt > check() ||
        request.validUntil > deadline ||
        request.validUntil <= latest
      )
        return fail();
      const digest = request.snapshotDigest;
      const fresh = async () => {
        check();
        const held = readClosedRecord(
          await hold.call(
            options,
            transaction,
            Object.freeze({
              ...scope,
              ...request,
              snapshotDigest: digest,
              permission: "publishing.review.submit",
              purposeCode: "RECEIPT_TEMPLATE_SUBMISSION",
            }),
          ),
          ["validUntil"],
        );
        const until = parseDeviceInstant(held.validUntil);
        if (until > request.validUntil) return fail();
        if (until < deadline) deadline = until;
        check();
      };
      await fresh();
      const found = await owner.resolveCurrentLifecycleMutation({
        familyReference: request.familyReference,
        lifecycleReference: request.reviewLifecycleReference,
        configurationType: "RECEIPT_TEMPLATE",
        purposeCode: "RECEIPT_ISSUANCE",
        observedAt: check(),
      });
      await fresh();
      if (found === null) return null;
      const mutation = parseRecordedPublishingMutation(found),
        next = mutation.next,
        validation = mutation.validationEvidence;
      if (
        mutation.operation !== "SubmitReview" ||
        String(mutation.idempotencyKey) !== request.operationReference ||
        next.state !== "InReview" ||
        String(next.familyReference) !== request.familyReference ||
        String(next.lifecycleId) !== request.reviewLifecycleReference ||
        String(next.snapshotReference) !== request.snapshotReference ||
        next.snapshotDigest !== digest ||
        next.configurationType !== "RECEIPT_TEMPLATE" ||
        next.purposeCode !== "RECEIPT_ISSUANCE" ||
        next.scope.kind !== "Store" ||
        String(next.scope.brandReference) !== scope.brandReference ||
        String(next.scope.storeReference) !== scope.storeReference ||
        mutation.audit.actor.type !== "User" ||
        mutation.audit.actor.reference !== scope.actorReference ||
        !validation ||
        validation.result !== "Pass" ||
        validation.evidenceReference !== next.validationEvidenceReference ||
        validation.snapshotReference !== next.snapshotReference ||
        validation.snapshotDigest !== next.snapshotDigest ||
        validation.scope.kind !== "Store" ||
        String(validation.scope.brandReference) !== scope.brandReference ||
        String(validation.scope.storeReference) !== scope.storeReference ||
        validation.checkedAt > mutation.audit.occurredAt ||
        validation.validUntil <= check() ||
        mutation.audit.occurredAt !== next.changedAt
      )
        return fail();
      capture();
      // The public source already validates original history and its canonical
      // digest. Canonicalization also rejects any malformed detached result.
      canonicalizeRfc8785(mutation);
      return mutation;
    } catch (error) {
      if (error instanceof DigitalReceiptTemplateError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
}
