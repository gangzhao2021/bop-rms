import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
} from "../../domain/cart.js";
import { createPostgresCartQueryStore, type CartQueryTransaction } from "./cart-query-store.js";
import { createPostgresDiningCartReadStore } from "./dining-cart-read-store.js";

/**
 * WP-2423 shared-table-checkout (c): staff see a table's shared cart (dishes guests put in and
 * haven't sent) and take a dish out, with a reason, recorded and attributed to the staff member.
 * Not a sale: no order holds a cart line; the cart's next version and this record keep it in the
 * history. The caller authorizes the staff member (dining.operate), owns the transaction and
 * supplies the read of Dining's checkout hold, which is asked under the cart row lock.
 */
export type StaffCartRemovalReason = "GuestAsked" | "GuestLeft" | "CantMake";
const reasons: readonly StaffCartRemovalReason[] = ["GuestAsked", "GuestLeft", "CantMake"];

export interface StaffDiningCartLine {
  readonly cartItemReference: string;
  readonly sellableReference: string;
  readonly quantity: number;
  readonly optionCount: number;
  /**
   * WP-2423 M35 (shared-table-cart-staff-round): the options chosen, so the staff round screen
   * names and estimates the guest's line from the menu it holds (never the guest's note).
   */
  readonly optionSelections: readonly {
    readonly optionReference: string;
    readonly quantity: number;
  }[];
  readonly addedByParticipantReference: string | null;
  readonly addedAt: string;
}
export interface StaffDiningCart {
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly lines: readonly StaffDiningCartLine[];
}
export interface StaffCartRemovalRecord {
  readonly sellableReference: string;
  readonly quantity: number;
  readonly occurredAt: string;
}

function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function rowsOf(value: unknown): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || !("rows" in value)) return unavailable();
  const rows = (value as { rows: unknown }).rows;
  if (!Array.isArray(rows)) return unavailable();
  return rows as Record<string, unknown>[];
}
const scoped = (scope: { readonly brandReference: string; readonly storeReference: string }) => ({
  brandReference: parseOrderingReference(scope.brandReference),
  storeReference: parseOrderingReference(scope.storeReference),
});
const setScope = (tx: CartQueryTransaction, brand: string, store: string) =>
  tx.query("SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)", [
    brand,
    store,
  ]);
const lent = (tx: CartQueryTransaction) => ({
  run: async <T>(action: (transaction: CartQueryTransaction) => Promise<T>) => action(tx),
});

function view(cart: CartAggregate): StaffDiningCart {
  return Object.freeze({
    cartReference: String(cart.cartReference),
    cartVersion: cart.aggregateVersion,
    lines: Object.freeze(
      cart.items.map((item) =>
        Object.freeze({
          cartItemReference: String(item.cartItemReference),
          sellableReference: String(item.sellableReference),
          quantity: item.quantity,
          optionCount: item.optionSelections.length,
          optionSelections: Object.freeze(
            item.optionSelections.map((option) =>
              Object.freeze({
                optionReference: String(option.optionReference),
                quantity: option.quantity,
              }),
            ),
          ),
          addedByParticipantReference:
            item.addedByParticipantReference === null
              ? null
              : String(item.addedByParticipantReference),
          addedAt: String(item.addedAt),
        }),
      ),
    ),
  });
}

/** The table's one current shared cart (null when there is none), read in the caller's transaction. */
export async function readStaffDiningCart(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  diningSessionReference: string,
  observedAt: string,
): Promise<StaffDiningCart | null> {
  const scope = scoped(scopeInput);
  const cart = await createPostgresDiningCartReadStore(lent(tx), scope).current({
    ...scope,
    diningSessionReference: parseOrderingReference(diningSessionReference),
    observedAt: parseOrderingInstant(observedAt),
  });
  return cart === null ? null : view(cart);
}

