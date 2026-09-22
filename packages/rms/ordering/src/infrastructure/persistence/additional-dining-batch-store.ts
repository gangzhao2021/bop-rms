import { createPostgresDiningOrderPreparationSource } from "./order-termination-store.js";
import { parseOrderSubmittedEnvelope } from "../../application/order-submitted-event.js";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { validateCheckoutDetailsPolicy } from "../../application/checkout-details-policy.js";
import { parseCheckoutDetailsSnapshot } from "../../domain/checkout-details.js";
import { parseCheckoutSession } from "../../domain/checkout-session.js";
import type { CartAggregate } from "../../domain/cart.js";
import type { CheckoutValidationEvidence } from "../../domain/checkout-validation.js";
import {
  parseOrderCapacityLink,
  type OrderCapacityLink,
} from "../../domain/order-capacity-link.js";
import {
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
} from "../../domain/checkout-validation.js";
import {
  createOrderItemSnapshots,
  createConfiguredOrderItemSnapshots,
} from "../../domain/order-item-snapshot.js";
import { createPostgresCartQueryStore } from "./cart-query-store.js";
import { clearSubmittedDiningCart } from "../../domain/dining-cart-continuation.js";
import { assertCartLifecycleActive } from "../../domain/cart-lifecycle.js";
import { createHash } from "node:crypto";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import {
  parseAdditionalDiningBatchSnapshot,
  type AdditionalDiningBatchSnapshot,
} from "../../domain/additional-dining-batch.js";
import {
  encodeAdditionalDiningBatchSnapshot,
  decodeAdditionalDiningBatchSnapshot,
} from "../../domain/additional-dining-batch-codec.js";
import {
  encodeOrderItemSnapshot,
  encodeConfiguredOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";

/** Internal persistence boundary for composition; not wired to a request.
 * Final composition must hold Identity/Dining Host, Checkout, Cart, Inventory
 * and settlement fences and atomically append the approved Audit/Event contracts.
 * Schema expansion and actual database acceptance are required before activation.
 */
export class AdditionalDiningBatchStoreError extends Error {
  readonly code = "ADDITIONAL_DINING_BATCH_STORE_UNAVAILABLE";
  constructor() {
    super("additional Dining batch persistence is unavailable");
  }
}
const fail = (): never => {
  throw new AdditionalDiningBatchStoreError();
};
export function createPostgresAdditionalDiningBatchStore(options: {
  brandReference: string;
  storeReference: string;
  /** Supplies identifiers and retention metadata; owner validates and appends. */
  audit(snapshot: AdditionalDiningBatchSnapshot): Promise<unknown>;
  eventReference(snapshot: AdditionalDiningBatchSnapshot): string;
  /** Current Store-owned policy source, bound to this transaction and its locks. */
  currentPolicies(
    transaction: ConsumerTransaction,
    request: Readonly<{
      brandReference: string;
      storeReference: string;
      orderType: "DineIn";
      observedAt: string;
    }>,
  ): Promise<unknown>;
  authorize(
    transaction: ConsumerTransaction,
    snapshot: AdditionalDiningBatchSnapshot,
  ): Promise<boolean>;
  /** Mandatory owner composition: revalidate all current gates, finalize inventory,
   * bind checkout/settlement evidence, append Audit
   * and published event, all using this transaction. No external calls.
   */
  finalize(
    transaction: ConsumerTransaction,
    snapshot: AdditionalDiningBatchSnapshot,
    capacityLink: OrderCapacityLink,
    context: Readonly<{
      cart: CartAggregate;
      checkoutValidationEvidence: CheckoutValidationEvidence<1 | 2>;
      observedAt: string;
    }>,
  ): Promise<void>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  if (
    typeof options.authorize !== "function" ||
    typeof options.finalize !== "function" ||
    typeof options.currentPolicies !== "function" ||
    typeof options.audit !== "function" ||
    typeof options.eventReference !== "function"
  )
    return fail();
  return Object.freeze({
    async append(input: {
      transaction: ConsumerTransaction;
      snapshot: unknown;
      checkoutValidationEvidence: unknown;
      capacityLink: unknown;
    }) {
      const snapshot = parseAdditionalDiningBatchSnapshot(input.snapshot);
      const encoded = encodeAdditionalDiningBatchSnapshot(snapshot);
      const tx = input.transaction;
      const batch = snapshot.batch;
      if (snapshot.brandReference !== brand || snapshot.storeReference !== store) return fail();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      if ((await options.authorize(tx, snapshot)) !== true) return fail();
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingOrderDisposition:" + brand + ":" + store + ":" + snapshot.orderReference,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingAdditionalSubmission:" + brand + ":" + store + ":" + batch.submissionReference,
      ]);
      const prior = await tx.query(
        "SELECT snapshot_json::text AS snapshot FROM rms_ordering.additional_dining_batch_record WHERE brand_id=$1 AND store_id=$2 AND submission_id=$3 LIMIT 2",
        [brand, store, batch.submissionReference],
      );
      if (prior.rows.length > 1) return fail();
      if (prior.rows.length === 1) {
        const original = decodeAdditionalDiningBatchSnapshot(prior.rows[0]?.snapshot);
        if (encodeAdditionalDiningBatchSnapshot(original) !== encoded) return fail();
        return Object.freeze({ status: "Existing" as const, snapshot: original });
      }
      const parent = await tx.query(
        "SELECT h.order_type,h.dining_session_id,h.created_at,h.closure_status,r.revision_id,r.version,r.kind,r.occurred_at," +
          "(SELECT count(*)::int FROM rms_ordering.order_batch b WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=h.order_id) AS batch_count " +
          "FROM rms_ordering.order_header h JOIN rms_ordering.order_revision r ON r.order_id=h.order_id AND r.brand_id=h.brand_id AND r.store_id=h.store_id " +
          "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 ORDER BY r.version DESC LIMIT 1 FOR SHARE OF h",
        [brand, store, snapshot.orderReference],
      );
      const row = parent.rows[0];
      const instant = (value: unknown) =>
        parseOrderingInstant(value instanceof Date ? value.toISOString() : value);
      if (
        parent.rows.length !== 1 ||
        !row ||
        row.order_type !== "DineIn" ||
        row.dining_session_id !== snapshot.diningSessionReference ||
        row.closure_status !== "Open" ||
        instant(row.created_at) !== snapshot.originalOrderCreatedAt ||
        row.version !== snapshot.expectedOrderVersion ||
        row.batch_count !== snapshot.batchSequence - 1 ||
        typeof row.kind !== "string" ||
        !["Initial", "AdditionalBatch", "Acceptance"].includes(row.kind) ||
        instant(row.occurred_at) > batch.submittedAt
      )
        return fail();
      const previousRevision = parseOrderingReference(row.revision_id);
      const capacityLink = parseOrderCapacityLink(input.capacityLink);
      if (
        capacityLink.owner !== "Dining" ||
        capacityLink.ownerContextReference !== snapshot.diningSessionReference ||
        capacityLink.brandReference !== brand ||
        capacityLink.storeReference !== store ||
        capacityLink.orderReference !== snapshot.orderReference ||
        capacityLink.orderBatchReference !== batch.orderBatchReference ||
        capacityLink.submissionReference !== batch.submissionReference ||
        capacityLink.cartReference !== batch.sourceCartReference ||
        capacityLink.cartVersion !== batch.sourceCartVersion ||
        capacityLink.quoteReference !== batch.quoteReference ||
        capacityLink.guestSessionReference !== snapshot.guestSessionReference ||
        batch.submittedAt < capacityLink.preparedAt ||
        batch.submittedAt >= capacityLink.validUntil
      )
        return fail();

      const evidence = (
        snapshot.snapshotVersion === 2
          ? parseConfiguredCheckoutValidationEvidence
          : parseCheckoutValidationEvidence
      )(input.checkoutValidationEvidence);
      if (
        evidence.validationReference !== batch.checkoutValidationReference ||
        evidence.guestSessionReference !== snapshot.guestSessionReference ||
        evidence.quoteReference !== batch.quoteReference ||
        evidence.orderType !== "DineIn"
      )
        return fail();
      if (
        evidence.fulfillment.evidenceReference !== capacityLink.commitmentReference ||
        evidence.fulfillment.evidenceVersion !== capacityLink.commitmentVersion ||
        evidence.fulfillment.evidenceDigest !== capacityLink.ownerSnapshotDigest ||
        evidence.fulfillment.checkedAt < capacityLink.preparedAt ||
        evidence.fulfillment.validUntil > capacityLink.validUntil ||
        evidence.validUntil > capacityLink.validUntil
      )
        return fail();
      const checkoutRows = await tx.query(
        "SELECT snapshot_json FROM rms_ordering.checkout_session_record WHERE brand_id=$1 AND store_id=$2 AND submission_id=$3 AND guest_session_id=$4 LIMIT 2",
        [brand, store, batch.submissionReference, snapshot.guestSessionReference],
      );
      if (checkoutRows.rows.length !== 1) return fail();
      const checkout = parseCheckoutSession(checkoutRows.rows[0]?.snapshot_json);
      if (
        checkout.submissionReference !== batch.submissionReference ||
        checkout.paymentOperationReference !== capacityLink.paymentOperationReference ||
        checkout.createdAt > batch.submittedAt ||
        JSON.stringify(checkout.validation) !== JSON.stringify(evidence)
      )
        return fail();
      const cartLock = await tx.query(
        "SELECT cart_id FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$4 FOR UPDATE",
        [brand, store, batch.sourceCartReference, batch.sourceCartVersion],
      );
      if (cartLock.rows.length !== 1) return fail();
      const detailRows = await tx.query(
        "SELECT snapshot_json AS snapshot FROM rms_ordering.checkout_details_record WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND guest_session_id=$4 ORDER BY details_version DESC LIMIT 1",
        [brand, store, batch.sourceCartReference, snapshot.guestSessionReference],
      );
      if (detailRows.rows.length !== 1) return fail();
      const details = parseCheckoutDetailsSnapshot(detailRows.rows[0]?.snapshot);
      if (
        details.brandReference !== brand ||
        details.storeReference !== store ||
        details.guestSessionReference !== snapshot.guestSessionReference ||
        details.cartReference !== batch.sourceCartReference ||
        details.cartVersion !== batch.sourceCartVersion ||
        details.quoteReference !== batch.quoteReference ||
        details.quoteVersion !== snapshot.snapshotVersion ||
        details.orderType !== "DineIn" ||
        details.recordedAt > batch.submittedAt
      )
        return fail();
      const cart = await createPostgresCartQueryStore(
        { run: (action) => action(tx) },
        { brandReference: brand, storeReference: store },
      ).load(batch.sourceCartReference);
      if (cart === null) return fail();
      const continuation = clearSubmittedDiningCart({
        cart,
        batch,
        brandReference: brand,
        storeReference: store,
        diningSessionReference: snapshot.diningSessionReference,
        orderReference: snapshot.orderReference,
      });
      const now = async () => {
        const result = await tx.query("SELECT clock_timestamp() AS observed_at", []);
        if (result.rows.length !== 1) return fail();
        const value = result.rows[0]?.observed_at;
        // PostgreSQL clock has microseconds; use the received millisecond UTC instant.
        return instant(value);
      };
      const policyWindow: { validUntil?: string } = {};
      const recheck = async () => {
        const observedAt = await now();
        if (
          observedAt < batch.submittedAt ||
          observedAt < evidence.validatedAt ||
          observedAt >= evidence.validUntil ||
          (policyWindow.validUntil !== undefined && observedAt >= policyWindow.validUntil)
        )
          return fail();
        return observedAt;
      };
      const policyCheckedAt = await recheck();
      const currentPolicies = await options.currentPolicies(tx, {
        brandReference: brand,
        storeReference: store,
        orderType: "DineIn",
        observedAt: policyCheckedAt,
      });
      policyWindow.validUntil = validateCheckoutDetailsPolicy(
        details,
        currentPolicies,
        policyCheckedAt,
        await recheck(),
      ).validUntil;
      assertCartLifecycleActive(cart.lifecycle, await recheck());
      const rebuilt = (
        snapshot.snapshotVersion === 2
          ? createConfiguredOrderItemSnapshots
          : createOrderItemSnapshots
      )({
        orderReference: snapshot.orderReference,
        orderBatchReference: batch.orderBatchReference,
        // Checkout can precede submission. Rebuild the immutable captured facts
        // at their original instant; the encoded comparison also rejects mixed times.
        snapshotCapturedAt: snapshot.items[0]?.snapshotCapturedAt,
        checkoutValidationEvidence: evidence,
        cart,
        lines: snapshot.items.map((item) => ({
          orderItemReference: item.orderItemReference,
          cartItemReference: item.cartItemReference,
          catalog: item.catalog,
          pricing: item.pricing,
        })),
      });
      if (encodeAdditionalDiningBatchSnapshot({ ...snapshot, items: rebuilt }) !== encoded)
        return fail();
      await tx.query("SAVEPOINT ordering_additional_batch", []);
      try {
        const write = async (sql: string, values: readonly unknown[]) => {
          if ((await tx.query(sql, values)).rowCount !== 1) return fail();
        };
        if ((await options.authorize(tx, snapshot)) !== true) return fail();
        // Submission ID is the additional operation identity; the dedicated record
        // retains the full immutable intent for exact replay without a new number.
        await write(
          "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Additional')",
          [
            batch.submissionReference,
            brand,
            store,
            snapshot.orderReference,
            snapshot.guestSessionReference,
            digest(encoded),
            batch.sourceCartReference,
            batch.sourceCartVersion,
            batch.quoteReference,
            batch.submittedAt,
          ],
        );
        await write(
          "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            batch.orderBatchReference,
            brand,
            store,
            snapshot.orderReference,
            batch.submissionReference,
            batch.sourceCartReference,
            batch.sourceCartVersion,
            batch.checkoutValidationReference,
            batch.quoteReference,
            batch.submittedByActorReference,
            batch.submittedAt,
          ],
        );
        for (const [index, item] of snapshot.items.entries()) {
          await write(
            "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)",
            [
              item.orderItemReference,
              brand,
              store,
              snapshot.orderReference,
              batch.orderBatchReference,
              item.cartItemReference,
              item.quantity,
              item.catalog.snapshotDigest,
              item.pricing.quoteInputDigest,
              (snapshot.snapshotVersion === 2
                ? encodeConfiguredOrderItemSnapshot
                : encodeOrderItemSnapshot)(item),
              item.snapshotCapturedAt,
              index + 1,
            ],
          );
        }
        await write(
          "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'AdditionalBatch',$5,$6,$7,NULL,$8)",
          [
            batch.submissionReference,
            brand,
            store,
            snapshot.orderReference,
            snapshot.expectedOrderVersion + 1,
            snapshot.expectedOrderVersion,
            previousRevision,
            batch.submittedAt,
          ],
        );
        await write(
          "INSERT INTO rms_ordering.additional_dining_batch_record (submission_id,brand_id,store_id,order_id,order_batch_id,batch_sequence,snapshot_json) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
          [
            batch.submissionReference,
            brand,
            store,
            snapshot.orderReference,
            batch.orderBatchReference,
            snapshot.batchSequence,
            encoded,
          ],
        );
        await write(
          "INSERT INTO rms_ordering.order_capacity_link (brand_id,store_id,submission_id,order_id,order_batch_id,commitment_id,payment_operation_id,created_at,link_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
          [
            brand,
            store,
            batch.submissionReference,
            snapshot.orderReference,
            batch.orderBatchReference,
            capacityLink.commitmentReference,
            capacityLink.paymentOperationReference,
            batch.submittedAt,
            JSON.stringify(capacityLink),
          ],
        );
        await write(
          "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            brand,
            store,
            batch.submissionReference,
            snapshot.orderReference,
            details.detailsReference,
            details.detailsVersion,
          ],
        );
        const auditInput = readClosedRecord(await options.audit(snapshot), [
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
        const audit = validateAuditRecord(auditInput as never, Date.parse(batch.submittedAt));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "ORDERING_ADDITIONAL_BATCH_SUBMIT" ||
          audit.targetType !== "OrderingOrderBatch" ||
          audit.targetId !== batch.orderBatchReference ||
          audit.reasonCode !== "AUTHORIZED_ADDITIONAL_BATCH_SUBMIT" ||
          audit.occurredAt !== batch.submittedAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted"
        )
          return fail();
        await appendAuditRecordInTransaction(tx, audit);
        await options.finalize(
          tx,
          snapshot,
          capacityLink,
          Object.freeze({
            cart,
            checkoutValidationEvidence: evidence,
            observedAt: await recheck(),
          }),
        );
        await appendEventInTransaction(
          tx,
          parseOrderSubmittedEnvelope({
            eventId: parseOrderingReference(options.eventReference(snapshot)),
            eventType: "OrderSubmitted",
            schemaVersion: 1,
            occurredAt: batch.submittedAt,
            producerModule: "@rms/ordering",
            tenantId: brand,
            storeId: store,
            aggregateType: "Order",
            aggregateId: snapshot.orderReference,
            aggregateVersion: BigInt(snapshot.expectedOrderVersion + 1),
            correlationId: audit.correlationId,
            causationId: batch.submissionReference,
            actor: { type: "System" },
            payload: {
              orderReference: snapshot.orderReference,
              orderBatchReference: batch.orderBatchReference,
              submissionReference: batch.submissionReference,
              sourceSnapshotDigest: digest(encoded),
              itemCount: snapshot.items.length,
              batchSequence: snapshot.batchSequence,
            },
            redactionClassification: "indirect_identifier",
            replayMetadata: { replaySafe: true },
          }),
        );
        const removed = await tx.query(
          "DELETE FROM rms_ordering.cart_line WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3",
          [brand, store, cart.cartReference],
        );
        if (removed.rowCount !== continuation.clearedItemReferences.length) return fail();
        const next = continuation.cart;
        await write(
          "UPDATE rms_ordering.cart SET aggregate_version=$4,updated_at=$5,idle_expires_at=$6 WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 AND aggregate_version=$7",
          [
            brand,
            store,
            cart.cartReference,
            next.aggregateVersion,
            next.updatedAt,
            next.lifecycle?.idleExpiresAt,
            cart.aggregateVersion,
          ],
        );
        assertCartLifecycleActive(next.lifecycle, await recheck());

        if ((await options.authorize(tx, snapshot)) !== true) return fail();
        await tx.query("RELEASE SAVEPOINT ordering_additional_batch", []);
      } catch {
        await tx.query("ROLLBACK TO SAVEPOINT ordering_additional_batch", []);
        await tx.query("RELEASE SAVEPOINT ordering_additional_batch", []);
        return fail();
      }
      return Object.freeze({ status: "Created" as const, snapshot });
    },
  });
}
function digest(value: string): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

