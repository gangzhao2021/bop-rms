import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parseRecordedPublishingMutation,
  type CommitPublishingMutationInput,
} from "@bop/publishing";
import {
  createPostgresDigitalReceiptTemplateSubmissionStore,
  DigitalReceiptTemplateError,
  digitalReceiptTemplateSubmissionRequiredFields,
  parseDeviceInstant,
  parseDeviceReference,
  type DigitalReceiptTemplateSubmission,
  type DigitalReceiptTemplateSubmissionStoreOptions,
  type DigitalReceiptTemplateSubmissionTransaction,
} from "@rms/printing-device";

export interface MerchantReceiptTemplateEditingReviewPacket {
  readonly profile: "DigitalReceiptTemplateEditingReviewV1";
  readonly submission: DigitalReceiptTemplateSubmission | null;
  readonly mutation: CommitPublishingMutationInput | null;
  readonly observedAt: string;
  readonly validUntil: string;
}
type Transaction = DigitalReceiptTemplateSubmissionTransaction;
type Scope = Readonly<{
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  actorReference: string;
}>;
type Request = Readonly<{
  templateReference: string;
  familyReference: string;
  observedAt: string;
  validUntil: string;
}>;
export interface MerchantReceiptTemplateEditingReviewOptions extends Scope {
  readonly transaction: Transaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: DigitalReceiptTemplateSubmissionStoreOptions["registerBeforeCommit"];
  readonly references: DigitalReceiptTemplateSubmissionStoreOptions["references"];
  readonly holdCurrentOrgAuthority: (
    tx: Transaction,
    input: Readonly<Scope & Request>,
  ) => Promise<{ readonly validUntil: string }>;
}

/** Acquires actual immutable submission and current Publishing head in one retained host.
 * This read classifies recorded editing state; it supplies no approval or publication qualification. */
