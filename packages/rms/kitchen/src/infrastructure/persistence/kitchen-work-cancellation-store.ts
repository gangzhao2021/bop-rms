import { createHash } from "node:crypto";

import { appendAuditRecordInTransaction } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";

import { createKitchenWorkCancelledEnvelope } from "../../application/kitchen-work-cancelled-event.js";
import {
  KitchenBatchCancellationError,
  kitchenWorkCancellationActionCode,
  kitchenWorkCancellationReasonCode,
  kitchenWorkCancellationSourceChannel,
  type KitchenBatchCancellationResult,
  type KitchenWorkCancellationRecord,
} from "../../contracts/kitchen-work-cancellation.js";
import {
  kitchenWorkLifecycleAuditRetentionPolicyCode,
  kitchenWorkLifecycleAuditRetentionPolicyVersion,
} from "../../domain/kitchen-work-lifecycle.js";
import {
  parseKitchenTicketDigest,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../../domain/kitchen-ticket.js";

const postgresqlBigintMaximum = 9_223_372_036_854_775_807n;

function unavailable(): never {
  throw new KitchenBatchCancellationError("KITCHEN_CANCELLATION_UNAVAILABLE");
}

function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return unavailable();
  }
}

const instantText = (value: unknown) =>
  parseKitchenTicketInstant(value instanceof Date ? value.toISOString() : value);

function versionValue(value: unknown): bigint {
  const text = typeof value === "bigint" ? value.toString(10) : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,18}$/.test(text)) return unavailable();
  const parsed = BigInt(text);
  if (parsed > postgresqlBigintMaximum) return unavailable();
  return parsed;
}

export const kitchenWorkCancellationColumns =
  "kitchen_work_cancellation_id,operation_id,kitchen_ticket_id,kitchen_work_item_id,order_id,order_batch_id," +
  "order_item_id,before_status,expected_ticket_version::text AS expected_ticket_version," +
  "result_ticket_version::text AS result_ticket_version,expected_work_item_version::text AS expected_work_item_version," +
  "result_work_item_version::text AS result_work_item_version,actor_id,order_cancellation_id,evidence_digest," +
  "event_id,audit_id,cancelled_at";

/** Owner row decoder shared by every Kitchen reader that replays work item history. */
export function parseKitchenWorkCancellationRow(row: unknown): KitchenWorkCancellationRecord {
  return guarded(() => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return unavailable();
    const r = row as Record<string, unknown>;
    if (r.before_status !== "Queued" && r.before_status !== "Held") return unavailable();
    const record: KitchenWorkCancellationRecord = Object.freeze({
      cancellationReference: parseKitchenTicketReference(r.kitchen_work_cancellation_id),
      operationReference: parseKitchenTicketReference(r.operation_id),
      ticketReference: parseKitchenTicketReference(r.kitchen_ticket_id),
      workItemReference: parseKitchenTicketReference(r.kitchen_work_item_id),
      orderReference: parseKitchenTicketReference(r.order_id),
      orderBatchReference: parseKitchenTicketReference(r.order_batch_id),
      orderItemReference: parseKitchenTicketReference(r.order_item_id),
      beforeStatus: r.before_status,
      expectedTicketVersion: versionValue(r.expected_ticket_version),
      resultTicketVersion: versionValue(r.result_ticket_version),
      expectedWorkItemVersion: versionValue(r.expected_work_item_version),
      resultWorkItemVersion: versionValue(r.result_work_item_version),
      actorReference: parseKitchenTicketReference(r.actor_id),
      orderCancellationReference: parseKitchenTicketReference(r.order_cancellation_id),
      evidenceDigest: parseKitchenTicketDigest(r.evidence_digest),
      eventReference: parseKitchenTicketReference(r.event_id),
      auditReference: parseKitchenTicketReference(r.audit_id),
      cancelledAt: instantText(r.cancelled_at),
    });
    if (
      record.resultTicketVersion !== record.expectedTicketVersion + 1n ||
      record.resultWorkItemVersion !== record.expectedWorkItemVersion + 1n
    )
      return unavailable();
    return record;
  });
}

