import { deriveOrdinaryRefundConfirmedPosition } from "../../application/ordinary-refund-confirmed-position.js";
import {
  createOrdinaryRefundObservation,
  encodeOrdinaryRefundObservation,
  decodeOrdinaryRefundObservation,
} from "../../application/ordinary-refund-observation.js";
import { createHash } from "node:crypto";
import {
  createOrdinaryRefundDispatch,
  encodeOrdinaryRefundDispatch,
  decodeOrdinaryRefundDispatch,
} from "../../application/ordinary-refund-dispatch.js";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseOrdinaryRefundOperation,
  encodeOrdinaryRefundOperation,
  decodeOrdinaryRefundOperation,
  type OrdinaryRefundOperation,
} from "../../application/ordinary-refund-operation.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { ordinaryRefundPaymentAmount } from "../../application/ordinary-refund-request.js";
import { createPostgresOrdinaryRefundApprovalSubjectSource } from "./ordinary-refund-request-store.js";

type SubjectOptions = Parameters<typeof createPostgresOrdinaryRefundApprovalSubjectSource>[0];
type Options = SubjectOptions & {
  /** Trusted composition must retain current executor, escalation/approval,
   * original Provider account/environment and captured-balance fences through
   * commit. No default grant. This adapter does not dispatch to the Provider. */
  validateCurrent(
    tx: ConsumerTransaction,
    operation: OrdinaryRefundOperation,
    observedAt: string,
  ): Promise<boolean>;
};
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_OPERATION_CONFLICT");
};

/** Append preparation and Audit atomically. Replays recover immutable history;
 * they do not authorize first dispatch, retry or release any occupied balance. */
