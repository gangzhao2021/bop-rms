import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  CartCheckoutInProgressError,
  CartError,
  parseCartAggregate,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
} from "../../domain/cart.js";
import { advanceCartLifecycle } from "../../domain/cart-lifecycle.js";
import { createPostgresCartQueryStore, type CartQueryTransaction } from "./cart-query-store.js";
import { createPostgresDiningCartReadStore } from "./dining-cart-read-store.js";

/**
 * WP-2423 shared-table-checkout (a), pay first (DEC-OWNER-DEFAULTS-2026-11-06 同桌结账 M38,
 * DEC-DINING-CHECKOUT-SCOPE; 2000_520). The guest paying a round at a pay-first table chooses its
 * dishes: the whole cart (nothing here), only what their phone added ("Mine"), or dishes they pick,
 * any number of each ("Chosen"). The round stays exactly one cart version: the dishes not chosen
 * leave the cart as its next version into a waiting list, and come back as new cart lines once the
 * cart moves on (the round was sent, the payer went back, anything changed) or the 5-minute
 * reservation ran out with nobody paying. Each waiting dish comes back exactly once; a dish is
 * never both in the round and waiting (2000_520 triggers).
 *
 * While the scope is live (the cart still at the version it produced) only the paying phone may
 * quote, record details or start checkout for that cart ("checkout_scope_held"). The other phones
 * see their dishes waiting and are told someone is paying for theirs. Callers own the transaction
 * and authorize the guest; every function here takes the cart row lock first.
 */
export type DiningCheckoutChoice = "Mine" | "Chosen";
export const diningCheckoutScopeMinutes = 5;
const scopeMs = diningCheckoutScopeMinutes * 60_000;

export interface DiningCheckoutScopeActor {
  readonly diningSessionReference: string;
  readonly guestSessionReference: string;
  readonly participantReference: string;
}
export interface DiningCheckoutLiveScope {
  readonly scopeReference: string;
  readonly choice: DiningCheckoutChoice;
  readonly cartReference: string;
  readonly cartVersion: number;
  readonly chooserParticipantReference: string;
  readonly chooserGuestSessionReference: string;
  /** When the other phones may take their dishes back (the latest "Keep them"). */
  readonly expiresAt: string;
}
export interface DiningCartWaitingLine {
  readonly waitingLineReference: string;
  readonly scopeReference: string;
  readonly sellableReference: string;
  readonly quantity: number;
  readonly optionCount: number;
  readonly addedByParticipantReference: string | null;
  readonly addedAt: string;
}
export interface DiningCheckoutScopeState {
  /** The table's one current cart, or null when there is none now. */
  readonly cartReference: string | null;
  readonly cartVersion: number | null;
  /** The scope live on the current cart (its round not sent, nothing changed), or null. */
  readonly live: DiningCheckoutLiveScope | null;
  /** Dishes set aside for the table that haven't come back yet (oldest first). */
  readonly waiting: readonly DiningCartWaitingLine[];
}

