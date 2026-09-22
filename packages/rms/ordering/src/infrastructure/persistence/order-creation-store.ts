import { clearSubmittedDiningCart } from "../../domain/dining-cart-continuation.js";
import { assertGuestSessionUsable, createGuestSession, type GuestSession } from "@bop/identity";
import type { CapacityLinkedOrderCreationPorts } from "../../application/order-creation-service.js";
import type { CheckoutDetailsPorts } from "../../application/checkout-details-service.js";
import { validateCheckoutDetailsPolicy } from "../../application/checkout-details-policy.js";
import { createPostgresCheckoutDetailsStore } from "./checkout-details-store.js";
import {
  parseCheckoutDetailsSnapshot,
  type CheckoutDetailsSnapshot,
} from "../../domain/checkout-details.js";
import { createHash } from "node:crypto";
import {
  parseOrderCapacityLink,
  assertOrderCapacityLinkMatches,
  type OrderCapacityLink,
} from "../../domain/order-capacity-link.js";
import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  canonicalizeRfc8785,
} from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import { assertCartLifecycleActive } from "../../domain/cart-lifecycle.js";
import { createOrderNumberAllocation } from "../../domain/order-number.js";
import {
  OrderCreationError,
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  type OrderCreationRecord,
} from "../../domain/order-creation.js";
import {
  createOrderItemSnapshots,
  createConfiguredOrderItemSnapshots,
} from "../../domain/order-item-snapshot.js";
import {
  encodeOrderItemSnapshot,
  encodeConfiguredOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";
import {
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
  type CheckoutValidationEvidence,
} from "../../domain/checkout-validation.js";
import {
  createOrderCreatedEnvelope,
  parseOrderCreatedEnvelope,
} from "../../application/order-created-event.js";
import { orderCreatedSourceInput } from "../../application/order-created-source.js";
import { validateOrderSubmissionWriteFence } from "../../application/order-submission-write-fence.js";
import { createPostgresCartQueryStore } from "./cart-query-store.js";
import {
  readOrderCreationHistory,
  createPostgresOrderCreationQueryStore,
  type OrderCreationQueryTransactionRunner,
  type OrderCreationQueryTransaction,
} from "./order-creation-query-store.js";

function fail(): never {
  throw new OrderCreationError("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value),
    out: Record<string, unknown> = {};
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail();
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    out[key] = d.value;
  }
  return out;
}
function capture(value: unknown): unknown {
  let nodes = 0,
    chars = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 200000 || depth > 40) return fail();
    if (v === null || typeof v === "boolean" || typeof v === "bigint") return v;
    if (typeof v === "string") {
      chars += v.length;
      if (chars > 64 * 1024 * 1024) return fail();
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) return fail();
      return v;
    }
    if (typeof v !== "object" || seen.has(v)) return fail();
    seen.add(v);
    try {
      const keys = Reflect.ownKeys(v);
      if (keys.length > 1001) return fail();
      if (Array.isArray(v)) {
        if (
          Object.getPrototypeOf(v) !== Array.prototype ||
          v.length > 1000 ||
          keys.length !== v.length + 1
        )
          return fail();
        const out: unknown[] = [];
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d?.enumerable || !("value" in d)) return fail();
          out.push(visit(d.value, depth + 1));
        }
        return Object.freeze(out);
      }
      if (Object.getPrototypeOf(v) !== Object.prototype) return fail();
      const entries: [string, unknown][] = [];
      for (const key of keys) {
        if (typeof key !== "string" || key.length > 256) return fail();
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d?.enumerable || !("value" in d)) return fail();
        entries.push([key, visit(d.value, depth + 1)]);
      }
      return Object.freeze(Object.fromEntries(entries));
    } finally {
      seen.delete(v);
    }
  }
  return visit(value, 0);
}
function rows(result: unknown): unknown[] {
  if (result === null || typeof result !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d?.enumerable || !("value" in d)) return fail();
  const value = capture(d.value);
  if (!Array.isArray(value) || value.length > 1) return fail();
  return value;
}
function count(result: unknown, expected = 1): number {
  if (result === null || typeof result !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(result, "rowCount");
  if (!d || !("value" in d) || d.value !== expected) return fail();
  return expected;
}
const hash = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown) =>
  canonicalizeRfc8785(
    JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    ),
  );

async function readCapacityLink(
  tx: OrderCreationQueryTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  submissionReference: string,
): Promise<OrderCapacityLink | null> {
  const found = rows(
    await tx.query(
      "SELECT link_json AS link FROM rms_ordering.order_capacity_link WHERE brand_id=$1 AND store_id=$2 AND submission_id=$3",
      [scope.brandReference, scope.storeReference, submissionReference],
    ),
  );
  if (found.length === 0) return null;
  const link = parseOrderCapacityLink(closed(found[0], ["link"]).link);
  if (
    link.brandReference !== scope.brandReference ||
    link.storeReference !== scope.storeReference ||
    link.submissionReference !== submissionReference
  )
    return fail();
  return link;
}

