import { createHash } from "node:crypto";

import { appendAuditRecordInTransaction } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";

import { createKitchenReworkCancelledEnvelope } from "../../application/kitchen-rework-cancelled-event.js";
import { createKitchenReworkCreatedEnvelope } from "../../application/kitchen-rework-created-event.js";
import {
  KitchenReworkError,
  kitchenReworkCancelReasons,
  kitchenReworkMaximumPerOriginal,
  kitchenReworkNotReadyWindowMs,
  kitchenReworkOriginalWindowMs,
  kitchenReworkReasons,
  kitchenReworkRecentWindowMs,
  kitchenReworkSourceChannel,
  kitchenReworkWasteApplies,
  parseKitchenReworkCommand,
  type KitchenReworkCancelReason,
  type KitchenReworkCommand,
  type KitchenReworkItem,
  type KitchenReworkReason,
  type KitchenReworkResult,
  type KitchenReworkStatus,
} from "../../domain/kitchen-rework.js";
import {
  kitchenWorkLifecycleAuditRetentionPolicyCode,
  kitchenWorkLifecycleAuditRetentionPolicyVersion,
} from "../../domain/kitchen-work-lifecycle.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../../domain/kitchen-ticket.js";

const fail = (code: KitchenReworkError["code"]): never => {
  throw new KitchenReworkError(code);
};
const iso = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : parseKitchenTicketInstant(value instanceof Date ? value.toISOString() : String(value));
const statuses: readonly KitchenReworkStatus[] = [
  "Queued",
  "In Progress",
  "Completed",
  "Cancelled",
];
/** SQL for a remake still to be made (cancelled and completed remakes are not open). */
const openSql = "status IN ('Queued','In Progress')";

const columns =
  "kitchen_rework_item_id::text AS id,kitchen_ticket_id::text AS ticket,original_kitchen_work_item_id::text AS original," +
  "order_id::text AS order_id,order_batch_id::text AS batch,order_item_id::text AS order_item,rework_ordinal AS ordinal," +
  "reason_code,reason_note,quantity,waste_applies,status,version::int AS version,created_by_actor_id::text AS created_by," +
  "created_at,started_by_actor_id::text AS started_by,started_at,completed_by_actor_id::text AS completed_by," +
  "completed_at,cancelled_by_actor_id::text AS cancelled_by,cancelled_at,cancel_reason_code,event_id::text AS event_id";

/** Owner row decoder; every reader of rework items goes through it. */
export function parseKitchenReworkRow(row: unknown): KitchenReworkItem {
  try {
    if (row === null || typeof row !== "object" || Array.isArray(row))
      return fail("KITCHEN_REWORK_UNAVAILABLE");
    const r = row as Record<string, unknown>;
    if (
      !kitchenReworkReasons.includes(r.reason_code as KitchenReworkReason) ||
      !statuses.includes(r.status as KitchenReworkStatus) ||
      typeof r.waste_applies !== "boolean" ||
      !Number.isSafeInteger(Number(r.quantity)) ||
      !Number.isSafeInteger(Number(r.version)) ||
      (r.reason_note !== null && typeof r.reason_note !== "string") ||
      (r.cancel_reason_code !== null &&
        !kitchenReworkCancelReasons.includes(r.cancel_reason_code as KitchenReworkCancelReason))
    )
      return fail("KITCHEN_REWORK_UNAVAILABLE");
    const optionalReference = (value: unknown) =>
      value === null ? null : parseKitchenTicketReference(value);
    return Object.freeze({
      reworkReference: parseKitchenTicketReference(r.id),
      ticketReference: parseKitchenTicketReference(r.ticket),
      originalWorkItemReference: parseKitchenTicketReference(r.original),
      orderReference: parseKitchenTicketReference(r.order_id),
      orderBatchReference: parseKitchenTicketReference(r.batch),
      orderItemReference: parseKitchenTicketReference(r.order_item),
      ordinal: Number(r.ordinal),
      reasonCode: r.reason_code as KitchenReworkReason,
      note: (r.reason_note as string | null) ?? null,
      quantity: Number(r.quantity),
      wasteApplies: r.waste_applies,
      status: r.status as KitchenReworkStatus,
      version: Number(r.version),
      createdBy: parseKitchenTicketReference(r.created_by),
      createdAt: iso(r.created_at) as string,
      startedBy: optionalReference(r.started_by),
      startedAt: iso(r.started_at),
      completedBy: optionalReference(r.completed_by),
      completedAt: iso(r.completed_at),
      cancelledBy: optionalReference(r.cancelled_by),
      cancelledAt: iso(r.cancelled_at),
      cancelReasonCode: (r.cancel_reason_code as KitchenReworkCancelReason | null) ?? null,
      eventReference: parseKitchenTicketReference(r.event_id),
    });
  } catch (error) {
    if (error instanceof KitchenReworkError) throw error;
    return fail("KITCHEN_REWORK_UNAVAILABLE");
  }
}

