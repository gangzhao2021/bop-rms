import { appendAuditRecordInTransaction } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import type { KitchenWorkLifecycleEffectValidationPorts } from "../../application/kitchen-work-lifecycle-service.js";
import type {
  KitchenWorkLifecycleEffect,
  KitchenWorkLifecycleCommit,
  KitchenWorkLifecyclePorts,
} from "../../application/ports/kitchen-work-lifecycle-ports.js";
import {
  KitchenWorkLifecycleError,
  parseKitchenWorkLifecycleCommand,
  parseKitchenWorkLifecycleSource,
  type KitchenWorkLifecycleCommand,
} from "../../contracts/kitchen-work-lifecycle.js";
import { decodeKitchenWorkLifecycleRecord } from "../../application/kitchen-work-lifecycle-record.js";
import { parseKitchenTicketReference } from "../../domain/kitchen-ticket.js";
import { createKitchenWorkLifecycleRows } from "./kitchen-work-lifecycle-rows.js";

function unavailable(): never {
  throw new KitchenWorkLifecycleError("KITCHEN_WORK_DEPENDENCY_UNAVAILABLE");
}

/** Caller owns the transaction; gates must acquire foreign owner fences before Kitchen locks. */
export function createPostgresKitchenWorkLifecycleWriter(
  options: KitchenWorkLifecycleEffectValidationPorts & {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly authorize: (
      tx: ConsumerTransaction,
      effect: KitchenWorkLifecycleEffect,
    ) => Promise<boolean>;
    readonly validateCurrentSource: (
      tx: ConsumerTransaction,
      effect: KitchenWorkLifecycleEffect,
    ) => Promise<boolean>;
  },
) {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  async function insert(
    tx: ConsumerTransaction,
    table:
      | "kitchen_work_lifecycle_operation"
      | "kitchen_order_item_ready_result"
      | "kitchen_ready_publication",
    row: Readonly<Record<string, unknown>>,
  ) {
    const columns = Object.keys(row);
    await tx.query(
      "INSERT INTO rms_kitchen." +
        table +
        " (" +
        columns.join(",") +
        ") VALUES (" +
        columns.map((_, index) => "$" + (index + 1)).join(",") +
        ")",
      columns.map((column) => row[column]),
    );
  }
  return async function commit(input: {
    readonly effect: KitchenWorkLifecycleEffect;
    readonly transaction: ConsumerTransaction;
  }): Promise<KitchenWorkLifecycleCommit> {
    const rows = createKitchenWorkLifecycleRows(input.effect, options);
    const effect = rows.effect;
    const m = effect.mutation;
    const tx = input.transaction;
    if (m.brandReference !== brand || m.storeReference !== store) return unavailable();
    if ((await options.authorize(tx, effect)) !== true) return unavailable();
    if ((await options.validateCurrentSource(tx, effect)) !== true) return unavailable();
    const ticket = await tx.query(
      "SELECT aggregate_version::text AS version,status FROM rms_kitchen.kitchen_ticket " +
        "WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3 FOR UPDATE",
      [brand, store, m.ticketReference],
    );
    const item = await tx.query(
      "SELECT version::text AS version,status,completed_quantity,required_quantity " +
        "FROM rms_kitchen.kitchen_work_item WHERE brand_id=$1 AND store_id=$2 " +
        "AND kitchen_ticket_id=$3 AND kitchen_work_item_id=$4 AND order_item_id=$5 FOR UPDATE",
      [brand, store, m.ticketReference, m.workItemReference, m.orderItemReference],
    );
    const t = ticket.rows[0];
    const w = item.rows[0];
    if (
      ticket.rows.length !== 1 ||
      item.rows.length !== 1 ||
      !t ||
      !w ||
      t.status !== "Open" ||
      t.version !== m.expectedTicketVersion.toString() ||
      w.version !== m.expectedWorkItemVersion.toString() ||
      w.status !== m.beforeStatus ||
      w.completed_quantity !== m.beforeCompletedQuantity ||
      w.required_quantity !== m.requiredQuantity
    )
      return { status: "Conflict" };
    await tx.query("SAVEPOINT kitchen_lifecycle_commit", []);
    try {
      await tx.query(
        "UPDATE rms_kitchen.kitchen_ticket SET aggregate_version=$4,updated_at=$5," +
          "updated_by_actor_type=$6,updated_by_actor_id=$7 WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3",
        [
          brand,
          store,
          m.ticketReference,
          m.resultTicketVersion.toString(),
          m.updatedAt,
          effect.operation.actorType,
          effect.operation.actorReference,
        ],
      );
      await tx.query(
        "UPDATE rms_kitchen.kitchen_work_item SET version=$5,status=$6,completed_quantity=$7," +
          "updated_at=$8,updated_by_actor_type=$9,updated_by_actor_id=$10 " +
          "WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3 AND kitchen_work_item_id=$4",
        [
          brand,
          store,
          m.ticketReference,
          m.workItemReference,
          m.resultWorkItemVersion.toString(),
          m.afterStatus,
          m.afterCompletedQuantity,
          m.updatedAt,
          effect.operation.actorType,
          effect.operation.actorReference,
        ],
      );
      await insert(tx, "kitchen_work_lifecycle_operation", rows.operation);
      if (rows.automaticOperation)
        await insert(tx, "kitchen_work_lifecycle_operation", rows.automaticOperation);
      if (rows.readyResult) await insert(tx, "kitchen_order_item_ready_result", rows.readyResult);
      for (const audit of effect.audits) await appendAuditRecordInTransaction(tx, audit);
      if (effect.event) await appendEventInTransaction(tx, effect.event);
      if (effect.readyPublication) {
        await appendEventInTransaction(tx, effect.readyPublication.itemEvent);
        if (effect.readyPublication.orderEvent)
          await appendEventInTransaction(tx, effect.readyPublication.orderEvent);
      }
      if (rows.readyPublication)
        await insert(tx, "kitchen_ready_publication", rows.readyPublication);
      await tx.query("RELEASE SAVEPOINT kitchen_lifecycle_commit", []);
      return { status: "Committed", effect };
    } catch {
      await tx.query("ROLLBACK TO SAVEPOINT kitchen_lifecycle_commit", []);
      await tx.query("RELEASE SAVEPOINT kitchen_lifecycle_commit", []);
      return unavailable();
    }
  };
}