export function createPostgresOrdinaryRefundOperationStore(options: Options) {
  const subjectSource = createPostgresOrdinaryRefundApprovalSubjectSource(options);
  return {
    async record(tx: ConsumerTransaction, value: unknown, auditValue: unknown) {
      const operation = parseOrdinaryRefundOperation(value);
      if (
        operation.tenantReference !== options.scope.tenantReference ||
        operation.brandReference !== options.scope.brandReference ||
        operation.storeReference !== options.scope.storeReference
      )
        return fail();
      const audit = validateAuditRecord(auditValue);
      if (
        audit.auditId !== operation.auditReference ||
        audit.brandId !== operation.brandReference ||
        audit.storeId !== operation.storeReference ||
        audit.actor.type !== "User" ||
        audit.actor.reference !== operation.executorReference ||
        audit.actionCode !== "PAYMENT_ORDINARY_REFUND_PREPARED" ||
        audit.targetType !== "PaymentRefundOperation" ||
        audit.targetId !== operation.operationReference ||
        audit.correlationId !== operation.operationReference ||
        audit.occurredAt !== operation.preparedAt ||
        audit.dataClassification !== "Restricted" ||
        audit.beforeSummary !== undefined ||
        audit.afterSummary !== undefined
      )
        return fail();
      const query = {
        ...options.scope,
        orderReference: operation.orderReference,
        requestReference: operation.requestReference,
      };
      const authorize = async () => {
        if ((await options.authorize(tx, query)) !== true) return fail();
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [operation.brandReference, operation.storeReference],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrdinaryRefundOperation:" +
          operation.brandReference +
          ":" +
          operation.storeReference +
          ":" +
          operation.operationReference,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PaymentReceiptOrder:" +
          operation.brandReference +
          ":" +
          operation.storeReference +
          ":" +
          operation.orderReference,
      ]);
      const encoded = encodeOrdinaryRefundOperation(operation);
      const existing = await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_operation " +
          "WHERE brand_id=$1 AND store_id=$2 AND (operation_id=$3 OR (request_id=$4 AND payment_attempt_id=$5))",
        [
          operation.brandReference,
          operation.storeReference,
          operation.operationReference,
          operation.requestReference,
          operation.paymentAttemptReference,
        ],
      );
      if (existing.rows.length > 1) return fail();
      if (existing.rows.length === 1) {
        if (
          encodeOrdinaryRefundOperation(decodeOrdinaryRefundOperation(existing.rows[0]?.record)) !==
          encoded
        )
          return fail();
        await authorize();
        return Object.freeze({
          status: "AlreadyCommitted" as const,
          operationReference: operation.operationReference,
        });
      }
      const validate = async () => {
        const clock = await tx.query(
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          [],
        );
        if (clock.rows.length !== 1) return fail();
        const time = clock.rows[0]?.now;
        const observedAt = parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
        if (operation.preparedAt > observedAt) return fail();
        const current = await subjectSource(tx, {
          orderReference: operation.orderReference,
          requestReference: operation.requestReference,
          observedAt,
        });
        const leg = current.request.payments.find(
          (entry) => entry.paymentAttemptReference === operation.paymentAttemptReference,
        );
        if (
          current.claimVersion !== operation.claimVersion ||
          current.subject.claimsDigest !== operation.claimsDigest ||
          current.subject.allocationDigest !== operation.allocationDigest ||
          current.subject.policyVersion !== operation.policyVersion ||
          !leg ||
          leg.paymentTransactionReference !== operation.paymentTransactionReference ||
          leg.paymentIntentReference !== operation.paymentIntentReference ||
          leg.firstCaptureReference !== operation.firstCaptureReference ||
          ordinaryRefundPaymentAmount(leg) !== operation.amountMinor ||
          (await options.validateCurrent(tx, operation, observedAt)) !== true
        )
          return fail();
        await authorize();
      };
      await validate();
      await tx.query("SAVEPOINT ordinary_refund_operation_append", []);
      try {
        const inserted = await tx.query(
          "INSERT INTO rms_payment.ordinary_refund_operation " +
            "(tenant_id,brand_id,store_id,order_id,request_id,operation_id,provider_operation_id," +
            "payment_transaction_id,payment_intent_id,payment_attempt_id,first_capture_id," +
            "provider_account_id,executor_id,audit_id,approval_id,claim_version,claims_digest," +
            "allocation_digest,prepared_at,environment,amount_minor,record_json) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)",
          [
            operation.tenantReference,
            operation.brandReference,
            operation.storeReference,
            operation.orderReference,
            operation.requestReference,
            operation.operationReference,
            operation.providerOperationReference,
            operation.paymentTransactionReference,
            operation.paymentIntentReference,
            operation.paymentAttemptReference,
            operation.firstCaptureReference,
            operation.providerAccountReference,
            operation.executorReference,
            operation.auditReference,
            operation.approvalReference,
            operation.claimVersion,
            operation.claimsDigest,
            operation.allocationDigest,
            operation.preparedAt,
            operation.environment,
            operation.amountMinor.toString(),
            encoded,
          ],
        );
        if (inserted.rowCount !== 1) return fail();
        await appendAuditRecordInTransaction(tx, audit);
        await validate();
        await tx.query("RELEASE SAVEPOINT ordinary_refund_operation_append", []);
        return Object.freeze({
          status: "Created" as const,
          operationReference: operation.operationReference,
        });
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT ordinary_refund_operation_append", []);
        await tx.query("RELEASE SAVEPOINT ordinary_refund_operation_append", []);
        throw error;
      }
    },
  };
}

/** Server-side preparation from immutable request facts. Caller supplies only
 * scoped server/command identities, never amount/digests/capture/account/time.
 * Use the same transaction for prepare and runtime.record. Historical recovery
 * returns the original operation and is not a fresh dispatch authorization. */
