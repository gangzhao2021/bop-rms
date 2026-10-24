import { parseKitchenTicketReference } from "./kitchen-ticket.js";

/**
 * WP-2423 (Handoff Section 26.1/26.4, DEC-KITCHEN-STALE-TICKETS): a kitchen ticket left open from an
 * earlier business day is closed by a manager with a reason. Closing records a Kitchen fact only:
 * work items keep the state the kitchen recorded (never rewritten), the ticket leaves the live
 * board, and no later kitchen step may change it. The Order, its payment and any refund stay with
 * their owners (Ordering, Payment); the reason only says whether the food was made, which tells
 * Inventory to record the ingredients as used (as a completed dish would).
 */
export const kitchenStaleTicketCloseReasons = [
  "ALREADY_SERVED",
  "CANCELLED_ELSEWHERE",
  "NOT_MADE_ABANDONED",
] as const;
export type KitchenStaleTicketCloseReason = (typeof kitchenStaleTicketCloseReasons)[number];

/** Code only the narrow stale-ticket permission grants (catalog v13): Owner and Store Manager. */
export const kitchenStaleTicketClosePermission = "kitchen.ticket.close_stale" as const;
export const kitchenStaleTicketSourceChannel = "MERCHANT_WEB" as const;
export const kitchenStaleTicketClosedActionCode = "KITCHEN_STALE_TICKET_CLOSED" as const;
export const kitchenTicketClosedQueueConsumer =
  "kitchen.queue-ticket-closed-projection:v1" as const;
export const kitchenTicketClosedInventoryConsumer =
  "inventory.kitchen-ticket-closed-consumption:v1" as const;

/** The food was made and handed over: its ingredients count as used, as for a completed dish. */
export function kitchenStaleTicketFoodMade(reason: KitchenStaleTicketCloseReason): boolean {
  return reason === "ALREADY_SERVED";
}

export const kitchenStaleTicketErrorCodes = [
  "KITCHEN_STALE_TICKET_INPUT_INVALID",
  "KITCHEN_STALE_TICKET_PERMISSION_DENIED",
  "KITCHEN_STALE_TICKET_NOT_FOUND",
  "KITCHEN_STALE_TICKET_CONFLICT",
  "KITCHEN_STALE_TICKET_NOT_EARLIER_DAY",
  "KITCHEN_STALE_TICKET_NOTHING_OPEN",
  "KITCHEN_STALE_TICKET_UNAVAILABLE",
] as const;
export type KitchenStaleTicketErrorCode = (typeof kitchenStaleTicketErrorCodes)[number];

export class KitchenStaleTicketError extends Error {
  constructor(readonly code: KitchenStaleTicketErrorCode) {
    super("kitchen stale ticket closure is unavailable");
    this.name = "KitchenStaleTicketError";
  }
}

export interface CloseStaleKitchenTicketCommand {
  readonly idempotencyKey: string;
  readonly ticketReference: string;
  /** The ticket version the manager saw on the board (decimal text). */
  readonly expectedTicketVersion: string;
  readonly reasonCode: KitchenStaleTicketCloseReason;
  readonly correlationReference: string;
}

export type KitchenStaleTicketOpenStatus = "Queued" | "Held" | "In Progress" | "Completed";

/** A work item that was still open when the ticket was closed (state as the kitchen recorded it). */
export interface KitchenStaleTicketOpenWorkItem {
  readonly workItemReference: string;
  readonly orderItemReference: string;
  readonly status: KitchenStaleTicketOpenStatus;
  readonly requiredQuantity: number;
  readonly completedQuantity: number;
}

export interface KitchenStaleTicketClosure {
  readonly closureReference: string;
  readonly ticketReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly reasonCode: KitchenStaleTicketCloseReason;
  readonly foodMade: boolean;
  readonly orderBusinessDate: string;
  readonly closingBusinessDate: string;
  readonly ticketVersion: string;
  readonly openWorkItemCount: number;
  readonly closedBy: string;
  readonly closedAt: string;
  readonly eventReference: string;
}

export interface KitchenStaleTicketCloseResult {
  readonly status: "Closed" | "AlreadyClosed";
  readonly closure: KitchenStaleTicketClosure;
}

const invalid = (): never => {
  throw new KitchenStaleTicketError("KITCHEN_STALE_TICKET_INPUT_INVALID");
};

function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(String(key))))
    return invalid();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
    result[field] = descriptor.value;
  }
  return result;
}
const reference = (value: unknown) => {
  try {
    return parseKitchenTicketReference(value);
  } catch {
    return invalid();
  }
};

/** A business date (YYYY-MM-DD, a real calendar day). */
export function parseKitchenBusinessDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    return invalid();
  return value;
}

/** Strict browser command (authority, scope, time and business days come from the server). */
export function parseCloseStaleKitchenTicketCommand(
  value: unknown,
): CloseStaleKitchenTicketCommand {
  const raw = closed(value, [
    "idempotencyKey",
    "ticketReference",
    "expectedTicketVersion",
    "reasonCode",
    "correlationReference",
  ]);
  if (!kitchenStaleTicketCloseReasons.includes(raw.reasonCode as KitchenStaleTicketCloseReason))
    return invalid();
  if (
    typeof raw.expectedTicketVersion !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(raw.expectedTicketVersion) ||
    BigInt(raw.expectedTicketVersion) > 9_223_372_036_854_775_807n
  )
    return invalid();
  const command = Object.freeze({
    idempotencyKey: reference(raw.idempotencyKey),
    ticketReference: reference(raw.ticketReference),
    expectedTicketVersion: raw.expectedTicketVersion,
    reasonCode: raw.reasonCode as KitchenStaleTicketCloseReason,
    correlationReference: reference(raw.correlationReference),
  });
  if (command.idempotencyKey === command.correlationReference) return invalid();
  return command;
}