/** Dishes staff took out of this table's cart since `since` (newest first, at most 20). */
export async function listStaffCartRemovals(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  diningSessionReference: string,
  since: string,
): Promise<readonly StaffCartRemovalRecord[]> {
  const scope = scoped(scopeInput);
  await setScope(tx, scope.brandReference, scope.storeReference);
  const rows = rowsOf(
    await tx.query(
      `SELECT sellable_id::text AS sellable, quantity,
        to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at
       FROM rms_ordering.cart_staff_line_removal
       WHERE brand_id=$1 AND store_id=$2 AND dining_session_id=$3 AND occurred_at >= $4
       ORDER BY occurred_at DESC, operation_id DESC LIMIT 20`,
      [
        scope.brandReference,
        scope.storeReference,
        parseOrderingReference(diningSessionReference),
        parseOrderingInstant(since),
      ],
    ),
  );
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        sellableReference: String(parseOrderingReference(row.sellable)),
        quantity: Number(row.quantity),
        occurredAt: String(parseOrderingInstant(row.occurred_at)),
      }),
    ),
  );
}

export interface StaffCartLineRemovalInput {
  readonly operationReference: string;
  readonly diningSessionReference: string;
  readonly cartReference: string;
  readonly cartItemReference: string;
  readonly expectedCartVersion: number;
  readonly reason: StaffCartRemovalReason;
  readonly actorReference: string;
  readonly observedAt: string;
  /** The staff member's Audit record for this removal (actor User, action ORDERING_CART_ITEM_REMOVE_BY_STAFF). */
  readonly audit: AppendAuditRecordInput;
  readonly hashIntent: (value: string) => string;
  /**
   * Whether a guest's checkout holds this cart version (Dining's checkout hold). Asked after the
   * cart row is locked: a guest's checkout session takes the same lock and checks the version, and
   * its hold is recorded before that, so a guest who started paying is either seen here or finds
   * the cart already at the next version and cannot pay for the removed dish.
   */
  readonly checkoutHeld: (cartVersion: number) => Promise<boolean>;
}

/** The digest of what staff asked for; the same operation reference replays only the same ask. */
function intentOf(input: StaffCartLineRemovalInput, hash: (value: string) => string) {
  return parseOrderingHash(
    hash(
      "StaffRemove:" +
        JSON.stringify({
          diningSessionReference: input.diningSessionReference,
          cartReference: input.cartReference,
          cartItemReference: input.cartItemReference,
          expectedCartVersion: input.expectedCartVersion,
          reason: input.reason,
        }),
    ),
  );
}

/**
 * Take one line out of a table's shared cart. `Removed` with the new cart version; the same
 * operation again answers `AlreadyRemoved` with the version it produced. A different view of the
 * cart (another version) is CART_VERSION_CONFLICT; a line no longer there is CART_ITEM_NOT_FOUND;
 * a pickup cart, another table's cart or a cart no longer current is CART_PERMISSION_DENIED.
 */
