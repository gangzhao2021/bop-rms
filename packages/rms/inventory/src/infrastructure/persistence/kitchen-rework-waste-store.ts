import { parseInventoryInstant, parseInventoryReference } from "../../domain/inventory-item.js";
import type { StoreWasteLine, StoreWasteReason } from "../../domain/store-waste.js";
import type { InventoryItemTransaction } from "./inventory-item-store.js";
import type { LedgerTransaction } from "./ledger-posting.js";
import { createPostgresStockReservationStore } from "./stock-reservation-store.js";
import {
  postStoreWaste,
  voidKitchenRemakeWaste,
  type StoreWasteScope,
} from "./store-waste-store.js";

export class KitchenReworkWasteError extends Error {
  readonly code = "INVENTORY_KITCHEN_REWORK_WASTE_UNAVAILABLE" as const;
  constructor() {
    super("Kitchen rework waste is unavailable");
    this.name = "KitchenReworkWasteError";
  }
}
const fail = (): never => {
  throw new KitchenReworkWasteError();
};

/** Kitchen's rework reasons that mean the first dish was made and thrown away. */
const wasteReasons: Readonly<Record<string, StoreWasteReason>> = Object.freeze({
  WRONG_ITEM: "PREPARATION_ERROR",
  DROPPED: "DROPPED",
  CUSTOMER_RETURNED: "CUSTOMER_RETURN",
  QUALITY_ISSUE: "QUALITY",
  OTHER: "OTHER",
});
export const kitchenReworkWasteNote = "Kitchen remake";

const decimal = /^(?:0|[1-9][0-9]{0,11})(?:\.([0-9]{1,6}))?$/u;
function scaled(value: string, precision: number): bigint {
  const match = decimal.exec(value);
  if (match === null) return fail();
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > precision) return fail();
  return BigInt(whole + fraction.padEnd(precision, "0"));
}
function text(value: bigint, precision: number): string {
  const digits = value.toString(10).padStart(precision + 1, "0");
  if (precision === 0) return digits;
  const fraction = digits.slice(-precision).replace(/0+$/u, "");
  const whole = digits.slice(0, -precision);
  return fraction.length === 0 ? whole : whole + "." + fraction;
}

/**
 * The share of an Order line's per-ingredient demand that `reworkQuantity` of its `lineQuantity`
 * portions used, at the item's ledger precision (half up). What a line reserved is what it
 * consumed, so a whole-line remake wastes exactly that.
 */
export function kitchenReworkWasteQuantity(input: {
  readonly lineDemand: string;
  readonly precision: number;
  readonly lineQuantity: number;
  readonly reworkQuantity: number;
}): string {
  if (
    !Number.isSafeInteger(input.precision) ||
    input.precision < 0 ||
    input.precision > 6 ||
    !Number.isSafeInteger(input.lineQuantity) ||
    !Number.isSafeInteger(input.reworkQuantity) ||
    input.lineQuantity < 1 ||
    input.reworkQuantity < 1 ||
    input.reworkQuantity > input.lineQuantity
  )
    return fail();
  const numerator = scaled(input.lineDemand, input.precision) * BigInt(input.reworkQuantity);
  const denominator = BigInt(input.lineQuantity);
  const quotient = numerator / denominator,
    remainder = numerator % denominator;
  return text(remainder * 2n >= denominator ? quotient + 1n : quotient, input.precision);
}

/**
 * DEC-KITCHEN-REWORK cancel: one remake's waste is recorded and voided one at a time. The waste
 * consumer takes this lock before it reads whether the remake was cancelled as opened by mistake,
 * and the cancel consumer takes it before it looks for the waste record, so a remake cancelled
 * while its waste is being recorded is either never recorded or recorded and then voided.
 */
export async function lockKitchenReworkWaste(
  tx: LedgerTransaction,
  reworkReference: string,
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "rms_inventory.kitchen_rework_waste:" + parseInventoryReference(reworkReference),
  ]);
}

