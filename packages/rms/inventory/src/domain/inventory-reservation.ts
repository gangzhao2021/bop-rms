import {
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  parseInventoryUnit,
  type InventoryInstant,
  type InventoryReference,
  type InventoryUnit,
} from "./inventory-item.js";

export interface InventoryReservationBinding {
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly storeReference: InventoryReference;
  readonly stockSiteReference: InventoryReference;
  readonly locationReference: InventoryReference;
  readonly itemReference: InventoryReference;
  readonly lotReference: InventoryReference | null;
  readonly submissionReference: InventoryReference;
  readonly cartReference: InventoryReference;
  readonly cartVersion: number;
  readonly quoteReference: InventoryReference;
  readonly demandReference: InventoryReference;
  readonly demandDigest: string;
  /** Schema 2: the Order line whose recipe demand this reservation holds (per-line consumption). */
  readonly cartItemReference?: InventoryReference;
}

export interface InventoryReservation {
  readonly schemaVersion: 1 | 2;
  readonly reservationReference: InventoryReference;
  readonly binding: InventoryReservationBinding;
  readonly unit: InventoryUnit;
  readonly originalQuantity: string;
  readonly remainingQuantity: string;
  readonly releasedQuantity: string;
  readonly consumedQuantity: string;
  readonly productionStartedAt: InventoryInstant | null;
  readonly createdAt: InventoryInstant;
  readonly updatedAt: InventoryInstant;
  readonly version: number;
}

export class InventoryReservationError extends Error {
  constructor(
    readonly code:
      | "INVENTORY_RESERVATION_INVALID"
      | "INVENTORY_RESERVATION_CONFLICT"
      | "INVENTORY_RESERVATION_BINDING_MISMATCH"
      | "INVENTORY_RESERVATION_RELEASE_DENIED"
      | "INVENTORY_RESERVATION_QUANTITY_EXCEEDED",
  ) {
    super("Inventory reservation transition failed");
    this.name = "InventoryReservationError";
  }
}
const invalid = (): never => {
  throw new InventoryReservationError("INVENTORY_RESERVATION_INVALID");
};
const unitFields = ["unitCode", "dimension", "displayPrecision", "ledgerPrecision", "roundingMode"];
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return invalid();
    output[field] = d.value;
  }
  return output;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return invalid();
  return Number(value);
}
function binding(value: unknown, schemaVersion: 1 | 2): InventoryReservationBinding {
  const refs = [
    "tenantReference",
    "brandReference",
    "storeReference",
    "stockSiteReference",
    "locationReference",
    "itemReference",
    "submissionReference",
    "cartReference",
    "quoteReference",
    "demandReference",
  ] as const;
  const raw = exact(value, [
    ...refs,
    "lotReference",
    "cartVersion",
    "demandDigest",
    ...(schemaVersion === 2 ? ["cartItemReference"] : []),
  ]);
  const references = Object.fromEntries(
    refs.map((key) => [key, parseInventoryReference(raw[key])]),
  ) as Readonly<Record<(typeof refs)[number], InventoryReference>>;
  if (typeof raw.demandDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(raw.demandDigest))
    return invalid();
  return Object.freeze({
    ...references,
    lotReference: raw.lotReference === null ? null : parseInventoryReference(raw.lotReference),
    cartVersion: version(raw.cartVersion),
    demandDigest: raw.demandDigest,
    ...(schemaVersion === 2
      ? { cartItemReference: parseInventoryReference(raw.cartItemReference) }
      : {}),
  });
}
function quantity(value: unknown, precision: number): bigint {
  const parsed = parseInventoryDecimal(value);
  const [whole, fraction = ""] = parsed.split(".");
  const fixed = BigInt(whole + fraction.padEnd(6, "0"));
  if (fixed % 10n ** BigInt(6 - precision) !== 0n) return invalid();
  return fixed;
}
function decimal(value: bigint): string {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return (value / 1_000_000n).toString() + (fraction ? "." + fraction : "");
}
function guarded<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof InventoryReservationError) throw error;
    return invalid();
  }
}