export function createPostgresOrdinaryRefundOperationPreparationSource(
  options: SubjectOptions & {
    providerAccountReference: string;
    environment: "Test" | "Live";
  },
) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  const providerAccountReference = String(parsePaymentReference(options.providerAccountReference));
  if (options.environment !== "Test" && options.environment !== "Live") return fail();
  const subject = createPostgresOrdinaryRefundApprovalSubjectSource(options);
  const keys = [
    "orderReference",
    "requestReference",
    "paymentAttemptReference",
    "operationReference",
    "providerOperationReference",
    "executorReference",
    "auditReference",
  ] as const;
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, [...keys, "approvalReference"]);
    const ids = Object.fromEntries(
      keys.map((key) => [key, String(parsePaymentReference(raw[key]))]),
    ) as Record<(typeof keys)[number], string>;
    const approvalReference =
      raw.approvalReference === null ? null : String(parsePaymentReference(raw.approvalReference));
    const query = {
      ...scope,
      orderReference: ids.orderReference,
      requestReference: ids.requestReference,
    };
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true) return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    // Same lock order as the writer, including when preparation and write share tx.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrdinaryRefundOperation:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        ids.operationReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        ids.orderReference,
    ]);
    const prior = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_operation " +
        "WHERE brand_id=$1 AND store_id=$2 AND (operation_id=$3 OR (request_id=$4 AND payment_attempt_id=$5))",
      [
        scope.brandReference,
        scope.storeReference,
        ids.operationReference,
        ids.requestReference,
        ids.paymentAttemptReference,
      ],
    );
    if (prior.rows.length > 1) return fail();
    if (prior.rows.length === 1) {
      const stored = decodeOrdinaryRefundOperation(prior.rows[0]?.record);
      if (
        stored.tenantReference !== scope.tenantReference ||
        stored.brandReference !== scope.brandReference ||
        stored.storeReference !== scope.storeReference ||
        stored.providerAccountReference !== providerAccountReference ||
        stored.environment !== options.environment ||
        stored.approvalReference !== approvalReference ||
        keys.some((key) => stored[key] !== ids[key])
      )
        return fail();
      await authorize();
      return stored;
    }
    const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    if (clock.rows.length !== 1) return fail();
    const time = clock.rows[0]?.now;
    const preparedAt = parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
    const current = await subject(tx, {
      orderReference: ids.orderReference,
      requestReference: ids.requestReference,
      observedAt: preparedAt,
    });
    const leg = current.request.payments.find(
      (entry) => entry.paymentAttemptReference === ids.paymentAttemptReference,
    );
    if (!leg) return fail();
    const prepared = parseOrdinaryRefundOperation({
      ...current.subject,
      ...ids,
      approvalReference,
      providerAccountReference,
      environment: options.environment,
      paymentTransactionReference: leg.paymentTransactionReference,
      paymentIntentReference: leg.paymentIntentReference,
      firstCaptureReference: leg.firstCaptureReference,
      claimVersion: current.claimVersion,
      preparedAt,
      currencyCode: current.request.currencyCode,
      amountMinor: ordinaryRefundPaymentAmount(leg),
      status: "Prepared",
    });
    await authorize();
    return prepared;
  };
}

/** First-dispatch journal, atomic with Audit. Caller commits before any I/O.
 * prepareCurrent must retain executor, current approval, balance and original
 * Provider binding fences. Replay is journal recovery, not a new send grant. */