function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}
function rowsOf(value: unknown): readonly Record<string, unknown>[] {
  if (value === null || typeof value !== "object" || !("rows" in value)) return unavailable();
  const rows = (value as { rows: unknown }).rows;
  if (!Array.isArray(rows)) return unavailable();
  return rows as Record<string, unknown>[];
}
function count(value: unknown): number {
  const rowCount = (value as { rowCount?: unknown } | null)?.rowCount;
  return typeof rowCount === "number" ? rowCount : -1;
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
const iso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const actorOf = (value: DiningCheckoutScopeActor) =>
  Object.freeze({
    diningSessionReference: parseOrderingReference(value.diningSessionReference),
    guestSessionReference: parseOrderingReference(value.guestSessionReference),
    participantReference: parseOrderingReference(value.participantReference),
  });
/** The paying phone: the session that chose, or a later session of the same table participant. */
const isChooser = (live: DiningCheckoutLiveScope, actor: DiningCheckoutScopeActor) =>
  live.chooserGuestSessionReference === actor.guestSessionReference ||
  live.chooserParticipantReference === actor.participantReference;

function checkAudit(
  value: AppendAuditRecordInput,
  at: string,
  scope: { brandReference: string; storeReference: string },
  actionCode: string,
  cartReference: string,
) {
  const audit = validateAuditRecord(value, Date.parse(at));
  if (
    audit.brandId !== scope.brandReference ||
    audit.storeId !== scope.storeReference ||
    audit.actor.type !== "System" ||
    audit.actionCode !== actionCode ||
    audit.targetType !== "OrderingCart" ||
    audit.targetId !== cartReference ||
    audit.occurredAt !== at ||
    audit.sourceChannel !== "CUSTOMER_PWA" ||
    audit.dataClassification !== "Restricted"
  )
    throw new CartError("CART_PERMISSION_DENIED");
  return audit;
}

async function lockCart(
  tx: CartQueryTransaction,
  scope: { brandReference: string; storeReference: string },
  cartReference: string,
  diningSessionReference: string,
) {
  const locked = rowsOf(
    await tx.query(
      "SELECT order_type, dining_session_id::text AS session FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
      [scope.brandReference, scope.storeReference, cartReference],
    ),
  );
  if (locked.length !== 1) throw new CartError("CART_UNAVAILABLE");
  if (locked[0]?.order_type !== "DineIn" || locked[0]?.session !== diningSessionReference)
    throw new CartError("CART_PERMISSION_DENIED");
}

async function currentCart(
  tx: CartQueryTransaction,
  scope: { brandReference: string; storeReference: string },
  diningSessionReference: string,
  at: string,
): Promise<CartAggregate | null> {
  return createPostgresDiningCartReadStore(lent(tx), scope).current({
    ...scope,
    diningSessionReference: parseOrderingReference(diningSessionReference),
    observedAt: parseOrderingInstant(at),
  });
}

/** The scope live on this cart now (the cart still at the version it produced), or null. */
async function liveScope(
  tx: CartQueryTransaction,
  scope: { brandReference: string; storeReference: string },
  cartReference: string,
): Promise<DiningCheckoutLiveScope | null> {
  const rows = rowsOf(
    await tx.query(
      `SELECT s.scope_id::text AS scope, s.choice, s.cart_id::text AS cart, s.cart_version_to AS version,
         s.chooser_participant_id::text AS participant, s.chooser_guest_session_id::text AS session,
         ${iso("GREATEST(s.expires_at, COALESCE((SELECT max(e.expires_at) FROM rms_ordering.dining_checkout_scope_extension e WHERE e.brand_id=s.brand_id AND e.store_id=s.store_id AND e.scope_id=s.scope_id), s.expires_at))")} AS expires_at
       FROM rms_ordering.dining_checkout_scope s
       JOIN rms_ordering.cart c ON c.cart_id=s.cart_id AND c.brand_id=s.brand_id AND c.store_id=s.store_id
        AND c.aggregate_version=s.cart_version_to
       WHERE s.brand_id=$1 AND s.store_id=$2 AND s.cart_id=$3`,
      [scope.brandReference, scope.storeReference, cartReference],
    ),
  );
  if (rows.length > 1) return unavailable();
  const row = rows[0];
  if (row === undefined) return null;
  if (row.choice !== "Mine" && row.choice !== "Chosen") return unavailable();
  return Object.freeze({
    scopeReference: String(parseOrderingReference(row.scope)),
    choice: row.choice,
    cartReference: String(parseOrderingReference(row.cart)),
    cartVersion: Number(row.version),
    chooserParticipantReference: String(parseOrderingReference(row.participant)),
    chooserGuestSessionReference: String(parseOrderingReference(row.session)),
    expiresAt: String(parseOrderingInstant(row.expires_at)),
  });
}

async function unresolvedWaiting(
  tx: CartQueryTransaction,
  scope: { brandReference: string; storeReference: string },
  diningSessionReference: string,
) {
  return rowsOf(
    await tx.query(
      `SELECT w.waiting_line_id::text AS line, w.scope_id::text AS scope, w.sellable_id::text AS sellable,
         w.quantity, w.option_selections_json AS options, w.customer_note AS note,
         w.catalog_selection_evidence_json AS evidence, w.added_by_actor_id::text AS actor,
         w.added_by_participant_id::text AS participant, ${iso("w.added_at")} AS added_at,
         s.cart_id::text AS scope_cart, s.cart_version_to AS scope_version
       FROM rms_ordering.dining_cart_waiting_line w
       JOIN rms_ordering.dining_checkout_scope s ON s.brand_id=w.brand_id AND s.store_id=w.store_id AND s.scope_id=w.scope_id
       WHERE w.brand_id=$1 AND w.store_id=$2 AND w.dining_session_id=$3
        AND NOT EXISTS (SELECT 1 FROM rms_ordering.dining_cart_waiting_line_resolution r
          WHERE r.brand_id=w.brand_id AND r.store_id=w.store_id AND r.waiting_line_id=w.waiting_line_id)
       ORDER BY w.recorded_at, w.waiting_line_id`,
      [scope.brandReference, scope.storeReference, diningSessionReference],
    ),
  );
}

function waitingView(row: Record<string, unknown>): DiningCartWaitingLine {
  const options = row.options;
  if (!Array.isArray(options)) return unavailable();
  return Object.freeze({
    waitingLineReference: String(parseOrderingReference(row.line)),
    scopeReference: String(parseOrderingReference(row.scope)),
    sellableReference: String(parseOrderingReference(row.sellable)),
    quantity: Number(row.quantity),
    optionCount: options.length,
    addedByParticipantReference:
      row.participant === null ? null : String(parseOrderingReference(row.participant)),
    addedAt: String(parseOrderingInstant(row.added_at)),
  });
}

/** What the table's phones see: the live scope on the current cart and the dishes waiting. */
export async function readDiningCheckoutScopeState(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: { readonly diningSessionReference: string; readonly observedAt: string },
): Promise<DiningCheckoutScopeState> {
  const scope = scoped(scopeInput);
  const session = parseOrderingReference(input.diningSessionReference);
  const at = parseOrderingInstant(input.observedAt);
  const cart = await currentCart(tx, scope, session, at);
  await setScope(tx, scope.brandReference, scope.storeReference);
  const live = cart === null ? null : await liveScope(tx, scope, cart.cartReference);
  const waiting = (await unresolvedWaiting(tx, scope, session)).map(waitingView);
  return Object.freeze({
    cartReference: cart === null ? null : String(cart.cartReference),
    cartVersion: cart === null ? null : cart.aggregateVersion,
    live,
    waiting: Object.freeze(waiting),
  });
}

/**
 * Whether another phone's scope keeps this cart version from the caller (quote, details,
 * checkout, cart edits): `heldUntil` is when its reservation runs out, or, once it ran out, a few
 * seconds on (the dishes are being given back; the caller asks again). Null when no other phone's
 * scope is live on this version.
 */
export async function readForeignDiningCheckoutScope(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly cartReference: string;
    readonly cartVersion: number;
    readonly participantReference: string;
    readonly observedAt: string;
  },
): Promise<{ readonly heldUntil: string; readonly reserved: boolean } | null> {
  const scope = scoped(scopeInput);
  await setScope(tx, scope.brandReference, scope.storeReference);
  const live = await liveScope(tx, scope, parseOrderingReference(input.cartReference));
  if (
    live === null ||
    live.cartVersion !== input.cartVersion ||
    live.chooserParticipantReference === parseOrderingReference(input.participantReference)
  )
    return null;
  const at = parseOrderingInstant(input.observedAt);
  const reserved = Date.parse(live.expiresAt) > Date.parse(at);
  return Object.freeze({
    heldUntil: reserved ? live.expiresAt : new Date(Date.parse(at) + 5_000).toISOString(),
    reserved,
  });
}

