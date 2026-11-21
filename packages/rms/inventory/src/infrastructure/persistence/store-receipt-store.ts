import { appendAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { InventoryItemAggregate } from "../../domain/inventory-item.js";
import type { StorageLocation } from "../../domain/stock-place.js";
import {
  StoreReceiptError,
  storeReceiptVoidReasons,
  validateStoreReceiptLines,
  type StoreReceipt,
} from "../../domain/store-receipt.js";
import {
  addDecimal,
  appendStockMovement,
  ensureStockAccount,
  ensureStockLot,
  LedgerPostingError,
} from "./ledger-posting.js";
import { openingCountReferences } from "./opening-count-store.js";

/**
 * WP-2423 / DEC-INV-DIRECT-RECEIPT: Inventory owner persistence for Store direct receipts, inside the
 * caller's transaction. Posting and voiding are each all-or-nothing and idempotent per operation.
 */
export interface StoreReceiptTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface StoreReceiptScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface PostedStoreReceipt extends StoreReceipt {
  readonly movements: readonly {
    readonly lineReference: string;
    readonly movementReference: string;
  }[];
  readonly voided: {
    readonly reasonCode: string;
    readonly voidedBy: string;
    readonly voidedAt: string;
  } | null;
}
const fail = (code: StoreReceiptError["code"], line: string | null = null): never => {
  throw new StoreReceiptError(code, line);
};
const scoped = (tx: StoreReceiptTransaction, scope: StoreReceiptScope) =>
  tx.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
    [scope.tenantReference, scope.brandReference, scope.storeReference],
  );
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const selectSql = `SELECT r.snapshot_json AS snapshot,v.reason_code,v.voided_by_actor_id::text AS voided_by,v.voided_at
  FROM rms_inventory.store_receipt r LEFT JOIN rms_inventory.store_receipt_void v
    ON v.tenant_id=r.tenant_id AND v.brand_id=r.brand_id AND v.store_id=r.store_id AND v.receipt_id=r.receipt_id
  WHERE r.tenant_id=$1 AND r.brand_id=$2 AND r.store_id=$3`;
const decode = (row: Record<string, unknown>): PostedStoreReceipt => ({
  ...(row.snapshot as PostedStoreReceipt),
  voided:
    row.reason_code === null || row.reason_code === undefined
      ? null
      : {
          reasonCode: String(row.reason_code),
          voidedBy: String(row.voided_by),
          voidedAt: iso(row.voided_at),
        },
});

export async function listStoreReceipts(
  tx: StoreReceiptTransaction,
  scope: StoreReceiptScope,
  input: { readonly before: string | null; readonly limit: number },
): Promise<{ readonly receipts: readonly PostedStoreReceipt[]; readonly hasMore: boolean }> {
  await scoped(tx, scope);
  const limit = Math.max(1, Math.min(100, input.limit));
  const rows = (
    await tx.query(
      selectSql +
        " AND ($4::timestamptz IS NULL OR r.received_at < $4) ORDER BY r.received_at DESC LIMIT $5",
      [scope.tenantReference, scope.brandReference, scope.storeReference, input.before, limit + 1],
    )
  ).rows;
  return { receipts: rows.slice(0, limit).map(decode), hasMore: rows.length > limit };
}
export async function loadStoreReceipt(
  tx: StoreReceiptTransaction,
  scope: StoreReceiptScope,
  receiptReference: string,
): Promise<PostedStoreReceipt | null> {
  await scoped(tx, scope);
  const row = (
    await tx.query(selectSql + " AND r.receipt_id=$4", [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      receiptReference,
    ])
  ).rows[0];
  return row ? decode(row) : null;
}

async function audit(
  tx: StoreReceiptTransaction,
  scope: StoreReceiptScope,
  value: {
    readonly auditReference: string;
    readonly actorReference: string;
    readonly actionCode: string;
    readonly receiptReference: string;
    readonly reasonCode: string;
    readonly correlationId: string;
    readonly occurredAt: string;
    readonly summary: Record<string, string | number | null>;
  },
) {
  await appendAuditRecordInTransaction(tx, {
    auditId: value.auditReference,
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "User", reference: value.actorReference },
    actionCode: value.actionCode,
    targetType: "StoreReceipt",
    targetId: value.receiptReference,
    afterSummary: value.summary,
    reasonCode: value.reasonCode,
    correlationId: value.correlationId,
    occurredAt: value.occurredAt,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_STANDARD",
    retentionPolicyVersion: 1,
  });
}

