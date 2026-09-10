import { createHash } from "node:crypto";
import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  canonicalizeRfc8785,
} from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import { assertCartLifecycleActive } from "../../domain/cart-lifecycle.js";
import { createOrderNumberAllocation } from "../../domain/order-number.js";
import { OrderCreationError, parseOrderCreationRecord } from "../../domain/order-creation.js";
import { createOrderItemSnapshots } from "../../domain/order-item-snapshot.js";
import { encodeOrderItemSnapshot } from "../../domain/order-item-snapshot-codec.js";
import { parseCheckoutValidationEvidence } from "../../domain/checkout-validation.js";
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
function count(result: unknown): number {
  if (result === null || typeof result !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(result, "rowCount");
  if (!d || !("value" in d) || d.value !== 1) return fail();
  return 1;
}
const hash = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const canonical = (value: unknown) =>
  canonicalizeRfc8785(
    JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    ),
  );

/** Internal authorized owner transaction. No Provider, Guest authorization or cross-owner capacity acquisition. */
export function createPostgresOrderCreationStore(
  runner: OrderCreationQueryTransactionRunner,
  scope: unknown,
) {
  const fixed = closed(scope, ["brandReference", "storeReference"]);
  const brandReference = parseOrderingReference(fixed.brandReference),
    storeReference = parseOrderingReference(fixed.storeReference);
  const scoped = Object.freeze({ brandReference, storeReference });
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
          const record = parseOrderCreationRecord({
            ...provisional,
            orderNumberAllocation: allocation,
          });
          const b = record.order.batches[0];
          const evidence = parseCheckoutValidationEvidence(raw.checkoutValidationEvidence);
          validateOrderSubmissionWriteFence({
            record,
            businessDateResolution: allocation.businessDateResolution,
            checkoutValidationEvidence: evidence,
            observedAt: record.createdAt,
          });
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
          const check = async () => {
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
                  batch.sourceCartVersion,
                  request.record.createdAt,
                  request.evidence.validUntil,
                ],
              ),
            );
            if (result.length !== 1) return fail();
            const row = closed(result[0], ["valid", "observedAt"]);
            if (row.valid !== true) throw expired;
            if (typeof row.observedAt !== "string") return fail();
            validateOrderSubmissionWriteFence({
              record: request.record,
              businessDateResolution: request.resolution,
              checkoutValidationEvidence: request.evidence,
              observedAt: row.observedAt,
            });
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
          const items = createOrderItemSnapshots({
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
          await check();
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
          const seeded = parseOrderCreationRecord({ ...request.record, orderNumberAllocation: n });
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
                encodeOrderItemSnapshot(item),
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
          const saved = await readOrderCreationHistory(tx, scoped, seeded.submissionReference);
          if (saved === null || canonical(saved) !== canonical(seeded)) return fail();
          await check();
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
