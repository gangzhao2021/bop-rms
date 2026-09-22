import { resolveOrderRevisionChain } from "../../domain/order-revision-chain.js";
import { decodeOrderFulfillmentCompletionRecord } from "../../application/order-fulfillment-completion-record.js";
import { parseOrderInitialExecution } from "../../application/order-initial-execution.js";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseOrderTerminationRecord,
  OrderTerminationError,
  type OrderTerminationRecord,
} from "../../application/order-termination-record.js";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";

const columns = {
  terminationReference: "termination_id",
  operationReference: "operation_id",
  brandReference: "brand_id",
  storeReference: "store_id",
  orderReference: "order_id",
  orderBatchReference: "order_batch_id",
  expectedOrderVersion: "expected_order_version",
  terminatedOrderVersion: "terminated_order_version",
  expectedSourceCheckpoint: "expected_source_checkpoint",
  previousPhase: "previous_phase",
  phase: "phase",
  actorType: "actor_type",
  actorReference: "actor_id",
  purposeCode: "purpose_code",
  permissionCode: "permission_code",
  reasonCode: "reason_code",
  workflowVersionReference: "workflow_version_id",
  transitionReference: "transition_id",
  sourceDigest: "source_digest",
  terminatedAt: "terminated_at",
} as const;
const keys = Object.keys(columns) as (keyof typeof columns)[];
const selection = keys.map((key) => columns[key] + ' AS "' + key + '"').join(",");
const fail = (conflict = false): never => {
  throw new OrderTerminationError(
    conflict ? "ORDER_TERMINATION_CONFLICT" : "ORDER_TERMINATION_UNAVAILABLE",
  );
};
function bind(row: Record<string, unknown> | undefined) {
  return parseOrderTerminationRecord({
    ...row,
    terminatedAt:
      row?.terminatedAt instanceof Date ? row.terminatedAt.toISOString() : row?.terminatedAt,
  });
}
type Scope = Readonly<{
  brandReference: string;
  storeReference: string;
  orderReference: string;
  orderBatchReference: string;
}>;
async function setScope(
  tx: ConsumerTransaction,
  scope: Pick<Scope, "brandReference" | "storeReference">,
) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
}

async function fence(tx: ConsumerTransaction, scope: Omit<Scope, "orderBatchReference">) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "OrderingOrderDisposition:" +
      scope.brandReference +
      ":" +
      scope.storeReference +
      ":" +
      scope.orderReference,
  ]);
}
async function current(tx: ConsumerTransaction, scope: Scope) {
  const completed = await tx.query(
    "SELECT completion_id FROM rms_ordering.order_fulfillment_completion_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 1",
    [scope.brandReference, scope.storeReference, scope.orderReference],
  );
  // This reader represents only the initial window; never return stale Accepted after delivery.
  if (completed.rows.length !== 0) return fail(true);
  return initialHistory(tx, scope);
}

async function initialHistory(tx: ConsumerTransaction, scope: Scope) {
  const values = [
    scope.brandReference,
    scope.storeReference,
    scope.orderReference,
    scope.orderBatchReference,
  ];
  const original = await tx.query(
    "SELECT h.aggregate_version,h.canonical_phase,b.submission_id,b.submitted_at FROM rms_ordering.order_header h " +
      "JOIN rms_ordering.order_batch b ON b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.order_id=h.order_id " +
      "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 AND b.order_batch_id=$4 FOR SHARE OF h,b",
    values,
  );
  const row = original.rows[0];
  if (
    original.rows.length !== 1 ||
    row?.aggregate_version !== 1 ||
    row.canonical_phase !== "Submitted"
  )
    return fail();
  let state = Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: scope.orderReference,
    orderBatchReference: scope.orderBatchReference,
    phase: "Submitted" as "Submitted" | "Accepted" | "Cancelled" | "Rejected",
    version: 1 as number,
    checkpoint: parseOrderingReference(row.submission_id),
    occurredAt: parseOrderingInstant(
      row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at,
    ),
  });
  const accepted = await tx.query(
    "SELECT acceptance_id,order_batch_id,expected_order_version,accepted_order_version,accepted_at FROM rms_ordering.order_acceptance_record " +
      "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 2",
    values.slice(0, 3),
  );
  if (accepted.rows.length > 1) return fail(true);
  if (accepted.rows.length === 1) {
    const a = accepted.rows[0];
    if (
      !a ||
      a.order_batch_id !== scope.orderBatchReference ||
      a.expected_order_version !== state.version ||
      a.accepted_order_version !== state.version + 1
    )
      return fail(true);
    const at = parseOrderingInstant(
      a.accepted_at instanceof Date ? a.accepted_at.toISOString() : a.accepted_at,
    );
    if (at < state.occurredAt) return fail(true);
    state = Object.freeze({
      ...state,
      phase: "Accepted",
      version: a.accepted_order_version,
      checkpoint: parseOrderingReference(a.acceptance_id),
      occurredAt: at,
    });
  }
  const terminal = await tx.query(
    "SELECT " +
      selection +
      " FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 2",
    values.slice(0, 3),
  );
  if (terminal.rows.length > 1) return fail(true);
  if (terminal.rows.length === 1) {
    const t = bind(terminal.rows[0]);
    if (
      t.brandReference !== scope.brandReference ||
      t.storeReference !== scope.storeReference ||
      t.orderReference !== scope.orderReference ||
      t.orderBatchReference !== scope.orderBatchReference ||
      t.expectedOrderVersion !== state.version ||
      t.expectedSourceCheckpoint !== state.checkpoint ||
      t.previousPhase !== state.phase ||
      t.terminatedAt < state.occurredAt
    )
      return fail(true);
    state = Object.freeze({
      ...state,
      phase: t.phase,
      version: t.terminatedOrderVersion,
      checkpoint: t.terminationReference,
      occurredAt: t.terminatedAt,
    });
  }
  return parseOrderInitialExecution(state);
}

