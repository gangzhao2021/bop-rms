import { createHash } from "node:crypto";

import { appendAuditRecordInTransaction } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";

import { createKitchenTicketClosedEnvelope } from "../../application/kitchen-ticket-closed-event.js";
import {
  KitchenStaleTicketError,
  kitchenStaleTicketClosedActionCode,
  kitchenStaleTicketCloseReasons,
  kitchenStaleTicketFoodMade,
  kitchenStaleTicketSourceChannel,
  parseCloseStaleKitchenTicketCommand,
  parseKitchenBusinessDate,
  type CloseStaleKitchenTicketCommand,
  type KitchenStaleTicketCloseReason,
  type KitchenStaleTicketCloseResult,
  type KitchenStaleTicketClosure,
  type KitchenStaleTicketOpenStatus,
  type KitchenStaleTicketOpenWorkItem,
} from "../../domain/kitchen-stale-ticket.js";
import {
  kitchenWorkLifecycleAuditRetentionPolicyCode,
  kitchenWorkLifecycleAuditRetentionPolicyVersion,
} from "../../domain/kitchen-work-lifecycle.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../../domain/kitchen-ticket.js";

const fail = (code: KitchenStaleTicketError["code"]): never => {
  throw new KitchenStaleTicketError(code);
};
const unavailable = (): never => fail("KITCHEN_STALE_TICKET_UNAVAILABLE");
const iso = (value: unknown): string =>
  parseKitchenTicketInstant(value instanceof Date ? value.toISOString() : String(value));
const dateText = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return parseKitchenBusinessDate(value);
};
const sha256 = (text: string) =>
  "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");

const columns =
  "kitchen_ticket_closure_id::text AS id,kitchen_ticket_id::text AS ticket,order_id::text AS order_id," +
  "order_batch_id::text AS batch,ticket_version::text AS ticket_version,reason_code,food_made," +
  "order_business_date::text AS order_business_date,closing_business_date::text AS closing_business_date," +
  "open_work_item_count,open_rework_count,actor_id::text AS actor,request_digest,closed_at,event_id::text AS event_id";

/** Owner row decoder; every reader of ticket closures goes through it. */
export function parseKitchenTicketClosureRow(row: unknown): KitchenStaleTicketClosure {
  try {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return unavailable();
    const r = row as Record<string, unknown>;
    if (
      !kitchenStaleTicketCloseReasons.includes(r.reason_code as KitchenStaleTicketCloseReason) ||
      typeof r.food_made !== "boolean" ||
      r.food_made !== kitchenStaleTicketFoodMade(r.reason_code as KitchenStaleTicketCloseReason) ||
      typeof r.ticket_version !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(r.ticket_version) ||
      !Number.isSafeInteger(Number(r.open_work_item_count))
    )
      return unavailable();
    return Object.freeze({
      closureReference: parseKitchenTicketReference(r.id),
      ticketReference: parseKitchenTicketReference(r.ticket),
      orderReference: parseKitchenTicketReference(r.order_id),
      orderBatchReference: parseKitchenTicketReference(r.batch),
      reasonCode: r.reason_code as KitchenStaleTicketCloseReason,
      foodMade: r.food_made,
      orderBusinessDate: dateText(r.order_business_date),
      closingBusinessDate: dateText(r.closing_business_date),
      ticketVersion: r.ticket_version,
      openWorkItemCount: Number(r.open_work_item_count),
      closedBy: parseKitchenTicketReference(r.actor),
      closedAt: iso(r.closed_at),
      eventReference: parseKitchenTicketReference(r.event_id),
    });
  } catch (error) {
    if (error instanceof KitchenStaleTicketError) throw error;
    return unavailable();
  }
}

function requestDigest(command: CloseStaleKitchenTicketCommand): string {
  return sha256(
    JSON.stringify({
      ticketReference: command.ticketReference,
      expectedTicketVersion: command.expectedTicketVersion,
      reasonCode: command.reasonCode,
      correlationReference: command.correlationReference,
    }),
  );
}

