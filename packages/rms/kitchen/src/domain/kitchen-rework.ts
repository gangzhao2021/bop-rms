import { parseKitchenTicketReference } from "./kitchen-ticket.js";

/**
 * WP-2423 Q26 (Handoff Section 26.6, DEC-KITCHEN-REWORK): a finished dish that has to be made again
 * becomes a new Rework work item linked to the original work item, which keeps its result. The
 * reason says whether the first dish was thrown away (Inventory records it as waste) or was simply
 * marked done too early (NOT_READY: the same dish continues, nothing is wasted).
 */
export const kitchenReworkReasons = [
  "WRONG_ITEM",
  "DROPPED",
  "CUSTOMER_RETURNED",
  "QUALITY_ISSUE",
  "NOT_READY",
  "OTHER",
] as const;
export type KitchenReworkReason = (typeof kitchenReworkReasons)[number];
export type KitchenReworkStatus = "Queued" | "In Progress" | "Completed" | "Cancelled";
/** A remake still to be made (open): the board, pickup, order and table screens show it. */
export const kitchenReworkOpenStatuses = ["Queued", "In Progress"] as const;
export type KitchenReworkAction =
  "CreateKitchenRework" | "StartKitchenRework" | "CompleteKitchenRework" | "CancelKitchenRework";
/**
 * Why an open remake is not made after all (DEC-KITCHEN-REWORK cancel, 2026-10-18):
 * GUEST_DECLINED — the guest no longer wants it (the first dish was still thrown away: its waste
 * stands); OPENED_BY_MISTAKE — the remake (or "not ready yet") was opened on the wrong dish or by
 * accident (nothing was thrown away: Inventory voids the remake's waste record).
 */
export const kitchenReworkCancelReasons = ["GUEST_DECLINED", "OPENED_BY_MISTAKE"] as const;
export type KitchenReworkCancelReason = (typeof kitchenReworkCancelReasons)[number];
export const kitchenReworkCancelledEventConsumer =
  "inventory.kitchen-rework-cancelled-waste:v1" as const;

/** Code only the narrow Kitchen rework permission grants (catalog v11). */
export const kitchenReworkPermission = "kitchen.work_item.rework" as const;
/** A dish marked done by mistake is corrected within this long of its completion or ready mark. */
export const kitchenReworkNotReadyWindowMs = 120_000;
/** Recent finished dishes the board offers for a remake. */
export const kitchenReworkRecentWindowMs = 2 * 60 * 60 * 1000;
export const kitchenReworkMaximumPerOriginal = 20;
/**
 * A dish is remade while the guest is still being served: within 12 hours of the dish reaching
 * the kitchen. An earlier business day's dish (e.g. a ticket left open and finished today) is
 * closed with its order, never remade.
 */
export const kitchenReworkOriginalWindowMs = 12 * 60 * 60 * 1000;
export const kitchenReworkNoteMaximumLength = 200;
export const kitchenReworkSourceChannel = "MERCHANT_WEB" as const;
export const kitchenReworkCreatedEventConsumer = "inventory.kitchen-rework-waste:v1" as const;

export const kitchenReworkErrorCodes = [
  "KITCHEN_REWORK_INPUT_INVALID",
  "KITCHEN_REWORK_PERMISSION_DENIED",
  "KITCHEN_REWORK_NOT_FOUND",
  "KITCHEN_REWORK_PRECONDITION_FAILED",
  "KITCHEN_REWORK_WINDOW_CLOSED",
  "KITCHEN_REWORK_CONFLICT",
  "KITCHEN_REWORK_UNAVAILABLE",
] as const;
export type KitchenReworkErrorCode = (typeof kitchenReworkErrorCodes)[number];
export class KitchenReworkError extends Error {
  constructor(readonly code: KitchenReworkErrorCode) {
    super("kitchen rework is unavailable");
    this.name = "KitchenReworkError";
  }
}

export interface CreateKitchenReworkCommand {
  readonly action: "CreateKitchenRework";
  readonly idempotencyKey: string;
  readonly originalWorkItemReference: string;
  readonly reasonCode: KitchenReworkReason;
  /** Staff words, at most 200 characters; required for OTHER. Stored, never evented or logged. */
  readonly note: string | null;
  readonly quantity: number;
  readonly correlationReference: string;
}
export interface AdvanceKitchenReworkCommand {
  readonly action: "StartKitchenRework" | "CompleteKitchenRework";
  readonly idempotencyKey: string;
  readonly reworkReference: string;
  readonly expectedVersion: number;
  readonly correlationReference: string;
}
/** Cancel an open remake (needs the remake permission, like creating one). */
export interface CancelKitchenReworkCommand {
  readonly action: "CancelKitchenRework";
  readonly idempotencyKey: string;
  readonly reworkReference: string;
  readonly expectedVersion: number;
  readonly cancelReasonCode: KitchenReworkCancelReason;
  readonly correlationReference: string;
}
export type KitchenReworkCommand =
  CreateKitchenReworkCommand | AdvanceKitchenReworkCommand | CancelKitchenReworkCommand;