export function createPostgresOrdinaryRefundDispatchStore(
  options: SubjectOptions & {
    prepareCurrent(
      tx: ConsumerTransaction,
      query: {
        operation: OrdinaryRefundOperation;
        approvalReference: string | null;
        observedAt: string;
      },
    ): Promise<{ providerBinding: unknown; claimVersion: number; claimsDigest: string }>;
  },
) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return {
    async record(tx: ConsumerTransaction, value: unknown, policy: unknown) {
      const keys = [
        "orderReference",
        "requestReference",
        "operationReference",
        "dispatchReference",
        "auditReference",
      ] as const;
      const raw = exactPaymentObject(value, [...keys, "approvalReference"]);
      const ids = Object.fromEntries(
        keys.map((key) => [key, String(parsePaymentReference(raw[key]))]),
      ) as Record<(typeof keys)[number], string>;
      const approvalReference =
        raw.approvalReference === null
          ? null
          : String(parsePaymentReference(raw.approvalReference));
      const auditPolicy = exactPaymentObject(policy, [
        "reasonCode",
        "retentionPolicyCode",
        "retentionPolicyVersion",
      ]);
      const query = {
        ...scope,
        orderReference: ids.orderReference,
        requestReference: ids.requestReference,
      };
      const authorize = async () => {
        if ((await options.authorize(tx, query)) !== true) return fail();
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrdinaryRefundOperation:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          ids.operationReference,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PaymentReceiptOrder:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          ids.orderReference,
      ]);
      const prior = await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_dispatch WHERE brand_id=$1 AND store_id=$2 AND (operation_id=$3 OR dispatch_id=$4)",
        [scope.brandReference, scope.storeReference, ids.operationReference, ids.dispatchReference],
      );
      if (prior.rows.length > 1) return fail();
      if (prior.rows.length === 1) {
        const dispatch = decodeOrdinaryRefundDispatch(prior.rows[0]?.record);
        if (
          dispatch.tenantReference !== scope.tenantReference ||
          dispatch.brandReference !== scope.brandReference ||
          dispatch.storeReference !== scope.storeReference ||
          dispatch.approvalReference !== approvalReference ||
          keys.some((key) => dispatch[key] !== ids[key])
        )
          return fail();
        await authorize();
        return Object.freeze({ status: "AlreadyCommitted" as const, dispatch });
      }
      const loaded = await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_operation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
        [scope.brandReference, scope.storeReference, ids.operationReference],
      );
      if (loaded.rows.length !== 1) return fail();
      const operation = decodeOrdinaryRefundOperation(loaded.rows[0]?.record);
      if (
        operation.tenantReference !== scope.tenantReference ||
        operation.brandReference !== scope.brandReference ||
        operation.storeReference !== scope.storeReference ||
        operation.orderReference !== ids.orderReference ||
        operation.requestReference !== ids.requestReference ||
        operation.operationReference !== ids.operationReference
      )
        return fail();
      const now = async () => {
        const clock = await tx.query(
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
          [],
        );
        if (clock.rows.length !== 1) return fail();
        const time = clock.rows[0]?.now;
        return parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
      };
      const startedAt = await now();
      const prepare = async (observedAt: string) => {
        const facts = await options.prepareCurrent(tx, {
          operation,
          approvalReference,
          observedAt,
        });
        await authorize();
        return createOrdinaryRefundDispatch({
          operation,
          providerBinding: facts.providerBinding,
          approvalReference,
          startedAt,
          dispatchReference: ids.dispatchReference,
          auditReference: ids.auditReference,
          claimVersion: facts.claimVersion,
          claimsDigest: facts.claimsDigest,
        });
      };
      const dispatch = await prepare(startedAt);
      const encoded = encodeOrdinaryRefundDispatch(dispatch);
      await tx.query("SAVEPOINT ordinary_refund_dispatch_append", []);
      try {
        const inserted = await tx.query(
          "INSERT INTO rms_payment.ordinary_refund_dispatch (tenant_id,brand_id,store_id,order_id,request_id,operation_id,provider_operation_id,payment_attempt_id,dispatch_id,audit_id,approval_id,claim_version,claims_digest,allocation_digest,operation_digest,provider_request_digest,started_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)",
          [
            dispatch.tenantReference,
            dispatch.brandReference,
            dispatch.storeReference,
            dispatch.orderReference,
            dispatch.requestReference,
            dispatch.operationReference,
            dispatch.providerOperationReference,
            dispatch.paymentAttemptReference,
            dispatch.dispatchReference,
            dispatch.auditReference,
            dispatch.approvalReference,
            dispatch.claimVersion,
            dispatch.claimsDigest,
            dispatch.allocationDigest,
            dispatch.operationDigest,
            dispatch.providerRequestDigest,
            dispatch.startedAt,
            encoded,
          ],
        );
        if (inserted.rowCount !== 1) return fail();
        await appendAuditRecordInTransaction(
          tx,
          validateAuditRecord({
            auditId: dispatch.auditReference,
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: operation.executorReference },
            actionCode: "PAYMENT_ORDINARY_REFUND_DISPATCH_STARTED",
            targetType: "PaymentRefundOperation",
            targetId: operation.operationReference,
            correlationId: dispatch.dispatchReference,
            occurredAt: startedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Restricted",
            reasonCode: auditPolicy.reasonCode,
            retentionPolicyCode: auditPolicy.retentionPolicyCode,
            retentionPolicyVersion: auditPolicy.retentionPolicyVersion,
          }),
        );
        if (encodeOrdinaryRefundDispatch(await prepare(await now())) !== encoded) return fail();
        await tx.query("RELEASE SAVEPOINT ordinary_refund_dispatch_append", []);
        return Object.freeze({ status: "Created" as const, dispatch });
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT ordinary_refund_dispatch_append", []);
        await tx.query("RELEASE SAVEPOINT ordinary_refund_dispatch_append", []);
        throw error;
      }
    },
  };
}

