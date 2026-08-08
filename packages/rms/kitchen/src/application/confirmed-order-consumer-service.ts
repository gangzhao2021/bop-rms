import {
  consumeEventInTransaction,
  ConsumerTransactionRollback,
  type ConsumerOutcome,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import type { OrderConfirmedEnvelope } from "@rms/ordering";

import {
  confirmedOrderConsumerName,
  confirmedOrderConsumerVersion,
  ConfirmedOrderIntakeError,
  type ConfirmedOrderIntakeReceipt,
  type ConfirmedOrderIntakeResult,
} from "../contracts/confirmed-order-intake.js";
import {
  confirmedOrderReceiptsMatchExact,
  confirmedOrderReceiptsMatchSemantic,
  createConfirmedOrderIntakeReceipt,
  createConfirmedOrderSemanticEventBinding,
  parseConfirmedOrderIntakeReceipt,
  parseConfirmedOrderSourceEvent,
  parseKitchenDigest,
  parseKitchenInstant,
  parseKitchenReference,
} from "./confirmed-order-intake.js";
import type {
  ConfirmedOrderConsumerPorts,
  ConfirmedOrderIntakeCommit,
  ConfirmedOrderIntakeResolution,
} from "./ports/confirmed-order-consumer-ports.js";

function fail(
  code:
    | "KITCHEN_CONFIRMED_ORDER_PERMISSION_DENIED"
    | "KITCHEN_CONFIRMED_ORDER_CONFLICT"
    | "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE",
): never {
  throw new ConfirmedOrderIntakeError(code);
}

function dependency(): never {
  return fail("KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE");
}

function conflict(): never {
  return fail("KITCHEN_CONFIRMED_ORDER_CONFLICT");
}

function portSnapshot(value: unknown): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return dependency();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.some((key) => {
        if (typeof key !== "string") return true;
        const descriptor = descriptors[key];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    )
      return dependency();
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => {
          if (typeof key !== "string") return dependency();
          return [key, descriptors[key]?.value];
        }),
      ),
    );
  } catch (error) {
    if (error instanceof ConfirmedOrderIntakeError) throw error;
    return dependency();
  }
}

function exactPortSnapshot(
  snapshot: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): void {
  const keys = Reflect.ownKeys(snapshot);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return dependency();
}

function parseResolution(value: unknown): ConfirmedOrderIntakeResolution {
  const raw = portSnapshot(value);
  const status = raw.status;
  if (status === "NotFound" || status === "Conflict") {
    exactPortSnapshot(raw, ["status"]);
    return Object.freeze({ status });
  }
  if (status !== "Resolved") return dependency();
  exactPortSnapshot(raw, ["status", "receipt"]);
  return Object.freeze({ status: "Resolved" as const, receipt: raw.receipt });
}

function parseCommit(value: unknown): ConfirmedOrderIntakeCommit {
  const raw = portSnapshot(value);
  const status = raw.status;
  if (status === "Conflict") {
    exactPortSnapshot(raw, ["status"]);
    return Object.freeze({ status });
  }
  if (status !== "Created" && status !== "AlreadyAccepted") return dependency();
  exactPortSnapshot(raw, ["status", "receipt"]);
  return Object.freeze({ status, receipt: raw.receipt });
}

function portReceipt(value: unknown): ConfirmedOrderIntakeReceipt {
  try {
    return parseConfirmedOrderIntakeReceipt(value);
  } catch {
    return dependency();
  }
}

