import type { ConsumerTransaction } from "@bop/eventing";
import {
  billTaxRoundingRule,
  type BillTaxRounding,
  type BillTaxRoundingLine,
} from "../../domain/bill-tax-rounding.js";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";

/**
 * WP-2423 DEC-TAX-WHOLE-RECEIPT step 2: the bill's tax rounding as recorded (append-only versions,
 * each superseding the last), read and written in the caller's transaction. Recorded by the system
 * rule only; the caller decides when (never once the bill has a payment).
 */
interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface RecordedBillTaxRounding {
  readonly adjustmentReference: string;
  readonly version: number;
  readonly basisDigest: string;
  readonly totalMinor: bigint;
  readonly lines: readonly BillTaxRoundingLine[];
}
const unavailable = (): never => {
  throw new Error("BILL_TAX_ROUNDING_UNAVAILABLE");
};
const context = async (transaction: ConsumerTransaction, scope: Scope) => {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  return { brand, store };
};
const integer = (value: unknown) =>
  typeof value === "string" && /^-?(0|[1-9][0-9]{0,15})$/u.test(value)
    ? BigInt(value)
    : unavailable();

/** The latest recorded version for this bill (its table's Order), or null when none was recorded. */
export async function loadBillTaxRounding(
  transaction: ConsumerTransaction,
  scope: Scope,
  billOrderReference: string,
): Promise<RecordedBillTaxRounding | null> {
  const { brand, store } = await context(transaction, scope);
  const bill = parseOrderingReference(billOrderReference);
  const [head] = (
    await transaction.query(
      "SELECT adjustment_id::text id,version,basis_digest,total_minor::text total FROM rms_ordering.order_tax_rounding_adjustment WHERE brand_id=$1 AND store_id=$2 AND bill_order_id=$3 ORDER BY version DESC LIMIT 1",
      [brand, store, bill],
    )
  ).rows as readonly { id?: unknown; version?: unknown; basis_digest?: unknown; total?: unknown }[];
  if (head === undefined) return null;
  const lines = (
    await transaction.query(
      "SELECT order_id::text order_ref,order_batch_id::text batch_ref,tax_component_code code,amount_minor::text amount FROM rms_ordering.order_tax_rounding_adjustment_line WHERE brand_id=$1 AND store_id=$2 AND adjustment_id=$3 ORDER BY line_number",
      [brand, store, head.id],
    )
  ).rows as readonly {
    order_ref?: unknown;
    batch_ref?: unknown;
    code?: unknown;
    amount?: unknown;
  }[];
  if (
    typeof head.version !== "number" ||
    typeof head.basis_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(head.basis_digest) ||
    typeof head.total !== "string"
  )
    return unavailable();
  const parsed = lines.map((line) =>
    Object.freeze({
      orderReference: String(parseOrderingReference(line.order_ref)),
      orderBatchReference: String(parseOrderingReference(line.batch_ref)),
      taxComponentCode:
        typeof line.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(line.code)
          ? line.code
          : unavailable(),
      amountMinor: integer(line.amount),
    }),
  );
  const totalMinor = integer(head.total);
  if (parsed.reduce((sum, line) => sum + line.amountMinor, 0n) !== totalMinor) return unavailable();
  return Object.freeze({
    adjustmentReference: String(parseOrderingReference(head.id)),
    version: head.version,
    basisDigest: head.basis_digest,
    totalMinor,
    lines: Object.freeze(parsed),
  });
}

/**
 * Records `computed` as the bill's current tax rounding when it differs from the latest version
 * (a new version superseding it); nothing when it is the same, or when nothing was ever recorded
 * and there is nothing to round.
 */
export async function recordBillTaxRounding(
  transaction: ConsumerTransaction,
  scope: Scope,
  input: {
    readonly billOrderReference: string;
    readonly computed: BillTaxRounding;
    readonly adjustmentReference: string;
    readonly recordedAt: string;
  },
): Promise<RecordedBillTaxRounding | null> {
  const latest = await loadBillTaxRounding(transaction, scope, input.billOrderReference);
  if (latest !== null && latest.basisDigest === input.computed.basisDigest) return latest;
  if (latest === null && input.computed.lines.length === 0) return null;
  const { brand, store } = await context(transaction, scope);
  const bill = parseOrderingReference(input.billOrderReference);
  const id = parseOrderingReference(input.adjustmentReference);
  const version = (latest?.version ?? 0) + 1;
  const inserted = await transaction.query(
    "INSERT INTO rms_ordering.order_tax_rounding_adjustment (adjustment_id,brand_id,store_id,bill_order_id,version,supersedes_adjustment_id,rule_code,rule_version,basis_digest,total_minor,currency_code,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CAD',$11)",
    [
      id,
      brand,
      store,
      bill,
      version,
      latest?.adjustmentReference ?? null,
      billTaxRoundingRule.code,
      billTaxRoundingRule.version,
      input.computed.basisDigest,
      input.computed.totalMinor.toString(),
      parseOrderingInstant(input.recordedAt),
    ],
  );
  if (inserted.rowCount !== 1) return unavailable();
  // One query at a time on the transaction (the pilot's runner refuses overlapping queries).
  for (const [index, line] of input.computed.lines.entries()) {
    const row = await transaction.query(
      "INSERT INTO rms_ordering.order_tax_rounding_adjustment_line (adjustment_id,brand_id,store_id,bill_order_id,line_number,order_id,order_batch_id,tax_component_code,amount_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        brand,
        store,
        bill,
        index + 1,
        parseOrderingReference(line.orderReference),
        parseOrderingReference(line.orderBatchReference),
        line.taxComponentCode,
        line.amountMinor.toString(),
      ],
    );
    if (row.rowCount !== 1) return unavailable();
  }
  return Object.freeze({
    adjustmentReference: String(id),
    version,
    basisDigest: input.computed.basisDigest,
    totalMinor: input.computed.totalMinor,
    lines: input.computed.lines,
  });
}

/**
 * This Order's share of its bill's tax rounding: its rounds' lines in the latest version of the
 * bill that holds them (0 when none was recorded). Part of the Order's priced total.
 */
export async function loadOrderTaxRoundingMinor(
  transaction: ConsumerTransaction,
  scope: Scope,
  orderReference: string,
): Promise<bigint> {
  const { brand, store } = await context(transaction, scope);
  const order = parseOrderingReference(orderReference);
  const rows = (
    await transaction.query(
      "SELECT a.bill_order_id::text bill,coalesce(sum(l.amount_minor),0)::text amount FROM rms_ordering.order_tax_rounding_adjustment a " +
        "JOIN rms_ordering.order_tax_rounding_adjustment_line l ON l.adjustment_id=a.adjustment_id AND l.brand_id=a.brand_id AND l.store_id=a.store_id " +
        "WHERE a.brand_id=$1 AND a.store_id=$2 AND l.order_id=$3 AND a.version=(SELECT max(v.version) FROM rms_ordering.order_tax_rounding_adjustment v WHERE v.brand_id=a.brand_id AND v.store_id=a.store_id AND v.bill_order_id=a.bill_order_id) " +
        "GROUP BY a.bill_order_id",
      [brand, store, order],
    )
  ).rows as readonly { bill?: unknown; amount?: unknown }[];
  // An Order is on one bill at a time.
  if (rows.length > 1) return unavailable();
  return rows.length === 0 ? 0n : integer(rows[0]?.amount);
}