/** Current initial acceptance/termination only. Kitchen, amendment and financial gates remain separate. */
export function createPostgresOrderInitialExecutionReader(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, scope: Scope): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async loadByBatch(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      orderBatchReference: string;
    }) {
      const scope = Object.freeze({
        brandReference: brand,
        storeReference: store,
        orderReference: parseOrderingReference(input.orderReference),
        orderBatchReference: parseOrderingReference(input.orderBatchReference),
      });
      await setScope(input.transaction, scope);
      if ((await options.authorize(input.transaction, scope)) !== true) return fail();
      await fence(input.transaction, scope);
      return current(input.transaction, scope);
    },
  });
}

/** Resolve the sole Pickup Batch without relying on a caller-supplied submission reference. */
export function createPostgresPickupOrderCompletionLookup(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    scope: Omit<Scope, "orderBatchReference">,
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async loadByOrder(input: { transaction: ConsumerTransaction; orderReference: string }) {
      const scope = Object.freeze({
        brandReference: brand,
        storeReference: store,
        orderReference: parseOrderingReference(input.orderReference),
      });
      const tx = input.transaction;
      await setScope(tx, scope);
      if ((await options.authorize(tx, scope)) !== true) return fail();
      await fence(tx, scope);
      const result = await tx.query(
        "SELECT h.order_type,b.order_batch_id,b.submission_id FROM rms_ordering.order_header h " +
          "JOIN rms_ordering.order_batch b ON b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.order_id=h.order_id " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 " +
          "ORDER BY b.submitted_at,b.order_batch_id LIMIT 10002 FOR SHARE OF h,b",
        [brand, store, scope.orderReference],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      if (result.rows.length !== 1 || row?.order_type !== "Pickup") return fail(true);
      return Object.freeze({
        ...scope,
        orderBatchReference: parseOrderingReference(row.order_batch_id),
        submissionReference: parseOrderingReference(row.submission_id),
      });
    },
  });
}