export interface KitchenReworkItem {
  readonly reworkReference: string;
  readonly ticketReference: string;
  readonly originalWorkItemReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderItemReference: string;
  readonly ordinal: number;
  readonly reasonCode: KitchenReworkReason;
  readonly note: string | null;
  readonly quantity: number;
  readonly wasteApplies: boolean;
  readonly status: KitchenReworkStatus;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly startedBy: string | null;
  readonly startedAt: string | null;
  readonly completedBy: string | null;
  readonly completedAt: string | null;
  readonly cancelledBy: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReasonCode: KitchenReworkCancelReason | null;
  readonly eventReference: string;
}

export interface KitchenReworkResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly action: KitchenReworkAction;
  readonly item: KitchenReworkItem;
}

const invalid = (): never => {
  throw new KitchenReworkError("KITCHEN_REWORK_INPUT_INVALID");
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

/** Staff note: trimmed, 1–200 characters, no control or format characters. */
export function parseKitchenReworkNote(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > kitchenReworkNoteMaximumLength ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    return invalid();
  return value;
}

/** The first dish was made and thrown away (Inventory waste), unless it was only marked too early. */
export function kitchenReworkWasteApplies(reason: KitchenReworkReason): boolean {
  return reason !== "NOT_READY";
}

/** Strict browser command (authority and scope come from the trusted session, never the body). */
export function parseKitchenReworkCommand(value: unknown): KitchenReworkCommand {
  const action =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "action")?.value
      : undefined;
  if (action === "CreateKitchenRework") {
    const raw = closed(value, [
      "action",
      "idempotencyKey",
      "originalWorkItemReference",
      "reasonCode",
      "note",
      "quantity",
      "correlationReference",
    ]);
    if (!kitchenReworkReasons.includes(raw.reasonCode as KitchenReworkReason)) return invalid();
    const reasonCode = raw.reasonCode as KitchenReworkReason;
    const note = parseKitchenReworkNote(raw.note);
    if (reasonCode === "OTHER" && note === null) return invalid();
    if (
      !Number.isSafeInteger(raw.quantity) ||
      Number(raw.quantity) < 1 ||
      Number(raw.quantity) > 999
    )
      return invalid();
    const command = Object.freeze({
      action: "CreateKitchenRework" as const,
      idempotencyKey: reference(raw.idempotencyKey),
      originalWorkItemReference: reference(raw.originalWorkItemReference),
      reasonCode,
      note,
      quantity: Number(raw.quantity),
      correlationReference: reference(raw.correlationReference),
    });
    if (command.idempotencyKey === command.correlationReference) return invalid();
    return command;
  }
  if (action === "StartKitchenRework" || action === "CompleteKitchenRework") {
    const raw = closed(value, [
      "action",
      "idempotencyKey",
      "reworkReference",
      "expectedVersion",
      "correlationReference",
    ]);
    if (
      !Number.isSafeInteger(raw.expectedVersion) ||
      Number(raw.expectedVersion) < 1 ||
      Number(raw.expectedVersion) > 2
    )
      return invalid();
    return Object.freeze({
      action,
      idempotencyKey: reference(raw.idempotencyKey),
      reworkReference: reference(raw.reworkReference),
      expectedVersion: Number(raw.expectedVersion),
      correlationReference: reference(raw.correlationReference),
    });
  }
  if (action === "CancelKitchenRework") {
    const raw = closed(value, [
      "action",
      "idempotencyKey",
      "reworkReference",
      "expectedVersion",
      "cancelReasonCode",
      "correlationReference",
    ]);
    if (
      !Number.isSafeInteger(raw.expectedVersion) ||
      Number(raw.expectedVersion) < 1 ||
      Number(raw.expectedVersion) > 2 ||
      !kitchenReworkCancelReasons.includes(raw.cancelReasonCode as KitchenReworkCancelReason)
    )
      return invalid();
    const command = Object.freeze({
      action: "CancelKitchenRework" as const,
      idempotencyKey: reference(raw.idempotencyKey),
      reworkReference: reference(raw.reworkReference),
      expectedVersion: Number(raw.expectedVersion),
      cancelReasonCode: raw.cancelReasonCode as KitchenReworkCancelReason,
      correlationReference: reference(raw.correlationReference),
    });
    if (command.idempotencyKey === command.correlationReference) return invalid();
    return command;
  }
  return invalid();
}