const locale = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/u;
const safeText = /^[^\p{Cc}\p{Cf}]{1,200}$/u;
function parseKitchenLocalizedNames(value: unknown): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("KITCHEN_REWORK_UNAVAILABLE");
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.length < 1 ||
    entries.length > 20 ||
    entries.some(
      ([key, text]) => !locale.test(key) || typeof text !== "string" || !safeText.test(text),
    )
  )
    return fail("KITCHEN_REWORK_UNAVAILABLE");
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}
function parseKitchenOptions(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) return fail("KITCHEN_REWORK_UNAVAILABLE");
  return Object.freeze(
    value.map((option: unknown) => {
      const raw = option as Record<string, unknown> | null;
      if (
        raw === null ||
        typeof raw !== "object" ||
        !Number.isSafeInteger(raw.quantity) ||
        Number(raw.quantity) < 1
      )
        return fail("KITCHEN_REWORK_UNAVAILABLE");
      return Object.freeze({
        quantity: Number(raw.quantity),
        localizedNames: parseKitchenLocalizedNames(raw.localizedNames),
      });
    }),
  );
}

function digest(command: KitchenReworkCommand): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(command), "utf8").digest("hex");
}

function databaseFailure(error: unknown): never {
  if (error instanceof KitchenReworkError) throw error;
  const code =
    error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "23505") return fail("KITCHEN_REWORK_CONFLICT");
  if (code === "23514") return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
  return fail("KITCHEN_REWORK_UNAVAILABLE");
}

/**
 * WP-2423 Q26 (Handoff Section 26.6) Kitchen owner persistence for Rework work items, in the
 * caller's transaction. The caller owns authentication and permission; this store installs the
 * Brand/Store scope, never changes the original work item, records one append-only operation and
 * one audit record per change, and publishes `KitchenReworkCreated` in the same transaction.
 */
export function createPostgresKitchenReworkStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  nextReference(): string;
}) {
  const brand = parseKitchenTicketReference(options.brandReference),
    store = parseKitchenTicketReference(options.storeReference);
  const next = () => parseKitchenTicketReference(options.nextReference());
  async function scoped(tx: ConsumerTransaction) {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  }
  async function load(tx: ConsumerTransaction, reworkReference: string, lock: boolean) {
    const result = await tx.query(
      "SELECT " +
        columns +
        " FROM rms_kitchen.kitchen_rework_item WHERE brand_id=$1 AND store_id=$2 AND kitchen_rework_item_id=$3" +
        (lock ? " FOR NO KEY UPDATE" : ""),
      [brand, store, reworkReference],
    );
    return result.rows.length === 1 ? parseKitchenReworkRow(result.rows[0]) : null;
  }
  async function audit(
    tx: ConsumerTransaction,
    input: {
      auditReference: string;
      actorReference: string;
      actionCode: string;
      item: KitchenReworkItem;
      before: KitchenReworkStatus | null;
      correlationReference: string;
      occurredAt: string;
    },
  ) {
    await appendAuditRecordInTransaction(tx, {
      auditId: input.auditReference,
      brandId: brand,
      storeId: store,
      actor: { type: "User", reference: input.actorReference },
      actionCode: input.actionCode,
      targetType: "KitchenReworkItem",
      targetId: input.item.reworkReference,
      ...(input.before === null ? {} : { beforeSummary: { status: input.before } }),
      afterSummary: {
        status: input.item.status,
        version: input.item.version,
        reasonCode: input.item.reasonCode,
        quantity: input.item.quantity,
        wasteApplies: input.item.wasteApplies,
        originalWorkItemReference: input.item.originalWorkItemReference,
        orderItemReference: input.item.orderItemReference,
        ...(input.item.cancelReasonCode === null
          ? {}
          : { cancelReasonCode: input.item.cancelReasonCode }),
      },
      reasonCode:
        input.item.cancelReasonCode === null
          ? "KITCHEN_REWORK_" + input.item.reasonCode
          : "KITCHEN_REWORK_CANCEL_" + input.item.cancelReasonCode,
      correlationId: input.correlationReference,
      occurredAt: input.occurredAt,
      sourceChannel: kitchenReworkSourceChannel,
      dataClassification: "Confidential",
      retentionPolicyCode: kitchenWorkLifecycleAuditRetentionPolicyCode,
      retentionPolicyVersion: kitchenWorkLifecycleAuditRetentionPolicyVersion,
    });
  }

  async function execute(
    tx: ConsumerTransaction,
    input: {
      readonly command: unknown;
      readonly actorReference: string;
      readonly occurredAt: string;
    },
  ): Promise<KitchenReworkResult> {
    const command = parseKitchenReworkCommand(input.command);
    let actor: string, occurredAt: string;
    try {
      actor = parseKitchenTicketReference(input.actorReference);
      occurredAt = parseKitchenTicketInstant(input.occurredAt);
    } catch {
      return fail("KITCHEN_REWORK_INPUT_INVALID");
    }
    const requestDigest = digest(command);
    try {
      await scoped(tx);
      const prior = await tx.query<Record<string, unknown>>(
        "SELECT kitchen_rework_item_id::text AS item,request_digest FROM rms_kitchen.kitchen_rework_operation " +
          "WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3 AND idempotency_key=$4",
        [brand, store, actor, command.idempotencyKey],
      );
      if (prior.rows.length === 1) {
        const row = prior.rows[0] as Record<string, unknown>;
        if (row.request_digest !== requestDigest) return fail("KITCHEN_REWORK_CONFLICT");
        const item = await load(tx, String(row.item), false);
        if (item === null) return fail("KITCHEN_REWORK_UNAVAILABLE");
        return Object.freeze({ status: "AlreadyApplied", action: command.action, item });
      }
      if (command.action === "CreateKitchenRework") {
        const found = await tx.query<Record<string, unknown>>(
          "SELECT w.kitchen_ticket_id::text AS ticket,w.order_id::text AS order_id,w.order_batch_id::text AS batch," +
            "w.order_item_id::text AS order_item,w.status,w.required_quantity,w.updated_at,w.created_at," +
            "(SELECT max(r.ready_at) FROM rms_kitchen.kitchen_order_item_ready_result r WHERE r.brand_id=w.brand_id " +
            "AND r.store_id=w.store_id AND r.kitchen_ticket_id=w.kitchen_ticket_id AND r.order_item_id=w.order_item_id) AS ready_at," +
            "(SELECT count(*)::int FROM rms_kitchen.kitchen_rework_item k WHERE k.brand_id=w.brand_id AND k.store_id=w.store_id " +
            "AND k.original_kitchen_work_item_id=w.kitchen_work_item_id) AS prior," +
            "(SELECT count(*)::int FROM rms_kitchen.kitchen_rework_item k WHERE k.brand_id=w.brand_id AND k.store_id=w.store_id " +
            "AND k.original_kitchen_work_item_id=w.kitchen_work_item_id AND k.reason_code='NOT_READY' AND k.status IN ('Queued','In Progress')) AS open_not_ready " +
            "FROM rms_kitchen.kitchen_work_item w WHERE w.brand_id=$1 AND w.store_id=$2 AND w.kitchen_work_item_id=$3 FOR NO KEY UPDATE OF w",
          [brand, store, command.originalWorkItemReference],
        );
        if (found.rows.length !== 1) return fail("KITCHEN_REWORK_NOT_FOUND");
        const original = found.rows[0] as Record<string, unknown>;
        if (original.status !== "Completed") return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
        if (command.quantity > Number(original.required_quantity))
          return fail("KITCHEN_REWORK_INPUT_INVALID");
        if (Number(original.prior) >= kitchenReworkMaximumPerOriginal)
          return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
        const finishedAt = Math.max(
          Date.parse(iso(original.updated_at) as string),
          original.ready_at === null ? 0 : Date.parse(iso(original.ready_at) as string),
        );
        if (Date.parse(occurredAt) < finishedAt) return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
        // Measured from when the dish reached the kitchen: an earlier day's ticket finished today
        // (a ticket left open) is closed with its order, never remade.
        if (
          Date.parse(occurredAt) - Date.parse(iso(original.created_at) as string) >
          kitchenReworkOriginalWindowMs
        )
          return fail("KITCHEN_REWORK_WINDOW_CLOSED");
        const notReady = command.reasonCode === "NOT_READY";
        if (notReady && Date.parse(occurredAt) - finishedAt > kitchenReworkNotReadyWindowMs)
          return fail("KITCHEN_REWORK_WINDOW_CLOSED");
        if (notReady && Number(original.open_not_ready) > 0)
          return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
        const reworkReference = next(),
          operationReference = next(),
          eventReference = next(),
          auditReference = next();
        const wasteApplies = kitchenReworkWasteApplies(command.reasonCode);
        await tx.query(
          "INSERT INTO rms_kitchen.kitchen_rework_item (kitchen_rework_item_id,brand_id,store_id,kitchen_ticket_id," +
            "original_kitchen_work_item_id,order_id,order_batch_id,order_item_id,rework_ordinal,reason_code,reason_note,quantity," +
            "waste_applies,status,version,created_operation_id,created_by_actor_id,created_at,started_by_actor_id,started_at,event_id) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16,$17,$18,$19,$20)",
          [
            reworkReference,
            brand,
            store,
            original.ticket,
            command.originalWorkItemReference,
            original.order_id,
            original.batch,
            original.order_item,
            Number(original.prior) + 1,
            command.reasonCode,
            command.note,
            command.quantity,
            wasteApplies,
            notReady ? "In Progress" : "Queued",
            operationReference,
            actor,
            occurredAt,
            notReady ? actor : null,
            notReady ? occurredAt : null,
            eventReference,
          ],
        );
        await tx.query(
          "INSERT INTO rms_kitchen.kitchen_rework_operation (kitchen_rework_operation_id,brand_id,store_id,kitchen_rework_item_id," +
            "action,actor_id,idempotency_key,request_digest,before_status,after_status,result_version,audit_id,correlation_id,occurred_at) " +
            "VALUES ($1,$2,$3,$4,'Create',$5,$6,$7,NULL,$8,1,$9,$10,$11)",
          [
            operationReference,
            brand,
            store,
            reworkReference,
            actor,
            command.idempotencyKey,
            requestDigest,
            notReady ? "In Progress" : "Queued",
            auditReference,
            command.correlationReference,
            occurredAt,
          ],
        );
        const item = await load(tx, reworkReference, false);
        if (item === null) return fail("KITCHEN_REWORK_UNAVAILABLE");
        await audit(tx, {
          auditReference,
          actorReference: actor,
          actionCode: "KITCHEN_REWORK_CREATED",
          item,
          before: null,
          correlationReference: command.correlationReference,
          occurredAt,
        });
        await appendEventInTransaction(
          tx,
          createKitchenReworkCreatedEnvelope({
            eventReference,
            operationReference,
            correlationReference: command.correlationReference,
            actorReference: actor,
            brandReference: brand,
            storeReference: store,
            payload: {
              kitchenReworkItemReference: item.reworkReference,
              kitchenTicketReference: item.ticketReference,
              originalKitchenWorkItemReference: item.originalWorkItemReference,
              orderReference: item.orderReference,
              orderBatchReference: item.orderBatchReference,
              orderItemReference: item.orderItemReference,
              reasonCode: item.reasonCode,
              quantity: item.quantity,
              wasteApplies: item.wasteApplies,
              createdAt: occurredAt,
            },
          }),
        );
        return Object.freeze({ status: "Applied", action: command.action, item });
      }
      const current = await load(tx, command.reworkReference, true);
      if (current === null) return fail("KITCHEN_REWORK_NOT_FOUND");
      if (current.version !== command.expectedVersion) return fail("KITCHEN_REWORK_CONFLICT");
      if (command.action === "CancelKitchenRework") {
        // Only a remake still to be made is cancelled; a finished one already went out.
        if (current.status !== "Queued" && current.status !== "In Progress")
          return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
        if (Date.parse(occurredAt) < Date.parse(current.startedAt ?? current.createdAt))
          return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
        const operationReference = next(),
          auditReference = next(),
          eventReference = next();
        await tx.query(
          "UPDATE rms_kitchen.kitchen_rework_item SET status='Cancelled',version=version+1,cancelled_by_actor_id=$4," +
            "cancelled_at=$5,cancel_reason_code=$6,cancel_event_id=$7 WHERE brand_id=$1 AND store_id=$2 AND kitchen_rework_item_id=$3",
          [
            brand,
            store,
            current.reworkReference,
            actor,
            occurredAt,
            command.cancelReasonCode,
            eventReference,
          ],
        );
        await tx.query(
          "INSERT INTO rms_kitchen.kitchen_rework_operation (kitchen_rework_operation_id,brand_id,store_id,kitchen_rework_item_id," +
            "action,actor_id,idempotency_key,request_digest,before_status,after_status,result_version,audit_id,correlation_id,occurred_at) " +
            "VALUES ($1,$2,$3,$4,'Cancel',$5,$6,$7,$8,'Cancelled',$9,$10,$11,$12)",
          [
            operationReference,
            brand,
            store,
            current.reworkReference,
            actor,
            command.idempotencyKey,
            requestDigest,
            current.status,
            current.version + 1,
            auditReference,
            command.correlationReference,
            occurredAt,
          ],
        );
        const item = await load(tx, current.reworkReference, false);
        if (item === null) return fail("KITCHEN_REWORK_UNAVAILABLE");
        await audit(tx, {
          auditReference,
          actorReference: actor,
          actionCode: "KITCHEN_REWORK_CANCELLED",
          item,
          before: current.status,
          correlationReference: command.correlationReference,
          occurredAt,
        });
        await appendEventInTransaction(
          tx,
          createKitchenReworkCancelledEnvelope({
            eventReference,
            operationReference,
            correlationReference: command.correlationReference,
            actorReference: actor,
            brandReference: brand,
            storeReference: store,
            version: item.version,
            payload: {
              kitchenReworkItemReference: item.reworkReference,
              kitchenTicketReference: item.ticketReference,
              originalKitchenWorkItemReference: item.originalWorkItemReference,
              orderReference: item.orderReference,
              orderBatchReference: item.orderBatchReference,
              orderItemReference: item.orderItemReference,
              reasonCode: item.reasonCode,
              cancelReasonCode: command.cancelReasonCode,
              quantity: item.quantity,
              wasteApplies: item.wasteApplies,
              createdEventReference: item.eventReference,
              cancelledAt: occurredAt,
            },
          }),
        );
        return Object.freeze({ status: "Applied", action: command.action, item });
      }
      const start = command.action === "StartKitchenRework";
      if (current.status !== (start ? "Queued" : "In Progress"))
        return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
      if (Date.parse(occurredAt) < Date.parse(current.startedAt ?? current.createdAt))
        return fail("KITCHEN_REWORK_PRECONDITION_FAILED");
      const operationReference = next(),
        auditReference = next(),
        after: KitchenReworkStatus = start ? "In Progress" : "Completed";
      await tx.query(
        start
          ? "UPDATE rms_kitchen.kitchen_rework_item SET status='In Progress',version=version+1,started_by_actor_id=$4,started_at=$5 " +
              "WHERE brand_id=$1 AND store_id=$2 AND kitchen_rework_item_id=$3"
          : "UPDATE rms_kitchen.kitchen_rework_item SET status='Completed',version=version+1,completed_by_actor_id=$4,completed_at=$5 " +
              "WHERE brand_id=$1 AND store_id=$2 AND kitchen_rework_item_id=$3",
        [brand, store, current.reworkReference, actor, occurredAt],
      );
      await tx.query(
        "INSERT INTO rms_kitchen.kitchen_rework_operation (kitchen_rework_operation_id,brand_id,store_id,kitchen_rework_item_id," +
          "action,actor_id,idempotency_key,request_digest,before_status,after_status,result_version,audit_id,correlation_id,occurred_at) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          operationReference,
          brand,
          store,
          current.reworkReference,
          start ? "Start" : "Complete",
          actor,
          command.idempotencyKey,
          requestDigest,
          current.status,
          after,
          current.version + 1,
          auditReference,
          command.correlationReference,
          occurredAt,
        ],
      );
      const item = await load(tx, current.reworkReference, false);
      if (item === null) return fail("KITCHEN_REWORK_UNAVAILABLE");
      await audit(tx, {
        auditReference,
        actorReference: actor,
        actionCode: start ? "KITCHEN_REWORK_STARTED" : "KITCHEN_REWORK_COMPLETED",
        item,
        before: current.status,
        correlationReference: command.correlationReference,
        occurredAt,
      });
      return Object.freeze({ status: "Applied", action: command.action, item });
    } catch (error) {
      return databaseFailure(error);
    }
  }

  return Object.freeze({
    execute,
    /**
     * Open reworks, and those finished within the last two hours, newest first (at most 100), each
     * with the original dish's Kitchen snapshot (display names and modifiers) for the board.
     */
    async listCurrent(tx: ConsumerTransaction, observedAt: string) {
      const at = parseKitchenTicketInstant(observedAt);
      try {
        await scoped(tx);
        const result = await tx.query<Record<string, unknown>>(
          "SELECT " +
            columns
              .split(",")
              .map((column) => "k." + column)
              .join(",") +
            ",w.localized_display_names_json AS names,w.selected_options_json AS options" +
            " FROM rms_kitchen.kitchen_rework_item k JOIN rms_kitchen.kitchen_work_item w ON w.brand_id=k.brand_id" +
            " AND w.store_id=k.store_id AND w.kitchen_work_item_id=k.original_kitchen_work_item_id" +
            " WHERE k.brand_id=$1 AND k.store_id=$2 AND " +
            "(k." +
            openSql +
            " OR (k.status='Completed' AND k.completed_at >= $3::timestamptz - make_interval(secs => $4))) " +
            // DEC-KITCHEN-STALE-TICKETS: a closed earlier-day ticket's remakes leave the board.
            "AND NOT EXISTS (SELECT 1 FROM rms_kitchen.kitchen_ticket_closure c WHERE c.brand_id=k.brand_id " +
            "AND c.store_id=k.store_id AND c.kitchen_ticket_id=k.kitchen_ticket_id) " +
            "ORDER BY k.created_at DESC, k.kitchen_rework_item_id DESC LIMIT 100",
          [brand, store, at, kitchenReworkRecentWindowMs / 1000],
        );
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              item: parseKitchenReworkRow(row),
              dish: Object.freeze({
                localizedDisplayNames: parseKitchenLocalizedNames(row.names),
                selectedOptions: parseKitchenOptions(row.options),
              }),
            }),
          ),
        );
      } catch (error) {
        return databaseFailure(error);
      }
    },
  });
}