/** Owner history query; no projection, financial finality or action eligibility is inferred. */
export function createPostgresOrderExecutionReader(options: {
  brandReference: string;
  storeReference: string;
  sha256(value: string): string;
  authorize(transaction: ConsumerTransaction, scope: Scope): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async loadByBatch(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      orderBatchReference: string;
    }) {
      const tx = input.transaction;
      const scope = Object.freeze({
        brandReference: brand,
        storeReference: store,
        orderReference: parseOrderingReference(input.orderReference),
        orderBatchReference: parseOrderingReference(input.orderBatchReference),
      });
      await setScope(tx, scope);
      if ((await options.authorize(tx, scope)) !== true) return fail();
      await fence(tx, scope);
      const initial = await initialHistory(tx, scope);
      const saved = await tx.query(
        "SELECT completion_record_json::text AS record FROM rms_ordering.order_fulfillment_completion_record " +
          "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 LIMIT 2",
        [brand, store, scope.orderReference],
      );
      if (saved.rows.length > 1) return fail(true);
      if (saved.rows.length === 0) return Object.freeze({ ...initial, completion: null });
      const completion = decodeOrderFulfillmentCompletionRecord(
        saved.rows[0]?.record,
        options.sha256,
      );
      if (
        completion.brandReference !== brand ||
        completion.storeReference !== store ||
        completion.orderReference !== scope.orderReference ||
        completion.orderBatchReference !== scope.orderBatchReference ||
        completion.phaseBefore !== initial.phase ||
        completion.expectedOrderVersion !== initial.version ||
        completion.expectedSourceCheckpoint !== initial.checkpoint ||
        completion.completedAt < initial.occurredAt
      )
        return fail(true);
      const header = await tx.query(
        "SELECT order_type FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR SHARE",
        [brand, store, scope.orderReference],
      );
      if (header.rows.length !== 1 || header.rows[0]?.order_type !== "Pickup") return fail(true);
      return Object.freeze({
        ...scope,
        phase: completion.phase,
        version: completion.fulfilledOrderVersion,
        checkpoint: completion.completionReference,
        occurredAt: completion.recordedAt,
        completion,
      });
    },
  });
}

/** Caller holds all current eligibility fences and owns transaction commit/rollback. */
export function createPostgresOrderTerminationStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(transaction: ConsumerTransaction, record: OrderTerminationRecord): Promise<boolean>;
  validateCurrentSource(
    transaction: ConsumerTransaction,
    record: OrderTerminationRecord,
  ): Promise<boolean>;
  audit(record: OrderTerminationRecord): Promise<unknown>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async commit(input: { transaction: ConsumerTransaction; record: unknown }) {
      const record = parseOrderTerminationRecord(input.record),
        tx = input.transaction;
      if (record.brandReference !== brand || record.storeReference !== store) return fail();
      await setScope(tx, record);
      if ((await options.authorize(tx, record)) !== true) return fail();
      // Order first matches acceptance and Payment, including a caller that already holds this fence.
      await fence(tx, record);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingTerminationOperation:" + brand + ":" + store + ":" + record.operationReference,
      ]);
      const prior = await tx.query(
        "SELECT " +
          selection +
          " FROM rms_ordering.order_termination_record WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
        [brand, store, record.operationReference],
      );
      if (prior.rows.length > 1) return fail(true);
      if (prior.rows.length === 1) {
        const original = bind(prior.rows[0]);
        for (const key of keys)
          if (
            key !== "terminationReference" &&
            key !== "terminatedAt" &&
            original[key] !== record[key]
          )
            return fail(true);
        return Object.freeze({ status: "AlreadyCommitted" as const, record: original });
      }
      const state = await current(tx, record);
      if (
        state.version !== record.expectedOrderVersion ||
        state.checkpoint !== record.expectedSourceCheckpoint ||
        state.phase !== record.previousPhase ||
        record.terminatedAt < state.occurredAt
      )
        return fail(true);
      if ((await options.validateCurrentSource(tx, record)) !== true) return fail();
      const audit = validateAuditRecord(await options.audit(record));
      if (
        audit.brandId !== brand ||
        audit.storeId !== store ||
        audit.actor.type !== record.actorType ||
        (audit.actor.type === "User" && audit.actor.reference !== record.actorReference) ||
        audit.actionCode !== "ORDER_TERMINATED" ||
        audit.targetType !== "Order" ||
        audit.targetId !== record.orderReference ||
        audit.correlationId !== record.operationReference ||
        audit.reasonCode !== record.reasonCode ||
        audit.occurredAt !== record.terminatedAt ||
        audit.beforeSummary !== undefined ||
        JSON.stringify(audit.afterSummary) !== JSON.stringify({ phase: record.phase }) ||
        audit.dataClassification !== "Restricted"
      )
        return fail(true);
      if ((await options.authorize(tx, record)) !== true) return fail();
      await tx.query("SAVEPOINT ordering_termination_revision", []);
      try {
        const inserted = await tx.query(
          "INSERT INTO rms_ordering.order_termination_record (" +
            keys.map((key) => columns[key]).join(",") +
            ") VALUES (" +
            keys.map((_, i) => "$" + (i + 1)).join(",") +
            ")",
          keys.map((key) => record[key]),
        );
        if (inserted.rowCount !== 1) return fail(true);
        await appendAuditRecordInTransaction(tx, audit);
        const revision = await tx.query(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) " +
            "SELECT $4::uuid,$1::uuid,$2::uuid,$3::uuid,'Termination',$5::integer,$6::integer,r.revision_id,NULL,$7::timestamptz FROM rms_ordering.order_revision r " +
            "WHERE r.brand_id=$1::uuid AND r.store_id=$2::uuid AND r.order_id=$3::uuid AND r.version=$6::integer AND r.occurred_at<=$7::timestamptz AND r.revision_id=$8::uuid",
          [
            brand,
            store,
            record.orderReference,
            record.terminationReference,
            record.terminatedOrderVersion,
            record.expectedOrderVersion,
            record.terminatedAt,
            record.expectedSourceCheckpoint,
          ],
        );
        if (revision.rowCount !== 1) return fail(true);
        await tx.query("RELEASE SAVEPOINT ordering_termination_revision", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_termination_revision", []);
        await tx.query("RELEASE SAVEPOINT ordering_termination_revision", []);
        return fail(true);
      }
      return Object.freeze({ status: "Created" as const, record });
    },
  });
}