export function parseInventoryReservation(value: unknown): InventoryReservation {
  return guarded(() => {
    const raw = exact(value, [
      "schemaVersion",
      "reservationReference",
      "binding",
      "unit",
      "originalQuantity",
      "remainingQuantity",
      "releasedQuantity",
      "consumedQuantity",
      "productionStartedAt",
      "createdAt",
      "updatedAt",
      "version",
    ]);
    if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) return invalid();
    const schemaVersion = raw.schemaVersion;
    const unit = parseInventoryUnit(exact(raw.unit, unitFields));
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/u.test(unit.unitCode)) return invalid();
    const original = quantity(raw.originalQuantity, unit.ledgerPrecision),
      remaining = quantity(raw.remainingQuantity, unit.ledgerPrecision),
      released = quantity(raw.releasedQuantity, unit.ledgerPrecision),
      consumed = quantity(raw.consumedQuantity, unit.ledgerPrecision);
    const createdAt = parseInventoryInstant(raw.createdAt),
      updatedAt = parseInventoryInstant(raw.updatedAt);
    const started =
      raw.productionStartedAt === null ? null : parseInventoryInstant(raw.productionStartedAt);
    if (
      original <= 0n ||
      original !== remaining + released + consumed ||
      updatedAt < createdAt ||
      (raw.version === 1 &&
        (released !== 0n || consumed !== 0n || started !== null || updatedAt !== createdAt)) ||
      (started !== null && (started < createdAt || started > updatedAt))
    )
      return invalid();
    return Object.freeze({
      schemaVersion,
      reservationReference: parseInventoryReference(raw.reservationReference),
      binding: binding(raw.binding, schemaVersion),
      unit,
      originalQuantity: decimal(original),
      remainingQuantity: decimal(remaining),
      releasedQuantity: decimal(released),
      consumedQuantity: decimal(consumed),
      productionStartedAt: started,
      createdAt,
      updatedAt,
      version: version(raw.version),
    });
  });
}

/** Candidate only: owner authorization and atomic Reserve/Movement/Audit commit remain required. */
export function createInventoryReservation(value: unknown): InventoryReservation {
  return guarded(() => {
    const raw = exact(value, ["reservationReference", "binding", "unit", "quantity", "occurredAt"]);
    const perLine =
      raw.binding !== null &&
      typeof raw.binding === "object" &&
      Object.hasOwn(raw.binding, "cartItemReference");
    return parseInventoryReservation({
      schemaVersion: perLine ? 2 : 1,
      reservationReference: raw.reservationReference,
      binding: raw.binding,
      unit: raw.unit,
      originalQuantity: raw.quantity,
      remainingQuantity: raw.quantity,
      releasedQuantity: "0",
      consumedQuantity: "0",
      productionStartedAt: null,
      createdAt: raw.occurredAt,
      updatedAt: raw.occurredAt,
      version: 1,
    });
  });
}

/** Pure candidate transition; durable idempotency must resolve before this expected-version fence. */
export function advanceInventoryReservation(
  value: unknown,
  command: unknown,
): InventoryReservation {
  return guarded(() => {
    const current = parseInventoryReservation(value);
    const raw = exact(command, [
      "reservationReference",
      "binding",
      "expectedVersion",
      "action",
      "quantity",
      "occurredAt",
    ]);
    if (
      parseInventoryReference(raw.reservationReference) !== current.reservationReference ||
      JSON.stringify(binding(raw.binding, current.schemaVersion)) !==
        JSON.stringify(current.binding)
    )
      throw new InventoryReservationError("INVENTORY_RESERVATION_BINDING_MISMATCH");
    if (
      version(raw.expectedVersion) !== current.version ||
      current.version >= Number.MAX_SAFE_INTEGER
    )
      throw new InventoryReservationError("INVENTORY_RESERVATION_CONFLICT");
    const occurredAt = parseInventoryInstant(raw.occurredAt);
    if (
      occurredAt < current.updatedAt ||
      typeof raw.action !== "string" ||
      !["StartProduction", "Release", "Consume"].includes(raw.action)
    )
      return invalid();
    const remaining = quantity(current.remainingQuantity, current.unit.ledgerPrecision);
    if (remaining === 0n) throw new InventoryReservationError("INVENTORY_RESERVATION_CONFLICT");
    if (raw.action === "StartProduction") {
      if (raw.quantity !== null) return invalid();
      if (current.productionStartedAt !== null)
        throw new InventoryReservationError("INVENTORY_RESERVATION_CONFLICT");
      return Object.freeze({
        ...current,
        productionStartedAt: occurredAt,
        updatedAt: occurredAt,
        version: current.version + 1,
      });
    }
    if (raw.action === "Release" && current.productionStartedAt !== null)
      throw new InventoryReservationError("INVENTORY_RESERVATION_RELEASE_DENIED");
    const delta = quantity(raw.quantity, current.unit.ledgerPrecision);
    if (delta === 0n) return invalid();
    if (delta > remaining)
      throw new InventoryReservationError("INVENTORY_RESERVATION_QUANTITY_EXCEEDED");
    return Object.freeze({
      ...current,
      remainingQuantity: decimal(remaining - delta),
      releasedQuantity:
        raw.action === "Release"
          ? decimal(quantity(current.releasedQuantity, current.unit.ledgerPrecision) + delta)
          : current.releasedQuantity,
      consumedQuantity:
        raw.action === "Consume"
          ? decimal(quantity(current.consumedQuantity, current.unit.ledgerPrecision) + delta)
          : current.consumedQuantity,
      updatedAt: occurredAt,
      version: current.version + 1,
    });
  });
}