/**
 * WP-2423 Q26 public owner Query: open remakes of the given Orders, per Order item (open portions
 * and whether the first dish was only marked done too early), so pickup, order and table screens
 * can say a dish is being remade. Matched by Order and Order item reference, never by number.
 * Kitchen facts only.
 */
export async function listOpenKitchenReworkItems(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<
  readonly {
    readonly orderReference: string;
    readonly orderItemReference: string;
    readonly openQuantity: number;
  }[]
> {
  if (orderReferences.length === 0) return Object.freeze([]);
  if (orderReferences.length > 200) return fail("KITCHEN_REWORK_INPUT_INVALID");
  const brand = parseKitchenTicketReference(scope.brandReference),
    store = parseKitchenTicketReference(scope.storeReference);
  const orders = [
    ...new Set(orderReferences.map((reference) => parseKitchenTicketReference(reference))),
  ];
  try {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    const result = await tx.query<Record<string, unknown>>(
      "SELECT order_id::text AS order_id,order_item_id::text AS order_item_id,sum(quantity)::int AS open " +
        "FROM rms_kitchen.kitchen_rework_item k WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) " +
        "AND " +
        openSql +
        " AND NOT EXISTS (SELECT 1 FROM rms_kitchen.kitchen_ticket_closure c " +
        "WHERE c.brand_id=k.brand_id AND c.store_id=k.store_id AND c.kitchen_ticket_id=k.kitchen_ticket_id) " +
        "GROUP BY order_id,order_item_id ORDER BY order_id,order_item_id",
      [brand, store, orders],
    );
    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          orderReference: parseKitchenTicketReference(row.order_id),
          orderItemReference: parseKitchenTicketReference(row.order_item_id),
          openQuantity: Number(row.open),
        }),
      ),
    );
  } catch (error) {
    return databaseFailure(error);
  }
}

