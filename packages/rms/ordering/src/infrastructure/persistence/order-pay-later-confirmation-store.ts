import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  appendEventInTransaction,
  loadOutboxEnvelope,
  type ConsumerTransaction,
} from "@bop/eventing";
import {
  createPayLaterOrderConfirmedEnvelope,
  OrderPayLaterConfirmationError,
  parseOrderPayLaterConfirmation,
  type OrderPayLaterConfirmation,
} from "../../application/order-pay-later-confirmation.js";
import { parseOrderConfirmedEnvelope } from "../../application/order-confirmed-event.js";
import { orderCreatedSourceInput } from "../../application/order-created-source.js";
import { encodeAdditionalDiningBatchSnapshot } from "../../domain/additional-dining-batch-codec.js";
import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
} from "../../domain/cart.js";
import {
  decodeConfiguredOrderItemSnapshot,
  decodeOrderItemSnapshot,
} from "../../domain/order-item-snapshot-codec.js";
import { createPostgresAdditionalDiningExecutionReader } from "./additional-dining-execution-reader.js";
import { createPostgresOrderCreationQueryStore } from "./order-creation-query-store.js";
import { acquireOrderDispositionFence } from "./order-termination-store.js";

/** The published workflow's Accept transition the automatic acceptance goes through. */
export interface PayLaterAcceptancePolicy {
  readonly workflowVersionReference: string;
  readonly transitionReference: string;
  readonly purposeCode: string;
  readonly permissionCode: string;
}

const fail = (
  code:
    | "ORDER_PAY_LATER_NOT_PAY_LATER"
    | "ORDER_PAY_LATER_CONFLICT"
    | "ORDER_PAY_LATER_UNAVAILABLE" = "ORDER_PAY_LATER_UNAVAILABLE",
): never => {
  throw new OrderPayLaterConfirmationError(code);
};
const instantOf = (value: unknown) =>
  parseOrderingInstant(value instanceof Date ? value.toISOString() : value);
const confirmationColumns =
  'confirmation_id AS "confirmationReference",brand_id AS "brandReference",store_id AS "storeReference",' +
  'order_id AS "orderReference",order_batch_id AS "orderBatchReference",submission_id AS "submissionReference",' +
  'dining_session_id AS "diningSessionReference",acceptance_id AS "acceptanceReference",' +
  'accepted_order_version AS "acceptedOrderVersion",operation_id AS "operationReference",' +
  'source_snapshot_digest AS "sourceSnapshotDigest",order_confirmed_event_id AS "orderConfirmedEventReference",' +
  'confirmed_at AS "confirmedAt"';
const row = (value: Record<string, unknown> | undefined) =>
  value === undefined
    ? null
    : parseOrderPayLaterConfirmation({ ...value, confirmedAt: instantOf(value.confirmedAt) });

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: send a round of a pay-later table to the kitchen. In the caller's
 * transaction and under the Order's disposition fence: the round is the table's, nothing paid,
 * accepted, cancelled or terminated it, and the table was opened pay later (a Dining fact the caller
 * reads in this same transaction). Then the automatic acceptance (System actor, through the
 * published Accept transition), its Order revision, this confirmation and the OrderConfirmed event
 * the kitchen takes, with their audit records — all or nothing. A replay returns the confirmation.
 */
export function createPostgresOrderPayLaterConfirmationStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly quoteVersion: 1 | 2;
  sha256(value: string): string;
  authorize(transaction: ConsumerTransaction): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const scope = { brandReference: brand, storeReference: store };
  const context = (tx: ConsumerTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const allowed = async (tx: ConsumerTransaction) => {
    if ((await options.authorize(tx)) !== true) fail();
  };
  const byBatch = async (tx: ConsumerTransaction, order: string, batch: string) =>
    row(
      (
        await tx.query<Record<string, unknown>>(
          `SELECT ${confirmationColumns} FROM rms_ordering.order_pay_later_confirmation WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4`,
          [brand, store, order, batch],
        )
      ).rows[0],
    );
  return Object.freeze({
    async loadByBatch(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      orderBatchReference: string;
    }): Promise<OrderPayLaterConfirmation | null> {
      const tx = input.transaction;
      await context(tx);
      await allowed(tx);
      return byBatch(
        tx,
        parseOrderingReference(input.orderReference),
        parseOrderingReference(input.orderBatchReference),
      );
    },

    /** The rounds of these Orders sent to the kitchen pay later (Orders, Tables, checkout). */
    async listByOrders(input: {
      transaction: ConsumerTransaction;
      orderReferences: readonly string[];
    }): Promise<readonly OrderPayLaterConfirmation[]> {
      if (input.orderReferences.length > 200) return fail();
      const orders = input.orderReferences.map((value) => parseOrderingReference(value));
      if (orders.length === 0) return Object.freeze([]);
      const tx = input.transaction;
      await context(tx);
      await allowed(tx);
      const found = await tx.query<Record<string, unknown>>(
        `SELECT ${confirmationColumns} FROM rms_ordering.order_pay_later_confirmation WHERE brand_id=$1 AND store_id=$2 AND order_id=ANY($3::uuid[]) ORDER BY confirmed_at LIMIT 5001`,
        [brand, store, orders],
      );
      if (found.rows.length > 5000) return fail();
      return Object.freeze(found.rows.map((value) => row(value) ?? fail()));
    },

    /**
     * What the round of this batch comes to, tax included (the sum of its items' captured prices):
     * what staff see when it goes to the kitchen and what the table owes for it.
     */
    async roundTotalMinor(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      orderBatchReference: string;
    }): Promise<bigint> {
      const tx = input.transaction;
      await context(tx);
      await allowed(tx);
      const batch = parseOrderingReference(input.orderBatchReference);
      const found = await tx.query<Record<string, unknown>>(
        "SELECT i.transaction_snapshot_json AS snapshot,i.transaction_snapshot_json->'pricing'->>'quoteVersion' AS quote_version FROM rms_ordering.order_item i WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 AND i.order_batch_id=$4 LIMIT 1001",
        [brand, store, parseOrderingReference(input.orderReference), batch],
      );
      if (found.rows.length < 1 || found.rows.length > 1000) return fail();
      let total = 0n;
      for (const value of found.rows) {
        if (value.quote_version !== "1" && value.quote_version !== "2") return fail();
        const item = (
          value.quote_version === "2" ? decodeConfiguredOrderItemSnapshot : decodeOrderItemSnapshot
        )(value.snapshot);
        if (item.orderBatchReference !== batch || item.pricing.total.currencyCode !== "CAD")
          return fail();
        total += item.pricing.total.amountMinor;
      }
      return total;
    },

    /** The confirmation and its OrderConfirmed event, for the kitchen and fulfillment sources. */
    async loadConfirmed(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      orderBatchReference: string;
      confirmationReference: string;
      orderConfirmedEventReference: string;
    }) {
      const tx = input.transaction;
      await context(tx);
      const found = await byBatch(
        tx,
        parseOrderingReference(input.orderReference),
        parseOrderingReference(input.orderBatchReference),
      );
      if (
        found === null ||
        found.confirmationReference !== input.confirmationReference ||
        found.orderConfirmedEventReference !== input.orderConfirmedEventReference
      )
        return null;
      const event = parseOrderConfirmedEnvelope(
        await loadOutboxEnvelope(tx, found.orderConfirmedEventReference),
      );
      if (
        event.payload.confirmationReference !== found.confirmationReference ||
        event.payload.sourceSnapshotDigest !== found.sourceSnapshotDigest ||
        event.payload.orderBatchReference !== found.orderBatchReference
      )
        return fail();
      return Object.freeze({ confirmation: found, orderConfirmedEvent: event });
    },

    async confirm(input: {
      transaction: ConsumerTransaction;
      operationReference: string;
      /** The round's submission (the checkout that just submitted it). */
      submissionReference: string;
      observedAt: string;
      correlationReference: string;
      /** Reads in this transaction whether the table was opened pay later (Dining). */
      sessionIsPayLater(diningSessionReference: string): Promise<boolean>;
      /**
       * The published workflow's Accept transition for this Order as it is now (its phase and
       * version), evaluated by the caller with the System gates.
       */
      acceptance(current: {
        readonly orderReference: string;
        readonly currentState: string;
        readonly expectedOrderVersion: number;
        readonly observedAt: string;
      }): Promise<PayLaterAcceptancePolicy>;
      references: { generate(kind: "Acceptance" | "Confirmation" | "Event"): string };
      audit: {
        acceptance(fact: { acceptanceReference: string; orderReference: string }): unknown;
        confirmation(fact: {
          confirmationReference: string;
          orderReference: string;
          orderBatchReference: string;
        }): unknown;
      };
    }): Promise<{
      readonly status: "Confirmed" | "AlreadyConfirmed";
      readonly confirmation: OrderPayLaterConfirmation;
    }> {
      const tx = input.transaction;
      const submitted = parseOrderingReference(input.submissionReference);
      const operation = parseOrderingReference(input.operationReference);
      const at = parseOrderingInstant(input.observedAt);
      await context(tx);
      await allowed(tx);
      const located = (
        await tx.query<Record<string, unknown>>(
          "SELECT order_id,order_batch_id FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND submission_id=$3 LIMIT 2",
          [brand, store, submitted],
        )
      ).rows;
      if (located.length !== 1) return fail();
      const order = parseOrderingReference(located[0]?.order_id);
      const batch = parseOrderingReference(located[0]?.order_batch_id);
      await acquireOrderDispositionFence(tx, { ...scope, orderReference: order });
      const prior = await byBatch(tx, order, batch);
      if (prior !== null) return Object.freeze({ status: "AlreadyConfirmed", confirmation: prior });
      const header = (
        await tx.query<Record<string, unknown>>(
          "SELECT order_type,dining_session_id FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE",
          [brand, store, order],
        )
      ).rows[0];
      if (header === undefined) return fail();
      if (header.order_type !== "DineIn" || header.dining_session_id == null)
        return fail("ORDER_PAY_LATER_NOT_PAY_LATER");
      const session = parseOrderingReference(header.dining_session_id);
      const found = (
        await tx.query<Record<string, unknown>>(
          "SELECT b.submission_id,b.submitted_at,s.submission_kind FROM rms_ordering.order_batch b " +
            "JOIN rms_ordering.order_submission_record s ON s.brand_id=b.brand_id AND s.store_id=b.store_id AND s.order_id=b.order_id AND s.submission_id=b.submission_id " +
            "WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.order_batch_id=$4",
          [brand, store, order, batch],
        )
      ).rows[0];
      if (found === undefined) return fail();
      const submission = parseOrderingReference(found.submission_id);
      if (submission !== submitted) return fail();
      if (instantOf(found.submitted_at) > at) return fail();
      // Anything that already decided this round (a payment, a wait for acceptance, an acceptance,
      // a cancellation or the Order's end) means it is not sent again here.
      const decided = (
        await tx.query<Record<string, unknown>>(
          "SELECT " +
            "EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=$1 AND a.store_id=$2 AND a.order_id=$3 AND a.order_batch_id=$4) " +
            "OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=$3 AND d.order_batch_id=$4) " +
            "OR EXISTS (SELECT 1 FROM rms_ordering.order_payment_acceptance_wait w WHERE w.brand_id=$1 AND w.store_id=$2 AND w.order_id=$3 AND w.order_batch_id=$4) " +
            "OR EXISTS (SELECT 1 FROM rms_ordering.order_batch_checkout_cancellation c WHERE c.brand_id=$1 AND c.store_id=$2 AND c.order_batch_id=$4) " +
            "OR EXISTS (SELECT 1 FROM rms_ordering.order_staff_cancellation x WHERE x.brand_id=$1 AND x.store_id=$2 AND x.order_id=$3 AND x.order_batch_id=$4) " +
            "OR EXISTS (SELECT 1 FROM rms_ordering.order_termination_record t WHERE t.brand_id=$1 AND t.store_id=$2 AND t.order_id=$3) AS decided",
          [brand, store, order, batch],
        )
      ).rows[0]?.decided;
      if (decided !== false) return fail("ORDER_PAY_LATER_CONFLICT");
      if ((await input.sessionIsPayLater(session)) !== true)
        return fail("ORDER_PAY_LATER_NOT_PAY_LATER");
      const version = Number(
        (
          await tx.query<Record<string, unknown>>(
            "SELECT max(version)::integer AS version FROM rms_ordering.order_revision WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
            [brand, store, order],
          )
        ).rows[0]?.version,
      );
      if (!Number.isSafeInteger(version) || version < 1) return fail();
      // The digest of the round's original snapshot, exactly as the kitchen checks it.
      const hash = (value: string) => parseOrderingHash(options.sha256(value));
      let digest;
      let currentState = "Submitted";
      if (found.submission_kind === "Additional") {
        const additional = await createPostgresAdditionalDiningExecutionReader({
          ...scope,
          authorize: (transaction) => options.authorize(transaction),
        }).loadBySubmission({ transaction: tx, submissionReference: submission, observedAt: at });
        if (
          !additional ||
          additional.batchPhase !== "Submitted" ||
          additional.snapshot.batch.orderBatchReference !== batch ||
          additional.orderVersion !== version
        )
          return fail("ORDER_PAY_LATER_CONFLICT");
        digest = hash(encodeAdditionalDiningBatchSnapshot(additional.snapshot));
        currentState = additional.canonicalPhase;
      } else if (found.submission_kind === "Initial") {
        digest = await createPostgresOrderCreationQueryStore(
          { run: async (work) => work(tx) },
          scope,
          options.quoteVersion,
        ).withCurrentSubmission(submission, async (_, record) =>
          record.order.orderReference === order &&
          record.order.batches.some((entry) => entry.orderBatchReference === batch)
            ? hash(
                orderCreatedSourceInput(
                  record,
                  record.orderNumberAllocation.businessDateResolution,
                ),
              )
            : fail(),
        );
        if (digest === null) return fail();
      } else return fail();

      const policy = await input.acceptance({
        orderReference: order,
        currentState,
        expectedOrderVersion: version,
        observedAt: at,
      });
      const acceptanceReference = parseOrderingReference(input.references.generate("Acceptance"));
      const acceptedOrderVersion = version + 1;
      const acceptanceAudit = validateAuditRecord(
        input.audit.acceptance({ acceptanceReference, orderReference: order }),
      );
      if (
        acceptanceAudit.brandId !== brand ||
        acceptanceAudit.storeId !== store ||
        acceptanceAudit.actor.type !== "System" ||
        acceptanceAudit.actionCode !== "ORDER_ACCEPTED" ||
        acceptanceAudit.targetId !== order ||
        acceptanceAudit.occurredAt !== at
      )
        return fail();
      const accepted = await tx.query(
        "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'System',NULL,$9,$10,'PAY_LATER_SENT_TO_KITCHEN',$11,$12,$13,$14)",
        [
          acceptanceReference,
          operation,
          brand,
          store,
          order,
          batch,
          version,
          acceptedOrderVersion,
          policy.purposeCode,
          policy.permissionCode,
          parseOrderingReference(policy.workflowVersionReference),
          parseOrderingReference(policy.transitionReference),
          digest,
          at,
        ],
      );
      if (accepted.rowCount !== 1) return fail("ORDER_PAY_LATER_CONFLICT");
      const revision = await tx.query(
        "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) " +
          "SELECT $4::uuid,$1::uuid,$2::uuid,$3::uuid,'Acceptance',$5::integer,$6::integer,r.revision_id,NULL,$7::timestamptz FROM rms_ordering.order_revision r " +
          "WHERE r.brand_id=$1::uuid AND r.store_id=$2::uuid AND r.order_id=$3::uuid AND r.version=$6::integer AND r.occurred_at<=$7::timestamptz",
        [brand, store, order, acceptanceReference, acceptedOrderVersion, version, at],
      );
      if (revision.rowCount !== 1) return fail("ORDER_PAY_LATER_CONFLICT");
      await appendAuditRecordInTransaction(tx, acceptanceAudit);

      const confirmation = parseOrderPayLaterConfirmation({
        confirmationReference: input.references.generate("Confirmation"),
        brandReference: brand,
        storeReference: store,
        orderReference: order,
        orderBatchReference: batch,
        submissionReference: submission,
        diningSessionReference: session,
        acceptanceReference,
        acceptedOrderVersion,
        operationReference: operation,
        sourceSnapshotDigest: digest,
        orderConfirmedEventReference: input.references.generate("Event"),
        confirmedAt: at,
      });
      const event = createPayLaterOrderConfirmedEnvelope({
        confirmation,
        correlationReference: input.correlationReference,
      });
      const confirmationAudit = validateAuditRecord(
        input.audit.confirmation({
          confirmationReference: confirmation.confirmationReference,
          orderReference: order,
          orderBatchReference: batch,
        }),
      );
      if (
        confirmationAudit.brandId !== brand ||
        confirmationAudit.storeId !== store ||
        confirmationAudit.actor.type !== "System" ||
        confirmationAudit.actionCode !== "ORDER_PAY_LATER_SENT_TO_KITCHEN" ||
        confirmationAudit.targetId !== order ||
        confirmationAudit.occurredAt !== at
      )
        return fail();
      const inserted = await tx.query(
        "INSERT INTO rms_ordering.order_pay_later_confirmation (confirmation_id,brand_id,store_id,order_id,order_batch_id,submission_id,dining_session_id,acceptance_id,accepted_order_version,operation_id,source_snapshot_digest,order_confirmed_event_id,confirmed_at) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          confirmation.confirmationReference,
          brand,
          store,
          order,
          batch,
          submission,
          session,
          acceptanceReference,
          acceptedOrderVersion,
          operation,
          digest,
          confirmation.orderConfirmedEventReference,
          at,
        ],
      );
      if (inserted.rowCount !== 1) return fail("ORDER_PAY_LATER_CONFLICT");
      await appendAuditRecordInTransaction(tx, confirmationAudit);
      await appendEventInTransaction(tx, event);
      await allowed(tx);
      return Object.freeze({ status: "Confirmed", confirmation });
    },
  });
}