/** Read immutable send history under reconciliation authorization. This is not
 * a new human execution grant and never authorizes resending to the Provider. */
export function createPostgresOrdinaryRefundDispatchReader(options: {
  scope: SubjectOptions["scope"];
  authorize(
    tx: ConsumerTransaction,
    query: SubjectOptions["scope"] & { orderReference: string; operationReference: string },
  ): Promise<boolean>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, ["orderReference", "operationReference"]);
    const query = {
      ...scope,
      orderReference: String(parsePaymentReference(raw.orderReference)),
      operationReference: String(parsePaymentReference(raw.operationReference)),
    };
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true) return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query(
      "SELECT d.record_json::text AS dispatch, o.record_json::text AS operation FROM rms_payment.ordinary_refund_dispatch d JOIN rms_payment.ordinary_refund_operation o ON o.brand_id=d.brand_id AND o.store_id=d.store_id AND o.operation_id=d.operation_id WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=$3 AND d.operation_id=$4",
      [scope.brandReference, scope.storeReference, query.orderReference, query.operationReference],
    );
    if (result.rows.length > 1) return fail();
    await authorize();
    if (result.rows.length === 0) return null;
    const dispatch = decodeOrdinaryRefundDispatch(result.rows[0]?.dispatch);
    const operation = decodeOrdinaryRefundOperation(result.rows[0]?.operation);
    for (const key of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "operationReference",
    ] as const)
      if (dispatch[key] !== query[key] || operation[key] !== query[key]) return fail();
    for (const key of [
      "requestReference",
      "providerOperationReference",
      "paymentAttemptReference",
      "allocationDigest",
    ] as const)
      if (dispatch[key] !== operation[key]) return fail();
    const operationDigest =
      "sha256:" +
      createHash("sha256").update(encodeOrdinaryRefundOperation(operation)).digest("hex");
    if (
      dispatch.operationDigest !== operationDigest ||
      dispatch.startedAt < operation.preparedAt ||
      dispatch.claimVersion < operation.claimVersion ||
      (dispatch.claimVersion === operation.claimVersion &&
        dispatch.claimsDigest !== operation.claimsDigest)
    )
      return fail();
    return Object.freeze({ dispatch, operation });
  };
}

/** Append normalized channel evidence and System Audit atomically. Recovery
 * must resolve original persisted facts, not current human execution authority. */