function assertDetailsMatch<V extends 1 | 2>(
  details: CheckoutDetailsSnapshot,
  record: OrderCreationRecord<V>,
  quoteVersion: V,
) {
  const batch = record.order.batches[0];
  if (
    details.brandReference !== record.order.brandReference ||
    details.storeReference !== record.order.storeReference ||
    details.guestSessionReference !== record.guestSessionReference ||
    details.cartReference !== batch.sourceCartReference ||
    details.cartVersion !== batch.sourceCartVersion ||
    details.quoteReference !== batch.quoteReference ||
    details.quoteVersion !== quoteVersion ||
    details.orderType !== record.order.orderType ||
    details.recordedAt > record.createdAt
  )
    return fail();
}
async function readLinkedDetails(
  tx: OrderCreationQueryTransaction,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  submissionReference: string,
) {
  const found = rows(
    await tx.query(
      "SELECT d.snapshot_json AS snapshot FROM rms_ordering.order_checkout_details_link l JOIN rms_ordering.checkout_details_record d ON d.brand_id=l.brand_id AND d.store_id=l.store_id AND d.details_id=l.details_id AND d.details_version=l.details_version WHERE l.brand_id=$1 AND l.store_id=$2 AND l.submission_id=$3",
      [scope.brandReference, scope.storeReference, submissionReference],
    ),
  );
  if (found.length === 0) return null;
  if (found.length !== 1) return fail();
  const details = parseCheckoutDetailsSnapshot(closed(found[0], ["snapshot"]).snapshot);
  if (
    details.brandReference !== scope.brandReference ||
    details.storeReference !== scope.storeReference
  )
    return fail();
  return details;
}

/** Internal authorized owner transaction. No Provider, Guest authorization or cross-owner capacity acquisition. */
export interface OrderSubmissionInventoryFinalizer<V extends 1 | 2 = 1> {
  /** Internal adapter must write durable owner evidence using this transaction. */
  finalize(
    input: Readonly<{
      transaction: Parameters<Parameters<OrderCreationQueryTransactionRunner["run"]>[0]>[0];
      cart: NonNullable<
        Awaited<ReturnType<ReturnType<typeof createPostgresCartQueryStore>["load"]>>
      >;
      record: Omit<OrderCreationRecord<V>, "orderNumberAllocation">;
      checkoutValidationEvidence: CheckoutValidationEvidence<V>;
      observedAt: string;
    }>,
  ): Promise<void>;
}

