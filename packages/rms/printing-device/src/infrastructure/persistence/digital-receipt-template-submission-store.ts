import {
  parseRecordedPublishingMutation,
  type CommitPublishingMutationInput,
} from "@bop/publishing";
import { parseDeviceReference, parseDeviceInstant } from "../../contracts/device-management.js";
import { DigitalReceiptTemplateError } from "../../contracts/digital-receipt-template.js";
import {
  parseDigitalReceiptTemplateDraft,
  type DigitalReceiptTemplateDraft,
  type DigitalReceiptTemplateDraftActorScope,
} from "../../contracts/digital-receipt-template-draft.js";
import {
  parseDigitalReceiptTemplateSubmission,
  createDigitalReceiptTemplateAuthoredContent,
  type DigitalReceiptTemplateSubmission,
} from "../../contracts/digital-receipt-template-submission.js";
export interface DigitalReceiptTemplateSubmissionTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface DigitalReceiptTemplateSubmissionWrite {
  readonly templateReference: string;
  readonly versionReference: string;
  readonly expectedRevision: number;
  readonly operationReference: string;
  readonly reviewLifecycleReference: string;
}
type Mode = "ReadSubmission" | "ReadLatestSubmission" | "ReadAuthoredContent" | "Write";
export const digitalReceiptTemplateSubmissionRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "templateReference",
  "familyReference",
  "versionReference",
  "draftRevision",
  "contentDigest",
  "authoredByReference",
  "submittedByReference",
  "operationReference",
  "reviewLifecycleReference",
  "reviewVersion",
  "validationEvidenceReference",
  "checkedAt",
  "validationValidUntil",
  "submittedAt",
  "auditReference",
] as const);
export interface DigitalReceiptTemplateSubmissionStoreOptions extends DigitalReceiptTemplateDraftActorScope {
  readonly transaction: DigitalReceiptTemplateSubmissionTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    tx: DigitalReceiptTemplateSubmissionTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly references: { canonicalize(value: unknown): string; hashIntent(value: string): string };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: DigitalReceiptTemplateSubmissionTransaction,
      input: Readonly<
        DigitalReceiptTemplateDraftActorScope & {
          permission: "organization.manage" | "publishing.review.submit";
          purposeCode: "RECEIPT_TEMPLATE_SUBMISSION";
          mode: Mode;
          requiredFields: typeof digitalReceiptTemplateSubmissionRequiredFields;
          command: DigitalReceiptTemplateSubmissionWrite | null;
          templateReference: string;
          versionReference: string | null;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<{ readonly validUntil: string }>;
  };
  readonly readPublishingReview: (
    tx: DigitalReceiptTemplateSubmissionTransaction,
    input: Readonly<{
      familyReference: string;
      reviewLifecycleReference: string;
      operationReference: string;
      snapshotReference: string;
      snapshotDigest: string;
      observedAt: string;
      validUntil: string;
    }>,
  ) => Promise<CommitPublishingMutationInput | null>;
}
const utc = (name: string) => `to_char(${name} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const draftColumns = `template_id,family_id,version_id,revision::text revision,publication_version_number::text publication_version_number,operation_id,actor_id,previous_version_id,content_digest,snapshot_json,snapshot_digest,${utc("created_at")} created_at,${utc("updated_at")} updated_at`;
const submissionColumns = `tenant_id,brand_id,store_id,template_id,family_id,version_id,draft_revision::text draft_revision,content_digest,authored_by_id,submitted_by_id,operation_id,review_lifecycle_id,review_version::text review_version,validation_evidence_id,${utc("checked_at")} checked_at,${utc("validation_valid_until")} validation_valid_until,${utc("submitted_at")} submitted_at,audit_reference,data_classification,record_json,record_digest`;
/** Owning immutable provenance. A recorded submission is not a current approval or publication grant. */
export function createPostgresDigitalReceiptTemplateSubmissionStore(
  options: DigitalReceiptTemplateSubmissionStoreOptions,
) {
  const tx = options.transaction,
    queryPort = tx.query,
    clock = options.clock,
    nowPort = clock.now,
    authority = options.authority,
    holdPort = authority.holdUntilTransactionCompletes,
    refs = options.references,
    canonicalPort = refs.canonicalize,
    hashPort = refs.hashIntent,
    registerPort = options.registerBeforeCommit,
    publishingPort = options.readPublishingReview;
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
    failed = false,
    active = false,
    registered = false,
    phase: "Work" | "Checks" | "Final" = "Work",
    guardCalls = 0,
    guardComplete = false,
    finalCalls = 0;
  let mode: Mode | null = null,
    command: DigitalReceiptTemplateSubmissionWrite | null = null,
    templateReference = "",
    versionReference: string | null = null;
  let held: DigitalReceiptTemplateSubmission | null | undefined,
    heldDraft: DigitalReceiptTemplateDraft | undefined,
    publishingDigest: string | undefined,
    wrote = false;
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    failed = true;
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
    [queryPort, nowPort, holdPort, canonicalPort, hashPort, registerPort, publishingPort].some(
      (p) => typeof p !== "function",
    ) ||
    originalUntil <= origin ||
    Date.parse(originalUntil) - Date.parse(origin) > 5000
  )
    return fail();
  const check = () => {
    if (
      failed ||
      Object.entries(fixed).some(
        ([k, v]) => Object.getOwnPropertyDescriptor(options, k)?.value !== v,
      ) ||
      options.transaction !== tx ||
      tx.query !== queryPort ||
      options.clock !== clock ||
      clock.now !== nowPort ||
      options.authority !== authority ||
      authority.holdUntilTransactionCompletes !== holdPort ||
      options.references !== refs ||
      refs.canonicalize !== canonicalPort ||
      refs.hashIntent !== hashPort ||
      options.registerBeforeCommit !== registerPort ||
      options.readPublishingReview !== publishingPort ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== originalUntil
    )
      return fail();
    const at = stored(() => parseDeviceInstant(nowPort.call(clock)));
    if (at < latest || at >= deadline) return fail();
    latest = at;
    return at;
  };
  const closed = (value: unknown, keys: readonly string[]) => {
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length
    )
      return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
      result[key] = d.value;
    }
    return result;
  };
  const canonical = (value: unknown) => {
    check();
    const text = canonicalPort.call(refs, value);
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 65536) return fail();
    check();
    return text;
  };
  const digest = (value: unknown) => {
    const result = hashPort.call(refs, canonical(value));
    if (typeof result !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(result)) return fail();
    check();
    return result;
  };
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const rows = (raw: unknown) => {
    const d =
      raw && typeof raw === "object" ? Object.getOwnPropertyDescriptor(raw, "rows") : undefined;
    if (
      !d ||
      !("value" in d) ||
      !Array.isArray(d.value) ||
      Object.getPrototypeOf(d.value) !== Array.prototype ||
      d.value.length > 1 ||
      Reflect.ownKeys(d.value).length !== d.value.length + 1
    )
      return fail();
    const row = Object.getOwnPropertyDescriptor(d.value, "0");
    if (d.value.length === 0) return null;
    if (
      !row?.enumerable ||
      !("value" in row) ||
      !row.value ||
      Object.getPrototypeOf(row.value) !== Object.prototype
    )
      return fail();
    for (const key of Reflect.ownKeys(row.value)) {
      const field = Object.getOwnPropertyDescriptor(row.value, key);
      if (typeof key !== "string" || !field?.enumerable || !("value" in field)) return fail();
    }
    return row.value as Record<string, unknown>;
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
  const root = async () => {
    await restore();
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `ReceiptTemplate:${fixed.brandReference}:${fixed.storeReference}:${templateReference}`,
    ]);
  };
  const hold = async () => {
    if (mode === null) return fail();
    const raw = await holdPort.call(
      authority,
      tx,
      Object.freeze({
        ...fixed,
        permission: mode === "Write" ? "publishing.review.submit" : "organization.manage",
        purposeCode: "RECEIPT_TEMPLATE_SUBMISSION",
        mode,
        requiredFields: digitalReceiptTemplateSubmissionRequiredFields,
        command,
        templateReference,
        versionReference,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
    check();
    const proof = stored(() => closed(raw, ["validUntil"]));
    const until = stored(() => parseDeviceInstant(proof.validUntil));
    if (until < deadline) deadline = until;
    check();
    await restore();
  };
  const decodeDraft = (row: Record<string, unknown>) => {
    if (Reflect.ownKeys(row).length !== 13) return fail();
    const d = stored(() => parseDigitalReceiptTemplateDraft(row.snapshot_json));
    if (
      d.tenantReference !== fixed.tenantReference ||
      d.brandReference !== fixed.brandReference ||
      d.storeReference !== fixed.storeReference ||
      row.template_id !== d.content.templateReference ||
      row.family_id !== d.familyReference ||
      row.version_id !== d.content.versionReference ||
      row.revision !== String(d.revision) ||
      row.publication_version_number !== String(d.content.versionNumber) ||
      row.actor_id !== d.authoredByReference ||
      row.previous_version_id !== d.previousVersionReference ||
      row.content_digest !== d.contentDigest ||
      row.created_at !== d.createdAt ||
      row.updated_at !== d.updatedAt ||
      d.updatedAt > check() ||
      digest(d.content) !== d.contentDigest ||
      digest(d) !== row.snapshot_digest
    )
      return fail();
    stored(() => parseDeviceReference(row.operation_id));
    return d;
  };
  const readDraft = async (exact: boolean, target: string | null = versionReference) => {
    await restore();
    const row = rows(
      await query(
        `SELECT ${draftColumns} FROM rms_device.digital_receipt_template_draft_revision WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND template_id=$4 ${exact ? "AND version_id=$5" : "ORDER BY revision DESC"} LIMIT 1`,
        exact
          ? [
              fixed.tenantReference,
              fixed.brandReference,
              fixed.storeReference,
              templateReference,
              target,
            ]
          : [fixed.tenantReference, fixed.brandReference, fixed.storeReference, templateReference],
      ),
    );
    if (!row) return null;
    const d = decodeDraft(row);
    if (
      d.content.templateReference !== templateReference ||
      (exact && d.content.versionReference !== target)
    )
      return fail();
    return d;
  };
  const decode = (row: Record<string, unknown>) => {
    if (Reflect.ownKeys(row).length !== 21) return fail();
    const r = stored(() => parseDigitalReceiptTemplateSubmission(row.record_json));
    const values: Record<string, unknown> = {
      tenant_id: r.tenantReference,
      brand_id: r.brandReference,
      store_id: r.storeReference,
      template_id: r.templateReference,
      family_id: r.familyReference,
      version_id: r.versionReference,
      draft_revision: String(r.draftRevision),
      content_digest: r.contentDigest,
      authored_by_id: r.authoredByReference,
      submitted_by_id: r.submittedByReference,
      operation_id: r.operationReference,
      review_lifecycle_id: r.reviewLifecycleReference,
      review_version: String(r.reviewVersion),
      validation_evidence_id: r.validationEvidenceReference,
      checked_at: r.checkedAt,
      validation_valid_until: r.validationValidUntil,
      submitted_at: r.submittedAt,
      audit_reference: r.auditReference,
      data_classification: r.dataClassification,
    };
    if (
      Object.entries(values).some(([k, v]) => row[k] !== v) ||
      r.tenantReference !== fixed.tenantReference ||
      r.brandReference !== fixed.brandReference ||
      r.storeReference !== fixed.storeReference ||
      r.submittedAt > check() ||
      digest(r) !== row.record_digest
    )
      return fail();
    return r;
  };
  const readRecord = async (by: "Operation" | "Version" | "Latest") => {
    await restore();
    const tail =
      by === "Operation"
        ? "AND operation_id=$4"
        : by === "Version"
          ? "AND template_id=$4 AND version_id=$5"
          : "AND template_id=$4 ORDER BY draft_revision DESC";
    const values =
      by === "Operation"
        ? [
            fixed.tenantReference,
            fixed.brandReference,
            fixed.storeReference,
            command?.operationReference,
          ]
        : by === "Latest"
          ? [fixed.tenantReference, fixed.brandReference, fixed.storeReference, templateReference]
          : [
              fixed.tenantReference,
              fixed.brandReference,
              fixed.storeReference,
              templateReference,
              versionReference,
            ];
    const row = rows(
      await query(
        `SELECT ${submissionColumns} FROM rms_device.digital_receipt_template_submission WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 ${tail} LIMIT 1`,
        values,
      ),
    );
    return row ? decode(row) : null;
  };
  const review = async (
    draft: DigitalReceiptTemplateDraft,
    c: DigitalReceiptTemplateSubmissionWrite,
  ) => {
    const raw = await publishingPort.call(
      options,
      tx,
      Object.freeze({
        familyReference: draft.familyReference,
        reviewLifecycleReference: c.reviewLifecycleReference,
        operationReference: c.operationReference,
        snapshotReference: draft.content.versionReference,
        snapshotDigest: draft.contentDigest,
        observedAt: check(),
        validUntil: deadline,
      }),
    );
    check();
    if (raw === null) return fail("RECEIPT_TEMPLATE_CONFLICT");
    const m = stored(() => parseRecordedPublishingMutation(raw)),
      v = m.validationEvidence,
      n = m.next,
      p = m.current;
    if (
      m.operation !== "SubmitReview" ||
      String(m.idempotencyKey) !== c.operationReference ||
      !p ||
      p.state !== "Draft" ||
      n.state !== "InReview" ||
      m.expectedVersion !== p.version ||
      n.version !== p.version + 1 ||
      String(n.createdAt) !== String(p.createdAt) ||
      String(p.changedAt) > String(n.changedAt) ||
      String(n.lifecycleId) !== c.reviewLifecycleReference ||
      String(p.lifecycleId) !== c.reviewLifecycleReference ||
      m.release !== null ||
      m.approvalEvidence !== null ||
      !v ||
      v.result !== "Pass" ||
      String(n.familyReference) !== draft.familyReference ||
      String(p.familyReference) !== draft.familyReference ||
      n.configurationType !== "RECEIPT_TEMPLATE" ||
      p.configurationType !== "RECEIPT_TEMPLATE" ||
      n.purposeCode !== "RECEIPT_ISSUANCE" ||
      p.purposeCode !== "RECEIPT_ISSUANCE" ||
      String(n.snapshotReference) !== draft.content.versionReference ||
      String(p.snapshotReference) !== draft.content.versionReference ||
      n.snapshotDigest !== draft.contentDigest ||
      p.snapshotDigest !== draft.contentDigest ||
      v.snapshotDigest !== draft.contentDigest ||
      String(v.snapshotReference) !== draft.content.versionReference ||
      String(n.validationEvidenceReference) !== String(v.evidenceReference) ||
      n.approvalEvidenceReference !== null ||
      !same(n.scope, p.scope) ||
      !same(n.scope, v.scope) ||
      n.scope.kind !== "Store" ||
      String(n.scope.brandReference) !== fixed.brandReference ||
      String(n.scope.storeReference) !== fixed.storeReference ||
      String(m.audit.brandId) !== fixed.brandReference ||
      String(m.audit.storeId) !== fixed.storeReference ||
      m.audit.actor.type !== "User" ||
      String(m.audit.actor.reference) !== fixed.actorReference ||
      m.audit.targetType !== "PublishingLifecycle" ||
      String(m.audit.targetId) !== c.reviewLifecycleReference ||
      m.audit.actionCode !== "PUBLISHING_REVIEW_SUBMITTED" ||
      m.audit.reasonCode !== "PUBLISHING_REVIEW_SUBMITTED" ||
      String(n.changedAt) !== m.audit.occurredAt ||
      m.audit.occurredAt > check() ||
      String(v.checkedAt) > m.audit.occurredAt ||
      String(v.checkedAt) < draft.updatedAt ||
      String(v.validUntil) <= check() ||
      draft.updatedAt > m.audit.occurredAt
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
    await restore();
    return m;
  };
  const register = async () => {
    if (registered) return;
    registered = true;
    const returned = await registerPort.call(
      options,
      tx,
      async () => {
        try {
          if (++guardCalls !== 1 || active || phase !== "Work") return fail();
          phase = "Checks";
          await hold();
          await root();
          const actual = await readRecord(
            mode === "ReadLatestSubmission" ? "Latest" : command ? "Operation" : "Version",
          );
          if (!same(actual, held)) return fail("RECEIPT_TEMPLATE_CONFLICT");
          if (heldDraft) {
            const d = await readDraft(true, heldDraft.content.versionReference);
            if (!same(d, heldDraft)) return fail();
            if (wrote) {
              if (!same(await readDraft(false), heldDraft) || !d || !command)
                return fail("RECEIPT_TEMPLATE_CONFLICT");
              const m = await review(d, command);
              if (canonical(m) !== publishingDigest) return fail("RECEIPT_TEMPLATE_CONFLICT");
            }
          }
          await hold();
          await restore();
          check();
          guardComplete = true;
        } catch (e) {
          failed = true;
          if (e instanceof DigitalReceiptTemplateError) throw e;
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
  const run = async <T>(
    selected: Mode,
    value: unknown,
    keys: readonly string[],
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      if (active || phase !== "Work" || mode !== null) return fail();
      const input = closed(value, keys);
      templateReference = parseDeviceReference(input.templateReference);
      versionReference =
        selected === "ReadLatestSubmission" ? null : parseDeviceReference(input.versionReference);
      if (selected === "Write") {
        if (
          typeof input.expectedRevision !== "number" ||
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision < 1 ||
          input.expectedRevision > 2147483647
        )
          return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
        command = Object.freeze({
          templateReference,
          versionReference: parseDeviceReference(input.versionReference),
          expectedRevision: input.expectedRevision,
          operationReference: parseDeviceReference(input.operationReference),
          reviewLifecycleReference: parseDeviceReference(input.reviewLifecycleReference),
        });
      }
      mode = selected;
      active = true;
      await register();
      const isolation = rows(
        await query("SELECT current_setting('transaction_isolation') isolation", []),
      );
      if (isolation?.isolation !== "read committed") return fail();
      await hold();
      await root();
      const result = await work();
      await hold();
      check();
      return result;
    } catch (e) {
      failed = true;
      if (e instanceof DigitalReceiptTemplateError) throw e;
      return fail();
    } finally {
      active = false;
    }
  };
  const historical = async () => {
    held = await readRecord("Version");
    if (held) {
      const d = await readDraft(true);
      if (!d) return fail();
      stored(() => createDigitalReceiptTemplateAuthoredContent(held, d));
      heldDraft = d;
    }
    return held;
  };
  return Object.freeze({
    readSubmission: (value: unknown) =>
      run("ReadSubmission", value, ["templateReference", "versionReference"], historical),
    readLatestSubmission: (value: unknown) =>
      run("ReadLatestSubmission", value, ["templateReference"], async () => {
        held = await readRecord("Latest");
        if (held) {
          const d = await readDraft(true, held.versionReference);
          if (!d) return fail();
          stored(() => createDigitalReceiptTemplateAuthoredContent(held, d));
          heldDraft = d;
        }
        return held;
      }),
    readAuthoredContent: (value: unknown) =>
      run("ReadAuthoredContent", value, ["templateReference", "versionReference"], async () => {
        const r = await historical();
        if (!r || !heldDraft) return null;
        return stored(() => createDigitalReceiptTemplateAuthoredContent(r, heldDraft));
      }),
    write: (value: unknown) =>
      run(
        "Write",
        value,
        [
          "templateReference",
          "versionReference",
          "expectedRevision",
          "operationReference",
          "reviewLifecycleReference",
        ],
        async () => {
          if (!command) return fail();
          const c = command;
          const old = await readRecord("Operation");
          if (old) {
            if (old.submittedByReference !== fixed.actorReference)
              return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
            if (
              old.templateReference !== c.templateReference ||
              old.versionReference !== c.versionReference ||
              old.draftRevision !== c.expectedRevision ||
              old.reviewLifecycleReference !== c.reviewLifecycleReference
            )
              return fail("RECEIPT_TEMPLATE_CONFLICT");
            const d = await readDraft(true);
            if (!d) return fail();
            stored(() => createDigitalReceiptTemplateAuthoredContent(old, d));
            heldDraft = d;
            held = old;
            return old;
          }
          const d = await readDraft(true);
          if (!d || d.revision !== c.expectedRevision || !same(await readDraft(false), d))
            return fail("RECEIPT_TEMPLATE_CONFLICT");
          if (await readRecord("Version")) return fail("RECEIPT_TEMPLATE_CONFLICT");
          const m = await review(d, c),
            v = m.validationEvidence;
          if (!v || m.audit.actor.type !== "User" || m.audit.auditId === undefined) return fail();
          const r = stored(() =>
            parseDigitalReceiptTemplateSubmission({
              profile: "DigitalReceiptTemplateSubmissionV1",
              tenantReference: fixed.tenantReference,
              brandReference: fixed.brandReference,
              storeReference: fixed.storeReference,
              templateReference: d.content.templateReference,
              familyReference: d.familyReference,
              versionReference: d.content.versionReference,
              draftRevision: d.revision,
              contentDigest: d.contentDigest,
              authoredByReference: d.authoredByReference,
              submittedByReference: fixed.actorReference,
              operationReference: c.operationReference,
              reviewLifecycleReference: c.reviewLifecycleReference,
              reviewVersion: m.next.version,
              validationEvidenceReference: v.evidenceReference,
              checkedAt: v.checkedAt,
              validationValidUntil: v.validUntil,
              submittedAt: m.audit.occurredAt,
              auditReference: m.audit.auditId,
              dataClassification: "Internal",
            }),
          );
          stored(() => createDigitalReceiptTemplateAuthoredContent(r, d));
          await restore();
          const result = await query(
            "INSERT INTO rms_device.digital_receipt_template_submission(tenant_id,brand_id,store_id,template_id,family_id,version_id,draft_revision,content_digest,authored_by_id,submitted_by_id,operation_id,review_lifecycle_id,review_version,validation_evidence_id,checked_at,validation_valid_until,submitted_at,audit_reference,data_classification,record_json,record_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'Internal',$19::jsonb,$20)",
            [
              r.tenantReference,
              r.brandReference,
              r.storeReference,
              r.templateReference,
              r.familyReference,
              r.versionReference,
              r.draftRevision,
              r.contentDigest,
              r.authoredByReference,
              r.submittedByReference,
              r.operationReference,
              r.reviewLifecycleReference,
              r.reviewVersion,
              r.validationEvidenceReference,
              r.checkedAt,
              r.validationValidUntil,
              r.submittedAt,
              r.auditReference,
              canonical(r),
              digest(r),
            ],
          );
          const count =
            result && typeof result === "object"
              ? Object.getOwnPropertyDescriptor(result, "rowCount")
              : undefined;
          if (!count || !("value" in count) || count.value !== 1) return fail();
          held = r;
          heldDraft = d;
          wrote = true;
          publishingDigest = canonical(m);
          return r;
        },
      ),
    assertFinalized: (actual: DigitalReceiptTemplateSubmissionTransaction) => {
      if (
        actual !== tx ||
        phase !== "Final" ||
        guardCalls !== 1 ||
        !guardComplete ||
        finalCalls !== 1 ||
        active
      )
        return fail();
      check();
      return deadline;
    },
  });
}