export async function removeStaffDiningCartLine(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: StaffCartLineRemovalInput,
): Promise<{ readonly status: "Removed" | "AlreadyRemoved"; readonly cartVersion: number }> {
  const scope = scoped(scopeInput);
  const brand = scope.brandReference;
  const store = scope.storeReference;
  const operation = parseOrderingReference(input.operationReference);
  const session = parseOrderingReference(input.diningSessionReference);
  const cartReference = parseOrderingReference(input.cartReference);
  const line = parseOrderingReference(input.cartItemReference);
  const actor = parseOrderingReference(input.actorReference);
  const at = parseOrderingInstant(input.observedAt);
  if (!reasons.includes(input.reason)) throw new CartError("CART_INPUT_INVALID");
  const expected = input.expectedCartVersion;
  if (!Number.isSafeInteger(expected) || expected < 1) throw new CartError("CART_INPUT_INVALID");
  const intent = intentOf(input, input.hashIntent);
  const audit = validateAuditRecord(input.audit, Date.parse(at));
  if (
    audit.brandId !== brand ||
    audit.storeId !== store ||
    audit.actor.type !== "User" ||
    audit.actor.reference !== actor ||
    audit.actionCode !== "ORDERING_CART_ITEM_REMOVE_BY_STAFF" ||
    audit.targetType !== "OrderingCart" ||
    audit.targetId !== cartReference ||
    audit.reasonCode !==
      "STAFF_CART_" + input.reason.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase() ||
    audit.occurredAt !== at
  )
    throw new CartError("CART_PERMISSION_DENIED");
  await setScope(tx, brand, store);
  const locked = rowsOf(
    await tx.query(
      "SELECT order_type, dining_session_id::text AS session FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
      [brand, store, cartReference],
    ),
  );
  if (locked.length !== 1) throw new CartError("CART_UNAVAILABLE");
  if (locked[0]?.order_type !== "DineIn" || locked[0]?.session !== session)
    throw new CartError("CART_PERMISSION_DENIED");
  const prior = rowsOf(
    await tx.query(
      "SELECT cart_id::text AS cart, cart_line_id::text AS line, intent_digest, result_aggregate_version FROM rms_ordering.cart_staff_line_removal WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
      [brand, store, operation],
    ),
  );
  if (prior.length === 1) {
    const found = prior[0] as Record<string, unknown>;
    if (found.cart !== cartReference || found.line !== line || found.intent_digest !== intent)
      throw new CartError("CART_IDEMPOTENCY_CONFLICT");
    return Object.freeze({
      status: "AlreadyRemoved" as const,
      cartVersion: Number(found.result_aggregate_version),
    });
  }
  // Only the table's current cart (not one replaced or timed out).
  const current = await createPostgresDiningCartReadStore(lent(tx), scope).current({
    ...scope,
    diningSessionReference: session,
    observedAt: at,
  });
  if (current === null || current.cartReference !== cartReference)
    throw new CartError("CART_PERMISSION_DENIED");
  if (current.aggregateVersion !== expected) throw new CartError("CART_VERSION_CONFLICT");
  const item = current.items.find((candidate) => candidate.cartItemReference === line);
  if (item === undefined) throw new CartError("CART_ITEM_NOT_FOUND");
  if (Date.parse(at) < Date.parse(current.updatedAt)) return unavailable();
  let held: boolean;
  try {
    held = await input.checkoutHeld(expected);
  } catch {
    return unavailable();
  }
  if (held !== false) throw new CartError("CART_CHECKOUT_IN_PROGRESS");
  const next = parseCartAggregate({
    ...current,
    aggregateVersion: expected + 1,
    updatedAt: at,
    items: current.items.filter((candidate) => candidate.cartItemReference !== line),
  });
  const updated = await tx.query(
    "UPDATE rms_ordering.cart SET aggregate_version=$4, updated_at=$5 WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$6",
    [brand, store, cartReference, next.aggregateVersion, at, expected],
  );
  if ((updated as { rowCount?: unknown }).rowCount !== 1)
    throw new CartError("CART_VERSION_CONFLICT");
  if (
    rowsOf(
      await tx.query(
        "DELETE FROM rms_ordering.cart_line WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND cart_line_id=$4 RETURNING cart_line_id",
        [brand, store, cartReference, line],
      ),
    ).length !== 1
  )
    return unavailable();
  const persisted = await createPostgresCartQueryStore(lent(tx), scope).load(cartReference);
  if (
    persisted === null ||
    persisted.aggregateVersion !== next.aggregateVersion ||
    persisted.items.length !== next.items.length
  )
    return unavailable();
  if (
    rowsOf(
      await tx.query(
        `INSERT INTO rms_ordering.cart_staff_line_removal
        (operation_id,brand_id,store_id,cart_id,dining_session_id,cart_line_id,sellable_id,quantity,added_by_participant_id,reason_code,result_aggregate_version,intent_digest,actor_id,occurred_at,audit_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING operation_id`,
        [
          operation,
          brand,
          store,
          cartReference,
          session,
          line,
          item.sellableReference,
          item.quantity,
          item.addedByParticipantReference,
          input.reason,
          next.aggregateVersion,
          intent,
          actor,
          at,
          audit.auditId,
        ],
      ),
    ).length !== 1
  )
    return unavailable();
  await appendAuditRecordInTransaction(tx as never, audit);
  return Object.freeze({ status: "Removed" as const, cartVersion: next.aggregateVersion });
}

export interface StaffCartLinesRemovalInput {
  readonly diningSessionReference: string;
  readonly cartReference: string;
  /** The cart version staff decided on. */
  readonly expectedCartVersion: number;
  /** The guests' lines staff keep (sent with their round): with `lines`, exactly the cart then. */
  readonly keep: readonly string[];
  /** Each line staff take out, with its own operation reference and Audit record. */
  readonly lines: readonly {
    readonly cartItemReference: string;
    readonly reason: StaffCartRemovalReason;
    readonly operationReference: string;
    readonly audit: AppendAuditRecordInput;
  }[];
  readonly actorReference: string;
  readonly observedAt: string;
  readonly hashIntent: (value: string) => string;
  readonly checkoutHeld: (cartVersion: number) => Promise<boolean>;
}