/** Immutable additional payment history; current payment readiness is separate. */
export function createPostgresAdditionalDiningBatchHistoryReader(options: {
  brandReference: string;
  storeReference: string;
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorize(
    transaction: ConsumerTransaction,
    scope: {
      brandReference: string;
      storeReference: string;
      submissionReference: string;
    },
  ): Promise<boolean>;
}) {
  const brandReference = parseOrderingReference(options.brandReference);
  const storeReference = parseOrderingReference(options.storeReference);
  async function load(reference: string, borrowed?: ConsumerTransaction) {
    const submissionReference = parseOrderingReference(reference);
    const scope = { brandReference, storeReference, submissionReference };
    const read = async (transaction: ConsumerTransaction) => {
      await transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      if ((await options.authorize(transaction, scope)) !== true) return fail();
      const found = await transaction.query(
        "SELECT a.snapshot_json::text AS snapshot,a.batch_sequence,r.version,s.intent_digest,l.link_json AS link " +
          "FROM rms_ordering.additional_dining_batch_record a " +
          "JOIN rms_ordering.order_submission_record s ON s.submission_id=a.submission_id AND s.brand_id=a.brand_id AND s.store_id=a.store_id AND s.order_id=a.order_id AND s.submission_kind='Additional' " +
          "JOIN rms_ordering.order_revision r ON r.revision_id=a.submission_id AND r.brand_id=a.brand_id AND r.store_id=a.store_id AND r.order_id=a.order_id AND r.kind='AdditionalBatch' " +
          "JOIN rms_ordering.order_capacity_link l ON l.submission_id=a.submission_id AND l.brand_id=a.brand_id AND l.store_id=a.store_id AND l.order_id=a.order_id AND l.order_batch_id=a.order_batch_id " +
          "WHERE a.brand_id=$1 AND a.store_id=$2 AND a.submission_id=$3 LIMIT 2",
        [brandReference, storeReference, submissionReference],
      );
      if ((await options.authorize(transaction, scope)) !== true) return fail();
      if (found.rows.length === 0) return null;
      if (found.rows.length !== 1) return fail();
      const row = found.rows[0];
      if (!row) return fail();
      const snapshot = decodeAdditionalDiningBatchSnapshot(row.snapshot);
      const link = parseOrderCapacityLink(row.link);
      const batch = snapshot.batch;
      if (
        snapshot.brandReference !== brandReference ||
        snapshot.storeReference !== storeReference ||
        batch.submissionReference !== submissionReference ||
        snapshot.batchSequence !== row.batch_sequence ||
        snapshot.expectedOrderVersion + 1 !== row.version ||
        "sha256:" +
          createHash("sha256")
            .update(encodeAdditionalDiningBatchSnapshot(snapshot))
            .digest("hex") !==
          row.intent_digest ||
        link.owner !== "Dining" ||
        link.brandReference !== brandReference ||
        link.storeReference !== storeReference ||
        link.submissionReference !== submissionReference ||
        link.orderReference !== snapshot.orderReference ||
        link.orderBatchReference !== batch.orderBatchReference ||
        link.guestSessionReference !== snapshot.guestSessionReference ||
        link.ownerContextReference !== snapshot.diningSessionReference ||
        link.cartReference !== batch.sourceCartReference ||
        link.cartVersion !== batch.sourceCartVersion ||
        link.quoteReference !== batch.quoteReference ||
        batch.submittedAt < link.preparedAt ||
        batch.submittedAt >= link.validUntil
      )
        return fail();
      return Object.freeze({ snapshot, link });
    };
    return borrowed ? read(borrowed) : options.transactions.run(read);
  }
  return Object.freeze({
    async withCurrentSubmission<T>(
      reference: string,
      at: string,
      action: (
        transaction: ConsumerTransaction,
        snapshot: AdditionalDiningBatchSnapshot,
        link: OrderCapacityLink,
      ) => Promise<T>,
    ): Promise<T | null> {
      const submissionReference = parseOrderingReference(reference);
      const observedAt = parseOrderingInstant(at);
      return options.transactions.run(async (transaction) => {
        const saved = await load(submissionReference, transaction);
        if (!saved) return null;
        const authorityScope = { brandReference, storeReference, submissionReference };
        const parent = await createPostgresDiningOrderPreparationSource({
          brandReference,
          storeReference,
          authorize: (tx) => options.authorize(tx, authorityScope),
        }).resolve({
          transaction,
          brandReference,
          storeReference,
          orderReference: saved.snapshot.orderReference,
          diningSessionReference: saved.snapshot.diningSessionReference,
          guestSessionReference: saved.snapshot.guestSessionReference,
          observedAt,
        });
        if (
          !parent ||
          parent.orderVersion < saved.snapshot.expectedOrderVersion + 1 ||
          saved.snapshot.batch.submittedAt > observedAt
        )
          return null;
        const result = await action(transaction, saved.snapshot, saved.link);
        if ((await options.authorize(transaction, authorityScope)) !== true) return fail();
        return result;
      });
    },
    async resolveSubmission(reference: string) {
      return (await load(reference))?.snapshot ?? null;
    },
    async resolveCapacityLink(reference: string) {
      return (await load(reference))?.link ?? null;
    },
  });
}