/** Current authority is required for recovery as well as new commands. Tenant context is caller-owned. */
export function createPostgresKitchenWorkLifecycleStore(
  options: KitchenWorkLifecycleEffectValidationPorts & {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly authorize: (
      tx: ConsumerTransaction,
      input:
        | { readonly access: "Recover"; readonly idempotencyKey: string }
        | { readonly access: "Execute"; readonly command: KitchenWorkLifecycleCommand },
    ) => Promise<boolean>;
    readonly validateCurrentSource: (
      tx: ConsumerTransaction,
      command: KitchenWorkLifecycleCommand,
    ) => Promise<boolean>;
  },
): KitchenWorkLifecyclePorts["repository"] {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  function command(value: unknown) {
    const result = parseKitchenWorkLifecycleCommand(value);
    if (result.brandReference !== brand || result.storeReference !== store) return unavailable();
    return result;
  }
  function original(row: Record<string, unknown>) {
    const effect = decodeKitchenWorkLifecycleRecord(row.record, options);
    if (
      effect.command.brandReference !== brand ||
      effect.command.storeReference !== store ||
      effect.operation.operationReference !== row.kitchen_work_lifecycle_operation_id ||
      effect.operation.ticketReference !== row.kitchen_ticket_id ||
      effect.operation.idempotencyKey !== row.idempotency_key ||
      effect.effectDigest !== row.effect_digest
    )
      return unavailable();
    return effect;
  }
  const selectRecord =
    "SELECT kitchen_work_lifecycle_operation_id,kitchen_ticket_id,idempotency_key," +
    "effect_digest,effect_record_json::text AS record FROM rms_kitchen.kitchen_work_lifecycle_operation ";
  const instant = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  const writer = createPostgresKitchenWorkLifecycleWriter({
    ...options,
    authorize: (tx, effect) =>
      options.authorize(tx, { access: "Execute", command: effect.command }),
    validateCurrentSource: (tx, effect) => options.validateCurrentSource(tx, effect.command),
  });
  return {
    async resolveByIdempotency(input) {
      if (
        input.brandReference !== brand ||
        input.storeReference !== store ||
        typeof input.idempotencyKey !== "string" ||
        input.idempotencyKey.length === 0
      )
        return unavailable();
      if (
        (await options.authorize(input.transaction, {
          access: "Recover",
          idempotencyKey: input.idempotencyKey,
        })) !== true
      )
        return unavailable();
      const result = await input.transaction.query(
        selectRecord + "WHERE brand_id=$1 AND store_id=$2 AND idempotency_key=$3",
        [brand, store, input.idempotencyKey],
      );
      if (result.rows.length === 0) return { status: "NotFound" };
      if (result.rows.length !== 1 || !result.rows[0]) return unavailable();
      return { status: "Found", effect: original(result.rows[0]) };
    },
    async loadSourceForUpdate(input) {
      const c = command(input.command);
      const tx = input.transaction;
      if ((await options.authorize(tx, { access: "Execute", command: c })) !== true)
        return unavailable();
      if ((await options.validateCurrentSource(tx, c)) !== true) return unavailable();
      const tickets = await tx.query(
        "SELECT order_id,order_batch_id,status,aggregate_version::text AS version,updated_at " +
          "FROM rms_kitchen.kitchen_ticket WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3 FOR UPDATE",
        [brand, store, c.ticketReference],
      );
      if (tickets.rows.length === 0) return null;
      const ticket = tickets.rows[0];
      if (tickets.rows.length !== 1 || !ticket || ticket.status !== "Open") return unavailable();
      const items = await tx.query(
        "SELECT kitchen_work_item_id,order_item_id,source_item_ordinal,split_ordinal,version::text AS version," +
          "status,required_quantity,completed_quantity,created_at,updated_at FROM rms_kitchen.kitchen_work_item " +
          "WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3 ORDER BY order_item_id,kitchen_work_item_id FOR UPDATE",
        [brand, store, c.ticketReference],
      );
      const records = await tx.query(
        selectRecord +
          "WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3 AND idempotency_key IS NOT NULL ORDER BY result_ticket_version",
        [brand, store, c.ticketReference],
      );
      const history = records.rows.map(original);
      if (history.some((effect) => effect.operation.ticketReference !== c.ticketReference))
        return unavailable();
      const targetId =
        c.action === "MarkKitchenOrderItemReady"
          ? c.workItems[0].workItemReference
          : c.workItemReference;
      const mapped = items.rows.map((row) => ({
        workItemReference: row.kitchen_work_item_id,
        orderItemReference: row.order_item_id,
        sourceItemOrdinal: row.source_item_ordinal,
        splitOrdinal: row.split_ordinal,
        workItemVersion: BigInt(String(row.version)),
        workItemStatus: row.status,
        requiredQuantity: row.required_quantity,
        completedQuantity: row.completed_quantity,
        createdAt: instant(row.created_at),
        updatedAt: instant(row.updated_at),
      }));
      const target = mapped.find((item) => item.workItemReference === targetId);
      if (!target) return null;
      const operations = history.filter((effect) => effect.mutation.workItemReference === targetId);
      const predecessor = (action: string) => {
        const matches = operations.filter((effect) => effect.operation.actionCode === action);
        if (matches.length > 1) return unavailable();
        const op = matches[0]?.operation;
        return op
          ? {
              operationReference: op.operationReference,
              actionCode: op.actionCode,
              purpose: op.purpose,
              actorReference: op.actorReference,
              ticketReference: op.ticketReference,
              workItemReference: op.workItemReference,
              orderItemReference: op.orderItemReference,
              resultTicketVersion: op.resultTicketVersion,
              resultWorkItemVersion: op.resultWorkItemVersion,
              occurredAt: op.occurredAt,
            }
          : null;
      };
      const readyResults = history.flatMap((effect) =>
        effect.readyResult ? [effect.readyResult] : [],
      );
      const normalizedReady = await tx.query(
        "SELECT ready_result_id,order_item_id,causal_operation_id,work_items_digest,ready_quantity,required_quantity,ready_at " +
          "FROM rms_kitchen.kitchen_order_item_ready_result WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3",
        [brand, store, c.ticketReference],
      );
      if (normalizedReady.rows.length !== readyResults.length) return unavailable();
      for (const ready of readyResults) {
        const row = normalizedReady.rows.find(
          (r) => r.ready_result_id === ready.readyResultReference,
        );
        if (
          !row ||
          row.order_item_id !== ready.orderItemReference ||
          row.causal_operation_id !== ready.causalOperationReference ||
          row.work_items_digest !== ready.workItemsDigest ||
          row.ready_quantity !== ready.readyQuantity ||
          row.required_quantity !== ready.requiredQuantity ||
          instant(row.ready_at) !== ready.readyAt
        )
          return unavailable();
      }
      // Never invent predecessor history for rows advanced outside this lifecycle contract.
      for (const item of mapped) {
        const latest = history
          .filter((effect) => effect.mutation.workItemReference === item.workItemReference)
          .at(-1);
        if (!latest) {
          if (
            item.workItemVersion !== 1n ||
            item.workItemStatus !== "Queued" ||
            item.completedQuantity !== 0
          )
            return unavailable();
        } else if (
          latest.mutation.resultWorkItemVersion !== item.workItemVersion ||
          latest.mutation.afterStatus !== item.workItemStatus ||
          latest.mutation.afterCompletedQuantity !== item.completedQuantity ||
          latest.mutation.requiredQuantity !== item.requiredQuantity ||
          latest.mutation.updatedAt !== item.updatedAt
        )
          return unavailable();
      }
      const latest = history.at(-1);
      if (BigInt(String(ticket.version)) !== (latest?.mutation.resultTicketVersion ?? 1n))
        return unavailable();
      const ready = readyResults.find((r) => r.orderItemReference === target.orderItemReference);
      const completed = operations
        .filter((effect) => effect.operation.actionCode === "KITCHEN_WORK_ITEM_COMPLETION_RECORDED")
        .at(-1);
      return parseKitchenWorkLifecycleSource({
        brandReference: brand,
        storeReference: store,
        ticketReference: c.ticketReference,
        orderReference: ticket.order_id,
        orderBatchReference: ticket.order_batch_id,
        ticketStatus: ticket.status,
        ticketVersion: BigInt(String(ticket.version)),
        ticketUpdatedAt: instant(ticket.updated_at),
        target,
        siblings: [target],
        acceptedOperation: predecessor("KITCHEN_WORK_ITEM_ACCEPTED"),
        startedOperation: predecessor("KITCHEN_WORK_ITEM_STARTED"),
        readyResult: ready
          ? {
              readyResultReference: ready.readyResultReference,
              ticketReference: ready.ticketReference,
              orderItemReference: ready.orderItemReference,
              causalOperationReference: ready.causalOperationReference,
              workItemsDigest: ready.workItemsDigest,
              readyQuantity: ready.readyQuantity,
              requiredQuantity: ready.requiredQuantity,
              readyAt: ready.readyAt,
            }
          : null,
        capturedExpo: completed?.operation.capturedExpo ?? null,
        ticketReadiness: mapped.map((item) => {
          const result = readyResults.find((r) => r.orderItemReference === item.orderItemReference);
          return {
            orderItemReference: item.orderItemReference,
            requiredQuantity: item.requiredQuantity,
            readyResultReference: result?.readyResultReference ?? null,
            readyQuantity: result?.readyQuantity ?? null,
            readyAt: result?.readyAt ?? null,
          };
        }),
      });
    },
    commit: writer,
  };
}
