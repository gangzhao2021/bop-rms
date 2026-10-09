import { appendFulfillmentCompletion } from "./fulfillment-completion-store.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseCompletePickupHandoffCommand,
  planCompletePickupHandoff,
  PickupHandoffError,
  completePickupHandoffPermission,
  type CompletePickupHandoffCommand,
  type PickupHandoffEffect,
  type PickupInPersonVerificationRecord,
} from "../../contracts/pickup-handoff.js";
import {
  parsePickupProofInstant,
  parsePickupProofReference,
} from "../../contracts/pickup-proof.js";
import {
  planPickupNotCollected,
  type PickupNotCollectedRecord,
} from "../../domain/pickup-not-collected.js";
import { parseReadinessReference } from "../../contracts/fulfillment-readiness.js";
import { encodePickupHandoffRecord } from "../../application/pickup-handoff-record.js";
import { encodePickupProofVerificationRecord } from "../../application/pickup-proof-record.js";
import { createPostgresFulfillmentReadinessStore } from "./fulfillment-readiness-store.js";
import {
  readPickupHandoffHistory,
  readPickupInPersonVerifications,
} from "./pickup-handoff-history.js";
import { readPickupProofHistory } from "./pickup-proof-history.js";
function unavailable(): never {
  throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
}
interface Query {
  readonly transaction: ConsumerTransaction;
  readonly orderReference: string;
  readonly idempotencyReference: string;
}
/** No pooled driver or cross-owner SQL. Caller owns tenant context and outer transaction. */
export function createPostgresPickupHandoffStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly deriveCompletionReference: (kind: "Publication" | "Event", identity: string) => string;
  readonly sha256: (value: string) => string;
  readonly now: () => string;
  readonly authorize: (
    tx: ConsumerTransaction,
    access: {
      readonly access: "Current" | "Recover" | "Complete";
      readonly orderReference: string;
      readonly actorReference: string;
      readonly permission: "fulfillment.pickup.complete";
    },
  ) => Promise<boolean>;
  readonly validateCurrentSource: (
    tx: ConsumerTransaction,
    orderReference: string,
  ) => Promise<boolean>;
  readonly admit: (
    tx: ConsumerTransaction,
    command: CompletePickupHandoffCommand,
  ) => Promise<boolean>;
  readonly appendAudit: (
    tx: ConsumerTransaction,
    audit: (
      | PickupHandoffEffect["audit"]
      | (Omit<PickupHandoffEffect["audit"], "actionCode" | "permission" | "purpose"> & {
          readonly actionCode: "PICKUP_NOT_COLLECTED";
          readonly permission: "ordering.order.cancel";
          readonly purpose: "CloseUncollectedPickup";
        })
    ) & { readonly fulfillmentReference: string },
  ) => Promise<void>;
}) {
  const brand = parsePickupProofReference(options.brandReference),
    store = parsePickupProofReference(options.storeReference),
    actor = parsePickupProofReference(options.actorReference);
  async function authorize(
    tx: ConsumerTransaction,
    order: string,
    access: "Current" | "Recover" | "Complete",
  ) {
    parsePickupProofReference(order);
    if (
      (await options.authorize(tx, {
        access,
        orderReference: order,
        actorReference: actor,
        permission: completePickupHandoffPermission,
      })) !== true
    )
      throw new PickupHandoffError("PICKUP_HANDOFF_PERMISSION_DENIED");
  }
  const reader = createPostgresFulfillmentReadinessStore({
    brandReference: brand,
    storeReference: store,
    sha256: options.sha256,
    now: options.now,
    authorize: async (tx, access) => {
      if (access.access !== "Current") return false;
      await authorize(tx, access.orderReference, "Current");
      return true;
    },
    validateCurrentSource: options.validateCurrentSource,
  });
  async function current(tx: ConsumerTransaction, order: string) {
    const result = await reader.lockPickupHandoffByOrder({
      brandReference: parseReadinessReference(brand),
      storeReference: parseReadinessReference(store),
      orderReference: parseReadinessReference(order),
      transaction: tx,
    });
    if (!result) throw new PickupHandoffError("PICKUP_HANDOFF_NOT_READY");
    return result;
  }
  async function recover(input: Query) {
    const key = parsePickupProofReference(input.idempotencyReference);
    const rows = (
      await input.transaction.query(
        "SELECT o.fulfillment_id,f.order_id FROM rms_fulfillment.pickup_handoff_operation o " +
          "JOIN rms_fulfillment.fulfillment f ON f.brand_id=o.brand_id AND f.store_id=o.store_id AND f.fulfillment_id=o.fulfillment_id " +
          "WHERE o.brand_id=$1 AND o.store_id=$2 AND o.idempotency_id=$3",
        [brand, store, key],
      )
    ).rows;
    if (!rows.length) return null;
    if (rows.length !== 1 || rows[0]?.order_id !== input.orderReference) return unavailable();
    const history = await readPickupHandoffHistory(
      input.transaction,
      brand,
      store,
      parsePickupProofReference(rows[0].fulfillment_id),
    );
    const effect = history.find((e) => e.operation.idempotencyReference === key);
    if (!effect) return unavailable();
    return effect;
  }
  async function insert(
    tx: ConsumerTransaction,
    table:
      | "pickup_handoff_record"
      | "pickup_handoff_item"
      | "pickup_handoff_operation"
      | "pickup_in_person_verification",
    row: Readonly<Record<string, unknown>>,
  ) {
    const columns = Object.keys(row);
    await tx.query(
      "INSERT INTO rms_fulfillment." +
        table +
        " (" +
        columns.join(",") +
        ") VALUES (" +
        columns.map((_, index) => "$" + (index + 1)).join(",") +
        ")",
      columns.map((key) => row[key]),
    );
  }
  async function write(
    tx: ConsumerTransaction,
    effect: PickupHandoffEffect,
    orderReference: string,
    inPerson: PickupInPersonVerificationRecord | null,
  ) {
    const r = effect.record,
      o = effect.operation;
    await tx.query("SAVEPOINT pickup_handoff_write", []);
    try {
      const scope = { brand_id: brand, store_id: store, fulfillment_id: r.fulfillmentReference };
      if (inPerson)
        await insert(tx, "pickup_in_person_verification", {
          ...scope,
          pickup_in_person_verification_id: inPerson.verificationReference,
          verified_by_actor_id: inPerson.verifiedByActorReference,
          identity_check: inPerson.identityCheck,
          reason: inPerson.reason,
          verified_at: inPerson.verifiedAt,
          correlation_id: inPerson.correlationReference,
          data_classification: "IndirectIdentifier",
        });
      await insert(tx, "pickup_handoff_record", {
        ...scope,
        pickup_handoff_id: r.handoffReference,
        pickup_location_id: r.pickupLocationReference,
        pickup_proof_verification_id: inPerson ? null : r.verificationReference,
        pickup_in_person_verification_id: inPerson ? r.verificationReference : null,
        verification_method: r.verificationMethod,
        recipient_type: r.recipientType,
        recipient_display_mask: r.recipientDisplayMask,
        actor_id: r.actorReference,
        device_id: r.deviceReference,
        handed_over_at: r.handedOverAt,
        validation_status: r.validationStatus,
        data_classification: "Confidential",
      });
      for (const item of effect.items)
        await insert(tx, "pickup_handoff_item", {
          ...scope,
          pickup_handoff_id: r.handoffReference,
          fulfillment_item_id: item.fulfillmentItemReference,
          handed_over_quantity: item.quantity,
          cumulative_handed_over_quantity: item.cumulativeHandedOverQuantity,
          data_classification: "IndirectIdentifier",
        });
      await insert(tx, "pickup_handoff_operation", {
        ...scope,
        pickup_handoff_operation_id: o.operationReference,
        pickup_handoff_id: r.handoffReference,
        idempotency_id: o.idempotencyReference,
        correlation_id: o.correlationReference,
        actor_id: r.actorReference,
        aggregate_version_before: o.aggregateVersionBefore.toString(),
        aggregate_version_after: o.aggregateVersionAfter.toString(),
        phase_before: o.phaseBefore,
        phase_after: o.phaseAfter,
        occurred_at: o.occurredAt,
        data_classification: "Confidential",
        handoff_record_json: encodePickupHandoffRecord(effect),
      });
      await options.appendAudit(tx, {
        ...effect.audit,
        fulfillmentReference: r.fulfillmentReference,
      });
      if (effect.nextPhase === "Completed")
        await appendFulfillmentCompletion(tx, {
          effect,
          orderReference,
          sha256: options.sha256,
          deriveReference: options.deriveCompletionReference,
        });
      await tx.query("RELEASE SAVEPOINT pickup_handoff_write", []);
    } catch {
      try {
        await tx.query("ROLLBACK TO SAVEPOINT pickup_handoff_write", []);
        await tx.query("RELEASE SAVEPOINT pickup_handoff_write", []);
      } catch {
        /* Caller rolls back a failed outer transaction. */
      }
      return unavailable();
    }
  }
  async function matchOriginal(
    tx: ConsumerTransaction,
    command: CompletePickupHandoffCommand,
    effect: PickupHandoffEffect,
  ) {
    const r = effect.record,
      o = effect.operation;
    const sameVerification =
      r.verificationMethod === "InPerson"
        ? (await readPickupInPersonVerifications(tx, brand, store, r.fulfillmentReference)).some(
            (v) =>
              v.verificationReference === r.verificationReference &&
              JSON.stringify(v) === JSON.stringify(command.verification),
          )
        : (
            await readPickupProofHistory(tx, brand, store, r.fulfillmentReference)
          ).verifications.some(
            (v) =>
              v.verificationReference === r.verificationReference &&
              command.verification.verificationMethod !== "InPerson" &&
              encodePickupProofVerificationRecord(v) ===
                encodePickupProofVerificationRecord(command.verification),
          );
    const lines = (items: readonly { fulfillmentItemReference: string; quantity: number }[]) =>
      JSON.stringify(
        items
          .map((i) => [i.fulfillmentItemReference, i.quantity])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    if (
      !sameVerification ||
      command.fulfillmentReference !== r.fulfillmentReference ||
      command.brandReference !== r.brandReference ||
      command.storeReference !== r.storeReference ||
      command.actorReference !== r.actorReference ||
      command.pickupLocationReference !== r.pickupLocationReference ||
      command.deviceReference !== r.deviceReference ||
      command.recipientType !== r.recipientType ||
      command.recipientDisplayMask !== r.recipientDisplayMask ||
      command.handoffReference !== r.handoffReference ||
      command.handedOverAt !== r.handedOverAt ||
      command.operationReference !== o.operationReference ||
      command.idempotencyReference !== o.idempotencyReference ||
      command.correlationReference !== o.correlationReference ||
      command.auditReference !== effect.audit.auditReference ||
      command.expectedAggregateVersion !== o.aggregateVersionBefore ||
      lines(command.quantities) !== lines(effect.items)
    )
      throw new PickupHandoffError("PICKUP_HANDOFF_VERSION_CONFLICT");
    return { status: "AlreadyApplied" as const, effect };
  }
  return {
    async lockByOrder(input: { transaction: ConsumerTransaction; orderReference: string }) {
      await authorize(input.transaction, input.orderReference, "Current");
      return current(input.transaction, input.orderReference);
    },
    async resolveByIdempotency(input: Query) {
      await authorize(input.transaction, input.orderReference, "Recover");
      return recover(input);
    },
    /**
     * WP-2423: closes a ready pickup nobody collected after the pickup hold, with no valid code.
     * The caller authorizes the staff member (a cancellation permission); no refund happens here.
     */
    async closeUncollected(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      expectedAggregateVersion: bigint;
      notCollectedReference: string;
      idempotencyReference: string;
      correlationReference: string;
      closedAt: string;
    }): Promise<{ status: "Applied" | "AlreadyApplied"; record: PickupNotCollectedRecord }> {
      const tx = input.transaction;
      await authorize(tx, input.orderReference, "Complete");
      const key = parsePickupProofReference(input.idempotencyReference);
      const replay = async () => {
        const rows = (
          await tx.query(
            "SELECT n.*,f.order_id FROM rms_fulfillment.pickup_not_collected_record n " +
              "JOIN rms_fulfillment.fulfillment f ON f.brand_id=n.brand_id AND f.store_id=n.store_id AND f.fulfillment_id=n.fulfillment_id " +
              "WHERE n.brand_id=$1 AND n.store_id=$2 AND n.idempotency_id=$3",
            [brand, store, key],
          )
        ).rows;
        if (!rows.length) return null;
        const row = rows[0];
        if (rows.length !== 1 || !row || row.order_id !== input.orderReference)
          return unavailable();
        const at = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
        return Object.freeze({
          status: "AlreadyApplied" as const,
          record: Object.freeze({
            notCollectedReference: String(row.pickup_not_collected_id),
            fulfillmentReference: String(row.fulfillment_id),
            brandReference: brand,
            storeReference: store,
            actorReference: String(row.actor_id),
            reason: "NotCollected" as const,
            readyAt: String(at(row.ready_at)),
            closedAt: String(at(row.closed_at)),
            idempotencyReference: key,
            correlationReference: String(row.correlation_id),
            aggregateVersionBefore: BigInt(String(row.aggregate_version_before)),
          }),
        });
      };
      const prior = await replay();
      if (prior) return prior;
      const state = await current(tx, input.orderReference);
      const again = await replay();
      if (again) return again;
      const record = planPickupNotCollected({
        source: state.source,
        readyAt: String(state.readyAt),
        proofExpiresAt: state.capability ? String(state.capability.expiresAt) : null,
        alreadyClosed: state.notCollected,
        expectedAggregateVersion: input.expectedAggregateVersion,
        actorReference: actor,
        notCollectedReference: input.notCollectedReference,
        idempotencyReference: key,
        correlationReference: input.correlationReference,
        closedAt: input.closedAt,
      });
      await tx.query("SAVEPOINT pickup_not_collected_write", []);
      try {
        await tx.query(
          "INSERT INTO rms_fulfillment.pickup_not_collected_record (pickup_not_collected_id,brand_id,store_id," +
            "fulfillment_id,actor_id,reason,ready_at,closed_at,idempotency_id,correlation_id,aggregate_version_before," +
            "data_classification) VALUES ($1,$2,$3,$4,$5,'NotCollected',$6,$7,$8,$9,$10,'IndirectIdentifier')",
          [
            record.notCollectedReference,
            brand,
            store,
            record.fulfillmentReference,
            record.actorReference,
            record.readyAt,
            record.closedAt,
            record.idempotencyReference,
            record.correlationReference,
            record.aggregateVersionBefore.toString(),
          ],
        );
        await options.appendAudit(tx, {
          auditReference: parsePickupProofReference(record.notCollectedReference),
          actorReference: parsePickupProofReference(record.actorReference),
          actionCode: "PICKUP_NOT_COLLECTED",
          permission: "ordering.order.cancel",
          purpose: "CloseUncollectedPickup",
          correlationReference: parsePickupProofReference(record.correlationReference),
          dataClassification: "Confidential",
          occurredAt: parsePickupProofInstant(record.closedAt),
          fulfillmentReference: record.fulfillmentReference,
        });
        await tx.query("RELEASE SAVEPOINT pickup_not_collected_write", []);
      } catch {
        try {
          await tx.query("ROLLBACK TO SAVEPOINT pickup_not_collected_write", []);
          await tx.query("RELEASE SAVEPOINT pickup_not_collected_write", []);
        } catch {
          /* Caller rolls back a failed outer transaction. */
        }
        return unavailable();
      }
      return { status: "Applied", record };
    },
    async complete(input: {
      transaction: ConsumerTransaction;
      orderReference: string;
      command: unknown;
    }) {
      const command = parseCompletePickupHandoffCommand(input.command),
        tx = input.transaction;
      if (
        command.brandReference !== brand ||
        command.storeReference !== store ||
        command.actorReference !== actor
      )
        return unavailable();
      if (!command.actorPermissions.includes(completePickupHandoffPermission))
        throw new PickupHandoffError("PICKUP_HANDOFF_PERMISSION_DENIED");
      await authorize(tx, input.orderReference, "Complete");
      const query = { ...input, idempotencyReference: command.idempotencyReference };
      let prior = await recover(query);
      if (prior) return matchOriginal(tx, command, prior);
      if ((await options.admit(tx, command)) !== true)
        throw new PickupHandoffError("PICKUP_HANDOFF_PERMISSION_DENIED");
      const state = await current(tx, input.orderReference);
      prior = await recover(query);
      if (prior) return matchOriginal(tx, command, prior);
      if (state.notCollected) throw new PickupHandoffError("PICKUP_HANDOFF_ALREADY_COMPLETED");
      const submitted = command.verification;
      if (
        command.handedOverAt > state.source.lockedAt ||
        command.handedOverAt < state.lastHandoffAt
      )
        throw new PickupHandoffError("PICKUP_HANDOFF_VERIFICATION_FAILED");
      let inPerson: PickupInPersonVerificationRecord | null = null;
      if (submitted.verificationMethod === "InPerson") {
        // WP-2423: in person only when no usable proof exists: never issued, or expired by now.
        const notIssued = state.capability === null;
        const expired =
          state.capability !== null &&
          String(state.source.lockedAt) >= String(state.capability.expiresAt);
        if (
          !(notIssued || expired) ||
          (submitted.reason === "ProofNotIssued") !== notIssued ||
          submitted.verifiedAt > state.source.lockedAt ||
          state.inPerson.some((v) => v.verificationReference === submitted.verificationReference)
        )
          throw new PickupHandoffError("PICKUP_HANDOFF_VERIFICATION_FAILED");
        inPerson = submitted;
      } else {
        const verification = state.verifications.find(
          (v) => v.verificationReference === submitted.verificationReference,
        );
        if (
          !verification ||
          !state.capability ||
          encodePickupProofVerificationRecord(verification) !==
            encodePickupProofVerificationRecord(submitted) ||
          String(state.source.lockedAt) >= String(state.capability.expiresAt) ||
          String(command.handedOverAt) >= String(state.capability.expiresAt)
        )
          throw new PickupHandoffError("PICKUP_HANDOFF_VERIFICATION_FAILED");
      }
      const effect = planCompletePickupHandoff(state.source, command);
      await write(tx, effect, input.orderReference, inPerson);
      return { status: "Applied" as const, effect };
    },
  };
}
