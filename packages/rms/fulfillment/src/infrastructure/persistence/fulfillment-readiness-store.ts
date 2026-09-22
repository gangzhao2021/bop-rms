import type { PickupQueueReadItem, PickupQueueReadPage } from "../../contracts/pickup-queue.js";
import { foldPickupHandoffHistory } from "../../application/pickup-handoff-history.js";
import { readPickupHandoffHistory } from "./pickup-handoff-history.js";
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

function unavailable(): never {
  throw new FulfillmentReadinessError("FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE");
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
  ): Promise<ReturnType<typeof foldPickupHandoffHistory>>;
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
    const ready = new Map<string, number>();
    let version = 1n,
      phase: "Pending" | "Ready" = "Pending";
    for (const effect of history) {
      const r = effect.result,
        o = effect.operation,
        item = aggregate.items.find(
          (v) => String(v.fulfillmentItemReference) === String(r.fulfillmentItemReference),
        );
      if (
        !item ||
        String(r.fulfillmentReference) !== String(aggregate.fulfillmentReference) ||
        r.orderReference !== order ||
        String(r.orderBatchReference) !== String(aggregate.orderBatchReference) ||
        String(r.orderItemReference) !== String(item.orderItemReference) ||
        r.readyQuantity !== item.orderedQuantity ||
        ready.has(r.fulfillmentItemReference) ||
        o.aggregateVersionBefore !== version ||
        o.aggregateVersionAfter !== version + 1n ||
        o.phaseBefore !== phase
      )
        return unavailable();
      ready.set(r.fulfillmentItemReference, r.readyQuantity);
      phase = ready.size === aggregate.items.length ? "Ready" : "Pending";
      if (o.phaseAfter !== phase) return unavailable();
      version = o.aggregateVersionAfter;
    }
    const lockedAt = parseReadinessInstant(options.now());
    if (
      String(aggregate.createdAt) > String(lockedAt) ||
      history.some((e) => e.result.occurredAt > lockedAt)
    )
      return unavailable();
    const readiness = parseFulfillmentReadinessSource({
      fulfillmentReference: aggregate.fulfillmentReference,
      brandReference: brand,
      storeReference: store,
      orderReference: order,
      orderBatchReference: aggregate.orderBatchReference,
      canonicalPhase: phase,
      aggregateVersion: version,
      lockedAt,
      items: aggregate.items.map((item) => ({
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
    if (phase !== "Ready") {
      if (proofHistory.issues.length || proofHistory.verifications.length || handoffHistory.length)
        return unavailable();
      return { readiness, proof: null, handoff: null, hasHandoff: false };
    }
    const readyAt = history.reduce(
      (at, effect) => (effect.result.occurredAt > at ? effect.result.occurredAt : at),
      "",
    );
    const proof = foldPickupProofHistory(readiness, readyAt, proofHistory);
    const handoff = foldPickupHandoffHistory(proof, proofHistory.verifications, handoffHistory);
    return {
      handoff,
      hasHandoff: handoffHistory.length > 0,
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
            "AND EXISTS (SELECT 1 FROM rms_fulfillment.fulfillment_ready_operation r " +
            "WHERE r.brand_id=f.brand_id AND r.store_id=f.store_id AND r.fulfillment_id=f.fulfillment_id AND r.phase_after='Ready') " +
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
      return (
        (await current(input.transaction, parseReadinessReference(input.orderReference)))
          ?.handoff ?? null
      );
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