export interface ChooseDiningCheckoutScopeInput {
  readonly operationReference: string;
  readonly cartReference: string;
  readonly expectedCartVersion: number;
  readonly choice: DiningCheckoutChoice;
  /** For "Chosen": each dish (cart line) and how many of it this round pays. */
  readonly lines: readonly { readonly cartItemReference: string; readonly quantity: number }[];
  readonly actor: DiningCheckoutScopeActor;
  readonly observedAt: string;
  readonly hashIntent: (value: string) => string;
  newReference(): string;
  /** System audit ORDERING_CART_CHECKOUT_SCOPE on CUSTOMER_PWA, Restricted, counts only. */
  readonly audit: AppendAuditRecordInput;
  /** Another participant's Dining checkout hold on this cart version (its end), or null. */
  heldByOther(cartVersion: number): Promise<string | null>;
}
export type ChooseDiningCheckoutScopeResult =
  | {
      readonly status: "Chosen";
      readonly cartVersion: number;
      readonly expiresAt: string;
      readonly setAsideUnits: number;
    }
  /** Every dish was chosen: the round is the whole cart, nothing was written. */
  | { readonly status: "WholeCart"; readonly cartVersion: number }
  /** "Mine" with no dish of this phone, or nothing picked: nothing was written. */
  | { readonly status: "NothingChosen"; readonly cartVersion: number };