export function createConfirmedOrderConsumerService(ports: ConfirmedOrderConsumerPorts) {
  async function authorize(event: OrderConfirmedEnvelope): Promise<void> {
    let authorized: boolean;
    try {
      authorized = await ports.authorization.authorize({
        action: "ConsumeConfirmedOrder",
        purpose: "CreateKitchenIntake",
        brandReference: parseKitchenReference(event.tenantId),
        storeReference: parseKitchenReference(event.storeId),
        orderReference: parseKitchenReference(event.payload.orderReference),
        orderBatchReference: parseKitchenReference(event.payload.orderBatchReference),
        confirmationReference: parseKitchenReference(event.payload.confirmationReference),
        sourceEventReference: parseKitchenReference(event.eventId),
        observedAt: parseKitchenInstant(event.occurredAt),
      });
    } catch {
      return dependency();
    }
    if (authorized !== true) return fail("KITCHEN_CONFIRMED_ORDER_PERMISSION_DENIED");
  }

  function attemptedReceipt(event: OrderConfirmedEnvelope): ConfirmedOrderIntakeReceipt {
    try {
      const semanticEventBindingDigest = parseKitchenDigest(
        ports.digests.sha256(createConfirmedOrderSemanticEventBinding(event)),
      );
      return createConfirmedOrderIntakeReceipt({ sourceEvent: event, semanticEventBindingDigest });
    } catch {
      return dependency();
    }
  }

  async function resolveByIdentity(
    attempted: ConfirmedOrderIntakeReceipt,
    transaction: ConsumerTransaction,
  ): Promise<
    | { readonly status: "NotFound" }
    | { readonly status: "Resolved"; readonly receipt: ConfirmedOrderIntakeReceipt }
  > {
    let result: ConfirmedOrderIntakeResolution;
    try {
      result = parseResolution(
        await ports.intakes.resolveByIdentity({
          brandReference: attempted.brandReference,
          storeReference: attempted.storeReference,
          sourceEventReference: attempted.sourceEventReference,
          confirmationReference: attempted.confirmationReference,
          orderBatchReference: attempted.orderBatchReference,
          transaction,
        }),
      );
    } catch (error) {
      if (error instanceof ConfirmedOrderIntakeError) throw error;
      return dependency();
    }
    if (result.status === "Conflict") return conflict();
    if (result.status === "NotFound") return Object.freeze({ status: "NotFound" as const });
    const receipt = portReceipt(result.receipt);
    if (!confirmedOrderReceiptsMatchSemantic(attempted, receipt)) return conflict();
    return Object.freeze({ status: "Resolved" as const, receipt });
  }

  async function processAuthorized(
    attempted: ConfirmedOrderIntakeReceipt,
    transaction: ConsumerTransaction,
  ): Promise<ConfirmedOrderIntakeResult> {
    let committed: ConfirmedOrderIntakeCommit;
    try {
      committed = parseCommit(await ports.intakes.accept({ receipt: attempted, transaction }));
    } catch (error) {
      if (error instanceof ConfirmedOrderIntakeError) throw error;
      return dependency();
    }
    if (committed.status === "Conflict") return conflict();
    const receipt = portReceipt(committed.receipt);
    if (committed.status === "Created") {
      if (!confirmedOrderReceiptsMatchExact(attempted, receipt)) return dependency();
      return Object.freeze({ status: "Accepted" as const, receipt });
    }
    if (!confirmedOrderReceiptsMatchSemantic(attempted, receipt)) return conflict();
    return Object.freeze({ status: "AlreadyAccepted" as const, receipt });
  }

  function handlerFailure(error: unknown) {
    if (
      error instanceof ConfirmedOrderIntakeError &&
      error.code !== "KITCHEN_CONFIRMED_ORDER_DEPENDENCY_UNAVAILABLE"
    )
      return {
        status: "rejected" as const,
        errorCode: "CONSUMER_REJECTED" as const,
      };
    return {
      status: "retry_required" as const,
      errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
    };
  }

  const registration: ConsumerRegistration = Object.freeze({
    consumerName: confirmedOrderConsumerName,
    consumerVersion: confirmedOrderConsumerVersion,
    eventType: "OrderConfirmed",
    schemaVersions: Object.freeze([1]),
    ownerModule: "@rms/kitchen",
    tenantScope: "store",
    ordering: "none",
    sideEffect: "accept_confirmed_order",
    replaySafe: true,
    handler: async ({ envelope, transaction }: Parameters<ConsumerRegistration["handler"]>[0]) => {
      try {
        const event = parseConfirmedOrderSourceEvent(envelope);
        await authorize(event);
        const result = await processAuthorized(attemptedReceipt(event), transaction);
        void result;
        return { status: "completed" as const };
      } catch (error) {
        return handlerFailure(error);
      }
    },
  });

  return Object.freeze({
    registration,
    async consume(
      transaction: ConsumerTransaction,
      value: unknown,
    ): Promise<ConfirmedOrderIntakeResult> {
      const event = parseConfirmedOrderSourceEvent(value);
      await authorize(event);
      const attempted = attemptedReceipt(event);
      const preflight = await resolveByIdentity(attempted, transaction);
      let execution: ConfirmedOrderIntakeResult | undefined;
      const authorizedRegistration: ConsumerRegistration = Object.freeze({
        ...registration,
        handler: async ({
          transaction: handlerTransaction,
        }: Parameters<ConsumerRegistration["handler"]>[0]) => {
          execution = await processAuthorized(attempted, handlerTransaction);
          return { status: "completed" as const };
        },
      });

      let consumerOutcome: ConsumerOutcome;
      try {
        consumerOutcome = await consumeEventInTransaction(
          transaction,
          authorizedRegistration,
          event,
        );
      } catch (error) {
        if (error instanceof ConfirmedOrderIntakeError) throw error;
        if (error instanceof ConsumerTransactionRollback) {
          return error.outcome.status === "rejected" ? conflict() : dependency();
        }
        return dependency();
      }
      if (consumerOutcome.status === "rejected") return dependency();
      if (consumerOutcome.status === "retry_required") return dependency();

      const postcondition = await resolveByIdentity(attempted, transaction);
      if (postcondition.status !== "Resolved") return dependency();
      if (
        preflight.status === "Resolved" &&
        !confirmedOrderReceiptsMatchExact(preflight.receipt, postcondition.receipt)
      )
        return dependency();
      if (consumerOutcome.status === "processed" && execution === undefined) return dependency();
      if (preflight.status === "Resolved" && execution?.status === "Accepted") return dependency();
      if (
        execution?.status === "Accepted" &&
        !confirmedOrderReceiptsMatchExact(execution.receipt, postcondition.receipt)
      )
        return dependency();
      if (
        execution?.status === "AlreadyAccepted" &&
        !confirmedOrderReceiptsMatchExact(execution.receipt, postcondition.receipt)
      )
        return dependency();

      return Object.freeze({
        status: execution?.status === "Accepted" ? "Accepted" : "AlreadyAccepted",
        receipt: postcondition.receipt,
      });
    },
  });
}