export function createPostgresOrdinaryRefundObservationStore(options: {
  scope: SubjectOptions["scope"];
  authorize: Parameters<typeof createPostgresOrdinaryRefundDispatchReader>[0]["authorize"];
  recover(
    tx: ConsumerTransaction,
    value: unknown,
  ): Promise<{ dispatch: unknown; request: unknown } | null>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return {
    async record(tx: ConsumerTransaction, value: unknown) {
      const raw = exactPaymentObject(value, [
        "orderReference",
        "operationReference",
        "observationReference",
        "auditReference",
        "outcome",
      ]);
      const query = {
        ...scope,
        orderReference: String(parsePaymentReference(raw.orderReference)),
        operationReference: String(parsePaymentReference(raw.operationReference)),
      };
      const observationReference = String(parsePaymentReference(raw.observationReference));
      const auditReference = String(parsePaymentReference(raw.auditReference));
      const authorize = async () => {
        if ((await options.authorize(tx, query)) !== true) return fail();
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrdinaryRefundObservation:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          observationReference,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PaymentReceiptOrder:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          query.orderReference,
      ]);
      const recovery = await options.recover(tx, {
        orderReference: query.orderReference,
        operationReference: query.operationReference,
      });
      if (!recovery) return fail();
      const build = (recordedAt: string) => {
        const record = createOrdinaryRefundObservation({
          dispatch: recovery.dispatch,
          request: recovery.request,
          outcome: raw.outcome,
          observationReference,
          auditReference,
          recordedAt,
        });
        for (const key of [
          "tenantReference",
          "brandReference",
          "storeReference",
          "orderReference",
          "operationReference",
        ] as const)
          if (record[key] !== query[key]) return fail();
        return record;
      };
      const prior = await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_observation WHERE brand_id=$1 AND store_id=$2 AND (observation_id=$3 OR audit_id=$4)",
        [scope.brandReference, scope.storeReference, observationReference, auditReference],
      );
      if (prior.rows.length > 1) return fail();
      if (prior.rows.length === 1) {
        const observation = decodeOrdinaryRefundObservation(prior.rows[0]?.record);
        if (
          encodeOrdinaryRefundObservation(build(observation.recordedAt)) !==
          encodeOrdinaryRefundObservation(observation)
        )
          return fail();
        await authorize();
        return Object.freeze({ status: "AlreadyCommitted" as const, observation });
      }
      const clock = await tx.query(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
        [],
      );
      if (clock.rows.length !== 1) return fail();
      const time = clock.rows[0]?.now;
      const observation = build(
        parsePaymentInstant(time instanceof Date ? time.toISOString() : time),
      );
      const encoded = encodeOrdinaryRefundObservation(observation);
      await authorize();
      await tx.query("SAVEPOINT ordinary_refund_observation_append", []);
      try {
        const inserted = await tx.query(
          "INSERT INTO rms_payment.ordinary_refund_observation (tenant_id,brand_id,store_id,order_id,request_id,operation_id,provider_operation_id,payment_attempt_id,dispatch_id,observation_id,audit_id,provider_request_digest,provider_environment,outcome_kind,recorded_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)",
          [
            observation.tenantReference,
            observation.brandReference,
            observation.storeReference,
            observation.orderReference,
            observation.requestReference,
            observation.operationReference,
            observation.providerOperationReference,
            observation.paymentAttemptReference,
            observation.dispatchReference,
            observation.observationReference,
            observation.auditReference,
            observation.providerRequestDigest,
            observation.outcome.context.environment,
            observation.outcome.kind,
            observation.recordedAt,
            encoded,
          ],
        );
        if (inserted.rowCount !== 1) return fail();
        await appendAuditRecordInTransaction(
          tx,
          validateAuditRecord({
            auditId: observation.auditReference,
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "PAYMENT_ORDINARY_REFUND_OBSERVED",
            targetType: "PaymentRefundOperation",
            targetId: observation.operationReference,
            correlationId: observation.observationReference,
            occurredAt: observation.recordedAt,
            sourceChannel: "PAYMENT_RECONCILIATION",
            dataClassification: "Restricted",
            reasonCode: "PROVIDER_OUTCOME_OBSERVED",
            retentionPolicyCode: "FINANCIAL_COMPLIANCE",
            retentionPolicyVersion: 1,
          }),
        );
        await authorize();
        await tx.query("RELEASE SAVEPOINT ordinary_refund_observation_append", []);
        return Object.freeze({ status: "Created" as const, observation });
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT ordinary_refund_observation_append", []);
        await tx.query("RELEASE SAVEPOINT ordinary_refund_observation_append", []);
        throw error;
      }
    },
  };
}

/** Lock one observation identity so concurrent reconciliation attempts recover
 * the first committed observation rather than replacing its channel evidence. */
export function createPostgresOrdinaryRefundObservationReader(
  options: Parameters<typeof createPostgresOrdinaryRefundObservationStore>[0],
) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, [
      "orderReference",
      "operationReference",
      "observationReference",
    ]);
    const query = {
      ...scope,
      orderReference: String(parsePaymentReference(raw.orderReference)),
      operationReference: String(parsePaymentReference(raw.operationReference)),
    };
    const observationReference = String(parsePaymentReference(raw.observationReference));
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true) return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrdinaryRefundObservation:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        observationReference,
    ]);
    const rows = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_observation WHERE brand_id=$1 AND store_id=$2 AND observation_id=$3",
      [scope.brandReference, scope.storeReference, observationReference],
    );
    if (rows.rows.length > 1) return fail();
    await authorize();
    if (rows.rows.length === 0) return null;
    const observation = decodeOrdinaryRefundObservation(rows.rows[0]?.record);
    for (const key of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "operationReference",
    ] as const)
      if (observation[key] !== query[key]) return fail();
    if (observation.observationReference !== observationReference) return fail();
    const recovery = await options.recover(tx, {
      orderReference: query.orderReference,
      operationReference: query.operationReference,
    });
    if (!recovery) return fail();
    const rebuilt = createOrdinaryRefundObservation({
      dispatch: recovery.dispatch,
      request: recovery.request,
      observationReference,
      auditReference: observation.auditReference,
      outcome: observation.outcome,
      recordedAt: observation.recordedAt,
    });
    if (encodeOrdinaryRefundObservation(rebuilt) !== encodeOrdinaryRefundObservation(observation))
      return fail();
    await authorize();
    return observation;
  };
}

