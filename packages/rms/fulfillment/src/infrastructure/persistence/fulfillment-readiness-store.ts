import type { PickupQueueReadItem, PickupQueueReadPage } from "../../contracts/pickup-queue.js";
import { foldPickupHandoffHistory } from "../../application/pickup-handoff-history.js";
import {
  readPickupHandoffHistory,
  readPickupInPersonVerifications,
} from "./pickup-handoff-history.js";
import { foldPickupProofHistory } from "../../application/pickup-proof-history.js";
import { readPickupProofHistory } from "./pickup-proof-history.js";
import { parseFulfillmentReference } from "../../contracts/pickup-fulfillment.js";
import type { ConsumerTransaction } from "@bop/eventing";
import type { FulfillmentReadinessPorts } from "../../application/ports/fulfillment-readiness-ports.js";
import {
  parseReadinessReference,
  parseReadinessInstant,
  parseFulfillmentReadinessSource,
  FulfillmentReadinessError,
} from "../../contracts/fulfillment-readiness.js";
import {
  decodeFulfillmentReadyRecord,
  encodeFulfillmentReadyRecord,
  validateFulfillmentReadyRecordEffect,
} from "../../application/fulfillment-ready-record.js";
import { validatePickupFulfillmentRecordEffect } from "../../application/pickup-fulfillment-record.js";
import { createPostgresPickupFulfillmentStore } from "./pickup-fulfillment-store.js";
import { createHash } from "node:crypto";
import { appendAuditRecordInTransaction } from "@bop/audit";
import {
  foldFulfillmentReadiness,
  fulfillmentItemCancellationActionCode,
  fulfillmentItemCancellationColumns,
  fulfillmentItemCancellationReasonCode,
  fulfillmentPhaseFor,
  parseFulfillmentItemCancellationRow,
  type FulfillmentItemCancellationRecord,
  type FulfillmentItemCancellationResult,
} from "../../domain/fulfillment-item-cancellation.js";
import {
  canonicalReadinessValue,
  parseReadinessDigest,
} from "../../domain/fulfillment-readiness.js";

function unavailable(): never {
  throw new FulfillmentReadinessError("FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE");
}

/** Owner reader of the staff-cancelled lines of one fulfillment, in aggregate version order. */
async function readFulfillmentItemCancellations(
  tx: ConsumerTransaction,
  brand: string,
  store: string,
  fulfillment: string,
): Promise<readonly FulfillmentItemCancellationRecord[]> {
  const result = await tx.query(
    "SELECT " +
      fulfillmentItemCancellationColumns +
      " FROM rms_fulfillment.fulfillment_item_cancellation WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 " +
      "ORDER BY aggregate_version_after LIMIT 101",
    [brand, store, fulfillment],
  );
  if (result.rows.length > 100) return unavailable();
  const rows = result.rows.map(parseFulfillmentItemCancellationRow);
  if (rows.some((row) => String(row.fulfillmentReference) !== fulfillment)) return unavailable();
  return Object.freeze(rows);
}
type Access =
  | { readonly access: "Current"; readonly orderReference: string }
  | { readonly access: "Recover"; readonly kitchenReadyResultReference: string };