/** WP-2423 item 8 ⑤ decisions 5–6: why a guest's round waits for staff. */
export type OrderRoundHoldReason = "FirstOrder" | "PhoneRapid" | "TableRapid";
/** Decision 6: a phone's 4th round, or the table's 7th guest round, within 10 minutes. */
export const orderRoundHoldLimits = Object.freeze({
  windowMinutes: 10,
  phoneRounds: 4,
  tableRounds: 7,
});

export interface OrderRoundHold {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly reason: OrderRoundHoldReason;
  readonly heldAt: string;
  /** Who released it and how; null while it still waits for staff. */
  readonly release: null | {
    readonly outcome: "Confirmed" | "Cancelled";
    readonly actorReference: string;
    readonly releasedAt: string;
  };
}

/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN decisions 5–7: at a table that pays at the end, a guest's
 * round waits for staff before it goes to the kitchen when it is a new phone's first round (the
 * Store's setting), a phone's 4th round or the table's 7th guest round within 10 minutes. The
 * hold is recorded in the caller's transaction; staff then send the round to the kitchen (its
 * pay-later confirmation) or cancel it (the unpaid round cancellation), and the release records
 * who did which. The database refuses either without the release; nothing releases a round
 * automatically. "Phone" is the guest session that submitted the round.
 */
export function createPostgresOrderRoundStaffHoldStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  authorize(transaction: ConsumerTransaction): Promise<boolean>;
}) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const context = (tx: ConsumerTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const allowed = async (tx: ConsumerTransaction) => {
    if ((await options.authorize(tx)) !== true) fail();
  };
  const holdColumns =
    'h.order_id AS "orderReference",h.order_batch_id AS "orderBatchReference",' +
    'h.submission_id AS "submissionReference",h.reason,h.held_at,' +
    'r.outcome,r.actor_id AS "actorReference",r.released_at';
  const holdRow = (value: Record<string, unknown>): OrderRoundHold => {
    const reason = value.reason;
    if (reason !== "FirstOrder" && reason !== "PhoneRapid" && reason !== "TableRapid")
      return fail();
    const outcome = value.outcome;
    if (outcome !== null && outcome !== "Confirmed" && outcome !== "Cancelled") return fail();
    return Object.freeze({
      orderReference: parseOrderingReference(value.orderReference),
      orderBatchReference: parseOrderingReference(value.orderBatchReference),
      submissionReference: parseOrderingReference(value.submissionReference),
      reason,
      heldAt: instantOf(value.held_at),
      release:
        outcome === null
          ? null
          : Object.freeze({
              outcome,
              actorReference: parseOrderingReference(value.actorReference),
              releasedAt: instantOf(value.released_at),
            }),
    });
  };
  const loadHold = async (tx: ConsumerTransaction, order: string, batch: string) => {
    const found = (
      await tx.query<Record<string, unknown>>(
        `SELECT ${holdColumns} FROM rms_ordering.order_round_staff_hold h LEFT JOIN rms_ordering.order_round_staff_hold_release r
          ON r.brand_id=h.brand_id AND r.store_id=h.store_id AND r.order_batch_id=h.order_batch_id
          WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=$3 AND h.order_batch_id=$4`,
        [brand, store, order, batch],
      )
    ).rows;
    return found.length === 0 ? null : holdRow(found[0] ?? fail());
  };
  return Object.freeze({
    /**
     * The round of this guest's submission: its hold if it has one, or whether it must wait for
     * staff now (`reason`, null: it goes straight to the kitchen).
     */
    async evaluate(input: {
      transaction: ConsumerTransaction;
      submissionReference: string;
      guestSessionReference: string;
      observedAt: string;
      firstRoundNeedsStaff: boolean;
    }): Promise<{
      readonly orderReference: string;
      readonly orderBatchReference: string;
      readonly hold: OrderRoundHold | null;
      readonly reason: OrderRoundHoldReason | null;
    }> {
      const tx = input.transaction;
      const submission = parseOrderingReference(input.submissionReference);
      const guest = parseOrderingReference(input.guestSessionReference);
      const at = parseOrderingInstant(input.observedAt);
      await context(tx);
      await allowed(tx);
      const batches = (
        await tx.query<Record<string, unknown>>(
          "SELECT order_id,order_batch_id,submitted_by_actor_id FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND submission_id=$3 LIMIT 2",
          [brand, store, submission],
        )
      ).rows;
      if (batches.length !== 1) return fail();
      const batch = batches[0] ?? fail();
      if (String(batch.submitted_by_actor_id) !== guest) return fail();
      const order = parseOrderingReference(batch.order_id);
      const batchReference = parseOrderingReference(batch.order_batch_id);
      // The Order's disposition fence: two rounds sent at once are counted one after the other.
      await acquireOrderDispositionFence(tx, {
        brandReference: brand,
        storeReference: store,
        orderReference: order,
      });
      const hold = await loadHold(tx, order, batchReference);
      if (hold !== null)
        return Object.freeze({
          orderReference: order,
          orderBatchReference: batchReference,
          hold,
          reason: null,
        });
      const counted = (
        await tx.query<Record<string, unknown>>(
          `SELECT
            count(*) FILTER (WHERE b.submitted_by_actor_id=$4 AND b.order_batch_id<>$5)::int AS phone_before,
            count(*) FILTER (WHERE b.submitted_by_actor_id=$4 AND b.submitted_at>$6::timestamptz-make_interval(mins=>$7))::int AS phone_recent,
            count(*) FILTER (WHERE b.submitted_at>$6::timestamptz-make_interval(mins=>$7)
              AND EXISTS (SELECT 1 FROM rms_ordering.order_item i WHERE i.brand_id=b.brand_id AND i.store_id=b.store_id
                AND i.order_batch_id=b.order_batch_id AND i.transaction_snapshot_json->>'addedByParticipantReference' IS NOT NULL))::int AS table_recent
          FROM rms_ordering.order_batch b WHERE b.brand_id=$1 AND b.store_id=$2 AND b.order_id=$3 AND b.submitted_at<=$6::timestamptz`,
          [brand, store, order, guest, batchReference, at, orderRoundHoldLimits.windowMinutes],
        )
      ).rows[0];
      if (counted === undefined) return fail();
      const reason: OrderRoundHoldReason | null =
        input.firstRoundNeedsStaff && Number(counted.phone_before) === 0
          ? "FirstOrder"
          : Number(counted.phone_recent) >= orderRoundHoldLimits.phoneRounds
            ? "PhoneRapid"
            : Number(counted.table_recent) >= orderRoundHoldLimits.tableRounds
              ? "TableRapid"
              : null;
      await allowed(tx);
      return Object.freeze({
        orderReference: order,
        orderBatchReference: batchReference,
        hold: null,
        reason,
      });
    },

    /** Records that the round waits for staff (in the transaction that evaluated it). */
    async hold(input: {
      transaction: ConsumerTransaction;
      holdReference: string;
      orderReference: string;
      orderBatchReference: string;
      submissionReference: string;
      guestSessionReference: string;
      reason: OrderRoundHoldReason;
      observedAt: string;
    }): Promise<OrderRoundHold> {
      const tx = input.transaction;
      const order = parseOrderingReference(input.orderReference);
      const batch = parseOrderingReference(input.orderBatchReference);
      await context(tx);
      await allowed(tx);
      await tx.query(
        "INSERT INTO rms_ordering.order_round_staff_hold (hold_id,brand_id,store_id,order_id,order_batch_id,submission_id,guest_session_id,reason,held_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          parseOrderingReference(input.holdReference),
          brand,
          store,
          order,
          batch,
          parseOrderingReference(input.submissionReference),
          parseOrderingReference(input.guestSessionReference),
          input.reason,
          parseOrderingInstant(input.observedAt),
        ],
      );
      await allowed(tx);
      return (await loadHold(tx, order, batch)) ?? fail();
    },

    /** The round's hold, or null when it never waited for staff. */
    async load(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      orderBatchReference: string;
    }): Promise<OrderRoundHold | null> {
      const tx = input.transaction;
      await context(tx);
      await allowed(tx);
      return loadHold(
        tx,
        parseOrderingReference(input.orderReference),
        parseOrderingReference(input.orderBatchReference),
      );
    },

    /** The rounds of these Orders that wait for staff now (Tables "needs action"). */
    async listWaiting(input: {
      transaction: ConsumerTransaction;
      orderReferences: readonly string[];
    }): Promise<readonly OrderRoundHold[]> {
      if (input.orderReferences.length > 200) return fail();
      const orders = input.orderReferences.map((value) => parseOrderingReference(value));
      if (orders.length === 0) return Object.freeze([]);
      const tx = input.transaction;
      await context(tx);
      await allowed(tx);
      const found = await tx.query<Record<string, unknown>>(
        `SELECT ${holdColumns} FROM rms_ordering.order_round_staff_hold h LEFT JOIN rms_ordering.order_round_staff_hold_release r
          ON r.brand_id=h.brand_id AND r.store_id=h.store_id AND r.order_batch_id=h.order_batch_id
          WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=ANY($3::uuid[]) AND r.order_batch_id IS NULL
          ORDER BY h.held_at LIMIT 501`,
        [brand, store, orders],
      );
      if (found.rows.length > 500) return fail();
      return Object.freeze(found.rows.map(holdRow));
    },

    /**
     * Staff release a waiting round, in the transaction that sends it to the kitchen or cancels
     * it. The same operation again returns the release; another decision for it is a conflict.
     */
    async release(input: {
      transaction: ConsumerTransaction;
      operationReference: string;
      orderReference: string;
      orderBatchReference: string;
      outcome: "Confirmed" | "Cancelled";
      actorReference: string;
      observedAt: string;
    }): Promise<{
      readonly status: "Released" | "AlreadyReleased";
      readonly hold: OrderRoundHold;
    }> {
      const tx = input.transaction;
      const order = parseOrderingReference(input.orderReference);
      const batch = parseOrderingReference(input.orderBatchReference);
      await context(tx);
      await allowed(tx);
      await acquireOrderDispositionFence(tx, {
        brandReference: brand,
        storeReference: store,
        orderReference: order,
      });
      const current = await loadHold(tx, order, batch);
      if (current === null) return fail("ORDER_PAY_LATER_CONFLICT");
      if (current.release !== null) {
        if (current.release.outcome !== input.outcome) return fail("ORDER_PAY_LATER_CONFLICT");
        return Object.freeze({ status: "AlreadyReleased" as const, hold: current });
      }
      await tx.query(
        "INSERT INTO rms_ordering.order_round_staff_hold_release (operation_id,brand_id,store_id,order_id,order_batch_id,outcome,actor_id,released_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          parseOrderingReference(input.operationReference),
          brand,
          store,
          order,
          batch,
          input.outcome,
          parseOrderingReference(input.actorReference),
          parseOrderingInstant(input.observedAt),
        ],
      );
      await allowed(tx);
      return Object.freeze({
        status: "Released" as const,
        hold: (await loadHold(tx, order, batch)) ?? fail(),
      });
    },
  });
}