function chooseIntent(input: ChooseDiningCheckoutScopeInput, hash: (value: string) => string) {
  return parseOrderingHash(
    hash(
      "CheckoutScope:" +
        JSON.stringify({
          cartReference: input.cartReference,
          expectedCartVersion: input.expectedCartVersion,
          choice: input.choice,
          lines: [...input.lines]
            .map((line) => [line.cartItemReference, line.quantity])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        }),
    ),
  );
}

/**
 * The paying phone chooses this round's dishes. The dishes not chosen (all of a line, or the units
 * of a line not chosen) wait for the next round; the cart is its next version with exactly the
 * chosen dishes, which the ordinary quote, details, checkout session and payment then use. The
 * same operation replays its answer. Refused: another phone's scope or checkout holds the cart
 * (CartCheckoutInProgressError), a stale view or dishes still waiting to come back
 * (CART_VERSION_CONFLICT), a dish not in the cart or more units than it has (CART_INPUT_INVALID).
 */
export async function chooseDiningCheckoutScope(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: ChooseDiningCheckoutScopeInput,
): Promise<ChooseDiningCheckoutScopeResult> {
  const scope = scoped(scopeInput);
  const operation = parseOrderingReference(input.operationReference);
  const cartReference = parseOrderingReference(input.cartReference);
  const actor = actorOf(input.actor);
  const at = parseOrderingInstant(input.observedAt);
  const expected = input.expectedCartVersion;
  if (!Number.isSafeInteger(expected) || expected < 1) return invalid();
  if (input.choice !== "Mine" && input.choice !== "Chosen") return invalid();
  if (input.choice === "Mine" && input.lines.length !== 0) return invalid();
  const picked = new Map<string, number>();
  for (const line of input.lines) {
    const reference = parseOrderingReference(line.cartItemReference);
    if (
      picked.has(reference) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 999
    )
      return invalid();
    picked.set(reference, line.quantity);
  }
  const intent = chooseIntent(input, input.hashIntent);
  const audit = checkAudit(input.audit, at, scope, "ORDERING_CART_CHECKOUT_SCOPE", cartReference);
  await setScope(tx, scope.brandReference, scope.storeReference);
  await lockCart(tx, scope, cartReference, actor.diningSessionReference);
  const prior = rowsOf(
    await tx.query(
      `SELECT s.cart_id::text AS cart, s.intent_digest, s.cart_version_to AS version, s.set_aside_unit_count AS units,
         s.chooser_guest_session_id::text AS session, ${iso("s.expires_at")} AS expires_at
       FROM rms_ordering.dining_checkout_scope s WHERE s.brand_id=$1 AND s.store_id=$2 AND s.operation_id=$3`,
      [scope.brandReference, scope.storeReference, operation],
    ),
  );
  if (prior.length === 1) {
    const found = prior[0] as Record<string, unknown>;
    if (
      found.cart !== cartReference ||
      found.intent_digest !== intent ||
      found.session !== actor.guestSessionReference
    )
      throw new CartError("CART_IDEMPOTENCY_CONFLICT");
    return Object.freeze({
      status: "Chosen" as const,
      cartVersion: Number(found.version),
      expiresAt: String(parseOrderingInstant(found.expires_at)),
      setAsideUnits: Number(found.units),
    });
  }
  const current = await currentCart(tx, scope, actor.diningSessionReference, at);
  if (current === null || current.cartReference !== cartReference)
    throw new CartError("CART_PERMISSION_DENIED");
  await setScope(tx, scope.brandReference, scope.storeReference);
  if (current.aggregateVersion !== expected) throw new CartError("CART_VERSION_CONFLICT");
  if (Date.parse(at) < Date.parse(current.updatedAt)) return unavailable();
  const live = await liveScope(tx, scope, cartReference);
  if (live !== null) {
    if (!isChooser(live, actor) && Date.parse(live.expiresAt) > Date.parse(at))
      throw new CartCheckoutInProgressError(live.expiresAt);
    // Dishes from this choice (or a lapsed one) are still out: they come back first.
    throw new CartError("CART_VERSION_CONFLICT");
  }
  if ((await unresolvedWaiting(tx, scope, actor.diningSessionReference)).length > 0)
    throw new CartError("CART_VERSION_CONFLICT");
  let held: string | null;
  try {
    held = await input.heldByOther(expected);
  } catch {
    return unavailable();
  }
  if (held !== null) throw new CartCheckoutInProgressError(held);
  // Which units of each line this round pays.
  const chosen = new Map<string, number>();
  if (input.choice === "Mine") {
    for (const item of current.items)
      if (item.addedByParticipantReference === actor.participantReference)
        chosen.set(item.cartItemReference, item.quantity);
  } else {
    for (const [reference, quantity] of picked) {
      const item = current.items.find((candidate) => candidate.cartItemReference === reference);
      if (item === undefined || quantity > item.quantity) return invalid();
      chosen.set(reference, quantity);
    }
  }
  if (chosen.size === 0)
    return Object.freeze({ status: "NothingChosen" as const, cartVersion: expected });
  const aside = current.items
    .map((item) => ({ item, waiting: item.quantity - (chosen.get(item.cartItemReference) ?? 0) }))
    .filter((entry) => entry.waiting > 0);
  if (aside.length === 0)
    return Object.freeze({ status: "WholeCart" as const, cartVersion: expected });
  const next = parseCartAggregate({
    ...current,
    aggregateVersion: expected + 1,
    updatedAt: at,
    lifecycle: advanceCartLifecycle(current.lifecycle, at),
    items: current.items
      .filter((item) => chosen.has(item.cartItemReference))
      .map((item) => ({ ...item, quantity: chosen.get(item.cartItemReference) as number })),
  });
  if (
    count(
      await tx.query(
        "UPDATE rms_ordering.cart SET aggregate_version=$4, updated_at=$5, idle_expires_at=$6 WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$7",
        [
          scope.brandReference,
          scope.storeReference,
          cartReference,
          next.aggregateVersion,
          at,
          next.lifecycle?.idleExpiresAt,
          expected,
        ],
      ),
    ) !== 1
  )
    throw new CartError("CART_VERSION_CONFLICT");
  for (const { item, waiting } of aside) {
    const changed =
      waiting === item.quantity
        ? await tx.query(
            "DELETE FROM rms_ordering.cart_line WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND cart_line_id=$4",
            [scope.brandReference, scope.storeReference, cartReference, item.cartItemReference],
          )
        : await tx.query(
            "UPDATE rms_ordering.cart_line SET quantity=$5 WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND cart_line_id=$4 AND quantity=$6",
            [
              scope.brandReference,
              scope.storeReference,
              cartReference,
              item.cartItemReference,
              item.quantity - waiting,
              item.quantity,
            ],
          );
    if (count(changed) !== 1) return unavailable();
  }
  const persisted = await createPostgresCartQueryStore(lent(tx), scope).load(cartReference);
  if (
    persisted === null ||
    persisted.aggregateVersion !== next.aggregateVersion ||
    persisted.items.length !== next.items.length ||
    !next.items.every((item) =>
      persisted.items.some(
        (saved) =>
          saved.cartItemReference === item.cartItemReference && saved.quantity === item.quantity,
      ),
    )
  )
    return unavailable();
  const scopeReference = parseOrderingReference(input.newReference());
  const expiresAt = new Date(Date.parse(at) + scopeMs).toISOString();
  const chosenUnits = [...chosen.values()].reduce((total, units) => total + units, 0);
  const asideUnits = aside.reduce((total, entry) => total + entry.waiting, 0);
  await tx.query(
    `INSERT INTO rms_ordering.dining_checkout_scope
     (scope_id,brand_id,store_id,dining_session_id,cart_id,cart_version_from,cart_version_to,choice,
      chooser_participant_id,chooser_guest_session_id,chosen_line_count,chosen_unit_count,
      set_aside_line_count,set_aside_unit_count,operation_id,intent_digest,recorded_at,expires_at,audit_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      scopeReference,
      scope.brandReference,
      scope.storeReference,
      actor.diningSessionReference,
      cartReference,
      expected,
      next.aggregateVersion,
      input.choice,
      actor.participantReference,
      actor.guestSessionReference,
      chosen.size,
      chosenUnits,
      aside.length,
      asideUnits,
      operation,
      intent,
      at,
      expiresAt,
      audit.auditId,
    ],
  );
  for (const { item, waiting } of aside)
    await tx.query(
      `INSERT INTO rms_ordering.dining_cart_waiting_line
       (waiting_line_id,brand_id,store_id,dining_session_id,cart_id,scope_id,origin_cart_line_id,origin_quantity,
        sellable_id,quantity,option_selections_json,customer_note,catalog_selection_evidence_json,
        added_by_actor_id,added_by_participant_id,added_at,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17)`,
      [
        parseOrderingReference(input.newReference()),
        scope.brandReference,
        scope.storeReference,
        actor.diningSessionReference,
        cartReference,
        scopeReference,
        item.cartItemReference,
        item.quantity,
        item.sellableReference,
        waiting,
        JSON.stringify(item.optionSelections),
        item.customerNote,
        item.catalogSelectionEvidence === null
          ? null
          : JSON.stringify(item.catalogSelectionEvidence),
        item.addedByActorReference,
        item.addedByParticipantReference,
        item.addedAt,
        at,
      ],
    );
  await appendAuditRecordInTransaction(tx as never, audit);
  return Object.freeze({
    status: "Chosen" as const,
    cartVersion: next.aggregateVersion,
    expiresAt,
    setAsideUnits: asideUnits,
  });
}

/**
 * The paying phone keeps its choice another 5 minutes ("Keep them"), while it is live. The same
 * operation replays. `NotLive`: the round was sent, the dishes came back or the cart changed.
 */
export async function extendDiningCheckoutScope(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly operationReference: string;
    readonly actor: DiningCheckoutScopeActor;
    readonly observedAt: string;
  },
): Promise<
  { readonly status: "Extended"; readonly expiresAt: string } | { readonly status: "NotLive" }
> {
  const scope = scoped(scopeInput);
  const operation = parseOrderingReference(input.operationReference);
  const actor = actorOf(input.actor);
  const at = parseOrderingInstant(input.observedAt);
  await setScope(tx, scope.brandReference, scope.storeReference);
  const prior = rowsOf(
    await tx.query(
      `SELECT guest_session_id::text AS session, ${iso("expires_at")} AS expires_at
       FROM rms_ordering.dining_checkout_scope_extension WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`,
      [scope.brandReference, scope.storeReference, operation],
    ),
  );
  if (prior.length === 1) {
    if (prior[0]?.session !== actor.guestSessionReference)
      throw new CartError("CART_IDEMPOTENCY_CONFLICT");
    return Object.freeze({
      status: "Extended" as const,
      expiresAt: String(parseOrderingInstant(prior[0]?.expires_at)),
    });
  }
  const cart = await currentCart(tx, scope, actor.diningSessionReference, at);
  if (cart === null) return Object.freeze({ status: "NotLive" as const });
  await setScope(tx, scope.brandReference, scope.storeReference);
  await lockCart(tx, scope, cart.cartReference, actor.diningSessionReference);
  const live = await liveScope(tx, scope, cart.cartReference);
  if (live === null || !isChooser(live, actor))
    return Object.freeze({ status: "NotLive" as const });
  const expiresAt = new Date(Date.parse(at) + scopeMs).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(live.expiresAt))
    return Object.freeze({ status: "Extended" as const, expiresAt: live.expiresAt });
  await tx.query(
    `INSERT INTO rms_ordering.dining_checkout_scope_extension
     (operation_id,brand_id,store_id,scope_id,guest_session_id,recorded_at,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      operation,
      scope.brandReference,
      scope.storeReference,
      live.scopeReference,
      actor.guestSessionReference,
      at,
      expiresAt,
    ],
  );
  return Object.freeze({ status: "Extended" as const, expiresAt });
}