/** Records the receipt and one Receive movement per line with an accepted quantity. */
export async function postStoreReceipt(
  tx: StoreReceiptTransaction,
  scope: StoreReceiptScope,
  input: {
    readonly operationReference: string;
    readonly receipt: StoreReceipt;
    readonly auditReference: string;
    readonly nextReference: () => string;
  },
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly receipt: PostedStoreReceipt;
}> {
  const receipt = input.receipt;
  if (
    receipt.tenantReference !== scope.tenantReference ||
    receipt.brandReference !== scope.brandReference ||
    receipt.storeReference !== scope.storeReference
  )
    return fail("STORE_RECEIPT_INVALID");
  await scoped(tx, scope);
  const intent =
    "sha256:" +
    sha256Hex(
      canonicalizeRfc8785({ receipt: { ...receipt, receivedAt: null }, actor: receipt.receivedBy }),
    );
  const prior = (
    await tx.query(
      "SELECT receipt_id::text AS receipt,intent_hash FROM rms_inventory.store_receipt WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
      [scope.tenantReference, scope.brandReference, scope.storeReference, input.operationReference],
    )
  ).rows[0];
  if (prior) {
    if (prior.intent_hash !== intent) fail("STORE_RECEIPT_IDEMPOTENCY_CONFLICT");
    return {
      status: "AlreadyApplied",
      receipt:
        (await loadStoreReceipt(tx, scope, String(prior.receipt))) ??
        fail("STORE_RECEIPT_NOT_FOUND"),
    };
  }
  const refs = await openingCountReferences(
    tx,
    scope,
    receipt.lines.map((line) => line.itemReference),
  );
  validateStoreReceiptLines(receipt.lines, refs.items, refs.locations);
  const movements: { lineReference: string; movementReference: string }[] = [];
  for (const line of receipt.lines) {
    if (/^0(?:\.0+)?$/u.test(line.acceptedQuantity)) continue;
    const item = refs.items.get(line.itemReference) as InventoryItemAggregate,
      location = refs.locations.get(line.locationReference) as StorageLocation;
    let lot: string | null = null;
    try {
      if (line.lotCode !== null)
        lot = await ensureStockLot(tx, scope, {
          itemReference: item.itemReference,
          lotCode: line.lotCode,
          expiryDate: line.expiryDate,
          sourceType: "GoodsReceipt",
          sourceReference: receipt.receiptReference,
          actorReference: receipt.receivedBy,
          occurredAt: receipt.receivedAt,
          nextReference: input.nextReference,
        });
    } catch (error) {
      if (error instanceof LedgerPostingError)
        fail("STORE_RECEIPT_LINE_INVALID", line.lineReference);
      throw error;
    }
    const account = await ensureStockAccount(tx, scope, {
      item,
      location,
      lotReference: lot,
      expiryDate: line.expiryDate,
      occurredAt: receipt.receivedAt,
      nextReference: input.nextReference,
      open: true,
    });
    const posted = await appendStockMovement(tx, scope, {
      account,
      item,
      location,
      lotReference: lot,
      expiryDate: line.expiryDate,
      movementType: "Receive",
      delta: line.acceptedQuantity,
      businessSourceType: "StoreReceipt",
      businessSourceReference: receipt.receiptReference,
      reasonCode: "STORE_DIRECT_RECEIPT",
      actorReference: receipt.receivedBy,
      occurredAt: receipt.receivedAt,
      auditReference: input.auditReference,
      extra: { unitCostMinor: line.unitCostMinor },
      nextReference: input.nextReference,
    });
    movements.push({
      lineReference: line.lineReference,
      movementReference: posted.movementReference,
    });
  }
  const stored: PostedStoreReceipt = { ...receipt, movements, voided: null };
  await tx.query(
    `INSERT INTO rms_inventory.store_receipt (tenant_id,brand_id,store_id,receipt_id,operation_id,intent_hash,supplier_name,supplier_document,
       currency_code,line_count,snapshot_json,received_by_actor_id,received_at,audit_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CAD',$9,$10,$11,$12,$13)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      receipt.receiptReference,
      input.operationReference,
      intent,
      receipt.supplierName,
      receipt.supplierDocument,
      receipt.lines.length,
      JSON.stringify({ ...receipt, movements }),
      receipt.receivedBy,
      receipt.receivedAt,
      input.auditReference,
    ],
  );
  await audit(tx, scope, {
    auditReference: input.auditReference,
    actorReference: receipt.receivedBy,
    actionCode: "INVENTORY_STORE_RECEIPT_POSTED",
    receiptReference: receipt.receiptReference,
    reasonCode: "STORE_DIRECT_RECEIPT",
    correlationId: input.operationReference,
    occurredAt: receipt.receivedAt,
    summary: {
      lines: receipt.lines.length,
      movements: movements.length,
      rejectedOrDamagedLines: receipt.lines.filter((line) => line.discrepancyReason !== null)
        .length,
    },
  });
  return { status: "Applied", receipt: stored };
}

/** Reverses every Receive of the receipt with a Correction; refused once that stock was used. */
export async function voidStoreReceipt(
  tx: StoreReceiptTransaction,
  scope: StoreReceiptScope,
  input: {
    readonly operationReference: string;
    readonly receiptReference: string;
    readonly reasonCode: string;
    readonly actorReference: string;
    readonly occurredAt: string;
    readonly auditReference: string;
    readonly nextReference: () => string;
  },
): Promise<{
  readonly status: "Applied" | "AlreadyApplied";
  readonly receipt: PostedStoreReceipt;
}> {
  if (!(storeReceiptVoidReasons as readonly string[]).includes(input.reasonCode))
    return fail("STORE_RECEIPT_INVALID");
  await scoped(tx, scope);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "StoreReceipt:" + input.receiptReference,
  ]);
  const receipt = await loadStoreReceipt(tx, scope, input.receiptReference);
  if (receipt === null) return fail("STORE_RECEIPT_NOT_FOUND");
  if (receipt.voided !== null) {
    const same = (
      await tx.query(
        "SELECT 1 FROM rms_inventory.store_receipt_void WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND receipt_id=$4 AND operation_id=$5",
        [
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          input.receiptReference,
          input.operationReference,
        ],
      )
    ).rows.length;
    if (same) return { status: "AlreadyApplied", receipt };
    return fail("STORE_RECEIPT_ALREADY_VOIDED");
  }
  const refs = await openingCountReferences(
    tx,
    scope,
    receipt.lines.map((line) => line.itemReference),
  );
  const ofItems = new Map<string, InventoryItemAggregate>(refs.items);
  for (const { lineReference, movementReference } of receipt.movements) {
    const line = receipt.lines.find((item) => item.lineReference === lineReference);
    const row = (
      await tx.query(
        `SELECT m.account_id::text AS account,a.location_id::text AS location,a.lot_id::text AS lot,a.expiry_date::text AS expiry,
           b.ledger_version::text AS version,b.on_hand::text AS on_hand,b.reserved::text AS reserved,b.in_transit::text AS in_transit
         FROM rms_inventory.stock_movement m
         JOIN rms_inventory.stock_account a USING (tenant_id,brand_id,store_id,account_id)
         JOIN rms_inventory.stock_balance b USING (tenant_id,brand_id,store_id,account_id)
         WHERE m.tenant_id=$1 AND m.brand_id=$2 AND m.store_id=$3 AND m.movement_id=$4`,
        [scope.tenantReference, scope.brandReference, scope.storeReference, movementReference],
      )
    ).rows[0];
    const item = line ? ofItems.get(line.itemReference) : undefined;
    const location = row ? refs.locations.get(String(row.location)) : undefined;
    if (!line || !row || !item || !location) return fail("STORE_RECEIPT_STOCK_USED", lineReference);
    // The received quantity must still be on hand and unreserved at that account.
    const left = addDecimal(
      addDecimal(String(row.on_hand), "-" + String(row.reserved)),
      "-" + line.acceptedQuantity,
    );
    if (left.startsWith("-")) return fail("STORE_RECEIPT_STOCK_USED", lineReference);
    await appendStockMovement(tx, scope, {
      account: {
        accountReference: String(row.account),
        ledgerVersion: Number(row.version),
        onHand: String(row.on_hand),
        reserved: String(row.reserved),
        inTransit: String(row.in_transit),
        opened: false,
      },
      item,
      location,
      lotReference: row.lot === null ? null : String(row.lot),
      expiryDate: row.expiry === null ? null : String(row.expiry),
      movementType: "Correction",
      delta: "-" + line.acceptedQuantity,
      businessSourceType: "StoreReceiptVoid",
      businessSourceReference: receipt.receiptReference,
      reasonCode: input.reasonCode,
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
      auditReference: input.auditReference,
      correctsMovementReference: movementReference,
      nextReference: input.nextReference,
    });
  }
  await tx.query(
    `INSERT INTO rms_inventory.store_receipt_void (tenant_id,brand_id,store_id,receipt_id,operation_id,reason_code,voided_by_actor_id,voided_at,movement_count,audit_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      input.receiptReference,
      input.operationReference,
      input.reasonCode,
      input.actorReference,
      input.occurredAt,
      receipt.movements.length,
      input.auditReference,
    ],
  );
  await audit(tx, scope, {
    auditReference: input.auditReference,
    actorReference: input.actorReference,
    actionCode: "INVENTORY_STORE_RECEIPT_VOIDED",
    receiptReference: input.receiptReference,
    reasonCode: input.reasonCode,
    correlationId: input.operationReference,
    occurredAt: input.occurredAt,
    summary: { reversedMovements: receipt.movements.length },
  });
  return {
    status: "Applied",
    receipt: {
      ...receipt,
      voided: {
        reasonCode: input.reasonCode,
        voidedBy: input.actorReference,
        voidedAt: input.occurredAt,
      },
    },
  };
}