/**
 * WP-2423 Q26 (Handoff Section 26.6): records the first dish of a Kitchen remake as Store waste, in
 * the caller's transaction, from the Order line's own recipe demand (its per-line reservations).
 * The Kitchen event is the operation: one waste record per event, so a replay returns the record
 * already written. Lines that hold no stock (no recipe, or legacy submission-wide reservations)
 * record nothing. When stock is short, the available part is recorded and the rest is kept on the
 * record as a shortfall (needs review). Caller owns authorization, the event's scope check and
 * `lockKitchenReworkWaste`.
 */
export async function recordKitchenReworkWaste(
  tx: LedgerTransaction,
  scope: StoreWasteScope,
  input: {
    readonly eventReference: string;
    readonly reworkReference: string;
    readonly kitchenReasonCode: string;
    readonly submissionReference: string;
    readonly cartItemReference: string;
    readonly lineQuantity: number;
    readonly reworkQuantity: number;
    readonly actorReference: string;
    readonly occurredAt: string;
    readonly nextReference: () => string;
  },
): Promise<
  | {
      readonly status: "Applied" | "AlreadyApplied";
      readonly wasteReference: string;
      readonly lines: number;
    }
  | { readonly status: "NoStock" }
> {
  const reason = wasteReasons[input.kitchenReasonCode] ?? fail();
  const operation = parseInventoryReference(input.eventReference);
  let occurredAt: string = parseInventoryInstant(input.occurredAt);
  const reservations = await createPostgresStockReservationStore(
    { run: async <T>(work: (t: InventoryItemTransaction) => Promise<T>) => work(tx) },
    scope,
  ).loadOrderLine(input.submissionReference, input.cartItemReference);
  const merged = new Map<string, Omit<StoreWasteLine, "lineReference"> & { precision: number }>();
  const accounts = new Set<string>();
  for (const { reservation, accountReference } of reservations) {
    if (reservation.schemaVersion !== 2) continue;
    const precision = reservation.unit.ledgerPrecision;
    const demand =
      scaled(reservation.originalQuantity, precision) -
      scaled(reservation.releasedQuantity, precision);
    if (demand <= 0n) continue;
    const quantity = kitchenReworkWasteQuantity({
      lineDemand: text(demand, precision),
      precision,
      lineQuantity: input.lineQuantity,
      reworkQuantity: input.reworkQuantity,
    });
    if (scaled(quantity, precision) === 0n) continue;
    accounts.add(accountReference);
    const binding = reservation.binding;
    const key =
      binding.itemReference + "|" + binding.locationReference + "|" + (binding.lotReference ?? "");
    const prior = merged.get(key);
    merged.set(key, {
      itemReference: binding.itemReference,
      locationReference: binding.locationReference,
      lotReference: binding.lotReference,
      quantity:
        prior === undefined
          ? quantity
          : text(scaled(prior.quantity, precision) + scaled(quantity, precision), precision),
      reasonCode: reason,
      note: reason === "OTHER" ? kitchenReworkWasteNote : null,
      precision,
    });
  }
  if (merged.size === 0) return Object.freeze({ status: "NoStock" as const });
  if (merged.size > 30) return fail();
  const lines: StoreWasteLine[] = [...merged.values()].map(({ precision: _precision, ...line }) => {
    void _precision;
    return Object.freeze({
      lineReference: parseInventoryReference(input.nextReference()),
      ...line,
    });
  });
  await tx.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
    [scope.tenantReference, scope.brandReference, scope.storeReference],
  );
  const prior = (
    await tx.query(
      "SELECT waste_id::text AS waste,jsonb_array_length(record_json->'lines') AS lines FROM rms_inventory.store_waste " +
        "WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, operation],
    )
  ).rows[0];
  if (prior !== undefined)
    return Object.freeze({
      status: "AlreadyApplied" as const,
      wasteReference: String(prior.waste),
      lines: Number(prior.lines),
    });
  // A stock ledger is ordered by posting: a remake that reaches Inventory after a later movement
  // on one of these accounts (a delayed or retried event) is posted when it is booked; the
  // Kitchen time stays on the rework and its event.
  const clock = (
    await tx.query(
      "SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now," +
        "EXISTS(SELECT 1 FROM rms_inventory.stock_movement m WHERE m.tenant_id=$1 AND m.brand_id=$2 AND m.store_id=$3 " +
        "AND m.account_id=ANY($4::uuid[]) AND m.occurred_at>$5::timestamptz) AS late",
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        [...accounts],
        occurredAt,
      ],
    )
  ).rows[0];
  if (clock === undefined || typeof clock.late !== "boolean") return fail();
  if (clock.late) occurredAt = parseInventoryInstant(clock.now);
  const result = await postStoreWaste(tx, scope, {
    operationReference: operation,
    wasteReference: parseInventoryReference(input.nextReference()),
    lines,
    actorReference: parseInventoryReference(input.actorReference),
    occurredAt,
    auditReference: parseInventoryReference(input.nextReference()),
    nextReference: input.nextReference,
    source: {
      kind: "KitchenRework",
      reworkReference: parseInventoryReference(input.reworkReference),
      reasonCode: input.kitchenReasonCode,
    },
    // WP-2423 (2026-10-18): the food is already gone. When stock cannot cover it (the rest is
    // reserved for other orders, or the count is behind), the available part leaves stock and the
    // shortfall stays on the record for a manager to review and count. A remake is never blocked
    // or dead-lettered by stock accounting, and reservations are never taken.
    whenShort: "RecordAvailable",
  });
  return Object.freeze({
    status: result.status,
    wasteReference: result.record.wasteReference,
    lines: result.record.lines.length,
  });
}