export interface ReturnDiningWaitingLinesInput {
  readonly operationReference: string;
  /** "Cancel": the paying phone goes back (its own choice ends now). "Return": anyone at the
   * table, once no phone holds the cart for paying. */
  readonly action: "Cancel" | "Return";
  readonly actor: DiningCheckoutScopeActor;
  readonly observedAt: string;
  newReference(): string;
  /** System audit ORDERING_CART_WAITING_RETURN on CUSTOMER_PWA, Restricted, counts only. */
  readonly audit: AppendAuditRecordInput;
  /** Another participant's Dining checkout hold on this cart version (its end), or null. */
  heldByOther(cartReference: string, cartVersion: number): Promise<string | null>;
}
export type ReturnDiningWaitingLinesResult =
  | { readonly status: "Returned"; readonly cartVersion: number; readonly returnedUnits: number }
  | { readonly status: "NothingToReturn"; readonly cartVersion: number | null };

/**
 * The dishes waiting for this table come back into its current cart, each as a new line exactly as
 * it was added (who, when, options, note), in one next cart version; each once. Refused while
 * another phone is still paying for the round they wait on (CartCheckoutInProgressError until its
 * reservation or checkout ends). The paying phone's "Cancel" ends its own choice at once. The same
 * operation replays its answer. No current cart (it timed out): nothing comes back until the
 * table's replacement cart exists.
 */