/** Caller owns tenant context and the complete service Audit/Inbox transaction. */
export function createPostgresFulfillmentReadinessStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly sha256: (value: string) => string;
  readonly now: () => string;
  readonly authorizeQueue?: (tx: ConsumerTransaction) => Promise<boolean>;
  readonly authorize: (tx: ConsumerTransaction, access: Access) => Promise<boolean>;
  readonly validateCurrentSource: (
    tx: ConsumerTransaction,
    orderReference: string,
  ) => Promise<boolean>;
}): FulfillmentReadinessPorts["repository"] & {
  listPickupQueue(input: {
    transaction: ConsumerTransaction;
    afterFulfillmentReference: string | null;
    limit: number;
    includeCompleted: boolean;
  }): Promise<PickupQueueReadPage>;
  lockPickupHandoffByOrder(
    input: Parameters<FulfillmentReadinessPorts["repository"]["lockByOrder"]>[0],
  ): Promise<
    (ReturnType<typeof foldPickupHandoffHistory> & { readonly notCollected: boolean }) | null
  >;
  lockPickupProofByOrder(
    input: Parameters<FulfillmentReadinessPorts["repository"]["lockByOrder"]>[0],
  ): Promise<ReturnType<typeof foldPickupProofHistory> | null>;
} {
  const brand = parseReadinessReference(options.brandReference),
    store = parseReadinessReference(options.storeReference);
  const original = createPostgresPickupFulfillmentStore({
    brandReference: brand,
    storeReference: store,
    sha256: options.sha256,
    authorize: (tx, orderReference) => options.authorize(tx, { access: "Current", orderReference }),
    validateCurrentSource: async () => false,
  });
  const select =
    "SELECT o.fulfillment_ready_operation_id,o.fulfillment_item_ready_result_id," +
    "o.semantic_binding_digest,o.ready_record_json::text AS record,r.order_id,r.order_batch_id,r.order_item_id," +
    "r.kitchen_ticket_id,r.ready_quantity,r.occurred_at FROM rms_fulfillment.fulfillment_ready_operation o " +
    "LEFT JOIN rms_fulfillment.fulfillment_item_ready_result r ON r.brand_id=o.brand_id AND r.store_id=o.store_id " +
    "AND r.fulfillment_item_ready_result_id=o.fulfillment_item_ready_result_id ";
  function scope(input: { brandReference: string; storeReference: string }) {
    if (input.brandReference !== brand || input.storeReference !== store) return unavailable();
  }
  function decode(row: Record<string, unknown>) {
    const effect = decodeFulfillmentReadyRecord(row.record, options.sha256),
      r = effect.result,
      o = effect.operation;
    const at = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at;
    if (
      o.brandReference !== brand ||
      o.storeReference !== store ||
      o.operationReference !== row.fulfillment_ready_operation_id ||
      o.semanticBindingDigest !== row.semantic_binding_digest ||
      r.resultReference !== row.fulfillment_item_ready_result_id ||
      r.orderReference !== row.order_id ||
      r.orderBatchReference !== row.order_batch_id ||
      r.orderItemReference !== row.order_item_id ||
      r.kitchenTicketReference !== row.kitchen_ticket_id ||
      r.readyQuantity !== row.ready_quantity ||
      r.occurredAt !== at
    )
      return unavailable();
    return effect;
  }
  async function recover(tx: ConsumerTransaction, key: string) {
    const result = await tx.query(
      select + "WHERE o.brand_id=$1 AND o.store_id=$2 AND o.kitchen_ready_result_id=$3",
      [brand, store, key],
    );
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || !result.rows[0]) return unavailable();
    const effect = decode(result.rows[0]);
    if (effect.result.kitchenReadyResultReference !== key) return unavailable();
    return effect;
  }
  async function current(tx: ConsumerTransaction, order: string) {
    if ((await options.authorize(tx, { access: "Current", orderReference: order })) !== true)
      return unavailable();
    if ((await options.validateCurrentSource(tx, order)) !== true) return unavailable();
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "fulfillment:" + brand + ":" + store + ":order:" + order,
    ]);
    const initial = await original.resolveByOrder({
      brandReference: parseFulfillmentReference(brand),
      storeReference: parseFulfillmentReference(store),
      orderReference: parseFulfillmentReference(order),
      transaction: tx,
    });
    if (initial.status === "NotFound") return null;
    if (initial.status !== "Resolved") return unavailable();
    // The original repository validates its record. Parse its public result before using it.
    const aggregate = validatePickupFulfillmentRecordEffect(
      initial.effect,
      options.sha256,
    ).aggregate;
    await tx.query(
      "SELECT fulfillment_id FROM rms_fulfillment.fulfillment WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 FOR UPDATE",
      [brand, store, aggregate.fulfillmentReference],
    );
    const history = (
      await tx.query(
        select +
          "WHERE o.brand_id=$1 AND o.store_id=$2 AND o.fulfillment_id=$3 ORDER BY o.aggregate_version_after",
        [brand, store, aggregate.fulfillmentReference],
      )
    ).rows.map(decode);
    const resultCount = await tx.query(
      "SELECT count(*)::int AS count FROM rms_fulfillment.fulfillment_item_ready_result " +
        "WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3",
      [brand, store, aggregate.fulfillmentReference],
    );
    if (resultCount.rows[0]?.count !== history.length) return unavailable();
    // WP-2423 Q6 step 2: staff-cancelled lines are folded with the ready facts in version order.
    const cancellations = await readFulfillmentItemCancellations(
      tx,
      brand,
      store,
      aggregate.fulfillmentReference,
    );
    for (const effect of history) {
      const r = effect.result;
      if (
        String(r.fulfillmentReference) !== String(aggregate.fulfillmentReference) ||
        r.orderReference !== order ||
        String(r.orderBatchReference) !== String(aggregate.orderBatchReference)
      )
        return unavailable();
    }
    for (const row of cancellations)
      if (
        row.orderReference !== order ||
        String(row.orderBatchReference) !== String(aggregate.orderBatchReference)
      )
        return unavailable();
    const items = aggregate.items.map((item) => ({
      fulfillmentItemReference: String(item.fulfillmentItemReference),
      orderItemReference: String(item.orderItemReference),
      orderedQuantity: item.orderedQuantity,
    }));
    const fold = foldFulfillmentReadiness({
      items,
      ready: history.map((effect) => ({
        fulfillmentItemReference: String(effect.result.fulfillmentItemReference),
        orderItemReference: String(effect.result.orderItemReference),
        readyQuantity: effect.result.readyQuantity,
        aggregateVersionBefore: effect.operation.aggregateVersionBefore,
        aggregateVersionAfter: effect.operation.aggregateVersionAfter,
        phaseBefore: effect.operation.phaseBefore,
        phaseAfter: effect.operation.phaseAfter,
        occurredAt: effect.result.occurredAt,
      })),
      cancellations,
    });
    const ready = fold.ready,
      version = fold.aggregateVersion,
      phase = fold.canonicalPhase;
    const lockedAt = parseReadinessInstant(options.now());
    if (
      String(aggregate.createdAt) > String(lockedAt) ||
      history.some((e) => e.result.occurredAt > lockedAt) ||
      cancellations.some((row) => row.cancelledAt > lockedAt)
    )
      return unavailable();
    const activeItems = aggregate.items.filter(
      (item) => !fold.cancelled.has(String(item.fulfillmentItemReference)),
    );
    // Every line was cancelled: nothing remains to prepare, hand over or prove.
    if (activeItems.length === 0) return null;
    const readiness = parseFulfillmentReadinessSource({
      fulfillmentReference: aggregate.fulfillmentReference,
      brandReference: brand,
      storeReference: store,
      orderReference: order,
      orderBatchReference: aggregate.orderBatchReference,
      canonicalPhase: phase,
      aggregateVersion: version,
      lockedAt,
      items: activeItems.map((item) => ({
        fulfillmentItemReference: item.fulfillmentItemReference,
        orderItemReference: item.orderItemReference,
        orderedQuantity: item.orderedQuantity,
        readyQuantity: ready.get(item.fulfillmentItemReference) ?? 0,
        handedOverQuantity: 0,
        state: ready.has(item.fulfillmentItemReference) ? "Ready" : "Pending",
      })),
    });
    const proofHistory = await readPickupProofHistory(
      tx,
      brand,
      store,
      aggregate.fulfillmentReference,
    );
    const handoffHistory = await readPickupHandoffHistory(
      tx,
      brand,
      store,
      aggregate.fulfillmentReference,
    );
    const notCollected = (
      await tx.query(
        "SELECT pickup_not_collected_id FROM rms_fulfillment.pickup_not_collected_record " +
          "WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3",
        [brand, store, aggregate.fulfillmentReference],
      )
    ).rows.length;
    if (notCollected > 1) return unavailable();
    if (phase !== "Ready") {
      if (
        notCollected ||
        proofHistory.issues.length ||
        proofHistory.verifications.length ||
        handoffHistory.length ||
        (await readPickupInPersonVerifications(tx, brand, store, aggregate.fulfillmentReference))
          .length
      )
        return unavailable();
      return { readiness, proof: null, handoff: null, hasHandoff: false, notCollected: false };
    }
    const readyAt = fold.readyAt ?? "";
    const proof = foldPickupProofHistory(readiness, readyAt, proofHistory);
    const inPerson = await readPickupInPersonVerifications(
      tx,
      brand,
      store,
      aggregate.fulfillmentReference,
    );
    const handoff = foldPickupHandoffHistory(
      proof,
      proofHistory.verifications,
      handoffHistory,
      inPerson,
    );
    return {
      handoff,
      hasHandoff: handoffHistory.length > 0,
      // WP-2423: closed as not collected; no later handoff or code.
      notCollected: notCollected === 1,
      readiness: parseFulfillmentReadinessSource({
        ...readiness,
        aggregateVersion: proof.source.aggregateVersion,
      }),
      proof,
    };
  }
  async function insert(
    tx: ConsumerTransaction,
    table: "fulfillment_item_ready_result" | "fulfillment_ready_operation",
    row: Readonly<Record<string, unknown>>,
  ) {
    const columns = Object.keys(row);
    await tx.query(
      "INSERT INTO rms_fulfillment." +
        table +
        " (" +
        columns.join(",") +
        ") VALUES (" +
        columns.map((_, index) => "$" + (index + 1)).join(",") +
        ")",
      columns.map((key) => row[key]),
    );
  }
  return {
    async listPickupQueue(input) {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 50 ||
        typeof input.includeCompleted !== "boolean"
      )
        return unavailable();
      const after =
        input.afterFulfillmentReference === null
          ? null
          : parseReadinessReference(input.afterFulfillmentReference);
      const tx = input.transaction;
      if (!options.authorizeQueue || !(await options.authorizeQueue(tx))) return unavailable();
      const candidates = (
        await tx.query<{ fulfillment_id: string; order_id: string }>(
          "SELECT f.fulfillment_id,f.order_id FROM rms_fulfillment.fulfillment f " +
            "WHERE f.brand_id=$1 AND f.store_id=$2 AND f.fulfillment_type='Pickup' " +
            "AND ($3::uuid IS NULL OR f.fulfillment_id>$3::uuid) " +
            "AND (EXISTS (SELECT 1 FROM rms_fulfillment.fulfillment_ready_operation r " +
            "WHERE r.brand_id=f.brand_id AND r.store_id=f.store_id AND r.fulfillment_id=f.fulfillment_id AND r.phase_after='Ready') " +
            // WP-2423 Q6: cancelling the last unfinished lines also makes the pickup Ready.
            "OR EXISTS (SELECT 1 FROM rms_fulfillment.fulfillment_item_cancellation c " +
            "WHERE c.brand_id=f.brand_id AND c.store_id=f.store_id AND c.fulfillment_id=f.fulfillment_id AND c.phase_after='Ready')) " +
            "AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.pickup_not_collected_record n " +
            "WHERE n.brand_id=f.brand_id AND n.store_id=f.store_id AND n.fulfillment_id=f.fulfillment_id) " +
            "AND ($4::boolean OR NOT EXISTS (SELECT 1 FROM rms_fulfillment.pickup_handoff_operation h " +
            "WHERE h.brand_id=f.brand_id AND h.store_id=f.store_id AND h.fulfillment_id=f.fulfillment_id AND h.phase_after='Completed')) " +
            "ORDER BY f.fulfillment_id LIMIT $5",
          [brand, store, after, input.includeCompleted, input.limit + 1],
        )
      ).rows;
      if (
        candidates.length > input.limit + 1 ||
        new Set(candidates.map((row) => row.fulfillment_id)).size !== candidates.length
      )
        return unavailable();
      const scanned = candidates.slice(0, input.limit),
        items: PickupQueueReadItem[] = [];
      for (const row of scanned) {
        const fulfillment = parseReadinessReference(row.fulfillment_id),
          order = parseReadinessReference(row.order_id);
        const result = await current(tx, order);
        if (
          !result?.proof ||
          String(result.proof.source.fulfillmentReference) !== String(fulfillment)
        )
          return unavailable();
        const source = result.handoff?.source ?? result.proof.source;
        if (source.canonicalPhase === "Completed" && !input.includeCompleted) continue;
        const capability = result.proof.capability;
        items.push(
          Object.freeze({
            fulfillmentReference: fulfillment,
            orderReference: order,
            phase: source.canonicalPhase,
            aggregateVersion: source.aggregateVersion,
            readyAt: result.proof.source.readyAt,
            publicOrderReference: capability?.publicOrderReference ?? null,
            proof: capability
              ? Object.freeze({
                  kind: capability.kind,
                  generation: capability.generation,
                  expiresAt: capability.expiresAt,
                })
              : null,
            items: Object.freeze(
              source.items.map((item) =>
                Object.freeze({
                  fulfillmentItemReference: item.fulfillmentItemReference,
                  orderedQuantity: item.orderedQuantity,
                  readyQuantity: item.readyQuantity,
                  handedOverQuantity: item.handedOverQuantity,
                }),
              ),
            ),
          }),
        );
      }
      if (!(await options.authorizeQueue(tx))) return unavailable();
      return Object.freeze({
        source: "CurrentFulfillment",
        observedAt: parseReadinessInstant(options.now()),
        items: Object.freeze(items),
        nextAfterFulfillmentReference:
          candidates.length > input.limit ? (scanned.at(-1)?.fulfillment_id ?? null) : null,
      });
    },
    async resolveByKitchenReadyResult(input) {
      scope(input);
      const key = parseReadinessReference(input.kitchenReadyResultReference);
      if (
        (await options.authorize(input.transaction, {
          access: "Recover",
          kitchenReadyResultReference: key,
        })) !== true
      )
        return unavailable();
      const effect = await recover(input.transaction, key);
      return effect ? { status: "Resolved", effect } : { status: "NotFound" };
    },
    async lockByOrder(input) {
      scope(input);
      const result = await current(
        input.transaction,
        parseReadinessReference(input.orderReference),
      );
      if (result?.hasHandoff) return unavailable();
      return result?.readiness ?? null;
    },
    async lockPickupProofByOrder(input) {
      scope(input);
      const result = await current(
        input.transaction,
        parseReadinessReference(input.orderReference),
      );
      if (result?.hasHandoff) return unavailable();
      return result?.proof ?? null;
    },
    async lockPickupHandoffByOrder(input) {
      scope(input);
      const state = await current(input.transaction, parseReadinessReference(input.orderReference));
      return state?.handoff ? { ...state.handoff, notCollected: state.notCollected } : null;
    },
    async apply(input) {
      const effect = validateFulfillmentReadyRecordEffect(input.effect, options.sha256),
        o = effect.operation,
        r = effect.result,
        tx = input.transaction;
      scope(o);
      if (
        (await options.authorize(tx, {
          access: "Recover",
          kitchenReadyResultReference: r.kitchenReadyResultReference,
        })) !== true
      )
        return unavailable();
      let prior = await recover(tx, r.kitchenReadyResultReference);
      if (prior)
        return prior.operation.semanticBindingDigest === o.semanticBindingDigest
          ? { status: "AlreadyApplied", effect: prior }
          : { status: "Conflict" };
      const state = await current(tx, r.orderReference);
      if (state?.hasHandoff) return unavailable();
      const source = state?.readiness;
      prior = await recover(tx, r.kitchenReadyResultReference);
      if (prior)
        return prior.operation.semanticBindingDigest === o.semanticBindingDigest
          ? { status: "AlreadyApplied", effect: prior }
          : { status: "Conflict" };
      const item = source?.items.find(
        (v) => String(v.fulfillmentItemReference) === String(r.fulfillmentItemReference),
      );
      if (
        !source ||
        !item ||
        source.fulfillmentReference !== r.fulfillmentReference ||
        source.orderBatchReference !== r.orderBatchReference ||
        item.orderItemReference !== r.orderItemReference ||
        item.state !== "Pending" ||
        item.readyQuantity !== 0 ||
        item.orderedQuantity !== r.readyQuantity ||
        source.aggregateVersion !== o.aggregateVersionBefore ||
        source.canonicalPhase !== o.phaseBefore ||
        r.occurredAt > source.lockedAt
      )
        return { status: "Conflict" };
      const phase = source.items.every(
        (v) =>
          String(v.fulfillmentItemReference) === String(r.fulfillmentItemReference) ||
          v.state === "Ready",
      )
        ? "Ready"
        : "Pending";
      if (o.phaseAfter !== phase) return { status: "Conflict" };
      const record = encodeFulfillmentReadyRecord(effect, options.sha256);
      await tx.query("SAVEPOINT fulfillment_ready_apply", []);
      try {
        await insert(tx, "fulfillment_item_ready_result", {
          fulfillment_item_ready_result_id: r.resultReference,
          brand_id: brand,
          store_id: store,
          fulfillment_id: r.fulfillmentReference,
          fulfillment_item_id: r.fulfillmentItemReference,
          order_id: r.orderReference,
          order_batch_id: r.orderBatchReference,
          order_item_id: r.orderItemReference,
          kitchen_ticket_id: r.kitchenTicketReference,
          kitchen_ready_result_id: r.kitchenReadyResultReference,
          source_event_id: r.sourceEventReference,
          ready_quantity: r.readyQuantity,
          occurred_at: r.occurredAt,
          data_classification: "IndirectIdentifier",
        });
        await insert(tx, "fulfillment_ready_operation", {
          fulfillment_ready_operation_id: o.operationReference,
          brand_id: brand,
          store_id: store,
          fulfillment_id: o.fulfillmentReference,
          fulfillment_item_id: o.fulfillmentItemReference,
          fulfillment_item_ready_result_id: r.resultReference,
          kitchen_ready_result_id: o.kitchenReadyResultReference,
          source_event_id: o.sourceEventReference,
          aggregate_version_before: o.aggregateVersionBefore.toString(),
          aggregate_version_after: o.aggregateVersionAfter.toString(),
          phase_before: o.phaseBefore,
          phase_after: o.phaseAfter,
          semantic_binding_digest: o.semanticBindingDigest,
          occurred_at: o.occurredAt,
          data_classification: "IndirectIdentifier",
          ready_record_json: record,
        });
        await tx.query("RELEASE SAVEPOINT fulfillment_ready_apply", []);
        return { status: "Applied", effect };
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT fulfillment_ready_apply", []);
        await tx.query("RELEASE SAVEPOINT fulfillment_ready_apply", []);
        return unavailable();
      }
    },
  };
}