/** Complete persisted history for one requested payment leg, under the Order
 * fence also held by the observation writer. Missing dispatch stays pending. */
export function createPostgresOrdinaryRefundClaimOutcomeReader(options: {
  scope: SubjectOptions["scope"];
  authorize(tx: ConsumerTransaction): Promise<boolean>;
  recover: Parameters<typeof createPostgresOrdinaryRefundObservationStore>[0]["recover"];
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, [
      "orderReference",
      "requestReference",
      "paymentAttemptReference",
      "observedAt",
    ]);
    const order = String(parsePaymentReference(raw.orderReference));
    const request = String(parsePaymentReference(raw.requestReference));
    const attempt = String(parsePaymentReference(raw.paymentAttemptReference));
    const observedAt = parsePaymentInstant(raw.observedAt);
    const authorize = async () => {
      if ((await options.authorize(tx)) !== true) return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" + scope.brandReference + ":" + scope.storeReference + ":" + order,
    ]);
    const rows = await tx.query(
      "SELECT o.record_json::text AS operation FROM rms_payment.ordinary_refund_operation o JOIN rms_payment.ordinary_refund_dispatch d ON d.brand_id=o.brand_id AND d.store_id=o.store_id AND d.operation_id=o.operation_id WHERE o.brand_id=$1 AND o.store_id=$2 AND o.order_id=$3 AND o.request_id=$4 AND o.payment_attempt_id=$5",
      [scope.brandReference, scope.storeReference, order, request, attempt],
    );
    await authorize();
    if (rows.rows.length > 1) return fail();
    if (rows.rows.length === 0) return null;
    const operation = decodeOrdinaryRefundOperation(rows.rows[0]?.operation);
    if (
      operation.tenantReference !== scope.tenantReference ||
      operation.brandReference !== scope.brandReference ||
      operation.storeReference !== scope.storeReference ||
      operation.orderReference !== order ||
      operation.requestReference !== request ||
      operation.paymentAttemptReference !== attempt ||
      operation.preparedAt > observedAt
    )
      return fail();
    const recovered = await options.recover(tx, {
      orderReference: order,
      operationReference: operation.operationReference,
    });
    if (!recovered) return fail();
    const observations = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_observation WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 ORDER BY recorded_at,observation_id LIMIT 1001",
      [scope.brandReference, scope.storeReference, operation.operationReference],
    );
    if (observations.rows.length > 1000) return fail();
    const position = deriveOrdinaryRefundConfirmedPosition({
      dispatch: recovered.dispatch,
      request: recovered.request,
      observedAt,
      observations: observations.rows.map((row) => decodeOrdinaryRefundObservation(row.record)),
    });
    await authorize();
    return Object.freeze({ operation, position });
  };
}

/** Bounded owner scan only. A candidate never grants dispatch authority.
 * Revisit journaled operations for reconciliation/receipt recovery; durable
 * send/reconcile runtimes decide effects under their current authority. */
