import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CheckoutSessionServiceError,
  type CheckoutSessionAuthority,
} from "../../application/checkout-session-service.js";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import {
  parseCheckoutSessionAllocation,
  type CheckoutSessionAllocation,
} from "../../domain/checkout-session-allocation.js";
import type { CheckoutSessionStoreGates } from "./checkout-session-store.js";
import type { CartQueryTransaction, CartQueryTransactionRunner } from "./cart-query-store.js";

export interface CheckoutSessionAllocationGates {
  readonly authorize: CheckoutSessionStoreGates["authorize"];
  readonly audit: (
    allocation: CheckoutSessionAllocation,
    authority: CheckoutSessionAuthority,
  ) => unknown;
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
export function createPostgresCheckoutSessionAllocationStore(
  runner: CartQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  gates: CheckoutSessionAllocationGates,
) {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  async function current(tx: CartQueryTransaction, authority: CheckoutSessionAuthority) {
    const result = rows(
      await tx.query(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at`,
        [],
      ),
    );
    if (result.length !== 1) return fail();
    const at = parseOrderingInstant(result[0]?.observed_at);
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
  return Object.freeze({
    async allocate(value: CheckoutSessionAllocation, authority: CheckoutSessionAuthority) {
      try {
        const candidate = parseCheckoutSessionAllocation(value);
        if (
          candidate.brandReference !== brand ||
          candidate.storeReference !== store ||
          candidate.guestSessionReference !== authority.guestSessionReference
        )
          return fail("PERMISSION_DENIED");
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "ordering.checkout-session:" +
              brand +
              ":" +
              store +
              ":" +
              candidate.createOperationReference,
          ]);
          const at = await current(tx, authority);
          const found = rows(
            await tx.query(
              `SELECT jsonb_build_object(
            'brandReference',brand_id,'storeReference',store_id,'guestSessionReference',guest_session_id,
            'createOperationReference',create_operation_id,'cartReference',cart_id,'cartVersion',cart_version,
            'quoteReference',quote_id,'quoteVersion',quote_version,'checkoutSessionReference',checkout_session_id,
            'submissionReference',submission_id,'paymentOperationReference',payment_operation_id,
            'allocatedAt',to_char(allocated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) AS allocation FROM rms_ordering.checkout_session_allocation
          WHERE brand_id=$1 AND store_id=$2 AND create_operation_id=$3`,
              [brand, store, candidate.createOperationReference],
            ),
          );
          if (found.length > 1) return fail();
          if (found.length === 1) {
            const prior = parseCheckoutSessionAllocation(
              readClosedRecord(found[0], ["allocation"]).allocation,
            );
            for (const field of [
              "brandReference",
              "storeReference",
              "guestSessionReference",
              "createOperationReference",
              "cartReference",
              "cartVersion",
              "quoteReference",
              "quoteVersion",
            ] as const)
              if (prior[field] !== candidate[field]) return fail("INTENT_CONFLICT");
            if (prior.allocatedAt > at) return fail();
            await current(tx, authority);
            return prior;
          }
          if (candidate.allocatedAt > at) return fail();
          const cart = rows(
            await tx.query(
              "SELECT cart_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$4 AND lifecycle_status='Active' AND updated_at<=$5::timestamptz AND idle_expires_at>$5::timestamptz AND absolute_expires_at>$5::timestamptz FOR UPDATE",
              [brand, store, candidate.cartReference, candidate.cartVersion, at],
            ),
          );
          if (cart.length !== 1) return fail("INTENT_CONFLICT");
          const audit = validateAuditRecord(gates.audit(candidate, authority), Date.parse(at));
          if (
            audit.brandId !== brand ||
            audit.storeId !== store ||
            audit.actor.type !== "System" ||
            audit.actionCode !== "ORDERING_CHECKOUT_SESSION_ALLOCATE" ||
            audit.reasonCode !== "AUTHORIZED_CHECKOUT_CREATE" ||
            audit.targetType !== "CheckoutSession" ||
            audit.targetId !== candidate.checkoutSessionReference ||
            audit.occurredAt !== candidate.allocatedAt ||
            audit.sourceChannel !== "CUSTOMER_PWA" ||
            audit.dataClassification !== "Restricted"
          )
            return fail();
          const inserted = rows(
            await tx.query(
              "INSERT INTO rms_ordering.checkout_session_allocation (brand_id,store_id,create_operation_id,guest_session_id,cart_id,cart_version,quote_id,quote_version,checkout_session_id,submission_id,payment_operation_id,allocated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING create_operation_id",
              [
                brand,
                store,
                candidate.createOperationReference,
                candidate.guestSessionReference,
                candidate.cartReference,
                candidate.cartVersion,
                candidate.quoteReference,
                candidate.quoteVersion,
                candidate.checkoutSessionReference,
                candidate.submissionReference,
                candidate.paymentOperationReference,
                candidate.allocatedAt,
              ],
            ),
          );
          if (
            inserted.length !== 1 ||
            inserted[0]?.create_operation_id !== candidate.createOperationReference
          )
            return fail();
          await appendAuditRecordInTransaction(tx, audit);
          await current(tx, authority);
          return candidate;
        });
      } catch (error) {
        if (error instanceof CheckoutSessionServiceError) throw error;
        return fail();
      }
    },
  });
}

export interface CheckoutAllocationHistoryInput {
  readonly cartReference: string;
  readonly expectedCartVersion: number;
  readonly observedAt: string;
}
/** Discovery only, not financial clearance. Retain the caller transaction/Cart
 * lock through the replacement decision. Includes allocations whose CheckoutSession
 * was never created; elapsed Quote/validation time says nothing about Payment.
 */
export function createPostgresCheckoutAllocationHistory(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly authorize: (
    transaction: CartQueryTransaction,
    input: CheckoutAllocationHistoryInput,
  ) => Promise<boolean>;
}) {
  const scope = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  const authorize = options.authorize;
  if (typeof authorize !== "function") return fail();
  const reader = Object.freeze({
    async load(transaction: CartQueryTransaction, value: CheckoutAllocationHistoryInput) {
      try {
        const raw = readClosedRecord(value, ["cartReference", "expectedCartVersion", "observedAt"]);
        const input = Object.freeze({
          cartReference: parseOrderingReference(raw.cartReference),
          expectedCartVersion: raw.expectedCartVersion as number,
          observedAt: parseOrderingInstant(raw.observedAt),
        });
        if (
          !Number.isSafeInteger(input.expectedCartVersion) ||
          input.expectedCartVersion < 1 ||
          input.expectedCartVersion > 2147483647
        )
          return fail("INTENT_CONFLICT");
        if (!(await authorize(transaction, input))) return fail("PERMISSION_DENIED");
        await transaction.query(
          "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
          [brand, store],
        );
        const cart = rows(
          await transaction.query(
            "SELECT aggregate_version FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND updated_at<=$4::timestamptz FOR UPDATE",
            [brand, store, input.cartReference, input.observedAt],
          ),
        );
        if (cart.length !== 1 || cart[0]?.aggregate_version !== input.expectedCartVersion)
          return fail("INTENT_CONFLICT");
        const found = rows(
          await transaction.query(
            `SELECT jsonb_build_object(
          'brandReference',brand_id,'storeReference',store_id,'guestSessionReference',guest_session_id,
          'createOperationReference',create_operation_id,'cartReference',cart_id,'cartVersion',cart_version,
          'quoteReference',quote_id,'quoteVersion',quote_version,'checkoutSessionReference',checkout_session_id,
          'submissionReference',submission_id,'paymentOperationReference',payment_operation_id,
          'allocatedAt',to_char(allocated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS allocation
          FROM rms_ordering.checkout_session_allocation WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3
          ORDER BY allocated_at,create_operation_id LIMIT 1001`,
            [brand, store, input.cartReference],
          ),
        );
        if (found.length > 1000) return fail();
        const allocations = found.map((row) =>
          parseCheckoutSessionAllocation(readClosedRecord(row, ["allocation"]).allocation),
        );
        const operations = new Set<string>(),
          sessions = new Set<string>(),
          payments = new Set<string>(),
          submissions = new Set<string>();
        for (const allocation of allocations) {
          if (
            allocation.brandReference !== brand ||
            allocation.storeReference !== store ||
            allocation.cartReference !== input.cartReference ||
            allocation.cartVersion > input.expectedCartVersion ||
            allocation.allocatedAt > input.observedAt ||
            operations.has(allocation.createOperationReference) ||
            sessions.has(allocation.checkoutSessionReference) ||
            payments.has(allocation.paymentOperationReference) ||
            submissions.has(allocation.submissionReference)
          )
            return fail();
          operations.add(allocation.createOperationReference);
          sessions.add(allocation.checkoutSessionReference);
          payments.add(allocation.paymentOperationReference);
          submissions.add(allocation.submissionReference);
        }
        if (!(await authorize(transaction, input))) return fail("PERMISSION_DENIED");
        return Object.freeze(allocations);
      } catch (error) {
        if (error instanceof CheckoutSessionServiceError) throw error;
        return fail();
      }
    },
  });
  return Object.freeze({
    ...reader,
    /** Includes direct/legacy submitted attempts, not just allocated attempts.
     * Caller retains this transaction's Cart lock through its replacement write.
     */
    async loadForReplacement(
      transaction: CartQueryTransaction,
      value: CheckoutAllocationHistoryInput,
    ) {
      try {
        const raw = readClosedRecord(value, ["cartReference", "expectedCartVersion", "observedAt"]);
        const input = Object.freeze({
          cartReference: parseOrderingReference(raw.cartReference),
          expectedCartVersion: raw.expectedCartVersion as number,
          observedAt: parseOrderingInstant(raw.observedAt),
        });
        const allocations = await reader.load(transaction, input);
        const coverage = rows(
          await transaction.query(
            `SELECT EXISTS (
          SELECT 1 FROM
            (SELECT * FROM rms_ordering.order_submission_record WHERE brand_id=$1 AND store_id=$2) s
          FULL JOIN
            (SELECT * FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2) b
          ON b.submission_id=s.submission_id AND b.order_id=s.order_id
          WHERE (s.source_cart_id=$3 OR b.source_cart_id=$3) AND (
            s.submission_id IS NULL OR b.order_batch_id IS NULL
            OR s.source_cart_id IS DISTINCT FROM b.source_cart_id
            OR s.source_cart_version IS DISTINCT FROM b.source_cart_version
            OR s.quote_id IS DISTINCT FROM b.quote_id
            OR s.guest_session_id IS DISTINCT FROM b.submitted_by_actor_id
            OR s.source_cart_version>$4 OR s.created_at>$5::timestamptz OR b.submitted_at>$5::timestamptz
            OR NOT EXISTS (
              SELECT 1 FROM rms_ordering.checkout_session_allocation a
              WHERE a.brand_id=$1 AND a.store_id=$2 AND a.cart_id=$3
                AND a.submission_id=s.submission_id AND a.cart_version=s.source_cart_version
                AND a.quote_id=s.quote_id AND a.guest_session_id=s.guest_session_id
                AND a.allocated_at<=s.created_at AND a.allocated_at<=b.submitted_at
            )
          )
        ) AS uncovered`,
            [brand, store, input.cartReference, input.expectedCartVersion, input.observedAt],
          ),
        );
        if (
          coverage.length !== 1 ||
          readClosedRecord(coverage[0], ["uncovered"]).uncovered !== false
        )
          return fail();
        if ((await authorize(transaction, input)) !== true) return fail("PERMISSION_DENIED");
        return allocations;
      } catch (error) {
        if (error instanceof CheckoutSessionServiceError) throw error;
        return fail();
      }
    },
  });
}

/** Read-only recovery discovery for a currently authorized Guest; never Payment admission. */
export function createPostgresGuestCheckoutRecovery(options: {
  scope: { brandReference: string; storeReference: string };
  authorize(
    transaction: CartQueryTransaction,
    input: Readonly<{ guestSessionReference: string; observedAt: string }>,
  ): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.scope.brandReference),
    store = parseOrderingReference(options.scope.storeReference);
  return Object.freeze({
    async latest(transaction: CartQueryTransaction, value: unknown) {
      try {
        const raw = readClosedRecord(value, ["guestSessionReference", "observedAt"]),
          input = Object.freeze({
            guestSessionReference: parseOrderingReference(raw.guestSessionReference),
            observedAt: parseOrderingInstant(raw.observedAt),
          });
        if ((await options.authorize(transaction, input)) !== true)
          return fail("PERMISSION_DENIED");
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        const found = rows(
          await transaction.query(
            `SELECT jsonb_build_object(
    'brandReference',a.brand_id,'storeReference',a.store_id,'guestSessionReference',a.guest_session_id,
    'createOperationReference',a.create_operation_id,'cartReference',a.cart_id,'cartVersion',a.cart_version,
    'quoteReference',a.quote_id,'quoteVersion',a.quote_version,'checkoutSessionReference',a.checkout_session_id,
    'submissionReference',a.submission_id,'paymentOperationReference',a.payment_operation_id,
    'allocatedAt',to_char(a.allocated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS allocation,
    to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created
    FROM rms_ordering.checkout_session_allocation a JOIN rms_ordering.checkout_session_record s
      ON s.brand_id=a.brand_id AND s.store_id=a.store_id AND s.checkout_session_id=a.checkout_session_id
      AND s.guest_session_id=a.guest_session_id AND s.create_operation_id=a.create_operation_id
      AND s.submission_id=a.submission_id AND s.payment_operation_id=a.payment_operation_id AND s.cart_id=a.cart_id
    WHERE a.brand_id=$1 AND a.store_id=$2 AND a.guest_session_id=$3 AND a.allocated_at<=$4::timestamptz
      AND s.created_at>=a.allocated_at AND s.created_at<=$4::timestamptz
    ORDER BY a.allocated_at DESC,a.checkout_session_id DESC LIMIT 1`,
            [brand, store, input.guestSessionReference, input.observedAt],
          ),
        );
        if (found.length > 1) return fail();
        let result: CheckoutSessionAllocation | null = null;
        if (found.length === 1) {
          const row = readClosedRecord(found[0], ["allocation", "created"]);
          result = parseCheckoutSessionAllocation(row.allocation);
          const created = parseOrderingInstant(row.created);
          if (
            result.brandReference !== brand ||
            result.storeReference !== store ||
            result.guestSessionReference !== input.guestSessionReference ||
            result.allocatedAt > input.observedAt ||
            created < result.allocatedAt ||
            created > input.observedAt
          )
            return fail();
        }
        if ((await options.authorize(transaction, input)) !== true)
          return fail("PERMISSION_DENIED");
        return result;
      } catch (error) {
        if (error instanceof CheckoutSessionServiceError) throw error;
        return fail();
      }
    },
  });
}