function databaseFailure(error: unknown): never {
  if (error instanceof KitchenStaleTicketError) throw error;
  const code =
    error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "23505" || code === "40001") return fail("KITCHEN_STALE_TICKET_CONFLICT");
  return unavailable();
}

const openStatuses: readonly KitchenStaleTicketOpenStatus[] = [
  "Queued",
  "Held",
  "In Progress",
  "Completed",
];

/**
 * WP-2423 (DEC-KITCHEN-STALE-TICKETS) Kitchen owner persistence: a manager closes a ticket left
 * open from an earlier business day, in the caller's transaction. The caller owns authentication,
 * the permission check and the business days (Ordering's business date of the Order, the Store's
 * current business day), supplied through `businessDays` after the ticket is locked. Work items
 * keep their recorded state; one append-only closure row, one audit record and one
 * `KitchenTicketClosed` event are written together. No money, Order or pickup fact changes.
 */
export function createPostgresKitchenStaleTicketStore(options: {
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
  async function loadByTicket(tx: ConsumerTransaction, ticketReference: string) {
    const result = await tx.query(
      "SELECT " +
        columns +
        " FROM rms_kitchen.kitchen_ticket_closure WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3",
      [brand, store, ticketReference],
    );
    if (result.rows.length > 1) return unavailable();
    return result.rows.length === 1
      ? { closure: parseKitchenTicketClosureRow(result.rows[0]), row: result.rows[0] }
      : null;
  }

  async function close(
    tx: ConsumerTransaction,
    input: {
      readonly command: unknown;
      readonly actorReference: string;
      readonly occurredAt: string;
      /**
       * The business date of the ticket's round (WP-2423 D4: a table's later round belongs to the
       * day it was submitted on; the first round's is the Order's) and the Store's current one.
       */
      businessDays(
        orderReference: string,
        orderBatchReference: string,
      ): Promise<{
        readonly orderBusinessDate: string | null;
        readonly currentBusinessDate: string;
      }>;
    },
  ): Promise<KitchenStaleTicketCloseResult> {
    const command = parseCloseStaleKitchenTicketCommand(input.command);
    let actor: string, closedAt: string;
    try {
      actor = parseKitchenTicketReference(input.actorReference);
      closedAt = parseKitchenTicketInstant(input.occurredAt);
    } catch {
      return fail("KITCHEN_STALE_TICKET_INPUT_INVALID");
    }
    const digest = requestDigest(command);
    try {
      await scoped(tx);
      // The same request again (a lost response) returns the same closure.
      const prior = await tx.query(
        "SELECT " +
          columns +
          " FROM rms_kitchen.kitchen_ticket_closure WHERE brand_id=$1 AND store_id=$2 AND actor_id=$3 AND idempotency_key=$4",
        [brand, store, actor, command.idempotencyKey],
      );
      if (prior.rows.length === 1) {
        const row = prior.rows[0] as Record<string, unknown>;
        if (row.request_digest !== digest) return fail("KITCHEN_STALE_TICKET_CONFLICT");
        return Object.freeze({
          status: "AlreadyClosed" as const,
          closure: parseKitchenTicketClosureRow(row),
        });
      }
      const tickets = await tx.query(
        "SELECT kitchen_ticket_id::text AS ticket,order_id::text AS order_id,order_batch_id::text AS batch," +
          "status,aggregate_version::text AS version,updated_at FROM rms_kitchen.kitchen_ticket " +
          "WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3 FOR NO KEY UPDATE",
        [brand, store, command.ticketReference],
      );
      if (tickets.rows.length !== 1) return fail("KITCHEN_STALE_TICKET_NOT_FOUND");
      const ticket = tickets.rows[0] as Record<string, unknown>;
      if (ticket.status !== "Open") return unavailable();
      if ((await loadByTicket(tx, command.ticketReference)) !== null)
        return fail("KITCHEN_STALE_TICKET_CONFLICT");
      if (ticket.version !== command.expectedTicketVersion)
        return fail("KITCHEN_STALE_TICKET_CONFLICT");
      const orderReference = parseKitchenTicketReference(ticket.order_id);
      const batchReference = parseKitchenTicketReference(ticket.batch);
      if (Date.parse(closedAt) < Date.parse(iso(ticket.updated_at))) return unavailable();

      // Locks the work items too, so a remake or kitchen step cannot slip in beside the closure.
      const items = await tx.query(
        "SELECT w.kitchen_work_item_id::text AS id,w.order_item_id::text AS order_item,w.status," +
          "w.required_quantity,w.completed_quantity,EXISTS (SELECT 1 FROM rms_kitchen.kitchen_order_item_ready_result r " +
          "WHERE r.brand_id=w.brand_id AND r.store_id=w.store_id AND r.kitchen_ticket_id=w.kitchen_ticket_id " +
          "AND r.order_item_id=w.order_item_id) AS ready FROM rms_kitchen.kitchen_work_item w " +
          "WHERE w.brand_id=$1 AND w.store_id=$2 AND w.kitchen_ticket_id=$3 " +
          "ORDER BY w.order_item_id,w.kitchen_work_item_id FOR NO KEY UPDATE OF w",
        [brand, store, command.ticketReference],
      );
      if (items.rows.length < 1 || items.rows.length > 100) return unavailable();
      const open: KitchenStaleTicketOpenWorkItem[] = [];
      for (const raw of items.rows as Record<string, unknown>[]) {
        const status = String(raw.status);
        if (status === "Cancelled") continue;
        if (!openStatuses.includes(status as KitchenStaleTicketOpenStatus)) return unavailable();
        if (typeof raw.ready !== "boolean") return unavailable();
        // Completed and marked ready is finished work; Completed but not ready is still open.
        if (status === "Completed" && raw.ready) continue;
        const required = Number(raw.required_quantity),
          completed = Number(raw.completed_quantity);
        if (
          !Number.isSafeInteger(required) ||
          !Number.isSafeInteger(completed) ||
          required < 1 ||
          completed < 0 ||
          completed > required
        )
          return unavailable();
        open.push(
          Object.freeze({
            workItemReference: parseKitchenTicketReference(raw.id),
            orderItemReference: parseKitchenTicketReference(raw.order_item),
            status: status as KitchenStaleTicketOpenStatus,
            requiredQuantity: required,
            completedQuantity: completed,
          }),
        );
      }
      const reworks = await tx.query(
        "SELECT count(*)::int AS open FROM rms_kitchen.kitchen_rework_item WHERE brand_id=$1 AND store_id=$2 " +
          "AND kitchen_ticket_id=$3 AND status<>'Completed'",
        [brand, store, command.ticketReference],
      );
      const openReworks = Number((reworks.rows[0] as Record<string, unknown> | undefined)?.open);
      if (!Number.isSafeInteger(openReworks) || openReworks < 0) return unavailable();
      if (open.length === 0 && openReworks === 0) return fail("KITCHEN_STALE_TICKET_NOTHING_OPEN");

      const days = await input.businessDays(orderReference, batchReference);
      let orderBusinessDate: string, closingBusinessDate: string;
      try {
        if (days.orderBusinessDate === null) return unavailable();
        orderBusinessDate = parseKitchenBusinessDate(days.orderBusinessDate);
        closingBusinessDate = parseKitchenBusinessDate(days.currentBusinessDate);
      } catch {
        return unavailable();
      }
      if (!(orderBusinessDate < closingBusinessDate))
        return fail("KITCHEN_STALE_TICKET_NOT_EARLIER_DAY");

      const closureReference = next(),
        auditReference = next(),
        eventReference = next();
      const evidenceDigest = sha256(
        JSON.stringify({
          ticketReference: command.ticketReference,
          ticketVersion: command.expectedTicketVersion,
          openWorkItems: open,
          openReworks,
        }),
      );
      const foodMade = kitchenStaleTicketFoodMade(command.reasonCode);
      await tx.query(
        "INSERT INTO rms_kitchen.kitchen_ticket_closure (kitchen_ticket_closure_id,brand_id,store_id,kitchen_ticket_id," +
          "order_id,order_batch_id,ticket_version,reason_code,food_made,order_business_date,closing_business_date," +
          "open_work_item_count,open_rework_count,evidence_digest,actor_type,actor_id,idempotency_key,request_digest," +
          "correlation_id,audit_id,event_id,closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14," +
          "'User',$15,$16,$17,$18,$19,$20,$21)",
        [
          closureReference,
          brand,
          store,
          command.ticketReference,
          orderReference,
          batchReference,
          command.expectedTicketVersion,
          command.reasonCode,
          foodMade,
          orderBusinessDate,
          closingBusinessDate,
          open.length,
          openReworks,
          evidenceDigest,
          actor,
          command.idempotencyKey,
          digest,
          command.correlationReference,
          auditReference,
          eventReference,
          closedAt,
        ],
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: actor },
        actionCode: kitchenStaleTicketClosedActionCode,
        targetType: "KitchenTicket",
        targetId: command.ticketReference,
        beforeSummary: {
          ticketVersion: command.expectedTicketVersion,
          orderBusinessDate,
          openWorkItems: open.map((item) => ({
            workItemReference: item.workItemReference,
            status: item.status,
            requiredQuantity: item.requiredQuantity,
            completedQuantity: item.completedQuantity,
          })),
          openReworkCount: openReworks,
        },
        afterSummary: {
          status: "Closed",
          closureReference,
          foodMade,
          closingBusinessDate,
          evidenceDigest,
        },
        reasonCode: "KITCHEN_STALE_TICKET_" + command.reasonCode,
        correlationId: command.correlationReference,
        occurredAt: closedAt,
        sourceChannel: kitchenStaleTicketSourceChannel,
        dataClassification: "Confidential",
        retentionPolicyCode: kitchenWorkLifecycleAuditRetentionPolicyCode,
        retentionPolicyVersion: kitchenWorkLifecycleAuditRetentionPolicyVersion,
      });
      await appendEventInTransaction(
        tx,
        createKitchenTicketClosedEnvelope({
          eventReference,
          closureReference,
          correlationReference: command.correlationReference,
          actorReference: actor,
          brandReference: brand,
          storeReference: store,
          payload: {
            kitchenTicketReference: command.ticketReference,
            orderReference,
            orderBatchReference: batchReference,
            reasonCode: command.reasonCode,
            foodMade,
            orderBusinessDate,
            ticketVersion: command.expectedTicketVersion,
            openWorkItems: open.map((item) => ({
              kitchenWorkItemReference: item.workItemReference,
              orderItemReference: item.orderItemReference,
              status: item.status,
              requiredQuantity: item.requiredQuantity,
              completedQuantity: item.completedQuantity,
            })),
            closedAt,
          },
        }),
      );
      const stored = await loadByTicket(tx, command.ticketReference);
      if (stored === null) return unavailable();
      return Object.freeze({ status: "Closed" as const, closure: stored.closure });
    } catch (error) {
      return databaseFailure(error);
    }
  }

  return Object.freeze({ close });
}

/**
 * Public owner Query (DEC-KITCHEN-STALE-TICKETS): which of these tickets a manager has closed, so
 * a board read never shows a closed ticket while the queue projection catches up. At most 200.
 */
export async function listClosedKitchenTickets(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  ticketReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ticketReferences.length === 0) return new Set();
  if (ticketReferences.length > 200) return unavailable();
  try {
    const brand = parseKitchenTicketReference(scope.brandReference),
      store = parseKitchenTicketReference(scope.storeReference);
    const tickets = [
      ...new Set(ticketReferences.map((reference) => parseKitchenTicketReference(reference))),
    ];
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    const result = await tx.query(
      "SELECT kitchen_ticket_id::text AS ticket FROM rms_kitchen.kitchen_ticket_closure " +
        "WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=ANY($3::uuid[])",
      [brand, store, tickets],
    );
    const closed = result.rows.map((row) => parseKitchenTicketReference(row.ticket));
    if (closed.some((ticket) => !tickets.includes(ticket))) return unavailable();
    return new Set(closed);
  } catch (error) {
    return databaseFailure(error);
  }
}
