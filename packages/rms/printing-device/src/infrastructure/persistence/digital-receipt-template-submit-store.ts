import { parseDeviceReference, parseDeviceInstant } from "../../contracts/device-management.js";
import { DigitalReceiptTemplateError } from "../../contracts/digital-receipt-template.js";
import type { DigitalReceiptTemplateDraftActorScope } from "../../contracts/digital-receipt-template-draft.js";
import {
  parseDigitalReceiptTemplateSubmission,
  type DigitalReceiptTemplateSubmission,
} from "../../contracts/digital-receipt-template-submission.js";
import {
  parseDigitalReceiptTemplateSubmit,
  parseDigitalReceiptTemplateSubmitResolve,
  parseDigitalReceiptTemplateSubmitReceipt,
  type DigitalReceiptTemplateSubmit,
  type DigitalReceiptTemplateSubmitResolve,
  type DigitalReceiptTemplateSubmitReceipt,
} from "../../contracts/digital-receipt-template-submit.js";

export interface DigitalReceiptTemplateSubmitTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export const digitalReceiptTemplateSubmitRequiredFields = Object.freeze([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "operationReference",
  "templateReference",
  "expectedVersionReference",
  "expectedRevision",
  "purposeCode",
  "intentDigest",
] as const);
export interface DigitalReceiptTemplateSubmitStoreOptions extends DigitalReceiptTemplateDraftActorScope {
  readonly transaction: DigitalReceiptTemplateSubmitTransaction;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly references: { canonicalize(value: unknown): string; hashIntent(value: string): string };
  readonly registerBeforeCommit: (
    tx: DigitalReceiptTemplateSubmitTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void> | void;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: DigitalReceiptTemplateSubmitTransaction,
      input: Readonly<
        DigitalReceiptTemplateDraftActorScope & {
          permission: "publishing.review.submit";
          purposeCode: "RECEIPT_TEMPLATE_REVIEW";
          mode: "SubmitReview" | "ResolveOriginal";
          requiredFields: typeof digitalReceiptTemplateSubmitRequiredFields;
          command: DigitalReceiptTemplateSubmit | DigitalReceiptTemplateSubmitResolve;
          observedAt: string;
          validUntil: string;
        }
      >,
    ): Promise<Readonly<{ validUntil: string }>>;
  };
  /** The real host composes the Publishing kernel and the immutable Submission
   * writer in this transaction and registers both owning final guards. */
  readonly submitReview: (
    tx: DigitalReceiptTemplateSubmitTransaction,
    command: DigitalReceiptTemplateSubmit,
  ) => Promise<DigitalReceiptTemplateSubmission>;
  readonly appendAbandonedIntent: (
    tx: DigitalReceiptTemplateSubmitTransaction,
    input: Readonly<{
      command: DigitalReceiptTemplateSubmitResolve;
      intentDigest: string;
      occurredAt: string;
    }>,
  ) => Promise<Readonly<{ auditReference: string; occurredAt: string }>>;
}
const columns = `operation_id,tenant_id,brand_id,store_id,actor_id,template_id,expected_version_id,expected_revision::text expected_revision,intent_digest,outcome,result_review_lifecycle_id,result_review_version::text result_review_version,submission_digest,audit_reference,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') occurred_at,receipt_json,receipt_digest`;

/** Durable original intent and terminal outcome. Historical receipts do not
 * renew review qualification or authorize a later approval/publication. */
