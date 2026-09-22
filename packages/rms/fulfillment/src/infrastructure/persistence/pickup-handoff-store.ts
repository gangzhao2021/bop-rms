import { appendFulfillmentCompletion } from "./fulfillment-completion-store.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseCompletePickupHandoffCommand,
  planCompletePickupHandoff,
  PickupHandoffError,
  completePickupHandoffPermission,
  type CompletePickupHandoffCommand,
  type PickupHandoffEffect,
} from "../../contracts/pickup-handoff.js";
import { parsePickupProofReference } from "../../contracts/pickup-proof.js";
import { parseReadinessReference } from "../../contracts/fulfillment-readiness.js";
import { encodePickupHandoffRecord } from "../../application/pickup-handoff-record.js";
import { encodePickupProofVerificationRecord } from "../../application/pickup-proof-record.js";
import { createPostgresFulfillmentReadinessStore } from "./fulfillment-readiness-store.js";
import { readPickupHandoffHistory } from "./pickup-handoff-history.js";
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
    audit: PickupHandoffEffect["audit"] & { readonly fulfillmentReference: string },
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
    table: "pickup_handoff_record" | "pickup_handoff_item" | "pickup_handoff_operation",
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
  ) {
    const r = effect.record,
      o = effect.operation;
    await tx.query("SAVEPOINT pickup_handoff_write", []);
    try {
      const scope = { brand_id: brand, store_id: store, fulfillment_id: r.fulfillmentReference };
      await insert(tx, "pickup_handoff_record", {
        ...scope,
        pickup_handoff_id: r.handoffReference,
        pickup_location_id: r.pickupLocationReference,
        pickup_proof_verification_id: r.verificationReference,
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
    const history = await readPickupProofHistory(tx, brand, store, r.fulfillmentReference);
    const verification = history.verifications.find(
      (v) => v.verificationReference === r.verificationReference,
    );
    const lines = (items: readonly { fulfillmentItemReference: string; quantity: number }[]) =>
      JSON.stringify(
        items
          .map((i) => [i.fulfillmentItemReference, i.quantity])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    if (
      !verification ||
      encodePickupProofVerificationRecord(verification) !==
        encodePickupProofVerificationRecord(command.verification) ||
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
      const verification = state.verifications.find(
        (v) => v.verificationReference === command.verification.verificationReference,
      );
      if (
        !verification ||
        encodePickupProofVerificationRecord(verification) !==
          encodePickupProofVerificationRecord(command.verification) ||
        String(state.source.lockedAt) >= String(state.capability.expiresAt) ||
        String(command.handedOverAt) >= String(state.capability.expiresAt) ||
        command.handedOverAt > state.source.lockedAt ||
        command.handedOverAt < state.lastHandoffAt
      )
        throw new PickupHandoffError("PICKUP_HANDOFF_VERIFICATION_FAILED");
      const effect = planCompletePickupHandoff(state.source, command);
      await write(tx, effect, input.orderReference);
      return { status: "Applied" as const, effect };
    },
  };
}