export function createMerchantReceiptTemplateEditingReview(
  options: MerchantReceiptTemplateEditingReviewOptions,
) {
  const tx = options.transaction,
    query = tx.query,
    clock = options.clock,
    now = clock.now,
    register = options.registerBeforeCommit,
    references = options.references,
    canonical = references.canonicalize,
    hash = references.hashIntent,
    hold = options.holdCurrentOrgAuthority;
  const scope = Object.freeze({
    tenantReference: parseDeviceReference(options.tenantReference),
    brandReference: parseDeviceReference(options.brandReference),
    storeReference: parseDeviceReference(options.storeReference),
    actorReference: parseDeviceReference(options.actorReference),
  });
  const origin = parseDeviceInstant(options.originalObservedAt),
    initial = parseDeviceInstant(options.originalValidUntil);
  let deadline = initial,
    last = origin,
    phase: "Ready" | "Reading" | "Held" | "Checking" | "Checked" | "Final" | "Poison" = "Ready",
    guardCount = 0,
    finalCount = 0,
    guardComplete = false;
  let request: Request | undefined,
    submission: DigitalReceiptTemplateSubmission | null = null,
    mutation: CommitPublishingMutationInput | null = null;
  let owner: ReturnType<typeof createPostgresDigitalReceiptTemplateSubmissionStore> | undefined;
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    phase = "Poison";
    throw new DigitalReceiptTemplateError(code);
  };
  if (
    [query, now, register, canonical, hash, hold].some((port) => typeof port !== "function") ||
    initial <= origin ||
    Date.parse(initial) - Date.parse(origin) > 5000
  )
    fail();
  const check = () => {
    if (
      phase === "Poison" ||
      options.transaction !== tx ||
      tx.query !== query ||
      options.clock !== clock ||
      clock.now !== now ||
      options.registerBeforeCommit !== register ||
      options.references !== references ||
      references.canonicalize !== canonical ||
      references.hashIntent !== hash ||
      options.holdCurrentOrgAuthority !== hold ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== initial ||
      options.tenantReference !== scope.tenantReference ||
      options.brandReference !== scope.brandReference ||
      options.storeReference !== scope.storeReference ||
      options.actorReference !== scope.actorReference
    )
      return fail();
    const observed = parseDeviceInstant(now.call(clock));
    if (observed < last || observed < origin || observed >= deadline) return fail();
    last = observed;
    return observed;
  };
  const tighten = (value: unknown) => {
    const r = readClosedRecord(value, ["validUntil"]),
      until = parseDeviceInstant(r.validUntil);
    if (until < deadline) deadline = until;
    check();
  };
  const fresh = async () => {
    if (!request) return fail();
    check();
    const result = await hold.call(
      options,
      tx,
      Object.freeze({ ...scope, ...request, observedAt: last, validUntil: deadline }),
    );
    tighten(result);
    check();
  };
  const publishing = createPostgresPublishingMutationStore(
    { run: <T>(work: (actual: Transaction) => Promise<T>) => work(tx) },
    scope.tenantReference,
    createPublishingScope({
      kind: "Store",
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    }),
  );
  const current = async (): Promise<CommitPublishingMutationInput | null> => {
    if (!submission) return null;
    if (!request) return fail();
    check();
    const raw = await publishing.resolveCurrentLifecycleMutation({
      familyReference: request.familyReference,
      lifecycleReference: submission.reviewLifecycleReference,
      configurationType: "RECEIPT_TEMPLATE",
      purposeCode: "RECEIPT_ISSUANCE",
      observedAt: last,
    });
    check();
    if (raw === null) return fail();
    const m = parseRecordedPublishingMutation(raw),
      n = m.next,
      v = m.validationEvidence;
    if (
      String(n.familyReference) !== request.familyReference ||
      String(n.lifecycleId) !== submission.reviewLifecycleReference ||
      n.version < submission.reviewVersion ||
      String(n.snapshotReference) !== submission.versionReference ||
      n.snapshotDigest !== submission.contentDigest ||
      String(n.validationEvidenceReference) !== submission.validationEvidenceReference ||
      String(n.changedAt) < submission.submittedAt ||
      n.scope.kind !== "Store" ||
      String(n.scope.brandReference) !== scope.brandReference ||
      String(n.scope.storeReference) !== scope.storeReference ||
      n.configurationType !== "RECEIPT_TEMPLATE" ||
      n.purposeCode !== "RECEIPT_ISSUANCE" ||
      (v !== null &&
        (String(v.evidenceReference) !== submission.validationEvidenceReference ||
          String(v.snapshotReference) !== submission.versionReference ||
          v.snapshotDigest !== submission.contentDigest ||
          String(v.checkedAt) !== submission.checkedAt ||
          String(v.validUntil) !== submission.validationValidUntil))
    )
      return fail();
    return m;
  };
  return Object.freeze({
    async read(
      actual: Transaction,
      input: Request,
    ): Promise<MerchantReceiptTemplateEditingReviewPacket> {
      try {
        if (actual !== tx || (phase !== "Ready" && phase !== "Held")) return fail();
        if (phase === "Held") {
          check();
          const repeated = readClosedRecord(input, [
            "templateReference",
            "familyReference",
            "observedAt",
            "validUntil",
          ]);
          if (
            !request ||
            repeated.templateReference !== request.templateReference ||
            repeated.familyReference !== request.familyReference ||
            typeof repeated.observedAt !== "string" ||
            parseDeviceInstant(repeated.observedAt) < origin ||
            parseDeviceInstant(repeated.observedAt) > last ||
            typeof repeated.validUntil !== "string"
          )
            return fail();
          const until = parseDeviceInstant(repeated.validUntil);
          if (until > initial || until <= origin) return fail();
          if (until < deadline) deadline = until;
          phase = "Reading";
          await fresh();
          const next = await current();
          if (canonicalizeRfc8785(next) !== canonicalizeRfc8785(mutation)) return fail();
          await fresh();
          phase = "Held";
          return Object.freeze({
            profile: "DigitalReceiptTemplateEditingReviewV1",
            submission,
            mutation,
            observedAt: origin,
            validUntil: deadline,
          });
        }
        phase = "Reading";
        check();
        const r = readClosedRecord(input, [
          "templateReference",
          "familyReference",
          "observedAt",
          "validUntil",
        ]);
        request = Object.freeze({
          templateReference: parseDeviceReference(r.templateReference),
          familyReference: parseDeviceReference(r.familyReference),
          observedAt: parseDeviceInstant(r.observedAt),
          validUntil: parseDeviceInstant(r.validUntil),
        });
        if (
          request.observedAt < origin ||
          request.observedAt > last ||
          request.validUntil > initial ||
          request.validUntil <= request.observedAt
        )
          return fail();
        if (request.validUntil < deadline) deadline = request.validUntil;
        await fresh();
        const result = await register.call(
          options,
          tx,
          async () => {
            try {
              if (phase !== "Held" || ++guardCount !== 1) return fail();
              phase = "Checking";
              await fresh();
              const next = await current();
              if (canonicalizeRfc8785(next) !== canonicalizeRfc8785(mutation)) return fail();
              await fresh();
              guardComplete = true;
              phase = "Checked";
            } catch (error) {
              phase = "Poison";
              throw error;
            }
          },
          () => {
            if (phase !== "Checked" || !guardComplete || guardCount !== 1 || ++finalCount !== 1)
              return fail();
            check();
            phase = "Final";
          },
        );
        if (result !== undefined) return fail();
        owner = createPostgresDigitalReceiptTemplateSubmissionStore({
          ...scope,
          transaction: tx,
          clock,
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: register,
          references,
          authority: {
            holdUntilTransactionCompletes: async (actualOwner, inputOwner) => {
              check();
              const p = readClosedRecord(inputOwner, [
                "tenantReference",
                "brandReference",
                "storeReference",
                "actorReference",
                "permission",
                "purposeCode",
                "mode",
                "requiredFields",
                "command",
                "templateReference",
                "versionReference",
                "observedAt",
                "validUntil",
              ]);
              if (
                actualOwner !== tx ||
                p.tenantReference !== scope.tenantReference ||
                p.brandReference !== scope.brandReference ||
                p.storeReference !== scope.storeReference ||
                p.actorReference !== scope.actorReference ||
                p.permission !== "organization.manage" ||
                p.purposeCode !== "RECEIPT_TEMPLATE_SUBMISSION" ||
                p.mode !== "ReadLatestSubmission" ||
                p.command !== null ||
                p.templateReference !== request?.templateReference ||
                p.versionReference !== null ||
                canonicalizeRfc8785(p.requiredFields) !==
                  canonicalizeRfc8785(digitalReceiptTemplateSubmissionRequiredFields) ||
                typeof p.observedAt !== "string" ||
                parseDeviceInstant(p.observedAt) < origin ||
                parseDeviceInstant(p.observedAt) > last ||
                typeof p.validUntil !== "string" ||
                parseDeviceInstant(p.validUntil) > initial
              )
                return fail();
              await fresh();
              return Object.freeze({ validUntil: deadline });
            },
          },
          readPublishingReview: async () => fail(),
        });
        submission = await owner.readLatestSubmission({
          templateReference: request.templateReference,
        });
        if (
          submission &&
          (submission.familyReference !== request.familyReference ||
            submission.tenantReference !== scope.tenantReference ||
            submission.brandReference !== scope.brandReference ||
            submission.storeReference !== scope.storeReference)
        )
          return fail();
        mutation = await current();
        await fresh();
        phase = "Held";
        return Object.freeze({
          profile: "DigitalReceiptTemplateEditingReviewV1",
          submission,
          mutation,
          observedAt: origin,
          validUntil: deadline,
        });
      } catch (error) {
        phase = "Poison";
        if (error instanceof DigitalReceiptTemplateError) throw error;
        return fail();
      }
    },
    assertFinalized(actual: Transaction) {
      if (
        actual !== tx ||
        phase !== "Final" ||
        guardCount !== 1 ||
        finalCount !== 1 ||
        !guardComplete ||
        !owner
      )
        return fail();
      const ownDeadline = owner.assertFinalized(tx);
      if (ownDeadline < deadline) deadline = ownDeadline;
      check();
      return deadline;
    },
  });
}