interface CancelItemsInput {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  /** Order lines staff cancelled; each must still be Pending in the pickup. */
  readonly orderItemReferences: readonly string[];
  /** Ordering's item cancellation record; one cancellation is recorded once. */
  readonly orderCancellationReference: string;
  readonly operationReference: string;
  readonly auditReference: string;
  readonly actorReference: string;
  readonly cancelledAt: string;
  /** One new reference per cancelled line. */
  nextReference(): string;
}

/**
 * WP-2423 Q6 step 2 Fulfillment owner command, called synchronously inside the staff item
 * cancellation transaction after the caller took the Ordering fence. It records each cancelled
 * line of a pickup as an append-only fact that advances the pickup by one version. When every
 * remaining line was already ready the last fact moves the pickup to Ready, exactly like the last
 * KitchenItemReady does; Kitchen publishes the matching KitchenOrderReady in the same transaction.
 * An order without a pickup fulfillment (dine-in) returns NoFulfillment without writes.
 */
export function createPostgresFulfillmentItemCancellation(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly authorize: (
    tx: ConsumerTransaction,
    input: {
      readonly orderReference: string;
      readonly orderBatchReference: string;
      readonly actorReference: string;
    },
  ) => Promise<boolean>;
}) {
  const guarded = <T>(work: () => T): T => {
    try {
      return work();
    } catch {
      return unavailable();
    }
  };
  const brand = guarded(() => parseReadinessReference(options.brandReference));
  const store = guarded(() => parseReadinessReference(options.storeReference));
  const sha256 = (value: string) =>
    "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");

  async function cancelItems(
    tx: ConsumerTransaction,
    raw: CancelItemsInput,
  ): Promise<FulfillmentItemCancellationResult> {
    const input = guarded(() => {
      if (
        !Array.isArray(raw.orderItemReferences) ||
        raw.orderItemReferences.length < 1 ||
        raw.orderItemReferences.length > 100
      )
        return unavailable();
      return {
        orderReference: parseReadinessReference(raw.orderReference),
        orderBatchReference: parseReadinessReference(raw.orderBatchReference),
        orderItemReferences: raw.orderItemReferences.map((value) => parseReadinessReference(value)),
        orderCancellationReference: parseReadinessReference(raw.orderCancellationReference),
        operationReference: parseReadinessReference(raw.operationReference),
        auditReference: parseReadinessReference(raw.auditReference),
        actorReference: parseReadinessReference(raw.actorReference),
        cancelledAt: parseReadinessInstant(raw.cancelledAt),
      };
    });
    const generated = [
      input.operationReference,
      input.orderCancellationReference,
      input.auditReference,
    ];
    if (
      new Set(generated).size !== generated.length ||
      new Set(input.orderItemReferences).size !== input.orderItemReferences.length
    )
      return unavailable();
    let authorized: boolean;
    try {
      authorized = await options.authorize(tx, {
        orderReference: input.orderReference,
        orderBatchReference: input.orderBatchReference,
        actorReference: input.actorReference,
      });
    } catch {
      return unavailable();
    }
    if (authorized !== true) return unavailable();

    const roots = await tx.query(
      "SELECT fulfillment_id,order_batch_id FROM rms_fulfillment.fulfillment " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
      [brand, store, input.orderReference],
    );
    if (roots.rows.length === 0) return Object.freeze({ status: "NoFulfillment" as const });
    const root = roots.rows[0];
    if (roots.rows.length !== 1 || !root || root.order_batch_id !== input.orderBatchReference)
      return unavailable();
    const fulfillment = guarded(() => parseReadinessReference(root.fulfillment_id));
    // The owner fold locks the pickup, validates its whole history and excludes cancelled lines.
    // Authority and the current Ordering source were established by the caller above.
    const reader = createPostgresFulfillmentReadinessStore({
      brandReference: brand,
      storeReference: store,
      sha256,
      now: () => input.cancelledAt,
      authorize: async () => true,
      validateCurrentSource: async () => true,
    });
    const locked = await reader.lockByOrder({
      brandReference: brand,
      storeReference: store,
      orderReference: input.orderReference,
      transaction: tx,
    });
    const readiness = locked === null ? null : parseFulfillmentReadinessSource(locked);
    if (readiness !== null && String(readiness.fulfillmentReference) !== fulfillment)
      return unavailable();
    const existing = await readFulfillmentItemCancellations(tx, brand, store, fulfillment);
    const mine = existing.filter(
      (row) =>
        row.operationReference === input.operationReference ||
        row.orderCancellationReference === input.orderCancellationReference,
    );
    if (mine.length > 0) {
      const first = mine[0];
      const lines = new Set(mine.map((row) => String(row.orderItemReference)));
      if (
        first === undefined ||
        mine.some(
          (row) =>
            row.operationReference !== first.operationReference ||
            row.orderCancellationReference !== first.orderCancellationReference ||
            row.auditReference !== first.auditReference ||
            row.evidenceDigest !== first.evidenceDigest,
        ) ||
        lines.size !== mine.length ||
        lines.size !== input.orderItemReferences.length ||
        input.orderItemReferences.some((line) => !lines.has(line))
      )
        return unavailable();
      return Object.freeze({
        status: "AlreadyRecorded" as const,
        fulfillmentReference: fulfillment,
        itemCount: mine.length,
        canonicalPhase: mine.at(-1)?.phaseAfter ?? "Pending",
        evidenceDigest: first.evidenceDigest,
      });
    }
    // Every line already cancelled, or the pickup is already Ready: nothing is cancellable.
    if (readiness === null || readiness.canonicalPhase !== "Pending") return unavailable();
    const targets = input.orderItemReferences.map((line) => {
      const item = readiness.items.find((value) => value.orderItemReference === line);
      if (item === undefined || item.state !== "Pending") return unavailable();
      return item;
    });
    const foldItems = readiness.items.map((item) => ({
      fulfillmentItemReference: String(item.fulfillmentItemReference),
      orderItemReference: String(item.orderItemReference),
      orderedQuantity: item.orderedQuantity,
    }));
    const ready = new Set<string>(
      readiness.items
        .filter((item) => item.state === "Ready")
        .map((item) => String(item.fulfillmentItemReference)),
    );
    const cancelled = new Set<string>();
    const plan = targets.map((item, index) => {
      cancelled.add(String(item.fulfillmentItemReference));
      return {
        cancellationReference: guarded(() => parseReadinessReference(raw.nextReference())),
        fulfillmentItemReference: item.fulfillmentItemReference,
        orderItemReference: item.orderItemReference,
        aggregateVersionBefore: readiness.aggregateVersion + BigInt(index),
        aggregateVersionAfter: readiness.aggregateVersion + BigInt(index) + 1n,
        phaseBefore: "Pending" as const,
        phaseAfter: fulfillmentPhaseFor(foldItems, ready, cancelled),
      };
    });
    if (plan.slice(0, -1).some((row) => row.phaseAfter !== "Pending")) return unavailable();
    const owned = [...generated, ...plan.map((row) => row.cancellationReference)];
    const observed = [
      brand,
      store,
      fulfillment,
      input.orderReference,
      input.orderBatchReference,
      input.actorReference,
      ...readiness.items.flatMap((item) => [
        String(item.fulfillmentItemReference),
        String(item.orderItemReference),
      ]),
      ...existing.flatMap((row) => [
        String(row.cancellationReference),
        String(row.operationReference),
        String(row.orderCancellationReference),
        String(row.auditReference),
      ]),
    ];
    if (
      new Set(owned).size !== owned.length ||
      owned.some((reference) => observed.includes(reference))
    )
      return unavailable();
    const finalPhase = plan.at(-1)?.phaseAfter ?? "Pending";
    const evidenceDigest = parseReadinessDigest(
      sha256(
        canonicalReadinessValue({
          fulfillmentReference: fulfillment,
          orderReference: input.orderReference,
          orderBatchReference: input.orderBatchReference,
          orderCancellationReference: input.orderCancellationReference,
          items: plan.map((row) => ({
            fulfillmentItemReference: row.fulfillmentItemReference,
            orderItemReference: row.orderItemReference,
            aggregateVersionBefore: row.aggregateVersionBefore,
            aggregateVersionAfter: row.aggregateVersionAfter,
            phaseAfter: row.phaseAfter,
          })),
        }),
      ),
    );
    await tx.query("SAVEPOINT fulfillment_item_cancellation", []);
    try {
      for (const row of plan)
        await tx.query(
          "INSERT INTO rms_fulfillment.fulfillment_item_cancellation (fulfillment_item_cancellation_id," +
            "operation_id,brand_id,store_id,fulfillment_id,fulfillment_item_id,order_id,order_batch_id," +
            "order_item_id,order_cancellation_id,actor_type,actor_id,reason_code,aggregate_version_before," +
            "aggregate_version_after,phase_before,phase_after,evidence_digest,audit_id,cancelled_at," +
            "data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'User',$11,$12,$13,$14,$15,$16," +
            "$17,$18,$19,'IndirectIdentifier')",
          [
            row.cancellationReference,
            input.operationReference,
            brand,
            store,
            fulfillment,
            row.fulfillmentItemReference,
            input.orderReference,
            input.orderBatchReference,
            row.orderItemReference,
            input.orderCancellationReference,
            input.actorReference,
            fulfillmentItemCancellationReasonCode,
            row.aggregateVersionBefore.toString(10),
            row.aggregateVersionAfter.toString(10),
            row.phaseBefore,
            row.phaseAfter,
            evidenceDigest,
            input.auditReference,
            input.cancelledAt,
          ],
        );
      await appendAuditRecordInTransaction(tx, {
        auditId: input.auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: input.actorReference },
        actionCode: fulfillmentItemCancellationActionCode,
        targetType: "Fulfillment",
        targetId: fulfillment,
        beforeSummary: {
          aggregateVersion: readiness.aggregateVersion.toString(10),
          canonicalPhase: "Pending",
          items: plan.map((row) => ({
            fulfillmentItemReference: row.fulfillmentItemReference,
            state: "Pending",
          })),
        },
        afterSummary: {
          aggregateVersion: (readiness.aggregateVersion + BigInt(plan.length)).toString(10),
          canonicalPhase: finalPhase,
          cancelledItemCount: plan.length,
          remainingItemCount: readiness.items.length - plan.length,
          operationReference: input.operationReference,
          orderCancellationReference: input.orderCancellationReference,
          evidenceDigest,
        },
        reasonCode: fulfillmentItemCancellationReasonCode,
        correlationId: input.orderCancellationReference,
        occurredAt: input.cancelledAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
        retentionPolicyVersion: 1,
      });
      await tx.query("RELEASE SAVEPOINT fulfillment_item_cancellation", []);
    } catch {
      await tx.query("ROLLBACK TO SAVEPOINT fulfillment_item_cancellation", []);
      await tx.query("RELEASE SAVEPOINT fulfillment_item_cancellation", []);
      return unavailable();
    }
    return Object.freeze({
      status: "Recorded" as const,
      fulfillmentReference: fulfillment,
      itemCount: plan.length,
      canonicalPhase: finalPhase,
      evidenceDigest,
    });
  }

  return Object.freeze({
    async cancelItems(
      tx: ConsumerTransaction,
      input: CancelItemsInput,
    ): Promise<FulfillmentItemCancellationResult> {
      try {
        return await cancelItems(tx, input);
      } catch {
        return unavailable();
      }
    },
  });
}