export function createPostgresDigitalReceiptTemplateSubmitStore(
  options: DigitalReceiptTemplateSubmitStoreOptions,
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
    submitPort = options.submitReview,
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
  let command: DigitalReceiptTemplateSubmit | DigitalReceiptTemplateSubmitResolve | undefined,
    mode: "SubmitReview" | "ResolveOriginal" | undefined,
    intent = "",
    held: DigitalReceiptTemplateSubmitReceipt | undefined,
    heldSubmission: DigitalReceiptTemplateSubmission | null | undefined,
    legacy = false;
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
      submitPort,
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
      options.submitReview !== submitPort ||
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
        permission: "publishing.review.submit",
        purposeCode: "RECEIPT_TEMPLATE_REVIEW",
        mode,
        requiredFields: digitalReceiptTemplateSubmitRequiredFields,
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
      `ReceiptTemplateSubmitOperation:${command.operationReference}`,
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
        "SELECT record_json,record_digest FROM rms_device.digital_receipt_template_submission WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4 LIMIT 1",
        [
          fixed.tenantReference,
          fixed.brandReference,
          fixed.storeReference,
          command.operationReference,
        ],
      ),
      2,
    );
    if (!r) return null;
    const submission = stored(() => parseDigitalReceiptTemplateSubmission(r.record_json));
    if (
      submission.tenantReference !== fixed.tenantReference ||
      submission.brandReference !== fixed.brandReference ||
      submission.storeReference !== fixed.storeReference ||
      submission.operationReference !== command.operationReference ||
      submission.submittedAt > check() ||
      digest(submission) !== r.record_digest
    )
      return fail();
    return submission;
  };
  const receipt = (
    submission: DigitalReceiptTemplateSubmission | null,
    auditReference: string,
    occurredAt: string,
  ) => {
    const currentCommand = command;
    if (!currentCommand) return fail();
    return stored(() =>
      parseDigitalReceiptTemplateSubmitReceipt({
        profile: "DigitalReceiptTemplateSubmitReceiptV1",
        ...fixed,
        operationReference: currentCommand.operationReference,
        templateReference: currentCommand.templateReference,
        expectedVersionReference: currentCommand.expectedVersionReference,
        expectedRevision: currentCommand.expectedRevision,
        intentDigest: intent,
        outcome: submission ? "Committed" : "Abandoned",
        submission,
        auditReference,
        occurredAt,
      }),
    );
  };
  const readOriginal = async () => {
    if (!command) return fail();
    await restore();
    const r = row(
      await query(
        `SELECT ${columns} FROM rms_device.digital_receipt_template_submit_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4 LIMIT 1`,
        [
          fixed.tenantReference,
          fixed.brandReference,
          fixed.storeReference,
          command.operationReference,
        ],
      ),
      17,
    );
    if (!r) return null;
    const value = stored(() => parseDigitalReceiptTemplateSubmitReceipt(r.receipt_json));
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
      result_review_lifecycle_id: value.submission?.reviewLifecycleReference ?? null,
      result_review_version: value.submission ? String(value.submission.reviewVersion) : null,
      submission_digest: value.submission ? digest(value.submission) : null,
      audit_reference: value.auditReference,
      occurred_at: value.occurredAt,
    };
    if (
      Object.entries(pins).some(([k, v]) => r[k] !== v) ||
      value.tenantReference !== fixed.tenantReference ||
      value.brandReference !== fixed.brandReference ||
      value.storeReference !== fixed.storeReference ||
      value.operationReference !== command.operationReference ||
      value.occurredAt > check() ||
      digest(value) !== r.receipt_digest
    )
      return fail();
    return value;
  };
  const matchOriginal = (original: DigitalReceiptTemplateSubmitReceipt) => {
    if (!command) return fail();
    if (original.actorReference !== fixed.actorReference)
      return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
    if (
      original.templateReference !== command.templateReference ||
      original.expectedVersionReference !== command.expectedVersionReference ||
      original.expectedRevision !== command.expectedRevision ||
      original.intentDigest !== intent
    )
      return fail("RECEIPT_TEMPLATE_CONFLICT");
  };
  const persist = async (value: DigitalReceiptTemplateSubmitReceipt) => {
    await restore();
    const s = value.submission;
    const result = await query(
      "INSERT INTO rms_device.digital_receipt_template_submit_operation(operation_id,tenant_id,brand_id,store_id,actor_id,template_id,expected_version_id,expected_revision,intent_digest,outcome,result_review_lifecycle_id,result_review_version,submission_digest,audit_reference,occurred_at,receipt_json,receipt_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17)",
      [
        value.operationReference,
        value.tenantReference,
        value.brandReference,
        value.storeReference,
        value.actorReference,
        value.templateReference,
        value.expectedVersionReference,
        value.expectedRevision,
        value.intentDigest,
        value.outcome,
        s?.reviewLifecycleReference ?? null,
        s?.reviewVersion ?? null,
        s ? digest(s) : null,
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
          if (legacy ? original !== null : !equal(original, held))
            return fail("RECEIPT_TEMPLATE_CONFLICT");
          const actualSubmission = await readSubmission();
          if (!equal(actualSubmission, heldSubmission)) return fail("RECEIPT_TEMPLATE_CONFLICT");
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
  const run = async (selected: "SubmitReview" | "ResolveOriginal", value: unknown) => {
    try {
      if (active || command || phase !== "Work") return fail();
      command =
        selected === "SubmitReview"
          ? parseDigitalReceiptTemplateSubmit(value)
          : parseDigitalReceiptTemplateSubmitResolve(value);
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
        parseDigitalReceiptTemplateSubmit({
          profile: "DigitalReceiptTemplateSubmitV1",
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
      heldSubmission = await readSubmission();
      if (original) {
        matchOriginal(original);
        if (!equal(heldSubmission, original.submission)) return fail();
        held = original;
      } else if (heldSubmission) {
        // Earlier provenance-only source records are retained as recorded facts;
        // do not manufacture a fresh command or replace their original Audit.
        if (heldSubmission.submittedByReference !== fixed.actorReference)
          return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        if (
          heldSubmission.templateReference !== command.templateReference ||
          heldSubmission.versionReference !== command.expectedVersionReference ||
          heldSubmission.draftRevision !== command.expectedRevision
        )
          return fail("RECEIPT_TEMPLATE_CONFLICT");
        held = receipt(heldSubmission, heldSubmission.auditReference, heldSubmission.submittedAt);
        legacy = true;
      } else if (selected === "SubmitReview") {
        const result = await submitPort.call(options, tx, command as DigitalReceiptTemplateSubmit);
        check();
        const submitted = stored(() => parseDigitalReceiptTemplateSubmission(result));
        heldSubmission = await readSubmission();
        if (!equal(submitted, heldSubmission)) return fail();
        held = receipt(submitted, submitted.auditReference, submitted.submittedAt);
        await persist(held);
      } else {
        const at = check(),
          resolved = command as DigitalReceiptTemplateSubmitResolve;
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
    submit: (value: unknown) => run("SubmitReview", value),
    resolve: (value: unknown) => run("ResolveOriginal", value),
    assertFinalized: (actual: DigitalReceiptTemplateSubmitTransaction) => {
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