/** Current persisted initial Dining Order eligibility for additional preparation.
 * Uses the same disposition fence as acceptance/termination. Additional history
 * must extend this owner source before the single-submission constraint is relaxed.
 * Caller retains the supplied transaction; Identity/Host and other final-write
 * gates are independently required.
 */
async function multiBatchPreparationVersion(
  tx: ConsumerTransaction,
  scope: Omit<Scope, "orderBatchReference">,
  batchCount: number,
  observedAt: string,
  includeCancelled = false,
) {
  const values = [scope.brandReference, scope.storeReference, scope.orderReference];
  const rows = (
    await tx.query(
      "SELECT r.revision_id,r.version,r.expected_version,r.previous_revision_id,r.initial_submission_id,r.kind,r.occurred_at," +
        "(SELECT c.phase FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=r.brand_id AND c.store_id=r.store_id AND c.order_id=r.order_id AND c.cancellation_id=r.revision_id) AS cancellation_phase," +
        "CASE r.kind WHEN 'Initial' THEN EXISTS (SELECT 1 FROM rms_ordering.order_submission_record s JOIN rms_ordering.order_batch b ON b.submission_id=s.submission_id AND b.brand_id=s.brand_id AND b.store_id=s.store_id AND b.order_id=s.order_id WHERE s.brand_id=r.brand_id AND s.store_id=r.store_id AND s.order_id=r.order_id AND s.submission_id=r.revision_id AND s.submission_kind='Initial' AND b.submitted_at=r.occurred_at) " +
        "WHEN 'Acceptance' THEN EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.acceptance_id=r.revision_id AND a.expected_order_version=r.expected_version AND a.accepted_order_version=r.version AND a.accepted_at=r.occurred_at) " +
        "WHEN 'BatchCancellation' THEN EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=r.brand_id AND c.store_id=r.store_id AND c.order_id=r.order_id AND c.cancellation_id=r.revision_id AND c.expected_source_checkpoint=r.previous_revision_id AND c.expected_order_version=r.expected_version AND c.cancelled_order_version=r.version AND c.cancelled_at=r.occurred_at) " +
        "WHEN 'AdditionalBatch' THEN EXISTS (SELECT 1 FROM rms_ordering.additional_dining_batch_record a JOIN rms_ordering.order_batch b ON b.order_batch_id=a.order_batch_id AND b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.order_id=a.order_id AND b.submission_id=a.submission_id WHERE a.brand_id=r.brand_id AND a.store_id=r.store_id AND a.order_id=r.order_id AND a.submission_id=r.revision_id AND b.submitted_at=r.occurred_at AND a.batch_sequence=(SELECT count(*)+1 FROM rms_ordering.order_revision p WHERE p.brand_id=r.brand_id AND p.store_id=r.store_id AND p.order_id=r.order_id AND p.kind='AdditionalBatch' AND p.version<=r.version)) ELSE false END AS operation_bound " +
        "FROM rms_ordering.order_revision r WHERE r.brand_id=$1 AND r.store_id=$2 AND r.order_id=$3 ORDER BY r.version LIMIT 10002",
      values,
    )
  ).rows;
  // A terminal revision never grants another checkout. Unsupported states fail closed.
  if (rows.some((row) => row.kind === "Termination" || row.kind === "Fulfillment")) return null;
  const root = rows[0];
  if (
    !root ||
    root.kind !== "Initial" ||
    root.version !== 1 ||
    root.revision_id !== root.initial_submission_id ||
    root.expected_version !== 0 ||
    root.previous_revision_id !== null ||
    rows.some((row) => row.operation_bound !== true) ||
    rows.filter((row) => row.kind === "AdditionalBatch").length + 1 !== batchCount
  )
    return fail(true);
  const time = (value: unknown) =>
    parseOrderingInstant(value instanceof Date ? value.toISOString() : value);
  const chain = resolveOrderRevisionChain({
    ...scope,
    initialSubmissionReference: root.initial_submission_id,
    createdAt: time(root.occurred_at),
    revisions: rows.slice(1).map((row) => ({
      ...scope,
      revisionReference: row.revision_id,
      previousRevisionReference: row.previous_revision_id,
      expectedVersion: row.expected_version,
      version: row.version,
      occurredAt: time(row.occurred_at),
      kind: row.kind,
    })),
  });
  if (chain.occurredAt > observedAt) return fail();
  // Cancellation phase belongs to one Batch. Only a fully bound cancellation
  // for every persisted Batch makes the whole Order unavailable here.
  const allCancelled =
    rows.filter((row) => row.kind === "BatchCancellation" && row.cancellation_phase === "Cancelled")
      .length === batchCount;
  if (allCancelled && !includeCancelled) return null;
  return {
    version: chain.version,
    checkpoint: chain.checkpoint,
    allCancelled,
    canonicalPhase: rows.some((row) => row.kind === "Acceptance")
      ? ("Accepted" as const)
      : ("Submitted" as const),
  };
}