export function createPostgresOrdinaryRefundWorkSource(options: {
  scope: SubjectOptions["scope"] & {
    providerAccountReference: string;
    environment: "Test" | "Live";
  };
  authorize(tx: ConsumerTransaction, scope: SubjectOptions["scope"]): Promise<boolean>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
    providerAccountReference: String(parsePaymentReference(options.scope.providerAccountReference)),
    environment: options.scope.environment,
  };
  if (scope.environment !== "Test" && scope.environment !== "Live") return fail();
  return async (
    tx: ConsumerTransaction,
    input: {
      afterOperationReference: string | null;
      limit: number;
    },
  ) => {
    const raw = exactPaymentObject(input, ["afterOperationReference", "limit"]);
    const after =
      raw.afterOperationReference === null
        ? null
        : String(parsePaymentReference(raw.afterOperationReference));
    if (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 100)
      return fail();
    const limit = raw.limit as number;
    const allowed = async () => {
      if (!(await options.authorize(tx, scope))) return fail();
    };
    await allowed();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query<{ record: string; operation_id: string; has_dispatch: boolean }>(
      "SELECT o.record_json::text AS record,o.operation_id,EXISTS(SELECT 1 FROM rms_payment.ordinary_refund_dispatch d WHERE d.tenant_id=o.tenant_id AND d.brand_id=o.brand_id AND d.store_id=o.store_id AND d.operation_id=o.operation_id) AS has_dispatch FROM rms_payment.ordinary_refund_operation o WHERE o.tenant_id=$1 AND o.brand_id=$2 AND o.store_id=$3 AND o.provider_account_id=$4 AND o.environment=$5 AND ($6::uuid IS NULL OR o.operation_id>$6::uuid) ORDER BY o.operation_id LIMIT $7",
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        scope.providerAccountReference,
        scope.environment,
        after,
        limit + 1,
      ],
    );
    let previous = after;
    const parsed = result.rows.map((row) => {
      const operation = decodeOrdinaryRefundOperation(row.record);
      if (
        operation.tenantReference !== scope.tenantReference ||
        operation.brandReference !== scope.brandReference ||
        operation.storeReference !== scope.storeReference ||
        operation.providerAccountReference !== scope.providerAccountReference ||
        operation.environment !== scope.environment ||
        operation.operationReference !== row.operation_id ||
        (previous !== null && operation.operationReference <= previous) ||
        typeof row.has_dispatch !== "boolean"
      )
        return fail();
      previous = operation.operationReference;
      return Object.freeze({
        operationReference: operation.operationReference,
        orderReference: operation.orderReference,
        requestReference: operation.requestReference,
        workKind: row.has_dispatch ? ("Reconcile" as const) : ("Dispatch" as const),
      });
    });
    await allowed();
    const candidates = parsed.slice(0, limit);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      nextAfterOperationReference:
        parsed.length > limit ? (candidates.at(-1)?.operationReference ?? null) : null,
    });
  };
}

/** Read immutable preparation by request/payment. Order fence only: safe when
 * caller already holds that fence; never invert writer operation->order locks. */
export function createPostgresOrdinaryRefundPreparedReader(
  options: SubjectOptions & { providerAccountReference: string; environment: "Test" | "Live" },
) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  const account = String(parsePaymentReference(options.providerAccountReference));
  if (options.environment !== "Test" && options.environment !== "Live") return fail();
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, [
      "orderReference",
      "requestReference",
      "paymentAttemptReference",
      "observedAt",
    ]);
    const order = String(parsePaymentReference(raw.orderReference)),
      request = String(parsePaymentReference(raw.requestReference)),
      attempt = String(parsePaymentReference(raw.paymentAttemptReference)),
      at = parsePaymentInstant(raw.observedAt);
    const authorize = async () => {
      if (
        (await options.authorize(tx, {
          ...scope,
          orderReference: order,
          requestReference: request,
        })) !== true
      )
        return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" + scope.brandReference + ":" + scope.storeReference + ":" + order,
    ]);
    const rows = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_operation WHERE brand_id=$1 AND store_id=$2 AND request_id=$3 AND payment_attempt_id=$4",
      [scope.brandReference, scope.storeReference, request, attempt],
    );
    if (rows.rows.length > 1) return fail();
    const operation =
      rows.rows.length === 0 ? null : decodeOrdinaryRefundOperation(rows.rows[0]?.record);
    if (
      operation &&
      (operation.tenantReference !== scope.tenantReference ||
        operation.brandReference !== scope.brandReference ||
        operation.storeReference !== scope.storeReference ||
        operation.orderReference !== order ||
        operation.requestReference !== request ||
        operation.paymentAttemptReference !== attempt ||
        operation.providerAccountReference !== account ||
        operation.environment !== options.environment ||
        operation.preparedAt > at)
    )
      return fail();
    await authorize();
    return operation;
  };
}