/**
 * DEC-KITCHEN-REWORK cancel (2026-10-18): a remake cancelled as opened by mistake threw nothing
 * away, so its waste record (keyed by the remake's creation event) is voided: the quantity goes
 * back to stock through Correction movements. The cancel event is the operation, so a replay is a
 * no-op. No record (no recipe, or the waste consumer has not run: it then sees the cancellation and
 * records nothing) and a record a manager already reviewed are left as they are. Caller owns
 * authorization, the event's scope check and `lockKitchenReworkWaste`.
 */
export async function voidKitchenReworkWaste(
  tx: LedgerTransaction,
  scope: StoreWasteScope,
  input: {
    readonly createdEventReference: string;
    readonly cancelEventReference: string;
    readonly actorReference: string;
    readonly occurredAt: string;
    readonly nextReference: () => string;
  },
): Promise<
  | {
      readonly status: "Applied" | "AlreadyApplied" | "AlreadyReviewed";
      readonly wasteReference: string;
    }
  | { readonly status: "NoWaste" }
> {
  const created = parseInventoryReference(input.createdEventReference);
  await tx.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
    [scope.tenantReference, scope.brandReference, scope.storeReference],
  );
  const prior = (
    await tx.query(
      "SELECT waste_id::text AS waste FROM rms_inventory.store_waste " +
        "WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, created],
    )
  ).rows[0];
  if (prior === undefined) return Object.freeze({ status: "NoWaste" as const });
  // Booked when Inventory applies it (a stock ledger is ordered by posting); the Kitchen time stays
  // on the cancelled remake and its event.
  parseInventoryInstant(input.occurredAt);
  const clock = (
    await tx.query(
      "SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now",
      [],
    )
  ).rows[0];
  if (clock === undefined) return fail();
  const result = await voidKitchenRemakeWaste(tx, scope, {
    operationReference: parseInventoryReference(input.cancelEventReference),
    wasteReference: String(prior.waste),
    actorReference: parseInventoryReference(input.actorReference),
    occurredAt: parseInventoryInstant(clock.now),
    auditReference: parseInventoryReference(input.nextReference()),
    nextReference: input.nextReference,
  });
  return Object.freeze({ status: result.status, wasteReference: result.record.wasteReference });
}