/** Rows of one ticket, ordered by ticket version; at most one row per work item. */
export async function loadKitchenWorkCancellations(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  ticketReference: string,
): Promise<readonly KitchenWorkCancellationRecord[]> {
  const result = await tx.query(
    "SELECT " +
      kitchenWorkCancellationColumns +
      " FROM rms_kitchen.kitchen_work_cancellation WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3 " +
      "ORDER BY result_ticket_version LIMIT 101",
    [scope.brandReference, scope.storeReference, ticketReference],
  );
  if (result.rows.length > 100) return unavailable();
  const rows = result.rows.map(parseKitchenWorkCancellationRow);
  const items = rows.map((row) => row.workItemReference);
  if (
    new Set(items).size !== items.length ||
    rows.some((row) => row.ticketReference !== ticketReference)
  )
    return unavailable();
  return Object.freeze(rows);
}

interface CancellationEvidenceItem {
  readonly workItemReference: string;
  readonly orderItemReference: string;
  readonly beforeStatus: "Queued" | "Held";
  readonly expectedTicketVersion: bigint;
  readonly resultTicketVersion: bigint;
  readonly expectedWorkItemVersion: bigint;
  readonly resultWorkItemVersion: bigint;
}

function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 over the canonical ordered item list (references, before status and versions). */
export function kitchenBatchCancellationEvidenceDigest(input: {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly kitchenTicketReference: string | null;
  readonly items: readonly CancellationEvidenceItem[];
}): string {
  return sha256(
    JSON.stringify({
      orderReference: input.orderReference,
      orderBatchReference: input.orderBatchReference,
      kitchenTicketReference: input.kitchenTicketReference,
      workItems: input.items.map((item) => ({
        workItemReference: item.workItemReference,
        orderItemReference: item.orderItemReference,
        beforeStatus: item.beforeStatus,
        expectedTicketVersion: item.expectedTicketVersion.toString(10),
        resultTicketVersion: item.resultTicketVersion.toString(10),
        expectedWorkItemVersion: item.expectedWorkItemVersion.toString(10),
        resultWorkItemVersion: item.resultWorkItemVersion.toString(10),
      })),
    }),
  );
}

interface CancelInput {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly operationReference: string;
  readonly orderCancellationReference: string;
  readonly actorReference: string;
  readonly cancelledAt: string;
  readonly auditReference: string;
  readonly eventReference: string;
  nextReference(): string;
}

/**
 * WP-2423 Q6 Kitchen half of the staff cancellation command. The caller owns the transaction,
 * tenant context and every foreign owner fence (Ordering disposition) taken before this locks the
 * kitchen ticket and then its work items. Either every work item of the batch becomes Cancelled or
 * nothing is written. The outbox event uses the Kitchen convention tenantId = brand.
 */