/**
 * WP-2423 M35/M06 (shared-table-cart-staff-round): staff decide on every guest line of the
 * table's cart at once (send it with their round, or take it out). All the lines staff take out
 * leave in one transaction, each recorded and audited as its own staff removal at the next cart
 * version, or none does: a cart that moved on since staff decided (another version, or lines that
 * are not exactly the ones they decided on) is CART_VERSION_CONFLICT with nothing removed. The
 * same operations again answer `AlreadyRemoved` with the version they produced.
 */
export async function removeStaffDiningCartLines(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: StaffCartLinesRemovalInput,
): Promise<{ readonly status: "Removed" | "AlreadyRemoved"; readonly cartVersion: number }> {
  const scope = scoped(scopeInput);
  const expected = input.expectedCartVersion;
  if (
    !Number.isSafeInteger(expected) ||
    expected < 1 ||
    input.lines.length === 0 ||
    input.lines.length > 30 ||
    input.keep.length > 100
  )
    throw new CartError("CART_INPUT_INVALID");
  const cartReference = parseOrderingReference(input.cartReference);
  const session = parseOrderingReference(input.diningSessionReference);
  const removing = input.lines.map((line) =>
    String(parseOrderingReference(line.cartItemReference)),
  );
  const keeping = input.keep.map((line) => String(parseOrderingReference(line)));
  const operations = input.lines.map((line) =>
    String(parseOrderingReference(line.operationReference)),
  );
  if (
    new Set([...removing, ...keeping]).size !== removing.length + keeping.length ||
    new Set(operations).size !== operations.length
  )
    throw new CartError("CART_INPUT_INVALID");
  await setScope(tx, scope.brandReference, scope.storeReference);
  // The cart row lock first, as every cart writer takes it, so the decision and the removals see
  // one cart state.
  const locked = rowsOf(
    await tx.query(
      "SELECT order_type, dining_session_id::text AS session FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
      [scope.brandReference, scope.storeReference, cartReference],
    ),
  );
  if (locked.length !== 1) throw new CartError("CART_UNAVAILABLE");
  if (locked[0]?.order_type !== "DineIn" || locked[0]?.session !== session)
    throw new CartError("CART_PERMISSION_DENIED");
  const prior = rowsOf(
    await tx.query(
      "SELECT operation_id::text AS operation, result_aggregate_version FROM rms_ordering.cart_staff_line_removal WHERE brand_id=$1 AND store_id=$2 AND operation_id = ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, operations],
    ),
  );
  if (prior.length === 0) {
    const current = await createPostgresDiningCartReadStore(lent(tx), scope).current({
      ...scope,
      diningSessionReference: session,
      observedAt: parseOrderingInstant(input.observedAt),
    });
    if (current === null || current.cartReference !== cartReference)
      throw new CartError("CART_PERMISSION_DENIED");
    const decided = new Set([...removing, ...keeping]);
    if (
      current.aggregateVersion !== expected ||
      current.items.length !== decided.size ||
      current.items.some((item) => !decided.has(String(item.cartItemReference)))
    )
      throw new CartError("CART_VERSION_CONFLICT");
  } else if (prior.length !== operations.length) throw new CartError("CART_IDEMPOTENCY_CONFLICT");
  let version = expected;
  let replayed = 0;
  for (const [index, line] of input.lines.entries()) {
    const removed = await removeStaffDiningCartLine(tx, scopeInput, {
      operationReference: line.operationReference,
      diningSessionReference: input.diningSessionReference,
      cartReference: input.cartReference,
      cartItemReference: line.cartItemReference,
      expectedCartVersion: expected + index,
      reason: line.reason,
      actorReference: input.actorReference,
      observedAt: input.observedAt,
      audit: line.audit,
      hashIntent: input.hashIntent,
      checkoutHeld: input.checkoutHeld,
    });
    if (removed.status === "AlreadyRemoved") replayed += 1;
    version = Math.max(version, removed.cartVersion);
  }
  if (replayed !== 0 && replayed !== input.lines.length)
    throw new CartError("CART_IDEMPOTENCY_CONFLICT");
  return Object.freeze({
    status: replayed === 0 ? ("Removed" as const) : ("AlreadyRemoved" as const),
    cartVersion: version,
  });
}