export function createPostgresDiningOrderPreparationSource(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    transaction: ConsumerTransaction,
    scope: Readonly<{
      brandReference: string;
      storeReference: string;
      orderReference: string;
      diningSessionReference: string;
      guestSessionReference: string;
    }>,
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const source = Object.freeze({
    async resolve(
      input: {
        transaction: ConsumerTransaction;
        brandReference: string;
        storeReference: string;
        orderReference: string;
        diningSessionReference: string;
        guestSessionReference: string;
        observedAt: string;
      },
      includeCancelled = false,
    ) {
      const scope = Object.freeze({
        brandReference: parseOrderingReference(input.brandReference),
        storeReference: parseOrderingReference(input.storeReference),
        orderReference: parseOrderingReference(input.orderReference),
        diningSessionReference: parseOrderingReference(input.diningSessionReference),
        guestSessionReference: parseOrderingReference(input.guestSessionReference),
      });
      const observedAt = parseOrderingInstant(input.observedAt);
      if (scope.brandReference !== brand || scope.storeReference !== store) return fail();
      const tx = input.transaction;
      await setScope(tx, scope);
      if ((await options.authorize(tx, scope)) !== true) return fail();
      await fence(tx, scope);
      const found = await tx.query(
        "SELECT h.order_type,h.dining_session_id,b.order_batch_id FROM rms_ordering.order_header h " +
          "JOIN rms_ordering.order_batch b ON b.order_id=h.order_id AND b.brand_id=h.brand_id AND b.store_id=h.store_id " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 ORDER BY b.submitted_at,b.order_batch_id LIMIT 10002 FOR SHARE OF h,b",
        [brand, store, scope.orderReference],
      );
      if (found.rows.length === 0) return null;
      if (found.rows.length > 10001) return fail(true);
      const row = found.rows[0];
      if (
        !row ||
        row.order_type !== "DineIn" ||
        row.dining_session_id !== scope.diningSessionReference
      )
        return null;
      const orderVersion = await multiBatchPreparationVersion(
        tx,
        {
          brandReference: brand,
          storeReference: store,
          orderReference: scope.orderReference,
        },
        found.rows.length,
        observedAt,
        includeCancelled,
      );
      if (orderVersion === null) {
        if ((await options.authorize(tx, scope)) !== true) return fail();
        return null;
      }
      if (found.rows.length > 1 || orderVersion.allCancelled) {
        if (
          found.rows.some(
            (batch) =>
              batch.order_type !== "DineIn" ||
              batch.dining_session_id !== scope.diningSessionReference,
          )
        )
          return fail(true);
        if ((await options.authorize(tx, scope)) !== true) return fail();
        return Object.freeze({
          brandReference: brand,
          storeReference: store,
          diningSessionReference: scope.diningSessionReference,
          orderReference: scope.orderReference,
          orderVersion: orderVersion.version,
          orderCheckpoint: orderVersion.checkpoint,
          canonicalPhase: orderVersion.canonicalPhase,
          allCancelled: orderVersion.allCancelled,
        });
      }
      const state = await current(tx, {
        ...scope,
        orderBatchReference: parseOrderingReference(row.order_batch_id),
      });
      const revisions = await tx.query(
        "SELECT revision_id,version,occurred_at FROM rms_ordering.order_revision " +
          "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY version DESC LIMIT 1",
        [brand, store, scope.orderReference],
      );
      const revision = revisions.rows[0];
      if (
        revisions.rows.length !== 1 ||
        revision?.revision_id !== state.checkpoint ||
        revision.version !== state.version ||
        parseOrderingInstant(
          revision.occurred_at instanceof Date
            ? revision.occurred_at.toISOString()
            : revision.occurred_at,
        ) !== state.occurredAt
      )
        return fail(true);
      if (state.occurredAt > observedAt) return fail();
      if ((await options.authorize(tx, scope)) !== true) return fail();
      if (state.phase !== "Submitted" && state.phase !== "Accepted") return null;
      return Object.freeze({
        brandReference: brand,
        storeReference: store,
        diningSessionReference: scope.diningSessionReference,
        orderReference: scope.orderReference,
        orderVersion: state.version,
        orderCheckpoint: state.checkpoint,
        canonicalPhase: state.phase,
        allCancelled: false,
      });
    },
  });

  // Keep the existing capacity/preparation contract closed and unchanged.
  const resolve = async (input: Parameters<typeof source.resolve>[0]) => {
    const result = await source.resolve(input);
    if (result === null) return null;
    const { canonicalPhase, orderCheckpoint, allCancelled, ...existing } = result;
    void allCancelled;
    void canonicalPhase;
    void orderCheckpoint;
    return Object.freeze(existing);
  };
  return Object.freeze({
    resolve,
    /** Current payable phase/version under the caller-retained Order disposition lock. */
    async resolveCurrent(input: Parameters<typeof source.resolve>[0]) {
      const result = await source.resolve(input);
      if (result === null) return null;
      const { allCancelled, ...current } = result;
      void allCancelled;
      return Object.freeze(current);
    },
    /** Terminal display only. Never grants checkout or another batch. */
    async resolveCancelled(input: Parameters<typeof source.resolve>[0]) {
      const result = await source.resolve(input, true);
      return result?.allCancelled
        ? Object.freeze({
            brandReference: result.brandReference,
            storeReference: result.storeReference,
            orderReference: result.orderReference,
            orderVersion: result.orderVersion,
            phase: "Cancelled" as const,
          })
        : null;
    },
    /** Parent facts for fresh Additional submission, under the same disposition fence. */
    async resolveAdditionalParent(input: Parameters<typeof source.resolve>[0]) {
      const current = await resolve(input);
      if (current === null) return null;
      const found = await input.transaction.query(
        "SELECT h.created_at,r.occurred_at AS initial_at," +
          "(SELECT count(*)::int FROM rms_ordering.order_batch b " +
          "WHERE b.brand_id=h.brand_id AND b.store_id=h.store_id AND b.order_id=h.order_id) AS batch_count " +
          "FROM rms_ordering.order_header h JOIN rms_ordering.order_revision r " +
          "ON r.brand_id=h.brand_id AND r.store_id=h.store_id AND r.order_id=h.order_id " +
          "AND r.kind='Initial' AND r.version=1 " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 LIMIT 2",
        [brand, store, current.orderReference],
      );
      if (found.rows.length !== 1) return fail(true);
      const row = found.rows[0];
      const instant = (value: unknown) =>
        parseOrderingInstant(value instanceof Date ? value.toISOString() : value);
      const originalOrderCreatedAt = instant(row?.created_at);
      const count = row?.batch_count;
      if (
        originalOrderCreatedAt !== instant(row?.initial_at) ||
        originalOrderCreatedAt > parseOrderingInstant(input.observedAt) ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 10001
      )
        return fail(true);
      if (
        (await options.authorize(input.transaction, {
          brandReference: brand,
          storeReference: store,
          orderReference: current.orderReference,
          diningSessionReference: current.diningSessionReference,
          guestSessionReference: parseOrderingReference(input.guestSessionReference),
        })) !== true
      )
        return fail();
      return Object.freeze({ ...current, originalOrderCreatedAt, nextBatchSequence: count + 1 });
    },
  });
}