export function createPostgresOrderCreationStore<V extends 1 | 2 = 1>(
  runner: OrderCreationQueryTransactionRunner,
  scope: unknown,
  capacityLinkValue?: unknown,
  quoteVersion: V = 1 as V,
  checkoutDetailsValue?: unknown,
  checkoutPolicyWindowValue?: Readonly<{ checkedAt: string; validUntil: string }>,
  inventoryFinalizer?: OrderSubmissionInventoryFinalizer<V>,
) {
  const fixed = closed(scope, ["brandReference", "storeReference"]);
  const brandReference = parseOrderingReference(fixed.brandReference),
    storeReference = parseOrderingReference(fixed.storeReference);
  const scoped = Object.freeze({ brandReference, storeReference });
  const parseRecord = (value: unknown) =>
    (quoteVersion === 2 ? parseConfiguredOrderCreationRecord : parseOrderCreationRecord)(
      value,
    ) as OrderCreationRecord<V>;
  const parseEvidence = (value: unknown) =>
    (quoteVersion === 2
      ? parseConfiguredCheckoutValidationEvidence
      : parseCheckoutValidationEvidence)(value) as CheckoutValidationEvidence<V>;
  const checkoutDetails =
    checkoutDetailsValue === undefined ? null : parseCheckoutDetailsSnapshot(checkoutDetailsValue);
  const checkoutPolicyWindow =
    checkoutPolicyWindowValue === undefined
      ? null
      : (() => {
          const value = closed(checkoutPolicyWindowValue, ["checkedAt", "validUntil"]);
          const checkedAt = parseOrderingInstant(value.checkedAt);
          const validUntil = parseOrderingInstant(value.validUntil);
          if (checkoutDetails === null || validUntil <= checkedAt) return fail();
          return Object.freeze({ checkedAt, validUntil });
        })();
  const capacityLink =
    capacityLinkValue === undefined ? null : parseOrderCapacityLink(capacityLinkValue);
  if (
    capacityLink !== null &&
    (capacityLink.brandReference !== brandReference ||
      capacityLink.storeReference !== storeReference)
  )
    throw new OrderCreationError("ORDER_CREATE_INPUT_INVALID");
  const conflict = new Error(),
    expired = new Error();
  return Object.freeze({
    async append(value: unknown) {
      const request = (() => {
        try {
          const raw = closed(capture(value), [
            "record",
            "businessDateResolution",
            "checkoutValidationEvidence",
            "audit",
            "event",
          ]);
          const provisional = closed(raw.record, [
            "submissionReference",
            "submissionIntentHash",
            "guestSessionReference",
            "order",
            "items",
            "createdAt",
          ]);
          const order = closed(provisional.order, [
            "orderReference",
            "brandReference",
            "storeReference",
            "orderType",
            "sourceChannel",
            "diningSessionReference",
            "createdByActorReference",
            "submittedByActorReference",
            "aggregateVersion",
            "canonicalPhase",
            "closureStatus",
            "paymentStatus",
            "createdAt",
            "batches",
          ]);
          const allocation = createOrderNumberAllocation({
            orderReference: order.orderReference,
            allocatedAt: provisional.createdAt,
            sequence: 1n,
            businessDateResolution: raw.businessDateResolution,
          });
          const record = parseRecord({
            ...provisional,
            orderNumberAllocation: allocation,
          });
          const b = record.order.batches[0];
          const evidence = parseEvidence(raw.checkoutValidationEvidence);
          validateOrderSubmissionWriteFence(
            {
              record,
              businessDateResolution: allocation.businessDateResolution,
              checkoutValidationEvidence: evidence,
              observedAt: record.createdAt,
            },
            quoteVersion,
          );
          if (
            record.order.brandReference !== brandReference ||
            record.order.storeReference !== storeReference ||
            record.submissionIntentHash !==
              hash(
                "CreateOrder:" +
                  JSON.stringify({
                    submissionReference: record.submissionReference,
                    cartReference: b.sourceCartReference,
                    expectedCartVersion: b.sourceCartVersion,
                    quoteReference: b.quoteReference,
                  }),
              )
          )
            return fail();
          if (capacityLink !== null) assertOrderCapacityLinkMatches(capacityLink, record, evidence);
          if (checkoutDetails !== null) assertDetailsMatch(checkoutDetails, record, quoteVersion);
          const auditInput = closed(raw.audit, [
            "auditId",
            "brandId",
            "storeId",
            "actor",
            "actionCode",
            "targetType",
            "targetId",
            "reasonCode",
            "correlationId",
            "occurredAt",
            "sourceChannel",
            "dataClassification",
            "retentionPolicyCode",
            "retentionPolicyVersion",
          ]);
          const audit = validateAuditRecord(auditInput as never, Date.parse(record.createdAt));
          if (
            audit.brandId !== brandReference ||
            audit.storeId !== storeReference ||
            audit.actor.type !== "System" ||
            audit.actionCode !== "ORDERING_ORDER_CREATE" ||
            audit.targetType !== "OrderingOrder" ||
            audit.targetId !== record.order.orderReference ||
            audit.reasonCode !== "AUTHORIZED_ORDER_CREATE" ||
            audit.occurredAt !== record.createdAt ||
            audit.sourceChannel !== "CUSTOMER_PWA" ||
            audit.dataClassification !== "Restricted"
          )
            return fail();
          const event = parseOrderCreatedEnvelope(raw.event);
          const expected = createOrderCreatedEnvelope({
            eventReference: event.eventId,
            correlationReference: audit.correlationId,
            sourceSnapshotDigest: hash(
              orderCreatedSourceInput(record, allocation.businessDateResolution),
            ),
            businessDate: allocation.businessDate,
            record,
          });
          if (canonical(event) !== canonical(expected)) return fail();
          return Object.freeze({
            record,
            evidence,
            audit,
            event,
            resolution: allocation.businessDateResolution,
          });
        } catch {
          throw new OrderCreationError("ORDER_CREATE_INPUT_INVALID");
        }
      })();
      try {
        return await runner.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
          await tx.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brandReference, storeReference],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            "ordering.submission:" +
              brandReference +
              ":" +
              storeReference +
              ":" +
              request.record.submissionReference,
          ]);
          const prior = await readOrderCreationHistory(
            tx,
            scoped,
            request.record.submissionReference,
            quoteVersion,
          );
          const batch = request.record.order.batches[0];
          if (prior !== null) {
            const original = prior.order.batches[0];
            if (
              prior.submissionIntentHash !== request.record.submissionIntentHash ||
              prior.guestSessionReference !== request.record.guestSessionReference ||
              original.sourceCartReference !== batch.sourceCartReference ||
              original.sourceCartVersion !== batch.sourceCartVersion ||
              original.quoteReference !== batch.quoteReference
            )
              throw conflict;
            if (capacityLink !== null) {
              const originalLink = await readCapacityLink(tx, scoped, prior.submissionReference);
              if (originalLink === null || canonical(originalLink) !== canonical(capacityLink))
                throw conflict;
              assertOrderCapacityLinkMatches(originalLink, prior);
            }
            if (checkoutDetails !== null) {
              const originalDetails = await readLinkedDetails(
                tx,
                scoped,
                prior.submissionReference,
              );
              if (
                originalDetails === null ||
                canonical(originalDetails) !== canonical(checkoutDetails)
              )
                throw conflict;
              assertDetailsMatch(originalDetails, prior, quoteVersion);
            }
            return Object.freeze({ status: "Existing" as const, record: prior });
          }
          const locked = rows(
            await tx.query(
              "SELECT cart_id AS reference FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$4 FOR UPDATE",
              [brandReference, storeReference, batch.sourceCartReference, batch.sourceCartVersion],
            ),
          );
          if (
            locked.length !== 1 ||
            closed(locked[0], ["reference"]).reference !== batch.sourceCartReference
          )
            return fail();
          if (checkoutDetails !== null) {
            const found = rows(
              await tx.query(
                "SELECT snapshot_json AS snapshot FROM rms_ordering.checkout_details_record WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND guest_session_id=$4 ORDER BY details_version DESC LIMIT 1",
                [
                  brandReference,
                  storeReference,
                  batch.sourceCartReference,
                  request.record.guestSessionReference,
                ],
              ),
            );
            if (found.length !== 1) return fail();
            const stored = parseCheckoutDetailsSnapshot(closed(found[0], ["snapshot"]).snapshot);
            if (canonical(stored) !== canonical(checkoutDetails)) return fail();
            assertDetailsMatch(stored, request.record, quoteVersion);
          }
          const check = async (expectedCartVersion = batch.sourceCartVersion) => {
            const result = rows(
              await tx.query(
                `WITH observed AS MATERIALIZED (SELECT clock_timestamp() AS at)
       SELECT o.at >= $5::timestamptz AND o.at < $6::timestamptz AND c.lifecycle_status='Active'
        AND o.at < c.idle_expires_at AND o.at < c.absolute_expires_at AS valid,
        to_char(o.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
       FROM rms_ordering.cart c CROSS JOIN observed o
       WHERE c.brand_id=$1 AND c.store_id=$2 AND c.cart_id=$3 AND c.aggregate_version=$4`,
                [
                  brandReference,
                  storeReference,
                  batch.sourceCartReference,
                  expectedCartVersion,
                  request.record.createdAt,
                  request.evidence.validUntil,
                ],
              ),
            );
            if (result.length !== 1) return fail();
            const row = closed(result[0], ["valid", "observedAt"]);
            if (row.valid !== true) throw expired;
            if (typeof row.observedAt !== "string") return fail();
            if (
              capacityLink !== null &&
              (row.observedAt < capacityLink.preparedAt ||
                row.observedAt >= capacityLink.validUntil)
            )
              throw expired;
            if (
              checkoutPolicyWindow !== null &&
              (row.observedAt < checkoutPolicyWindow.checkedAt ||
                row.observedAt >= checkoutPolicyWindow.validUntil)
            )
              throw expired;
            validateOrderSubmissionWriteFence(
              {
                record: request.record,
                businessDateResolution: request.resolution,
                checkoutValidationEvidence: request.evidence,
                observedAt: row.observedAt,
              },
              quoteVersion,
            );
            return row.observedAt;
          };
          const observed = await check();
          const cart = await createPostgresCartQueryStore(
            { run: (action) => action(tx) },
            scoped,
          ).load(batch.sourceCartReference);
          if (
            cart === null ||
            cart.diningSessionReference !== request.record.order.diningSessionReference ||
            cart.createdByActorReference !== request.record.order.createdByActorReference
          )
            return fail();
          assertCartLifecycleActive(cart.lifecycle, parseOrderingInstant(observed));
          const items = (
            quoteVersion === 2 ? createConfiguredOrderItemSnapshots : createOrderItemSnapshots
          )({
            orderReference: request.record.order.orderReference,
            orderBatchReference: batch.orderBatchReference,
            snapshotCapturedAt: request.record.createdAt,
            checkoutValidationEvidence: request.evidence,
            cart,
            lines: request.record.items.map((i) => ({
              orderItemReference: i.orderItemReference,
              cartItemReference: i.cartItemReference,
              catalog: i.catalog,
              pricing: i.pricing,
            })),
          });
          if (canonical(items) !== canonical(request.record.items)) return fail();
          const inventoryObservedAt = await check();
          if (inventoryFinalizer !== undefined) {
            const { orderNumberAllocation: provisionalAllocation, ...inventoryRecord } =
              request.record;
            void provisionalAllocation;
            await inventoryFinalizer.finalize(
              Object.freeze({
                transaction: tx,
                cart,
                record: Object.freeze(inventoryRecord),
                checkoutValidationEvidence: request.evidence,
                observedAt: inventoryObservedAt,
              }),
            );
            await check();
          }
          const allocationRows = rows(
            await tx.query(
              `INSERT INTO rms_ordering.order_number_counter
       (brand_id,store_id,business_date,next_sequence,updated_at) VALUES ($1,$2,$3,2,$4)
       ON CONFLICT (brand_id,store_id,business_date) DO UPDATE
       SET next_sequence=rms_ordering.order_number_counter.next_sequence+1,
           updated_at=GREATEST(rms_ordering.order_number_counter.updated_at,EXCLUDED.updated_at)
       WHERE rms_ordering.order_number_counter.next_sequence<9223372036854775807
       RETURNING (next_sequence-1)::text AS sequence`,
              [
                brandReference,
                storeReference,
                request.resolution.businessDate,
                request.record.createdAt,
              ],
            ),
          );
          if (allocationRows.length !== 1) return fail();
          const seq = closed(allocationRows[0], ["sequence"]).sequence;
          if (typeof seq !== "string" || !/^[1-9][0-9]{0,18}$/u.test(seq)) return fail();
          const n = createOrderNumberAllocation({
            orderReference: request.record.order.orderReference,
            allocatedAt: request.record.createdAt,
            sequence: BigInt(seq),
            businessDateResolution: request.resolution,
          });
          const seeded = parseRecord({ ...request.record, orderNumberAllocation: n });
          const r = seeded.order,
            b = r.batches[0];
          const execute = async (sql: string, values: readonly unknown[]) =>
            count(await tx.query(sql, values));
          await execute(
            `INSERT INTO rms_ordering.order_number_allocation
      (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
       business_date_configuration_id,business_date_configuration_version,business_date_content_digest,
       time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              n.orderReference,
              n.brandReference,
              n.storeReference,
              n.businessDate,
              n.sequence.toString(),
              n.orderNumber,
              n.allocatedAt,
              n.businessDateResolution.configurationReference,
              n.businessDateResolution.configurationVersion,
              n.businessDateResolution.contentDigest,
              n.businessDateResolution.timeZone,
              n.businessDateResolution.businessDayStartLocalTime,
              n.businessDateResolution.businessDateBoundaryAt,
              n.businessDateResolution.boundaryDisambiguation,
            ],
          );
          await execute(
            `INSERT INTO rms_ordering.order_header
      (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,
       created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              r.orderReference,
              r.brandReference,
              r.storeReference,
              n.businessDate,
              n.orderNumber,
              r.orderType,
              r.sourceChannel,
              r.diningSessionReference,
              r.createdByActorReference,
              r.submittedByActorReference,
              r.aggregateVersion,
              r.canonicalPhase,
              r.closureStatus,
              r.paymentStatus,
              r.createdAt,
            ],
          );
          await execute(
            `INSERT INTO rms_ordering.order_submission_record
      (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              seeded.submissionReference,
              r.brandReference,
              r.storeReference,
              r.orderReference,
              seeded.guestSessionReference,
              seeded.submissionIntentHash,
              b.sourceCartReference,
              b.sourceCartVersion,
              b.quoteReference,
              seeded.createdAt,
            ],
          );
          await execute(
            "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
            [
              seeded.submissionReference,
              r.brandReference,
              r.storeReference,
              r.orderReference,
              seeded.createdAt,
            ],
          );
          await execute(
            `INSERT INTO rms_ordering.order_batch
      (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,
       checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              b.orderBatchReference,
              r.brandReference,
              r.storeReference,
              r.orderReference,
              b.submissionReference,
              b.sourceCartReference,
              b.sourceCartVersion,
              b.checkoutValidationReference,
              b.quoteReference,
              b.submittedByActorReference,
              b.submittedAt,
            ],
          );
          if (capacityLink !== null) {
            await execute(
              "INSERT INTO rms_ordering.order_capacity_link (brand_id,store_id,submission_id,order_id,order_batch_id,commitment_id,payment_operation_id,created_at,link_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
              [
                r.brandReference,
                r.storeReference,
                seeded.submissionReference,
                r.orderReference,
                b.orderBatchReference,
                capacityLink.commitmentReference,
                capacityLink.paymentOperationReference,
                seeded.createdAt,
                JSON.stringify(capacityLink),
              ],
            );
          }
          if (checkoutDetails !== null) {
            await execute(
              "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,$6)",
              [
                r.brandReference,
                r.storeReference,
                seeded.submissionReference,
                r.orderReference,
                checkoutDetails.detailsReference,
                checkoutDetails.detailsVersion,
              ],
            );
          }
          // Persist the original immutable item ordinal.
          for (const [index, item] of seeded.items.entries()) {
            await execute(
              `INSERT INTO rms_ordering.order_item
        (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,
         catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
              [
                item.orderItemReference,
                r.brandReference,
                r.storeReference,
                r.orderReference,
                item.orderBatchReference,
                item.cartItemReference,
                item.quantity,
                item.catalog.snapshotDigest,
                item.pricing.quoteInputDigest,
                (quoteVersion === 2 ? encodeConfiguredOrderItemSnapshot : encodeOrderItemSnapshot)(
                  item,
                ),
                item.snapshotCapturedAt,
                index + 1,
              ],
            );
          }

          await appendAuditRecordInTransaction(tx, request.audit);
          await appendEventInTransaction(
            { query: async (sql, values) => ({ rowCount: count(await tx.query(sql, values)) }) },
            request.event,
          );
          const saved = await readOrderCreationHistory(
            tx,
            scoped,
            seeded.submissionReference,
            quoteVersion,
          );
          if (saved === null || canonical(saved) !== canonical(seeded)) return fail();
          if (capacityLink !== null) {
            const savedLink = await readCapacityLink(tx, scoped, seeded.submissionReference);
            if (savedLink === null || canonical(savedLink) !== canonical(capacityLink))
              return fail();
          }
          await check();
          if (checkoutDetails !== null) {
            const savedDetails = await readLinkedDetails(tx, scoped, saved.submissionReference);
            if (savedDetails === null || canonical(savedDetails) !== canonical(checkoutDetails))
              return fail();
            assertDetailsMatch(savedDetails, saved, quoteVersion);
          }
          if (saved.order.orderType === "DineIn") {
            const continuation = clearSubmittedDiningCart({
              cart,
              batch,
              brandReference,
              storeReference,
              diningSessionReference: saved.order.diningSessionReference,
              orderReference: saved.order.orderReference,
            });
            const removed = count(
              await tx.query(
                "DELETE FROM rms_ordering.cart_line WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3",
                [brandReference, storeReference, cart.cartReference],
              ),
              continuation.clearedItemReferences.length,
            );
            if (removed !== continuation.clearedItemReferences.length) return fail();
            const next = continuation.cart;
            const advanced = count(
              await tx.query(
                "UPDATE rms_ordering.cart SET aggregate_version=$4,updated_at=$5,idle_expires_at=$6 " +
                  "WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$7",
                [
                  brandReference,
                  storeReference,
                  next.cartReference,
                  next.aggregateVersion,
                  next.updatedAt,
                  next.lifecycle?.idleExpiresAt,
                  cart.aggregateVersion,
                ],
              ),
            );
            if (advanced !== 1) return fail();
            await check(next.aggregateVersion);
          }
          return Object.freeze({ status: "Created" as const, record: saved });
        });
      } catch (error) {
        if (error === conflict) throw new OrderCreationError("ORDER_CREATE_IDEMPOTENCY_CONFLICT");
        if (error === expired) throw new OrderCreationError("ORDER_CREATE_VALIDATION_EXPIRED");
        return fail();
      }
    },
  });
}

/** Compose dedicated read and write transactions; application authorization remains above this boundary. */
export function createPostgresOrderCreationRepository(
  runners: Readonly<{
    query: OrderCreationQueryTransactionRunner;
    write: OrderCreationQueryTransactionRunner;
  }>,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const reader = createPostgresOrderCreationQueryStore(runners.query, scope);
  const writer = createPostgresOrderCreationStore(runners.write, scope);
  return Object.freeze({
    resolveSubmission: reader.resolveSubmission,
    commit: writer.append,
  });
}

/** Required-capacity path. Missing or different original linkage never falls back to legacy history. */
export function createPostgresCapacityLinkedOrderCreationRepository<V extends 1 | 2 = 1>(
  runners: Readonly<{
    query: OrderCreationQueryTransactionRunner;
    write: OrderCreationQueryTransactionRunner;
  }>,
  scopeValue: Readonly<{ brandReference: string; storeReference: string }>,
  linkValue: unknown,
  quoteVersion: V = 1 as V,
  checkoutDetailsValue?: unknown,
  checkoutPolicyWindowValue?: Readonly<{ checkedAt: string; validUntil: string }>,
  inventoryFinalizer?: OrderSubmissionInventoryFinalizer<V>,
) {
  const link = parseOrderCapacityLink(linkValue);
  const raw = closed(scopeValue, ["brandReference", "storeReference"]);
  const scope = Object.freeze({
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
  });
  if (scope.brandReference !== link.brandReference || scope.storeReference !== link.storeReference)
    throw new OrderCreationError("ORDER_CREATE_INPUT_INVALID");
  const checkoutDetails =
    checkoutDetailsValue === undefined ? null : parseCheckoutDetailsSnapshot(checkoutDetailsValue);
  const writer = createPostgresOrderCreationStore(
    runners.write,
    scope,
    link,
    quoteVersion,
    checkoutDetailsValue,
    checkoutPolicyWindowValue,
    inventoryFinalizer,
  );
  async function resolve(referenceValue: string) {
    const reference = parseOrderingReference(referenceValue);
    if (reference !== link.submissionReference)
      throw new OrderCreationError("ORDER_CREATE_IDEMPOTENCY_CONFLICT");
    try {
      return await runners.query.run(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY", []);
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const record = await readOrderCreationHistory(tx, scope, reference, quoteVersion);
        if (record === null) return null;
        const savedLink = await readCapacityLink(tx, scope, reference);
        if (savedLink === null || canonical(savedLink) !== canonical(link)) return fail();
        assertOrderCapacityLinkMatches(savedLink, record);
        const details =
          checkoutDetails === null ? null : await readLinkedDetails(tx, scope, reference);
        if (checkoutDetails !== null) {
          if (details === null || canonical(details) !== canonical(checkoutDetails)) return fail();
          assertDetailsMatch(details, record, quoteVersion);
        }
        return Object.freeze({ record, link: savedLink, details });
      });
    } catch {
      return fail();
    }
  }
  return Object.freeze({
    commit: writer.append,
    async resolveSubmission(reference: string) {
      return (await resolve(reference))?.record ?? null;
    },
    async resolveCheckoutDetails(reference: string) {
      if (checkoutDetails === null) return fail();
      return (await resolve(reference))?.details ?? null;
    },
    async resolveCapacityLink(reference: string) {
      return (await resolve(reference))?.link ?? null;
    },
  });
}

export function createPostgresConfiguredOrderCreationStore(
  runner: OrderCreationQueryTransactionRunner,
  scope: unknown,
  capacityLinkValue?: unknown,
) {
  return createPostgresOrderCreationStore(runner, scope, capacityLinkValue, 2);
}
export function createPostgresConfiguredOrderCreationRepository(
  runners: Readonly<{
    query: OrderCreationQueryTransactionRunner;
    write: OrderCreationQueryTransactionRunner;
  }>,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const reader = createPostgresOrderCreationQueryStore(runners.query, scope, 2);
  const writer = createPostgresConfiguredOrderCreationStore(runners.write, scope);
  return Object.freeze({ resolveSubmission: reader.resolveSubmission, commit: writer.append });
}

/** Pilot path: both original capacity and saved checkout detail bindings are mandatory. */
export function createPostgresCheckoutLinkedOrderCreationRepository<V extends 1 | 2>(
  runners: Readonly<{
    query: OrderCreationQueryTransactionRunner;
    write: OrderCreationQueryTransactionRunner;
  }>,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  capacityLink: unknown,
  details: CheckoutDetailsSnapshot,
  quoteVersion: V,
) {
  return createPostgresCapacityLinkedOrderCreationRepository(
    runners,
    scope,
    capacityLink,
    quoteVersion,
    parseCheckoutDetailsSnapshot(details),
  );
}

/**
 * Request-local pilot repository. Current Identity/CSRF authorization is supplied by
 * the Order application service before reads and commit. Policy is mandatory for new writes.
 */
export function createPostgresCurrentCheckoutOrderCreationRepository<V extends 1 | 2>(
  runners: Readonly<{
    query: OrderCreationQueryTransactionRunner;
    write: OrderCreationQueryTransactionRunner;
  }>,
  scopeValue: Readonly<{ brandReference: string; storeReference: string }>,
  linkValue: unknown,
  quoteVersion: V,
  policy: Readonly<{
    now: () => string;
    policies: CheckoutDetailsPorts["policies"];
    authorization: CapacityLinkedOrderCreationPorts<V>["authorization"] | undefined;
  }>,
  inventoryFinalizer?: OrderSubmissionInventoryFinalizer<V>,
) {
  const link = parseOrderCapacityLink(linkValue);
  const raw = closed(scopeValue, ["brandReference", "storeReference"]);
  const scope = Object.freeze({
    brandReference: parseOrderingReference(raw.brandReference),
    storeReference: parseOrderingReference(raw.storeReference),
  });
  if (scope.brandReference !== link.brandReference || scope.storeReference !== link.storeReference)
    return fail();
  const store = createPostgresCheckoutDetailsStore(runners.query, scope);
  let selected: Promise<CheckoutDetailsSnapshot> | undefined;
  const select = () =>
    (selected ??= (async () => {
      const original = await runners.query.run(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY", []);
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const record = await readOrderCreationHistory(
          tx,
          scope,
          link.submissionReference,
          quoteVersion,
        );
        if (record === null) return null;
        const savedLink = await readCapacityLink(tx, scope, link.submissionReference);
        if (savedLink === null || canonical(savedLink) !== canonical(link)) return fail();
        assertOrderCapacityLinkMatches(link, record);
        const details = await readLinkedDetails(tx, scope, link.submissionReference);
        if (details === null) return fail();
        assertDetailsMatch(details, record, quoteVersion);
        return details;
      });
      const details =
        original ?? (await store.loadLatest(link.cartReference, link.guestSessionReference));
      if (
        details === null ||
        details.brandReference !== scope.brandReference ||
        details.storeReference !== scope.storeReference ||
        details.guestSessionReference !== link.guestSessionReference ||
        details.cartReference !== link.cartReference ||
        details.cartVersion !== link.cartVersion ||
        details.quoteReference !== link.quoteReference ||
        details.quoteVersion !== quoteVersion ||
        details.orderType !== (link.owner === "Dining" ? "DineIn" : "Pickup")
      )
        return fail();
      return details;
    })().catch(() => fail()));
  const repository = async () =>
    createPostgresCheckoutLinkedOrderCreationRepository(
      runners,
      scope,
      link,
      await select(),
      quoteVersion,
    );
  return Object.freeze({
    async resolveSubmission(reference: string) {
      return (await repository()).resolveSubmission(reference);
    },
    async resolveCapacityLink(reference: string) {
      return (await repository()).resolveCapacityLink(reference);
    },
    async resolveCheckoutDetails(reference: string) {
      return (await repository()).resolveCheckoutDetails(reference);
    },
    async commit(input: unknown) {
      try {
        const bound = await repository();
        if ((await bound.resolveSubmission(link.submissionReference)) !== null)
          return await bound.commit(input);
        const details = await select();
        const checkedAt = parseOrderingInstant(policy.now());
        const authorize = async () => {
          if (policy.authorization === undefined) return fail();
          const at = parseOrderingInstant(policy.now());
          const result = await policy.authorization.authorize({
            action: "CreateOrder",
            submissionReference: link.submissionReference,
            cartReference: link.cartReference,
            observedAt: at,
          });
          if (result === null) throw new OrderCreationError("ORDER_CREATE_PERMISSION_DENIED");
          const guest = assertGuestSessionUsable(
            createGuestSession(result.guestSession),
            policy.now(),
          );
          if (
            String(guest.sessionReference) !== link.guestSessionReference ||
            String(guest.brandReference) !== scope.brandReference ||
            String(guest.storeReference) !== scope.storeReference ||
            guest.channel !== details.orderType ||
            String(guest.createdAt) > policy.now() ||
            String(guest.lastSeenAt) > policy.now() ||
            (link.owner === "Dining"
              ? guest.diningState !== "DiningBound" ||
                guest.diningParticipantReference === null ||
                String(guest.diningSessionReference) !== link.ownerContextReference
              : guest.diningState !== "ContextOnly" || guest.diningSessionReference !== null)
          )
            throw new OrderCreationError("ORDER_CREATE_PERMISSION_DENIED");
          return guest;
        };
        const first = await authorize();
        const evidence = await policy.policies.current({
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          orderType: details.orderType,
          observedAt: checkedAt,
        });
        const current = await authorize();
        const identityFields: readonly (keyof GuestSession)[] = [
          "sessionReference",
          "version",
          "brandReference",
          "storeReference",
          "channel",
          "publicStoreReference",
          "publicTableReference",
          "qrReference",
          "qrRevocationVersion",
          "diningState",
          "diningSessionReference",
          "diningParticipantReference",
        ];
        if (identityFields.some((field) => first[field] !== current[field]))
          throw new OrderCreationError("ORDER_CREATE_PERMISSION_DENIED");
        const window = validateCheckoutDetailsPolicy(details, evidence, checkedAt, policy.now());
        return await createPostgresCapacityLinkedOrderCreationRepository(
          runners,
          scope,
          link,
          quoteVersion,
          details,
          window,
          inventoryFinalizer,
        ).commit(input);
      } catch (error) {
        if (error instanceof OrderCreationError) throw error;
        return fail();
      }
    },
  });
}

/**
 * Explicit customer pilot path: current Identity/CSRF and checkout policy checks remain mandatory,
 * with Inventory finalization inside the new Order write transaction.
 */
export function createPostgresInventoryFinalizedOrderCreationRepository<V extends 1 | 2>(
  runners: Readonly<{
    query: OrderCreationQueryTransactionRunner;
    write: OrderCreationQueryTransactionRunner;
  }>,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  capacityLink: unknown,
  quoteVersion: V,
  policy: Parameters<typeof createPostgresCurrentCheckoutOrderCreationRepository<V>>[4],
  inventory: OrderSubmissionInventoryFinalizer<V>,
) {
  if (!inventory || typeof inventory.finalize !== "function") return fail();
  return createPostgresCurrentCheckoutOrderCreationRepository(
    runners,
    scope,
    capacityLink,
    quoteVersion,
    policy,
    inventory,
  );
}
