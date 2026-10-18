import type { InventoryItemAggregate } from "../../domain/inventory-item.js";
import type { StorageLocation } from "../../domain/stock-place.js";

/**
 * WP-2423: shared Inventory owner steps for Store stock documents (opening count, Store receipts,
 * counts, waste): register lots, open accounts and append ledger movements inside the caller's
 * transaction. The ledger triggers remain the final authority on every arithmetic and binding rule.
 */
export interface LedgerTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface LedgerScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export class LedgerPostingError extends Error {
  constructor(readonly code: "LEDGER_LOT_EXPIRY_MISMATCH" | "LEDGER_ACCOUNT_NOT_FOUND") {
    super(code);
    this.name = "LedgerPostingError";
  }
}

/** The Store lot for this item and printed code, registering it when new. */
export async function ensureStockLot(
  tx: LedgerTransaction,
  scope: LedgerScope,
  input: {
    readonly itemReference: string;
    readonly lotCode: string;
    readonly expiryDate: string | null;
    readonly sourceType: "OpeningCount" | "GoodsReceipt";
    readonly sourceReference: string;
    readonly actorReference: string;
    readonly occurredAt: string;
    readonly nextReference: () => string;
  },
): Promise<string> {
  const existing = (
    await tx.query(
      "SELECT lot_id::text AS lot,expiry_date::text AS expiry FROM rms_inventory.stock_lot WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND item_id=$4 AND lot_code=$5",
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        input.itemReference,
        input.lotCode,
      ],
    )
  ).rows[0];
  if (existing) {
    if ((existing.expiry ?? null) !== input.expiryDate)
      throw new LedgerPostingError("LEDGER_LOT_EXPIRY_MISMATCH");
    return String(existing.lot);
  }
  const lot = input.nextReference();
  await tx.query(
    `INSERT INTO rms_inventory.stock_lot (tenant_id,brand_id,store_id,lot_id,item_id,lot_code,expiry_date,source_type,source_id,created_at,created_by_actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      lot,
      input.itemReference,
      input.lotCode,
      input.expiryDate,
      input.sourceType,
      input.sourceReference,
      input.occurredAt,
      input.actorReference,
    ],
  );
  return lot;
}

export interface LedgerAccount {
  readonly accountReference: string;
  readonly ledgerVersion: number;
  readonly onHand: string;
  readonly reserved: string;
  readonly inTransit: string;
  readonly opened: boolean;
}
/** The account for item x location x lot, opened (zero balance) in the item's current version when absent. */
export async function ensureStockAccount(
  tx: LedgerTransaction,
  scope: LedgerScope,
  input: {
    readonly item: InventoryItemAggregate;
    readonly location: StorageLocation;
    readonly lotReference: string | null;
    readonly expiryDate: string | null;
    readonly occurredAt: string;
    readonly nextReference: () => string;
    readonly open: boolean;
  },
): Promise<LedgerAccount> {
  const found = (
    await tx.query(
      `SELECT a.account_id::text AS account,b.ledger_version::text AS version,b.on_hand::text AS on_hand,
         b.reserved::text AS reserved,b.in_transit::text AS in_transit
       FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b
         ON b.tenant_id=a.tenant_id AND b.brand_id=a.brand_id AND b.store_id=a.store_id AND b.account_id=a.account_id
       WHERE a.tenant_id=$1 AND a.brand_id=$2 AND a.store_id=$3 AND a.stock_site_id=$4 AND a.location_id=$5 AND a.item_id=$6
         AND a.lot_id IS NOT DISTINCT FROM $7::uuid`,
      [
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        input.location.stockSiteReference,
        input.location.locationReference,
        input.item.itemReference,
        input.lotReference,
      ],
    )
  ).rows[0];
  if (found)
    return {
      accountReference: String(found.account),
      ledgerVersion: Number(found.version),
      onHand: String(found.on_hand),
      reserved: String(found.reserved),
      inTransit: String(found.in_transit),
      opened: false,
    };
  if (!input.open) throw new LedgerPostingError("LEDGER_ACCOUNT_NOT_FOUND");
  const account = input.nextReference();
  await tx.query(
    `INSERT INTO rms_inventory.stock_account (tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,
       lot_id,expiry_date,unit_code,ledger_precision,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      input.location.stockSiteReference,
      input.location.locationReference,
      account,
      input.item.itemReference,
      input.item.aggregateVersion,
      input.lotReference,
      input.expiryDate,
      input.item.baseUnit.unitCode,
      input.item.baseUnit.ledgerPrecision,
      input.occurredAt,
    ],
  );
  await tx.query(
    "INSERT INTO rms_inventory.stock_balance (tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES ($1,$2,$3,$4,1,0,0,0)",
    [scope.tenantReference, scope.brandReference, scope.storeReference, account],
  );
  return {
    accountReference: account,
    ledgerVersion: 1,
    onHand: "0",
    reserved: "0",
    inTransit: "0",
    opened: true,
  };
}

