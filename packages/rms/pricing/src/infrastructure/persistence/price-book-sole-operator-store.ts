import { parsePricingReference } from "../../domain/money-tax-contract.js";

/** WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): the mark of a price book published by its own
 * author as sole operator. Append-only; written in the publishing transaction. */
export interface PriceBookSoleOperatorTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export class PriceBookSoleOperatorError extends Error {
  constructor(readonly code: "PRICE_BOOK_SOLE_OPERATOR_CONFLICT") {
    super(code);
    this.name = "PriceBookSoleOperatorError";
  }
}
const conflict = (): never => {
  throw new PriceBookSoleOperatorError("PRICE_BOOK_SOLE_OPERATOR_CONFLICT");
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const instant = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : value;
  return typeof text === "string" && instantPattern.test(text) ? text : conflict();
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  return d && "value" in d && Array.isArray(d.value) ? d.value : conflict();
}

/**
 * Records the mark for a Publish operation already committed in this transaction (the database
 * checks it is a publication of the same book, and the 15-minute second-factor window). Exact
 * replay of the same operation returns the existing mark; anything else conflicts.
 */
export async function recordPriceBookSoleOperatorApproval(
  tx: PriceBookSoleOperatorTransaction,
  input: {
    readonly brandReference: string;
    readonly priceBookReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly actorMfaAt: string;
    readonly approvedAt: string;
    readonly auditReference: string;
  },
): Promise<"Created" | "AlreadyCommitted"> {
  const value = {
    brand: String(parsePricingReference(input.brandReference)),
    book: String(parsePricingReference(input.priceBookReference)),
    operation: String(parsePricingReference(input.operationReference)),
    actor: String(parsePricingReference(input.actorReference)),
    audit: String(parsePricingReference(input.auditReference)),
    mfa: instant(input.actorMfaAt),
    at: instant(input.approvedAt),
  };
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    value.brand,
  ]);
  const prior = rows(
    await tx.query(
      "SELECT price_book_id::text book,actor_id::text actor,audit_id::text audit FROM rms_pricing.price_book_sole_operator_approval WHERE operation_id=$1 AND brand_id=$2",
      [value.operation, value.brand],
    ),
  )[0];
  if (prior !== undefined) {
    if (prior.book !== value.book || prior.actor !== value.actor || prior.audit !== value.audit)
      return conflict();
    return "AlreadyCommitted";
  }
  await tx.query(
    "INSERT INTO rms_pricing.price_book_sole_operator_approval (operation_id,brand_id,price_book_id,approval_mode,actor_id,actor_mfa_at,approved_at,audit_id) VALUES ($1,$2,$3,'SoleOperator',$4,$5,$6,$7)",
    [value.operation, value.brand, value.book, value.actor, value.mfa, value.at, value.audit],
  );
  return "Created";
}

/**
 * WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the mark of an option price published by its own draft
 * author as sole operator, for a Publish operation already committed in this transaction (the
 * database checks it is that author's own publication of the same rule at the same instant, the
 * 15-minute second-factor window and that sole operator is on). The Brand scope must be set. Exact
 * replay of the same operation returns the existing mark; anything else conflicts.
 */
export async function recordOptionPriceSoleOperatorApproval(
  tx: PriceBookSoleOperatorTransaction,
  input: {
    readonly brandReference: string;
    readonly ruleReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly actorMfaAt: string;
    readonly approvedAt: string;
    readonly auditReference: string;
  },
): Promise<"Created" | "AlreadyCommitted"> {
  const value = {
    brand: String(parsePricingReference(input.brandReference)),
    rule: String(parsePricingReference(input.ruleReference)),
    operation: String(parsePricingReference(input.operationReference)),
    actor: String(parsePricingReference(input.actorReference)),
    audit: String(parsePricingReference(input.auditReference)),
    mfa: instant(input.actorMfaAt),
    at: instant(input.approvedAt),
  };
  const prior = rows(
    await tx.query(
      "SELECT option_price_rule_id::text rule,actor_id::text actor,audit_id::text audit FROM rms_pricing.option_price_sole_operator_approval WHERE operation_id=$1 AND brand_id=$2",
      [value.operation, value.brand],
    ),
  )[0];
  if (prior !== undefined) {
    if (prior.rule !== value.rule || prior.actor !== value.actor || prior.audit !== value.audit)
      return conflict();
    return "AlreadyCommitted";
  }
  await tx.query(
    "INSERT INTO rms_pricing.option_price_sole_operator_approval (operation_id,brand_id,option_price_rule_id,approval_mode,actor_id,actor_mfa_at,approved_at,audit_id) VALUES ($1,$2,$3,'SoleOperator',$4,$5,$6,$7)",
    [value.operation, value.brand, value.rule, value.actor, value.mfa, value.at, value.audit],
  );
  return "Created";
}

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU: the mark of a price book or option price published by
 * its own draft author at a single store ("List it", no review), for a Publish operation already
 * committed in this transaction. The database refuses it unless the Brand has exactly one store
 * (not archived), the one named. Exact replay returns the existing mark; anything else conflicts.
 */
export async function recordPricingSingleStoreListing(
  tx: PriceBookSoleOperatorTransaction,
  input: {
    readonly subject: "PriceBook" | "OptionPrice";
    readonly brandReference: string;
    readonly storeReference: string;
    /** The price book, or the option price rule. */
    readonly targetReference: string;
    readonly operationReference: string;
    readonly actorReference: string;
    readonly listedAt: string;
    readonly auditReference: string;
  },
): Promise<"Created" | "AlreadyCommitted"> {
  const table =
    input.subject === "PriceBook"
      ? { name: "price_book_single_store_listing", target: "price_book_id" }
      : { name: "option_price_single_store_listing", target: "option_price_rule_id" };
  const value = {
    brand: String(parsePricingReference(input.brandReference)),
    store: String(parsePricingReference(input.storeReference)),
    target: String(parsePricingReference(input.targetReference)),
    operation: String(parsePricingReference(input.operationReference)),
    actor: String(parsePricingReference(input.actorReference)),
    audit: String(parsePricingReference(input.auditReference)),
    at: instant(input.listedAt),
  };
  // Brand-scoped mark; the Store scope stays as the command set it, since its own Store-scoped
  // rows (an option price's authoring operation) are still checked before commit.
  await tx.query("SELECT set_config('bop.brand_id',$1,true)", [value.brand]);
  const prior = rows(
    await tx.query(
      `SELECT ${table.target}::text target,actor_id::text actor,audit_id::text audit FROM rms_pricing.${table.name} WHERE operation_id=$1 AND brand_id=$2`,
      [value.operation, value.brand],
    ),
  )[0];
  if (prior !== undefined) {
    if (prior.target !== value.target || prior.actor !== value.actor || prior.audit !== value.audit)
      return conflict();
    return "AlreadyCommitted";
  }
  await tx.query(
    `INSERT INTO rms_pricing.${table.name} (operation_id,brand_id,${table.target},approval_mode,listing_store_id,actor_id,listed_at,audit_id) VALUES ($1,$2,$3,'SingleStoreListing',$4,$5,$6,$7)`,
    [value.operation, value.brand, value.target, value.store, value.actor, value.at, value.audit],
  );
  return "Created";
}
