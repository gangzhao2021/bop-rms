import {
  parseInventoryReference,
  parseInventoryInstant,
  parseInventoryDecimal,
  parseInventoryUnit,
} from "./inventory-item.js";
import { ReservationBalanceError } from "./reservation-balance.js";
function fail(): never {
  throw new ReservationBalanceError("INVENTORY_BALANCE_INVALID");
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail();
  return Number(value);
}
function fixed(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 1024) return fail();
  const parsed = parseInventoryDecimal(value),
    [whole, fraction = ""] = parsed.split(".");
  return BigInt(whole + fraction.padEnd(6, "0"));
}
function decimal(value: bigint): string {
  const fraction = (value % 1000000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return (value / 1000000n).toString() + (fraction ? "." + fraction : "");
}
/** All-or-none proposal. Current permissions, policies and account locks still gate actual writes. */
export function planStockAllocation(value: unknown) {
  const raw = record(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "stockSiteReference",
    "itemReference",
    "currentItemVersion",
    "unit",
    "quantity",
    "issuePolicy",
    "observedAt",
    "candidates",
  ]);
  const scope = Object.freeze({
    tenantReference: parseInventoryReference(raw.tenantReference),
    brandReference: parseInventoryReference(raw.brandReference),
    storeReference: parseInventoryReference(raw.storeReference),
    stockSiteReference: parseInventoryReference(raw.stockSiteReference),
    itemReference: parseInventoryReference(raw.itemReference),
    currentItemVersion: integer(raw.currentItemVersion),
  });
  const unit = parseInventoryUnit(
    record(raw.unit, [
      "unitCode",
      "dimension",
      "displayPrecision",
      "ledgerPrecision",
      "roundingMode",
    ]),
  );
  const observedAt = parseInventoryInstant(raw.observedAt),
    quantity = fixed(raw.quantity);
  const quantum = 10n ** BigInt(6 - unit.ledgerPrecision);
  if (
    quantity % quantum !== 0n ||
    !["FIFO", "FEFO"].includes(String(raw.issuePolicy)) ||
    !Array.isArray(raw.candidates) ||
    raw.candidates.length > 1000 ||
    Reflect.ownKeys(raw.candidates).length !== raw.candidates.length + 1
  )
    return fail();
  const seen = new Set<string>();
  const eligible = [];
  for (let i = 0; i < raw.candidates.length; i++) {
    const slot = Object.getOwnPropertyDescriptor(raw.candidates, String(i));
    if (!slot?.enumerable || !("value" in slot)) return fail();
    const c = record(slot.value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "stockSiteReference",
      "itemReference",
      "currentItemVersion",
      "accountReference",
      "locationReference",
      "ledgerVersion",
      "unitCode",
      "ledgerPrecision",
      "available",
      "holdStatus",
      "firstReceivedAt",
      "observedAt",
      "expiryDate",
      "expiryCutoff",
    ]);
    for (const [field, expected] of Object.entries(scope)) if (c[field] !== expected) return fail();
    const account = parseInventoryReference(c.accountReference),
      location = parseInventoryReference(c.locationReference);
    const ledgerVersion = integer(c.ledgerVersion),
      available = fixed(c.available),
      received = parseInventoryInstant(c.firstReceivedAt);
    if (
      seen.has(account) ||
      c.unitCode !== unit.unitCode ||
      c.ledgerPrecision !== unit.ledgerPrecision ||
      available % quantum !== 0n ||
      c.observedAt !== observedAt ||
      received > observedAt ||
      !["Available", "Quarantined"].includes(String(c.holdStatus))
    )
      return fail();
    seen.add(account);
    let cutoff: string | null = null;
    if (c.expiryDate === null) {
      if (c.expiryCutoff !== null) return fail();
    } else {
      if (
        typeof c.expiryDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(c.expiryDate) ||
        !Number.isFinite(Date.parse(c.expiryDate + "T00:00:00.000Z")) ||
        new Date(c.expiryDate + "T00:00:00.000Z").toISOString().slice(0, 10) !== c.expiryDate ||
        raw.issuePolicy !== "FEFO"
      )
        return fail();
      cutoff = parseInventoryInstant(c.expiryCutoff);
    }
    if (
      c.holdStatus === "Quarantined" ||
      available === 0n ||
      (cutoff !== null && cutoff <= observedAt)
    )
      continue;
    eligible.push({
      accountReference: account,
      locationReference: location,
      ledgerVersion,
      available,
      received,
      cutoff,
    });
  }
  eligible.sort((a, b) => {
    if (raw.issuePolicy === "FEFO" && a.cutoff !== b.cutoff) {
      if (a.cutoff === null) return 1;
      if (b.cutoff === null) return -1;
      return a.cutoff < b.cutoff ? -1 : 1;
    }
    if (a.received !== b.received) return a.received < b.received ? -1 : 1;
    return a.accountReference < b.accountReference
      ? -1
      : a.accountReference > b.accountReference
        ? 1
        : 0;
  });
  const total = eligible.reduce((sum, c) => sum + c.available, 0n);
  let remaining = quantity;
  const allocations = [];
  if (total >= quantity)
    for (const c of eligible) {
      if (remaining === 0n) break;
      const taken = c.available < remaining ? c.available : remaining;
      allocations.push(
        Object.freeze({
          accountReference: c.accountReference,
          locationReference: c.locationReference,
          expectedLedgerVersion: c.ledgerVersion,
          quantity: decimal(taken),
        }),
      );
      remaining -= taken;
    }
  return Object.freeze({
    ...scope,
    unit,
    observedAt,
    quantity: decimal(quantity),
    status: total >= quantity ? ("Ready" as const) : ("Insufficient" as const),
    shortage: decimal(total >= quantity ? 0n : quantity - total),
    allocations: Object.freeze(allocations),
  });
}