/** Exact decimal addition of two non-exponent decimal strings (no binary floating point). */
export function addDecimal(left: string, right: string): string {
  const parse = (value: string) => {
    const negative = value.startsWith("-");
    const [whole = "0", fraction = ""] = (negative ? value.slice(1) : value).split(".");
    return { negative, whole, fraction };
  };
  const a = parse(left),
    b = parse(right);
  const scale = Math.max(a.fraction.length, b.fraction.length);
  const big = (p: ReturnType<typeof parse>) =>
    (p.negative ? -1n : 1n) * BigInt(p.whole + p.fraction.padEnd(scale, "0"));
  const total = big(a) + big(b);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale),
    fraction = digits.slice(digits.length - scale).replace(/0+$/u, "");
  const text = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative && text !== "0" ? "-" + text : text;
}

/** Appends one movement; quantities are decimal strings in the account's base unit. */
export async function appendStockMovement(
  tx: LedgerTransaction,
  scope: LedgerScope,
  input: {
    readonly account: LedgerAccount;
    readonly item: InventoryItemAggregate;
    readonly location: StorageLocation;
    readonly lotReference: string | null;
    readonly expiryDate: string | null;
    readonly movementType:
      "OpeningBalance" | "Receive" | "Correction" | "Adjustment" | "CountAdjustment" | "Waste";
    readonly delta: string;
    readonly businessSourceType: string;
    readonly businessSourceReference: string;
    readonly reasonCode: string;
    readonly actorReference: string;
    readonly occurredAt: string;
    readonly auditReference: string;
    readonly correctsMovementReference?: string | null;
    readonly extra?: Readonly<Record<string, unknown>>;
    readonly nextReference: () => string;
  },
): Promise<{ readonly movementReference: string; readonly account: LedgerAccount }> {
  const movement = input.nextReference();
  const outgoing = input.delta.startsWith("-");
  const afterOnHand = addDecimal(input.account.onHand, input.delta);
  const available = (onHand: string) => addDecimal(onHand, "-" + input.account.reserved);
  const unit = input.item.baseUnit.unitCode;
  const scopeOf = { scopeType: "Location", scopeReference: input.location.locationReference };
  const version = input.account.ledgerVersion + 1;
  await tx.query(
    `INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,
       base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      input.account.accountReference,
      movement,
      version,
      input.movementType,
      input.delta,
      JSON.stringify({
        movementReference: movement,
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        itemReference: input.item.itemReference,
        movementType: input.movementType,
        quantityDelta: input.delta,
        unitCode: unit,
        baseQuantityDelta: input.delta,
        baseUnitCode: unit,
        conversionMultiplier: "1",
        sourceScope: outgoing ? scopeOf : null,
        destinationScope: outgoing ? null : scopeOf,
        lotReference: input.lotReference,
        expiryDate: input.expiryDate,
        businessSourceType: input.businessSourceType,
        businessSourceReference: input.businessSourceReference,
        reasonCode: input.reasonCode,
        performedBy: input.actorReference,
        occurredAt: input.occurredAt,
        before: {
          onHand: input.account.onHand,
          reserved: input.account.reserved,
          available: available(input.account.onHand),
          inTransit: input.account.inTransit,
          unitCode: unit,
          ledgerVersion: input.account.ledgerVersion,
        },
        after: {
          onHand: afterOnHand,
          reserved: input.account.reserved,
          available: available(afterOnHand),
          inTransit: input.account.inTransit,
          unitCode: unit,
          ledgerVersion: version,
        },
        auditReference: input.auditReference,
        correctsMovementReference: input.correctsMovementReference ?? null,
        ...input.extra,
      }),
      input.auditReference,
      input.occurredAt,
    ],
  );
  return {
    movementReference: movement,
    account: { ...input.account, ledgerVersion: version, onHand: afterOnHand },
  };
}