/**
 * DEC-KITCHEN-REWORK cancel public owner Query: whether a remake was cancelled and why, so the
 * Inventory waste consumer never records waste for a remake opened by mistake. Kitchen facts only.
 */
export async function readKitchenReworkCancellation(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  reworkReference: string,
): Promise<{
  readonly cancelReasonCode: KitchenReworkCancelReason;
  readonly cancelledAt: string;
} | null> {
  const brand = parseKitchenTicketReference(scope.brandReference),
    store = parseKitchenTicketReference(scope.storeReference),
    rework = parseKitchenTicketReference(reworkReference);
  try {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    const result = await tx.query<Record<string, unknown>>(
      "SELECT cancel_reason_code,cancelled_at FROM rms_kitchen.kitchen_rework_item " +
        "WHERE brand_id=$1 AND store_id=$2 AND kitchen_rework_item_id=$3 AND status='Cancelled'",
      [brand, store, rework],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (!kitchenReworkCancelReasons.includes(row.cancel_reason_code as KitchenReworkCancelReason))
      return fail("KITCHEN_REWORK_UNAVAILABLE");
    return Object.freeze({
      cancelReasonCode: row.cancel_reason_code as KitchenReworkCancelReason,
      cancelledAt: iso(row.cancelled_at) as string,
    });
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Open remake portions per Order (sum over its items); see `listOpenKitchenReworkItems`. */
export async function listOpenKitchenReworkByOrder(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, { readonly openQuantity: number }>> {
  const totals = new Map<string, { openQuantity: number }>();
  for (const entry of await listOpenKitchenReworkItems(tx, scope, orderReferences))
    totals.set(entry.orderReference, {
      openQuantity: (totals.get(entry.orderReference)?.openQuantity ?? 0) + entry.openQuantity,
    });
  return totals;
}