export function createPostgresKitchenBatchCancellation(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  /** Accepted for the composition contract; Kitchen events carry the brand as tenant. */
  readonly tenantReference?: string;
  readonly authorize: (
    tx: ConsumerTransaction,
    input: {
      readonly orderReference: string;
      readonly orderBatchReference: string;
      readonly actorReference: string;
    },
  ) => Promise<boolean>;
}) {
  const brand = guarded(() => parseKitchenTicketReference(options.brandReference));
  const store = guarded(() => parseKitchenTicketReference(options.storeReference));
  if (options.tenantReference !== undefined)
    guarded(() => parseKitchenTicketReference(options.tenantReference));
  const scope = { brandReference: brand, storeReference: store };

  async function cancel(
    tx: ConsumerTransaction,
    raw: CancelInput,
  ): Promise<KitchenBatchCancellationResult> {
    const input = guarded(() => ({
      orderReference: parseKitchenTicketReference(raw.orderReference),
      orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
      operationReference: parseKitchenTicketReference(raw.operationReference),
      orderCancellationReference: parseKitchenTicketReference(raw.orderCancellationReference),
      actorReference: parseKitchenTicketReference(raw.actorReference),
      cancelledAt: parseKitchenTicketInstant(raw.cancelledAt),
      auditReference: parseKitchenTicketReference(raw.auditReference),
      eventReference: parseKitchenTicketReference(raw.eventReference),
    }));
    const generated = [
      input.operationReference,
      input.orderCancellationReference,
      input.auditReference,
      input.eventReference,
    ];
    if (new Set(generated).size !== generated.length) return unavailable();
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

    const tickets = await tx.query(
      "SELECT kitchen_ticket_id,order_id,status,aggregate_version::text AS version,updated_at " +
        "FROM rms_kitchen.kitchen_ticket WHERE brand_id=$1 AND store_id=$2 AND order_batch_id=$3 FOR UPDATE",
      [brand, store, input.orderBatchReference],
    );
    if (tickets.rows.length === 0)
      return Object.freeze({
        status: "NoKitchenWork" as const,
        evidenceDigest: kitchenBatchCancellationEvidenceDigest({
          orderReference: input.orderReference,
          orderBatchReference: input.orderBatchReference,
          kitchenTicketReference: null,
          items: [],
        }),
      });
    const ticket = tickets.rows[0];
    if (tickets.rows.length !== 1 || !ticket || ticket.status !== "Open") return unavailable();
    const ticketReference = guarded(() => parseKitchenTicketReference(ticket.kitchen_ticket_id));
    if (ticket.order_id !== input.orderReference) return unavailable();
    const ticketVersion = versionValue(ticket.version);
    const ticketUpdatedAt = guarded(() => instantText(ticket.updated_at));

    const itemRows = await tx.query(
      "SELECT kitchen_work_item_id,order_id,order_batch_id,order_item_id,version::text AS version,status,updated_at " +
        "FROM rms_kitchen.kitchen_work_item WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3 " +
        "ORDER BY order_item_id,kitchen_work_item_id FOR UPDATE",
      [brand, store, ticketReference],
    );
    if (itemRows.rows.length < 1 || itemRows.rows.length > 100) return unavailable();
    const items = itemRows.rows.map((row) =>
      guarded(() => {
        if (
          row.order_id !== input.orderReference ||
          row.order_batch_id !== input.orderBatchReference
        )
          return unavailable();
        return {
          workItemReference: parseKitchenTicketReference(row.kitchen_work_item_id),
          orderItemReference: parseKitchenTicketReference(row.order_item_id),
          version: versionValue(row.version),
          status: String(row.status),
          updatedAt: instantText(row.updated_at),
        };
      }),
    );

    const existing = await loadKitchenWorkCancellations(tx, scope, ticketReference);
    if (existing.length > 0) {
      const first = existing[0];
      if (
        first === undefined ||
        existing.length !== items.length ||
        existing.some(
          (row) =>
            row.operationReference !== first.operationReference ||
            row.orderCancellationReference !== first.orderCancellationReference ||
            row.evidenceDigest !== first.evidenceDigest ||
            row.orderBatchReference !== input.orderBatchReference ||
            row.orderReference !== input.orderReference,
        ) ||
        (first.operationReference !== input.operationReference &&
          first.orderCancellationReference !== input.orderCancellationReference)
      )
        return unavailable();
      const ordered = items.map((item) => {
        const row = existing.find((value) => value.workItemReference === item.workItemReference);
        if (
          row === undefined ||
          item.status !== "Cancelled" ||
          item.version !== row.resultWorkItemVersion ||
          row.orderItemReference !== item.orderItemReference
        )
          return unavailable();
        return row;
      });
      const evidenceDigest = kitchenBatchCancellationEvidenceDigest({
        orderReference: input.orderReference,
        orderBatchReference: input.orderBatchReference,
        kitchenTicketReference: ticketReference,
        items: ordered,
      });
      if (evidenceDigest !== first.evidenceDigest) return unavailable();
      return Object.freeze({
        status: "AlreadyCancelled" as const,
        kitchenTicketReference: ticketReference,
        workItemCount: ordered.length,
        evidenceDigest,
      });
    }

    const started = await tx.query(
      "SELECT 1 FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE brand_id=$1 AND store_id=$2 " +
        "AND kitchen_ticket_id=$3 AND action_code='KITCHEN_WORK_ITEM_STARTED' LIMIT 1",
      [brand, store, ticketReference],
    );
    if (items.some((item) => item.status === "Cancelled")) return unavailable();
    if (started.rows.length > 0 || items.some((item) => !["Queued", "Held"].includes(item.status)))
      throw new KitchenBatchCancellationError("KITCHEN_WORK_STARTED");
    // Kitchen history is monotonic: a cancellation never precedes a fact it replaces.
    if (
      Date.parse(input.cancelledAt) < Date.parse(ticketUpdatedAt) ||
      items.some((item) => Date.parse(input.cancelledAt) < Date.parse(item.updatedAt))
    )
      return unavailable();

    const plan = items.map((item, index) => ({
      cancellationReference: guarded(() => parseKitchenTicketReference(raw.nextReference())),
      workItemReference: item.workItemReference,
      orderItemReference: item.orderItemReference,
      beforeStatus: item.status as "Queued" | "Held",
      expectedTicketVersion: ticketVersion + BigInt(index),
      resultTicketVersion: ticketVersion + BigInt(index) + 1n,
      expectedWorkItemVersion: item.version,
      resultWorkItemVersion: item.version + 1n,
    }));
    const owned = [...generated, ...plan.map((item) => item.cancellationReference)];
    const observed = [
      brand,
      store,
      ticketReference,
      input.orderReference,
      input.orderBatchReference,
      input.actorReference,
      ...items.flatMap((item) => [item.workItemReference, item.orderItemReference]),
    ];
    if (
      new Set(owned).size !== owned.length ||
      owned.some((reference) => observed.includes(reference))
    )
      return unavailable();
    const evidenceDigest = kitchenBatchCancellationEvidenceDigest({
      orderReference: input.orderReference,
      orderBatchReference: input.orderBatchReference,
      kitchenTicketReference: ticketReference,
      items: plan,
    });
    const finalTicketVersion = ticketVersion + BigInt(plan.length);
    const event = guarded(() =>
      createKitchenWorkCancelledEnvelope({
        eventReference: input.eventReference,
        operationReference: input.operationReference,
        actorReference: input.actorReference,
        brandReference: brand,
        storeReference: store,
        payload: Object.freeze({
          kitchenTicketReference: ticketReference,
          orderReference: input.orderReference,
          orderBatchReference: input.orderBatchReference,
          orderCancellationReference: input.orderCancellationReference,
          ticketVersion: finalTicketVersion.toString(10),
          reasonCode: kitchenWorkCancellationReasonCode,
          workItems: Object.freeze(
            plan.map((item) =>
              Object.freeze({
                kitchenWorkItemReference: item.workItemReference,
                orderItemReference: item.orderItemReference,
                fromStatus: item.beforeStatus,
                toStatus: "Cancelled" as const,
                workItemVersion: item.resultWorkItemVersion.toString(10),
              }),
            ),
          ),
          cancelledAt: input.cancelledAt,
        }),
      }),
    );

    await tx.query("SAVEPOINT kitchen_batch_cancellation", []);
    try {
      for (const item of plan) {
        const updatedItem = await tx.query(
          "UPDATE rms_kitchen.kitchen_work_item SET version=$5,status='Cancelled',updated_at=$6," +
            "updated_by_actor_type='User',updated_by_actor_id=$7 WHERE brand_id=$1 AND store_id=$2 " +
            "AND kitchen_ticket_id=$3 AND kitchen_work_item_id=$4 AND version=$8 AND status=$9",
          [
            brand,
            store,
            ticketReference,
            item.workItemReference,
            item.resultWorkItemVersion.toString(10),
            input.cancelledAt,
            input.actorReference,
            item.expectedWorkItemVersion.toString(10),
            item.beforeStatus,
          ],
        );
        const updatedTicket = await tx.query(
          "UPDATE rms_kitchen.kitchen_ticket SET aggregate_version=$4,updated_at=$5," +
            "updated_by_actor_type='User',updated_by_actor_id=$6 WHERE brand_id=$1 AND store_id=$2 " +
            "AND kitchen_ticket_id=$3 AND aggregate_version=$7",
          [
            brand,
            store,
            ticketReference,
            item.resultTicketVersion.toString(10),
            input.cancelledAt,
            input.actorReference,
            item.expectedTicketVersion.toString(10),
          ],
        );
        if (updatedItem.rowCount !== 1 || updatedTicket.rowCount !== 1) return unavailable();
        await tx.query(
          "INSERT INTO rms_kitchen.kitchen_work_cancellation (kitchen_work_cancellation_id,operation_id," +
            "brand_id,store_id,kitchen_ticket_id,kitchen_work_item_id,order_id,order_batch_id,order_item_id," +
            "before_status,expected_ticket_version,result_ticket_version,expected_work_item_version," +
            "result_work_item_version,actor_type,actor_id,reason_code,order_cancellation_id,evidence_digest," +
            "event_id,audit_id,cancelled_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'User'," +
            "$15,$16,$17,$18,$19,$20,$21)",
          [
            item.cancellationReference,
            input.operationReference,
            brand,
            store,
            ticketReference,
            item.workItemReference,
            input.orderReference,
            input.orderBatchReference,
            item.orderItemReference,
            item.beforeStatus,
            item.expectedTicketVersion.toString(10),
            item.resultTicketVersion.toString(10),
            item.expectedWorkItemVersion.toString(10),
            item.resultWorkItemVersion.toString(10),
            input.actorReference,
            kitchenWorkCancellationReasonCode,
            input.orderCancellationReference,
            evidenceDigest,
            input.eventReference,
            input.auditReference,
            input.cancelledAt,
          ],
        );
      }
      await appendAuditRecordInTransaction(tx, {
        auditId: input.auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: input.actorReference },
        actionCode: kitchenWorkCancellationActionCode,
        targetType: "KitchenTicket",
        targetId: ticketReference,
        beforeSummary: {
          ticketVersion: ticketVersion.toString(10),
          workItems: plan.map((item) => ({
            workItemReference: item.workItemReference,
            status: item.beforeStatus,
            workItemVersion: item.expectedWorkItemVersion.toString(10),
          })),
        },
        afterSummary: {
          ticketVersion: finalTicketVersion.toString(10),
          status: "Cancelled",
          workItemCount: plan.length,
          operationReference: input.operationReference,
          orderCancellationReference: input.orderCancellationReference,
          evidenceDigest,
        },
        reasonCode: kitchenWorkCancellationReasonCode,
        correlationId: input.orderCancellationReference,
        occurredAt: input.cancelledAt,
        sourceChannel: kitchenWorkCancellationSourceChannel,
        dataClassification: "Confidential",
        retentionPolicyCode: kitchenWorkLifecycleAuditRetentionPolicyCode,
        retentionPolicyVersion: kitchenWorkLifecycleAuditRetentionPolicyVersion,
      });
      await appendEventInTransaction(tx, event);
      await tx.query("RELEASE SAVEPOINT kitchen_batch_cancellation", []);
    } catch {
      await tx.query("ROLLBACK TO SAVEPOINT kitchen_batch_cancellation", []);
      await tx.query("RELEASE SAVEPOINT kitchen_batch_cancellation", []);
      return unavailable();
    }
    return Object.freeze({
      status: "Cancelled" as const,
      kitchenTicketReference: ticketReference,
      workItemCount: plan.length,
      evidenceDigest,
    });
  }

  return Object.freeze({
    async cancel(tx: ConsumerTransaction, input: CancelInput) {
      try {
        return await cancel(tx, input);
      } catch (error) {
        if (error instanceof KitchenBatchCancellationError) throw error;
        return unavailable();
      }
    },
  });
}

