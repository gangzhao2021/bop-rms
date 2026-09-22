import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CheckoutSessionServiceError,
  type CheckoutSessionAuthority,
  type CheckoutSessionRequest,
} from "../../application/checkout-session-service.js";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import { parseCheckoutSession, type CheckoutSession } from "../../domain/checkout-session.js";
import type { CartQueryTransaction, CartQueryTransactionRunner } from "./cart-query-store.js";

export interface CheckoutSessionStoreGates {
  /** Must reauthorize current Guest/CSRF in this transaction; never a client boolean.
   * Writes additionally require exact Cart access here. For read bootstrap, the caller
   * must authorize the persisted source Cart in the same transaction before exposing it. */
  authorize(
    tx: CartQueryTransaction,
    authority: CheckoutSessionAuthority,
    observedAt: string,
  ): Promise<boolean>;
  audit(session: CheckoutSession, authority: CheckoutSessionAuthority): unknown;
}
const fail = (code: CheckoutSessionServiceError["code"] = "DEPENDENCY_UNAVAILABLE"): never => {
  throw new CheckoutSessionServiceError(code);
};
function rows(value: unknown): Record<string, unknown>[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("rows" in value) ||
    !Array.isArray(value.rows)
  )
    return fail();
  return value.rows;
}
export function createPostgresCheckoutSessionStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  gates: CheckoutSessionStoreGates,
) {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  async function clock(tx: CartQueryTransaction) {
    const found = rows(
      await tx.query(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at`,
        [],
      ),
    );
    if (found.length !== 1) return fail();
    return parseOrderingInstant(found[0]?.observed_at);
  }
  async function authorize(tx: CartQueryTransaction, authority: CheckoutSessionAuthority) {
    const at = await clock(tx);
    parseOrderingReference(authority.guestSessionReference);
    if (
      authority.brandReference !== brand ||
      authority.storeReference !== store ||
      parseOrderingInstant(authority.checkedAt) > at ||
      parseOrderingInstant(authority.validUntil) <= at ||
      !(await gates.authorize(tx, authority, at))
    )
      return fail("PERMISSION_DENIED");
    return at;
  }
  async function run<T>(action: (tx: CartQueryTransaction) => Promise<T>) {
    try {
      return await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        return action(tx);
      });
    } catch (error) {
      if (error instanceof CheckoutSessionServiceError) throw error;
      return fail();
    }
  }
  async function read(
    tx: CartQueryTransaction,
    column: "create_operation_id" | "checkout_session_id",
    reference: string,
    authority: CheckoutSessionAuthority,
  ) {
    const found = rows(
      await tx.query(
        "SELECT snapshot_json FROM rms_ordering.checkout_session_record WHERE brand_id=$1 AND store_id=$2 AND " +
          column +
          "=$3 AND guest_session_id=$4",
        [brand, store, reference, authority.guestSessionReference],
      ),
    );
    if (found.length > 1) return fail();
    if (found.length === 0) return null;
    const row = readClosedRecord(found[0], ["snapshot_json"]);
    const session = parseCheckoutSession(row.snapshot_json),
      validation = session.validation;
    if (
      validation.brandReference !== brand ||
      validation.storeReference !== store ||
      validation.guestSessionReference !== authority.guestSessionReference ||
      (column === "create_operation_id"
        ? session.createOperationReference
        : session.checkoutSessionReference) !== reference
    )
      return fail();
    return session;
  }
  function intent(session: CheckoutSession, input: CheckoutSessionRequest) {
    const v = session.validation;
    if (
      session.createOperationReference !== input.createOperationReference ||
      v.cartReference !== input.cartReference ||
      v.cartVersion !== input.cartVersion ||
      v.quoteReference !== input.quoteReference ||
      v.quoteVersion !== input.quoteVersion
    )
      return fail("INTENT_CONFLICT");
  }
  return Object.freeze({
    async resolveOperation(input: CheckoutSessionRequest, authority: CheckoutSessionAuthority) {
      const operation = parseOrderingReference(input.createOperationReference);
      return run(async (tx) => {
        await authorize(tx, authority);
        const session = await read(tx, "create_operation_id", operation, authority);
        if (session) intent(session, input);
        await authorize(tx, authority);
        return session;
      });
    },
    async load(checkoutSessionReference: string, authority: CheckoutSessionAuthority) {
      const reference = parseOrderingReference(checkoutSessionReference);
      return run(async (tx) => {
        await authorize(tx, authority);
        const session = await read(tx, "checkout_session_id", reference, authority);
        await authorize(tx, authority);
        return session;
      });
    },
    async create(value: CheckoutSession, authority: CheckoutSessionAuthority) {
      const session = parseCheckoutSession(value),
        v = session.validation;
      if (
        v.brandReference !== brand ||
        v.storeReference !== store ||
        v.guestSessionReference !== authority.guestSessionReference
      )
        return fail("PERMISSION_DENIED");
      return run(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "ordering.checkout-session:" +
            brand +
            ":" +
            store +
            ":" +
            session.createOperationReference,
        ]);
        await authorize(tx, authority);
        const prior = await read(
          tx,
          "create_operation_id",
          session.createOperationReference,
          authority,
        );
        if (prior) {
          intent(prior, { ...v, createOperationReference: session.createOperationReference });
          await authorize(tx, authority);
          return Object.freeze({ status: "AlreadyCreated" as const, session: prior });
        }
        const allocation = rows(
          await tx.query(
            "SELECT create_operation_id FROM rms_ordering.checkout_session_allocation WHERE brand_id=$1 AND store_id=$2 AND create_operation_id=$3 AND guest_session_id=$4 AND cart_id=$5 AND cart_version=$6 AND quote_id=$7 AND quote_version=$8 AND checkout_session_id=$9 AND submission_id=$10 AND payment_operation_id=$11 AND allocated_at<=$12::timestamptz",
            [
              brand,
              store,
              session.createOperationReference,
              v.guestSessionReference,
              v.cartReference,
              v.cartVersion,
              v.quoteReference,
              v.quoteVersion,
              session.checkoutSessionReference,
              session.submissionReference,
              session.paymentOperationReference,
              session.createdAt,
            ],
          ),
        );
        if (
          allocation.length !== 1 ||
          allocation[0]?.create_operation_id !== session.createOperationReference
        )
          return fail("INTENT_CONFLICT");
        const carts = rows(
          await tx.query(
            "SELECT aggregate_version,order_type,source_channel,lifecycle_status FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
            [brand, store, v.cartReference],
          ),
        );
        if (
          carts.length !== 1 ||
          carts[0]?.aggregate_version !== v.cartVersion ||
          carts[0]?.order_type !== v.orderType ||
          carts[0]?.source_channel !== v.sourceChannel ||
          carts[0]?.lifecycle_status !== "Active"
        )
          return fail("INTENT_CONFLICT");
        async function current() {
          const at = await authorize(tx, authority);
          if (session.createdAt > at || v.validUntil <= at) return fail("INTENT_CONFLICT");
          const active = rows(
            await tx.query(
              "SELECT cart_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND updated_at<=$4::timestamptz AND idle_expires_at>$4::timestamptz AND absolute_expires_at>$4::timestamptz",
              [brand, store, v.cartReference, at],
            ),
          );
          const quotes = rows(
            await tx.query(
              "SELECT quote_id,quote_version,quote_input_digest,guest_session_id,quote_expires_at>$4::timestamptz AS valid FROM rms_ordering.cart_quote_attachment WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND cart_version=$5 AND attached_at<=$4::timestamptz ORDER BY attached_at DESC,operation_id DESC LIMIT 1",
              [brand, store, v.cartReference, at, v.cartVersion],
            ),
          );
          const quote = quotes[0];
          if (
            active.length !== 1 ||
            quotes.length !== 1 ||
            quote?.quote_id !== v.quoteReference ||
            quote?.quote_version !== v.quoteVersion ||
            quote?.quote_input_digest !== v.quoteInputDigest ||
            quote?.guest_session_id !== v.guestSessionReference ||
            quote?.valid !== true
          )
            return fail("INTENT_CONFLICT");
        }
        await current();
        const audit = validateAuditRecord(
          gates.audit(session, authority),
          Date.parse(await clock(tx)),
        );
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actionCode !== "ORDERING_CHECKOUT_SESSION_CREATE" ||
          audit.reasonCode !== "AUTHORIZED_CHECKOUT_CREATE" ||
          audit.targetType !== "CheckoutSession" ||
          audit.targetId !== session.checkoutSessionReference ||
          audit.occurredAt !== session.createdAt ||
          audit.actor.type !== "System" ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted"
        )
          return fail();
        const inserted = rows(
          await tx.query(
            "INSERT INTO rms_ordering.checkout_session_record (brand_id,store_id,checkout_session_id,create_operation_id,submission_id,payment_operation_id,guest_session_id,cart_id,snapshot_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING checkout_session_id",
            [
              brand,
              store,
              session.checkoutSessionReference,
              session.createOperationReference,
              session.submissionReference,
              session.paymentOperationReference,
              v.guestSessionReference,
              v.cartReference,
              JSON.stringify(session),
              session.createdAt,
            ],
          ),
        );
        if (
          inserted.length !== 1 ||
          inserted[0]?.checkout_session_id !== session.checkoutSessionReference
        )
          return fail();
        await appendAuditRecordInTransaction(tx, audit);
        await current();
        return Object.freeze({ status: "Created" as const, session });
      });
    },
  });
}