export async function returnDiningWaitingLines(
  tx: CartQueryTransaction,
  scopeInput: { readonly brandReference: string; readonly storeReference: string },
  input: ReturnDiningWaitingLinesInput,
): Promise<ReturnDiningWaitingLinesResult> {
  const scope = scoped(scopeInput);
  const operation = parseOrderingReference(input.operationReference);
  const actor = actorOf(input.actor);
  const at = parseOrderingInstant(input.observedAt);
  if (input.action !== "Cancel" && input.action !== "Return") return invalid();
  await setScope(tx, scope.brandReference, scope.storeReference);
  const replay = rowsOf(
    await tx.query(
      `SELECT max(cart_version) AS version, count(*)::int AS lines, bool_and(guest_session_id=$4) AS same
       FROM rms_ordering.dining_cart_waiting_line_resolution WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3`,
      [scope.brandReference, scope.storeReference, operation, actor.guestSessionReference],
    ),
  );
  if (Number(replay[0]?.lines ?? 0) > 0) {
    if (replay[0]?.same !== true) throw new CartError("CART_IDEMPOTENCY_CONFLICT");
    const units = rowsOf(
      await tx.query(
        `SELECT coalesce(sum(w.quantity),0)::int AS units FROM rms_ordering.dining_cart_waiting_line_resolution r
         JOIN rms_ordering.dining_cart_waiting_line w ON w.brand_id=r.brand_id AND w.store_id=r.store_id AND w.waiting_line_id=r.waiting_line_id
         WHERE r.brand_id=$1 AND r.store_id=$2 AND r.operation_id=$3`,
        [scope.brandReference, scope.storeReference, operation],
      ),
    );
    return Object.freeze({
      status: "Returned" as const,
      cartVersion: Number(replay[0]?.version),
      returnedUnits: Number(units[0]?.units ?? 0),
    });
  }
  const found = await currentCart(tx, scope, actor.diningSessionReference, at);
  if (found === null)
    return Object.freeze({ status: "NothingToReturn" as const, cartVersion: null });
  await setScope(tx, scope.brandReference, scope.storeReference);
  await lockCart(tx, scope, found.cartReference, actor.diningSessionReference);
  // Read again under the lock: another phone may have just given them back.
  const cart = await createPostgresCartQueryStore(lent(tx), scope).load(found.cartReference);
  if (cart === null) return unavailable();
  const waiting = await unresolvedWaiting(tx, scope, actor.diningSessionReference);
  if (waiting.length === 0)
    return Object.freeze({
      status: "NothingToReturn" as const,
      cartVersion: cart.aggregateVersion,
    });
  const live = await liveScope(tx, scope, cart.cartReference);
  const cancelling = input.action === "Cancel" && live !== null && isChooser(live, actor);
  if (live !== null && !cancelling && Date.parse(live.expiresAt) > Date.parse(at))
    throw new CartCheckoutInProgressError(live.expiresAt);
  let held: string | null;
  try {
    held = await input.heldByOther(cart.cartReference, cart.aggregateVersion);
  } catch {
    return unavailable();
  }
  if (held !== null) throw new CartCheckoutInProgressError(held);
  if (cart.items.length + waiting.length > 100) throw new CartError("CART_ITEM_LIMIT_REACHED");
  // Why each scope's dishes come back: its round was sent, the payer went back, the reservation
  // ran out with the cart unchanged, or the cart changed.
  const sent = new Set(
    rowsOf(
      await tx.query(
        `SELECT s.scope_id::text AS scope FROM rms_ordering.dining_checkout_scope s
         WHERE s.brand_id=$1 AND s.store_id=$2 AND s.scope_id = ANY($3::uuid[])
          AND EXISTS (SELECT 1 FROM rms_ordering.order_submission_record o WHERE o.brand_id=s.brand_id
           AND o.store_id=s.store_id AND o.source_cart_id=s.cart_id AND o.source_cart_version=s.cart_version_to)`,
        [
          scope.brandReference,
          scope.storeReference,
          [...new Set(waiting.map((row) => String(row.scope)))],
        ],
      ),
    ).map((row) => String(row.scope)),
  );
  const reasonOf = (row: Record<string, unknown>) =>
    live !== null && String(row.scope) === live.scopeReference
      ? cancelling
        ? "PayerCancelled"
        : "ScopeExpired"
      : sent.has(String(row.scope))
        ? "RoundSent"
        : "CartChanged";
  const version = cart.aggregateVersion + 1;
  const audit = checkAudit(
    input.audit,
    at,
    scope,
    "ORDERING_CART_WAITING_RETURN",
    cart.cartReference,
  );
  const returned = waiting.map((row) => ({
    row,
    line: parseOrderingReference(input.newReference()),
  }));
  const next = parseCartAggregate({
    ...cart,
    aggregateVersion: version,
    updatedAt: at,
    lifecycle: advanceCartLifecycle(cart.lifecycle, at),
    items: [
      ...cart.items,
      ...returned.map(({ row, line }) => ({
        cartItemReference: line,
        cartReference: cart.cartReference,
        sellableReference: row.sellable,
        quantity: Number(row.quantity),
        optionSelections: row.options,
        customerNote: row.note ?? null,
        catalogSelectionEvidence: row.evidence ?? null,
        addedByActorReference: row.actor,
        addedByParticipantReference: row.participant ?? null,
        addedAt: row.added_at,
      })),
    ],
  });
  if (
    count(
      await tx.query(
        "UPDATE rms_ordering.cart SET aggregate_version=$4, updated_at=$5, idle_expires_at=$6 WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$7",
        [
          scope.brandReference,
          scope.storeReference,
          cart.cartReference,
          version,
          at,
          next.lifecycle?.idleExpiresAt,
          cart.aggregateVersion,
        ],
      ),
    ) !== 1
  )
    throw new CartError("CART_VERSION_CONFLICT");
  for (const { row, line } of returned) {
    await tx.query(
      `INSERT INTO rms_ordering.cart_line
       (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,
        added_by_participant_id,added_at,customer_note,catalog_selection_evidence_json)
       SELECT $1,$2,w.brand_id,w.store_id,w.sellable_id,w.quantity,w.option_selections_json,w.added_by_actor_id,
        w.added_by_participant_id,w.added_at,w.customer_note,w.catalog_selection_evidence_json
       FROM rms_ordering.dining_cart_waiting_line w WHERE w.brand_id=$3 AND w.store_id=$4 AND w.waiting_line_id=$5`,
      [line, cart.cartReference, scope.brandReference, scope.storeReference, row.line],
    );
    await tx.query(
      `INSERT INTO rms_ordering.dining_cart_waiting_line_resolution
       (waiting_line_id,brand_id,store_id,cart_id,cart_version,resolution,returned_cart_line_id,reason_code,
        operation_id,guest_session_id,occurred_at,audit_id)
       VALUES ($1,$2,$3,$4,$5,'Returned',$6,$7,$8,$9,$10,$11)`,
      [
        row.line,
        scope.brandReference,
        scope.storeReference,
        cart.cartReference,
        version,
        line,
        reasonOf(row),
        operation,
        actor.guestSessionReference,
        at,
        audit.auditId,
      ],
    );
  }
  const persisted = await createPostgresCartQueryStore(lent(tx), scope).load(cart.cartReference);
  if (
    persisted === null ||
    persisted.aggregateVersion !== version ||
    persisted.items.length !== next.items.length
  )
    return unavailable();
  await appendAuditRecordInTransaction(tx as never, audit);
  return Object.freeze({
    status: "Returned" as const,
    cartVersion: version,
    returnedUnits: returned.reduce((total, { row }) => total + Number(row.quantity), 0),
  });
}
