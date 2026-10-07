import { parseDeviceReference, parseDeviceInstant } from "../../contracts/device-management.js";
import { DigitalReceiptTemplateError } from "../../contracts/digital-receipt-template.js";
import type { DigitalReceiptTemplateDraftActorScope } from "../../contracts/digital-receipt-template-draft.js";
import {
  parseDigitalReceiptTemplateSubmission,
  type DigitalReceiptTemplateSubmission,
} from "../../contracts/digital-receipt-template-submission.js";
import {
  parseRecordedPublishingMutation,
  createPublishingApprovalEvidence,
  evaluatePublishingTransition,
  type CommitPublishingMutationInput,
  type PublishingApprovalEvidence,
} from "@bop/publishing";
import {
  parseDigitalReceiptTemplateVersion,
  type DigitalReceiptTemplateVersion,
} from "../../contracts/digital-receipt-template.js";
import {
  parseDigitalReceiptTemplateLifecycleAction,
  parseDigitalReceiptTemplateLifecycleResolve,
  parseDigitalReceiptTemplateLifecycleReceipt,
  digitalReceiptTemplateLifecycleActionRequiredFields,
  type DigitalReceiptTemplateLifecycleAction,
  type DigitalReceiptTemplateLifecycleResolve,
  type DigitalReceiptTemplateLifecycleReceipt,
  type DigitalReceiptTemplateLifecycleResult,
} from "../../contracts/digital-receipt-template-lifecycle-action.js";
export interface DigitalReceiptTemplateLifecycleActualPacket {
  readonly mutation: CommitPublishingMutationInput;
  readonly approval: PublishingApprovalEvidence;
  readonly publishedVersion: DigitalReceiptTemplateVersion | null;
  readonly publicationDigest: string | null;
}
export interface DigitalReceiptTemplateLifecycleTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface DigitalReceiptTemplateLifecycleStoreOptions extends DigitalReceiptTemplateDraftActorScope {
  readonly transaction: DigitalReceiptTemplateLifecycleTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly references: { canonicalize(value: unknown): string; hashIntent(value: string): string };
  readonly registerBeforeCommit: (
    tx: DigitalReceiptTemplateLifecycleTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: DigitalReceiptTemplateLifecycleTransaction,
      input: Readonly<
        DigitalReceiptTemplateDraftActorScope & {
          permission: "publishing.review.approve" | "publishing.release.publish";
          purposeCode: "RECEIPT_TEMPLATE_REVIEW";
          mode: "Execute" | "ResolveOriginal";
          requiredFields: typeof digitalReceiptTemplateLifecycleActionRequiredFields;
          command: DigitalReceiptTemplateLifecycleAction | DigitalReceiptTemplateLifecycleResolve;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<Readonly<{ validUntil: string }>>;
  };
  /** Actual Core mutation, approval history and owning publication append in this same host. */
  readonly performAction: (
    tx: DigitalReceiptTemplateLifecycleTransaction,
    command: DigitalReceiptTemplateLifecycleAction,
  ) => Promise<DigitalReceiptTemplateLifecycleActualPacket>;
  readonly readActualAction: (
    tx: DigitalReceiptTemplateLifecycleTransaction,
    command: DigitalReceiptTemplateLifecycleAction,
  ) => Promise<DigitalReceiptTemplateLifecycleActualPacket>;
  readonly appendAbandonedIntent: (
    tx: DigitalReceiptTemplateLifecycleTransaction,
    input: Readonly<{
      command: DigitalReceiptTemplateLifecycleResolve;
      intentDigest: string;
      occurredAt: string;
    }>,
  ) => Promise<Readonly<{ auditReference: string; occurredAt: string }>>;
}
const columns = `operation_id,tenant_id,brand_id,store_id,actor_id,action,template_id,expected_version_id,expected_revision::text expected_revision,review_lifecycle_id,expected_review_version::text expected_review_version,expected_review_operation_id,intent_digest,outcome,result_digest,audit_reference,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') occurred_at,receipt_json,receipt_digest,data_classification`;

/** Durable original intent and terminal outcome. Historical receipts do not
 * renew review qualification or authorize a later approval/publication. */
export function createPostgresDigitalReceiptTemplateLifecycleStore(
  options: DigitalReceiptTemplateLifecycleStoreOptions,
) {
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    nowPort = clock.now,
    refs = options.references,
    canonicalPort = refs.canonicalize,
    hashPort = refs.hashIntent,
    authority = options.authority,
    holdPort = authority.holdUntilTransactionCompletes,
    registerPort = options.registerBeforeCommit,
    performPort = options.performAction,
    readActionPort = options.readActualAction,
    abandonPort = options.appendAbandonedIntent;
  const fixed = Object.freeze({
    tenantReference: parseDeviceReference(options.tenantReference),
    brandReference: parseDeviceReference(options.brandReference),
    storeReference: parseDeviceReference(options.storeReference),
    actorReference: parseDeviceReference(options.actorReference),
  });
  const origin = parseDeviceInstant(options.originalObservedAt),
    originalUntil = parseDeviceInstant(options.originalValidUntil);
  let latest = origin,
    deadline = originalUntil,
    poisoned = false,
    active = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    guardCalls = 0,
    guardComplete = false,
    finalCalls = 0;
  let command:
      DigitalReceiptTemplateLifecycleAction | DigitalReceiptTemplateLifecycleResolve | undefined,
    mode: "Execute" | "ResolveOriginal" | undefined,
    intent = "",
    held: DigitalReceiptTemplateLifecycleReceipt | undefined,
    heldSubmission: DigitalReceiptTemplateSubmission | null | undefined,
    heldPacket: DigitalReceiptTemplateLifecycleActualPacket | undefined,
    heldApprovalReceipt: DigitalReceiptTemplateLifecycleReceipt | undefined;
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    poisoned = true;
    throw new DigitalReceiptTemplateError(code);
  };
  const stored = <T>(work: () => T): T => {
    try {
      return work();
    } catch {
      return fail();
    }
  };
  if (
    [
      queryPort,
      nowPort,
      canonicalPort,
      hashPort,
      holdPort,
      registerPort,
      performPort,
      readActionPort,
      abandonPort,
    ].some((p) => typeof p !== "function") ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  const check = () => {
    if (
      poisoned ||
      Object.entries(fixed).some(
        ([k, v]) => Object.getOwnPropertyDescriptor(options, k)?.value !== v,
      ) ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.clock !== clock ||
      clock.now !== nowPort ||
      options.references !== refs ||
      refs.canonicalize !== canonicalPort ||
      refs.hashIntent !== hashPort ||
      options.authority !== authority ||
      authority.holdUntilTransactionCompletes !== holdPort ||
      options.registerBeforeCommit !== registerPort ||
      options.performAction !== performPort ||
      options.readActualAction !== readActionPort ||
      options.appendAbandonedIntent !== abandonPort ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil
    )
      return fail();
    const at = stored(() => parseDeviceInstant(nowPort.call(clock)));
    if (at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  };
  const canonical = (value: unknown) => {
    check();
    const text = canonicalPort.call(refs, value);
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 16384) return fail();
    check();
    return text;
  };
  const digest = (value: unknown) => {
    const valueHash = hashPort.call(refs, canonical(value));
    if (typeof valueHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(valueHash)) return fail();
    check();
    return valueHash;
  };
  const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const row = (result: unknown, count: number): Record<string, unknown> | null => {
    const rows =
      result && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rows")
        : undefined;
    if (
      !rows ||
      !("value" in rows) ||
      !Array.isArray(rows.value) ||
      Object.getPrototypeOf(rows.value) !== Array.prototype ||
      rows.value.length > 1 ||
      Reflect.ownKeys(rows.value).length !== rows.value.length + 1
    )
      return fail();
    if (rows.value.length === 0) return null;
    const first = Object.getOwnPropertyDescriptor(rows.value, "0");
    if (
      !first?.enumerable ||
      !("value" in first) ||
      !first.value ||
      Object.getPrototypeOf(first.value) !== Object.prototype ||
      Reflect.ownKeys(first.value).length !== count
    )
      return fail();
    for (const key of Reflect.ownKeys(first.value)) {
      const d = Object.getOwnPropertyDescriptor(first.value, key);
      if (typeof key !== "string" || !d?.enumerable || !("value" in d)) return fail();
    }
    return first.value as Record<string, unknown>;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    await queryPort.call(
      tx,
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
      [String(Math.max(1, Date.parse(deadline) - Date.parse(latest)))],
    );
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  const restore = () =>
    query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [fixed.tenantReference, fixed.brandReference, fixed.storeReference],
    );
  const hold = async () => {
    if (!command || !mode) return fail();
    check();
    const raw = await holdPort.call(
      authority,
      tx,
      Object.freeze({
        ...fixed,
        permission:
          command.action === "Approve" ? "publishing.review.approve" : "publishing.release.publish",
        purposeCode: "RECEIPT_TEMPLATE_REVIEW",
        mode,
        requiredFields: digitalReceiptTemplateLifecycleActionRequiredFields,
        command,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
    check();
    if (
      !raw ||
      Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).length !== 1
    )
      return fail();
    const d = Object.getOwnPropertyDescriptor(raw, "validUntil");
    if (!d?.enumerable || !("value" in d)) return fail();
    const until = stored(() => parseDeviceInstant(d.value));
    if (until < deadline) deadline = until;
    check();
    await restore();
  };
  const lock = async () => {
    if (!command) return fail();
    await restore();
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `ReceiptTemplateLifecycleOriginal:${command.operationReference}`,
    ]);
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `ReceiptTemplate:${fixed.brandReference}:${fixed.storeReference}:${command.templateReference}`,
    ]);
  };
  const readSubmission = async () => {
    if (!command) return fail();
    await restore();
    const r = row(
      await query(
        "SELECT record_json,record_digest FROM rms_device.digital_receipt_template_submission WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND template_id=$4 AND version_id=$5 AND draft_revision=$6 AND review_lifecycle_id=$7 LIMIT 1",
        [
          fixed.tenantReference,
          fixed.brandReference,
          fixed.storeReference,
          command.templateReference,
          command.expectedVersionReference,
          command.expectedRevision,
          command.reviewLifecycleReference,
        ],
      ),
      2,
    );
    if (!r) return fail("RECEIPT_TEMPLATE_CONFLICT");
    const submission = stored(() => parseDigitalReceiptTemplateSubmission(r.record_json));
    if (
      submission.tenantReference !== fixed.tenantReference ||
      submission.brandReference !== fixed.brandReference ||
      submission.storeReference !== fixed.storeReference ||
      submission.templateReference !== command.templateReference ||
      submission.versionReference !== command.expectedVersionReference ||
      submission.draftRevision !== command.expectedRevision ||
      submission.reviewLifecycleReference !== command.reviewLifecycleReference ||
      submission.submittedAt > check() ||
      digest(submission) !== r.record_digest
    )
      return fail();
    return submission;
  };
  const receipt = (
    result: DigitalReceiptTemplateLifecycleResult | null,
    auditReference: string,
    occurredAt: string,
  ) => {
    if (!command) return fail();
    const { profile: _profile, purposeCode: _purpose, ...pins } = command;
    void _profile;
    void _purpose;
    const { intentDigest: _hash, ...originalPins } = pins as typeof pins & {
      intentDigest?: string;
    };
    void _hash;
    return stored(() =>
      parseDigitalReceiptTemplateLifecycleReceipt({
        profile: "DigitalReceiptTemplateLifecycleReceiptV1",
        ...originalPins,
        intentDigest: intent,
        outcome: result ? "Committed" : "Abandoned",
        result,
        auditReference,
        occurredAt,
      }),
    );
  };
  const readOriginal = async (operationReference = command?.operationReference) => {
    if (!command || !operationReference) return fail();
    await restore();
    const r = row(
      await query(
        `SELECT ${columns} FROM rms_device.digital_receipt_template_lifecycle_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4 LIMIT 1`,
        [fixed.tenantReference, fixed.brandReference, fixed.storeReference, operationReference],
      ),
      20,
    );
    if (!r) return null;
    const value = stored(() => parseDigitalReceiptTemplateLifecycleReceipt(r.receipt_json));
    const pins = {
      operation_id: value.operationReference,
      tenant_id: value.tenantReference,
      brand_id: value.brandReference,
      store_id: value.storeReference,
      actor_id: value.actorReference,
      template_id: value.templateReference,
      expected_version_id: value.expectedVersionReference,
      expected_revision: String(value.expectedRevision),
      intent_digest: value.intentDigest,
      outcome: value.outcome,
      action: value.action,
      review_lifecycle_id: value.reviewLifecycleReference,
      expected_review_version: String(value.expectedReviewVersion),
      expected_review_operation_id: value.expectedReviewOperationReference,
      result_digest: value.result ? digest(value.result) : null,
      data_classification: "Confidential",
      audit_reference: value.auditReference,
      occurred_at: value.occurredAt,
    };
    if (
      Object.entries(pins).some(([k, v]) => r[k] !== v) ||
      value.tenantReference !== fixed.tenantReference ||
      value.brandReference !== fixed.brandReference ||
      value.storeReference !== fixed.storeReference ||
      value.operationReference !== operationReference ||
      value.occurredAt > check() ||
      digest(value) !== r.receipt_digest
    )
      return fail();
    return value;
  };
  const matchOriginal = (original: DigitalReceiptTemplateLifecycleReceipt) => {
    if (!command) return fail();
    if (original.actorReference !== fixed.actorReference)
      return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    if (
      original.templateReference !== command.templateReference ||
      original.expectedVersionReference !== command.expectedVersionReference ||
      original.expectedRevision !== command.expectedRevision ||
      original.action !== command.action ||
      original.reviewLifecycleReference !== command.reviewLifecycleReference ||
      original.expectedReviewVersion !== command.expectedReviewVersion ||
      original.expectedReviewOperationReference !== command.expectedReviewOperationReference ||
      original.intentDigest !== intent
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
  };
  const persist = async (value: DigitalReceiptTemplateLifecycleReceipt) => {
    await restore();
    const result = await query(
      "INSERT INTO rms_device.digital_receipt_template_lifecycle_operation(operation_id,tenant_id,brand_id,store_id,actor_id,action,template_id,expected_version_id,expected_revision,review_lifecycle_id,expected_review_version,expected_review_operation_id,intent_digest,outcome,result_digest,audit_reference,occurred_at,receipt_json,receipt_digest,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,'Confidential')",
      [
        value.operationReference,
        value.tenantReference,
        value.brandReference,
        value.storeReference,
        value.actorReference,
        value.action,
        value.templateReference,
        value.expectedVersionReference,
        value.expectedRevision,
        value.reviewLifecycleReference,
        value.expectedReviewVersion,
        value.expectedReviewOperationReference,
        value.intentDigest,
        value.outcome,
        value.result ? digest(value.result) : null,
        value.auditReference,
        value.occurredAt,
        canonical(value),
        digest(value),
      ],
    );
    const count =
      result && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rowCount")
        : undefined;
    if (!count || !("value" in count) || count.value !== 1) return fail();
  };
  const actionCommand = () => {
    if (!command) return fail();
    const { profile: _profile, ...pins } = command;
    void _profile;
    const { intentDigest: _hash, ...originalPins } = pins as typeof pins & {
      intentDigest?: string;
    };
    void _hash;
    return stored(() =>
      parseDigitalReceiptTemplateLifecycleAction({
        profile: "DigitalReceiptTemplateLifecycleActionV1",
        ...originalPins,
      }),
    );
  };
  const packet = (value: DigitalReceiptTemplateLifecycleActualPacket) => {
    if (
      !value ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 4
    )
      return fail();
    for (const key of ["mutation", "approval", "publishedVersion", "publicationDigest"]) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail();
    }
    const mutation = stored(() => parseRecordedPublishingMutation(value.mutation));
    const approval = stored(() => createPublishingApprovalEvidence(value.approval));
    const publishedVersion =
      value.publishedVersion === null
        ? null
        : stored(() => parseDigitalReceiptTemplateVersion(value.publishedVersion));
    const publicationDigest = value.publicationDigest;
    if (
      publicationDigest !== null &&
      (typeof publicationDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(publicationDigest))
    )
      return fail();
    return Object.freeze({ mutation, approval, publishedVersion, publicationDigest });
  };
  let heldPublishedTuple: string | undefined;
  const assess = async (value: DigitalReceiptTemplateLifecycleActualPacket) => {
    if (!command || !heldSubmission) return fail();
    const p = packet(value),
      m = p.mutation,
      a = p.approval,
      sub = heldSubmission,
      c = m.current,
      n = m.next;
    const sameScope = (scope: typeof n.scope) =>
      scope.kind === "Store" &&
      String(scope.brandReference) === fixed.brandReference &&
      String(scope.storeReference) === fixed.storeReference;
    const sameLife = (life: typeof n) =>
      String(life.lifecycleId) === command?.reviewLifecycleReference &&
      String(life.familyReference) === sub.familyReference &&
      String(life.snapshotReference) === sub.versionReference &&
      life.snapshotDigest === sub.contentDigest &&
      life.configurationType === "RECEIPT_TEMPLATE" &&
      life.purposeCode === "RECEIPT_ISSUANCE" &&
      String(life.validationEvidenceReference) === sub.validationEvidenceReference &&
      sameScope(life.scope);
    if (
      !c ||
      !sameLife(c) ||
      !sameLife(n) ||
      m.operation !== command.action ||
      String(m.idempotencyKey) !== command.operationReference ||
      m.expectedVersion !== command.expectedReviewVersion ||
      c.version !== command.expectedReviewVersion ||
      n.version !== command.expectedReviewVersion + 1 ||
      (command.action === "Approve"
        ? c.state !== "InReview" || n.state !== "Approved"
        : c.state !== "Approved" || n.state !== "Published") ||
      !evaluatePublishingTransition({
        operation: m.operation,
        expectedVersion: m.expectedVersion,
        current: c,
        next: n,
      }).allowed
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
    const at = String(n.changedAt);
    if (
      at < origin ||
      at > check() ||
      at < sub.submittedAt ||
      m.audit.brandId !== fixed.brandReference ||
      m.audit.storeId !== fixed.storeReference ||
      m.audit.actor.type !== "User" ||
      m.audit.actor.reference !== fixed.actorReference ||
      m.audit.targetId !== command.reviewLifecycleReference ||
      m.audit.targetType !== "PublishingLifecycle" ||
      m.audit.correlationId !== command.operationReference ||
      m.audit.occurredAt !== at ||
      m.audit.actionCode !==
        (command.action === "Approve"
          ? "PUBLISHING_REVIEW_APPROVED"
          : "PUBLISHING_RELEASE_PUBLISHED") ||
      m.audit.reasonCode !== m.audit.actionCode
    )
      return fail();
    if (
      String(a.reviewLifecycleId) !== command.reviewLifecycleReference ||
      a.reviewVersion !== sub.reviewVersion ||
      String(a.snapshotReference) !== sub.versionReference ||
      a.snapshotDigest !== sub.contentDigest ||
      !sameScope(a.scope) ||
      a.decision !== "Accepted" ||
      String(a.approvedActorReference) === sub.authoredByReference ||
      String(a.approvedActorReference) === sub.submittedByReference ||
      String(a.approvedAt) < sub.submittedAt ||
      String(a.approvedAt) > at ||
      String(a.validUntil) > sub.validationValidUntil ||
      at >= String(a.validUntil) ||
      String(n.approvalEvidenceReference) !== String(a.evidenceReference)
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
    const validation = m.validationEvidence;
    if (
      validation &&
      (validation.result !== "Pass" ||
        String(validation.evidenceReference) !== sub.validationEvidenceReference ||
        String(validation.snapshotReference) !== sub.versionReference ||
        validation.snapshotDigest !== sub.contentDigest ||
        !sameScope(validation.scope) ||
        String(validation.checkedAt) !== sub.checkedAt ||
        String(validation.validUntil) !== sub.validationValidUntil)
    )
      return fail();
    if (String(a.validUntil) < deadline) deadline = parseDeviceInstant(String(a.validUntil));
    if (sub.validationValidUntil < deadline)
      deadline = parseDeviceInstant(sub.validationValidUntil);
    check();
    if (command.action === "Approve") {
      if (
        String(a.approvedActorReference) !== fixed.actorReference ||
        String(a.approvedAt) !== at ||
        !equal(m.approvalEvidence, a) ||
        p.publishedVersion !== null ||
        p.publicationDigest !== null ||
        m.release !== null ||
        c.version !== sub.reviewVersion ||
        String(c.changedAt) !== sub.submittedAt
      )
        return fail();
    } else {
      const prior = await readOriginal(command.expectedReviewOperationReference);
      if (
        !prior ||
        prior.outcome !== "Committed" ||
        prior.action !== "Approve" ||
        !prior.result ||
        prior.templateReference !== command.templateReference ||
        prior.expectedVersionReference !== command.expectedVersionReference ||
        prior.expectedRevision !== command.expectedRevision ||
        prior.reviewLifecycleReference !== command.reviewLifecycleReference ||
        prior.result.lifecycleVersion !== command.expectedReviewVersion ||
        prior.result.approvalEvidenceReference !== String(a.evidenceReference) ||
        prior.result.approvedByReference !== String(a.approvedActorReference) ||
        prior.result.approvedAt !== String(a.approvedAt) ||
        prior.result.approvalValidUntil !== String(a.validUntil) ||
        String(c.changedAt) !== prior.result.changedAt ||
        String(c.approvalEvidenceReference) !== String(a.evidenceReference)
      )
        return fail("RECEIPT_TEMPLATE_CONFLICT");
      if (heldApprovalReceipt && !equal(heldApprovalReceipt, prior))
        return fail("RECEIPT_TEMPLATE_CONFLICT");
      heldApprovalReceipt = prior;
      const v = p.publishedVersion,
        release = m.release;
      if (
        !v ||
        !release ||
        p.publicationDigest !== sub.contentDigest ||
        !equal(m.approvalEvidence, a) ||
        String(release.releaseId) !== String(v.publicationReference) ||
        String(release.familyReference) !== sub.familyReference ||
        release.configurationType !== "RECEIPT_TEMPLATE" ||
        release.purposeCode !== "RECEIPT_ISSUANCE" ||
        release.kind !== "Publish" ||
        String(release.snapshotReference) !== sub.versionReference ||
        release.snapshotDigest !== sub.contentDigest ||
        !sameScope(release.scope) ||
        String(release.createdAt) !== at ||
        String(release.sourceLifecycleId) !== sub.reviewLifecycleReference ||
        String(v.brandReference) !== fixed.brandReference ||
        String(v.storeReference) !== fixed.storeReference ||
        String(v.templateReference) !== command.templateReference ||
        String(v.versionReference) !== command.expectedVersionReference ||
        v.publishedAt !== at
      )
        return fail();
      await restore();
      const r = row(
        await query(
          "SELECT version_json,operation_id,audit_id,publication_digest FROM rms_device.digital_receipt_template_version WHERE brand_id=$1 AND store_id=$2 AND template_id=$3 AND version_id=$4 LIMIT 1",
          [
            fixed.brandReference,
            fixed.storeReference,
            command.templateReference,
            command.expectedVersionReference,
          ],
        ),
        4,
      );
      if (
        !r ||
        r.operation_id !== command.operationReference ||
        stored(() => parseDeviceReference(r.audit_id)) === String(m.audit.auditId) ||
        r.publication_digest !== sub.contentDigest ||
        !equal(
          stored(() => parseDigitalReceiptTemplateVersion(r.version_json)),
          v,
        )
      )
        return fail();
      const tuple = canonical(r);
      if (heldPublishedTuple !== undefined && heldPublishedTuple !== tuple) return fail();
      heldPublishedTuple = tuple;
    }
    check();
    return p;
  };
  const register = async () => {
    const returned = await registerPort.call(
      options,
      tx,
      async () => {
        try {
          if (++guardCalls !== 1 || active || phase !== "Work" || !held) return fail();
          phase = "Checks";
          await hold();
          await lock();
          const original = await readOriginal();
          if (!equal(original, held)) return fail("RECEIPT_TEMPLATE_CONFLICT");
          if (heldPacket) {
            if (!equal(await readSubmission(), heldSubmission))
              return fail("RECEIPT_TEMPLATE_CONFLICT");
            const actual = await readActionPort.call(options, tx, actionCommand());
            check();
            const currentPacket = await assess(actual);
            if (!equal(currentPacket, heldPacket)) return fail("RECEIPT_TEMPLATE_CONFLICT");
          }
          await hold();
          await restore();
          check();
          guardComplete = true;
        } catch (error) {
          poisoned = true;
          if (error instanceof DigitalReceiptTemplateError) throw error;
          return fail();
        }
      },
      () => {
        if (
          ++finalCalls !== 1 ||
          !guardComplete ||
          guardCalls !== 1 ||
          active ||
          phase !== "Checks"
        )
          return fail();
        check();
        phase = "Final";
      },
    );
    if (returned !== undefined) return fail();
    check();
  };
  const run = async (selected: "Execute" | "ResolveOriginal", value: unknown) => {
    try {
      if (active || command || phase !== "Work") return fail();
      command =
        selected === "Execute"
          ? parseDigitalReceiptTemplateLifecycleAction(value)
          : parseDigitalReceiptTemplateLifecycleResolve(value);
      if (
        Object.entries(fixed).some(
          ([k, v]) => Object.getOwnPropertyDescriptor(command, k)?.value !== v,
        )
      )
        return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
      const { profile: unusedProfile, ...pins } = command;
      void unusedProfile;
      const { intentDigest: supplied, ...originalPins } = pins as typeof pins & {
        intentDigest?: string;
      };
      intent = digest(
        parseDigitalReceiptTemplateLifecycleAction({
          profile: "DigitalReceiptTemplateLifecycleActionV1",
          ...originalPins,
        }),
      );
      if (selected === "ResolveOriginal" && supplied !== intent)
        return fail("RECEIPT_TEMPLATE_CONFLICT");
      mode = selected;
      active = true;
      await register();
      const isolation = row(
        await query("SELECT current_setting('transaction_isolation') isolation", []),
        1,
      );
      if (isolation?.isolation !== "read committed") return fail();
      await hold();
      await lock();
      const original = await readOriginal();
      if (original) {
        matchOriginal(original);
        held = original;
      } else if (selected === "Execute") {
        heldSubmission = await readSubmission();
        if (
          command.action === "Approve" &&
          (command.expectedReviewVersion !== heldSubmission.reviewVersion ||
            command.expectedReviewOperationReference !== heldSubmission.operationReference)
        )
          return fail("RECEIPT_TEMPLATE_CONFLICT");
        const actual = await performPort.call(options, tx, actionCommand());
        check();
        heldPacket = await assess(actual);
        const m = heldPacket.mutation,
          a = heldPacket.approval;
        held = receipt(
          Object.freeze({
            lifecycleReference: String(m.next.lifecycleId),
            lifecycleVersion: m.next.version,
            state: command.action === "Approve" ? "Approved" : "Published",
            mutationOperationReference: String(m.idempotencyKey),
            changedAt: String(m.next.changedAt),
            approvalEvidenceReference: String(a.evidenceReference),
            approvedByReference: String(a.approvedActorReference),
            approvedAt: String(a.approvedAt),
            approvalValidUntil: String(a.validUntil),
            publishedVersion: heldPacket.publishedVersion,
          }),
          String(m.audit.auditId),
          String(m.audit.occurredAt),
        );
        await persist(held);
      } else {
        const at = check(),
          resolved = command as DigitalReceiptTemplateLifecycleResolve;
        const audit = await abandonPort.call(
          options,
          tx,
          Object.freeze({ command: resolved, intentDigest: intent, occurredAt: at }),
        );
        check();
        if (
          !audit ||
          Object.getPrototypeOf(audit) !== Object.prototype ||
          Reflect.ownKeys(audit).length !== 2
        )
          return fail();
        const auditId = Object.getOwnPropertyDescriptor(audit, "auditReference"),
          time = Object.getOwnPropertyDescriptor(audit, "occurredAt");
        if (
          !auditId?.enumerable ||
          !("value" in auditId) ||
          !time?.enumerable ||
          !("value" in time) ||
          time.value !== at
        )
          return fail();
        held = receipt(
          null,
          stored(() => parseDeviceReference(auditId.value)),
          at,
        );
        await persist(held);
      }
      await hold();
      check();
      if (!held) return fail();
      return held;
    } catch (error) {
      poisoned = true;
      if (error instanceof DigitalReceiptTemplateError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    execute: (value: unknown) => run("Execute", value),
    resolve: (value: unknown) => run("ResolveOriginal", value),
    assertFinalized: (actual: DigitalReceiptTemplateLifecycleTransaction) => {
      if (
        actual !== tx ||
        phase !== "Final" ||
        guardCalls !== 1 ||
        !guardComplete ||
        finalCalls !== 1 ||
        active ||
        !held
      )
        return fail();
      check();
      return deadline;
    },
  });
}