/** Batches (of at most 100 order batch references) where any kitchen work item has started. */
export async function listStoreStartedKitchenBatches(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderBatchReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  const brand = guarded(() => parseKitchenTicketReference(scope.brandReference));
  const store = guarded(() => parseKitchenTicketReference(scope.storeReference));
  if (!Array.isArray(orderBatchReferences) || orderBatchReferences.length > 100)
    return unavailable();
  const batches = guarded(() =>
    [...new Set(orderBatchReferences)].map((value) => parseKitchenTicketReference(value)),
  );
  if (batches.length === 0) return new Set();
  try {
    const result = await tx.query(
      "SELECT DISTINCT t.order_batch_id FROM rms_kitchen.kitchen_ticket t " +
        "JOIN rms_kitchen.kitchen_work_item w ON w.brand_id=t.brand_id AND w.store_id=t.store_id " +
        "AND w.kitchen_ticket_id=t.kitchen_ticket_id WHERE t.brand_id=$1 AND t.store_id=$2 " +
        "AND t.order_batch_id=ANY($3::uuid[]) AND (w.status NOT IN ('Queued','Held','Cancelled') " +
        "OR EXISTS (SELECT 1 FROM rms_kitchen.kitchen_work_lifecycle_operation o WHERE o.brand_id=w.brand_id " +
        "AND o.store_id=w.store_id AND o.kitchen_ticket_id=w.kitchen_ticket_id " +
        "AND o.kitchen_work_item_id=w.kitchen_work_item_id AND o.action_code='KITCHEN_WORK_ITEM_STARTED'))",
      [brand, store, batches],
    );
    const started = result.rows.map((row) => parseKitchenTicketReference(row.order_batch_id));
    if (started.some((value) => !batches.includes(value))) return unavailable();
    return new Set(started);
  } catch {
    return unavailable();
  }
}
