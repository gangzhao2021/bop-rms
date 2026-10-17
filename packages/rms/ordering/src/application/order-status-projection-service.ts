import { assertGuestSessionUsable, createGuestSession } from "@bop/identity";
import { parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import {
  buildOrderStatusProjection,
  OrderStatusProjectionError,
  parseOrderStatusProjection,
  parseOrderStatusSourceSnapshot,
  type OrderStatusCanonicalPhase,
} from "../domain/order-status-projection.js";
import type {
  OrderStatusProjectionPorts,
  OrderStatusQueryPorts,
} from "./ports/order-status-projection-ports.js";

function fail(code: ConstructorParameters<typeof OrderStatusProjectionError>[0]): never {
  throw new OrderStatusProjectionError(code);
}
function dependency(): never {
  return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
}

function parseDependencySource(value: unknown) {
  try {
    return parseOrderStatusSourceSnapshot(value);
  } catch {
    return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
  }
}

function parseDependencyProjection(value: unknown) {
  try {
    return parseOrderStatusProjection(value);
  } catch {
    return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
  }
}

function equivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equivalent(value, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  const leftEntries = Object.entries(left);
  const rightRecord = right as Readonly<Record<string, unknown>>;
  return (
    leftEntries.length === Object.keys(rightRecord).length &&
    leftEntries.every(([key, value]) =>
      Object.hasOwn(rightRecord, key) ? equivalent(value, rightRecord[key]) : false,
    )
  );
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return fail("ORDER_STATUS_INPUT_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get ||
        descriptor.set ||
        !descriptor.enumerable
      )
        return fail("ORDER_STATUS_INPUT_INVALID");
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderStatusProjectionError) throw error;
    return fail("ORDER_STATUS_INPUT_INVALID");
  }
}

function optionalChoice<T extends string>(value: unknown, choices: readonly T[]): T | null {
  if (value === null) return null;
  if (typeof value !== "string" || !choices.includes(value as T))
    return fail("ORDER_STATUS_INPUT_INVALID");
  return value as T;
}

function exactReferenceOrNumber(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64) return fail("ORDER_STATUS_INPUT_INVALID");
  if (/^[1-9][0-9]{0,18}$/u.test(value)) return value;
  try {
    return parseOrderingReference(value);
  } catch {
    return fail("ORDER_STATUS_INPUT_INVALID");
  }
}

export function createOrderStatusProjector(ports: OrderStatusProjectionPorts) {
  return Object.freeze({
    async project(orderReferenceValue: unknown) {
      let orderReference;
      try {
        orderReference = parseOrderingReference(orderReferenceValue);
      } catch {
        return fail("ORDER_STATUS_INPUT_INVALID");
      }
      // Sequential: owner ports may share one caller transaction (no concurrent use of a client).
      const sourceValue = await ports.source.loadExact(orderReference).catch(dependency);
      const currentValue = await ports.projections.load(orderReference).catch(dependency);
      if (sourceValue === null) return fail("ORDER_STATUS_NOT_FOUND");
      const source = parseDependencySource(sourceValue);
      if (source.orderReference !== orderReference)
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      const current = currentValue === null ? null : parseDependencyProjection(currentValue);
      if (current && current.snapshot.sourceVersion > source.sourceVersion) return current;
      if (current && current.snapshot.sourceVersion === source.sourceVersion) {
        if (
          current.snapshot.sourceCheckpoint !== source.sourceCheckpoint ||
          !equivalent(current.snapshot, source)
        )
          return fail("ORDER_STATUS_VERSION_CONFLICT");
        return current;
      }
      let projection;
      try {
        projection = buildOrderStatusProjection({
          source,
          generationReference: ports.references.generateGeneration(),
          projectedAt: ports.references.now(),
        });
      } catch {
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      const saved = await ports.projections.replace(projection).catch(dependency);
      const parsed = parseDependencyProjection(saved);
      if (
        parsed.snapshot.orderReference !== orderReference ||
        parsed.snapshot.sourceCheckpoint !== source.sourceCheckpoint
      )
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      return parsed;
    },
  });
}

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: the projection snapshot keeps the phase bound to its Order
 * revision; the current overall phase is Ordering's merge of its own records and consumed Kitchen
 * facts. A pickup's collected state stays tied to the recorded completion (Fulfilled iff
 * Completed). A dine-in Order has no Fulfillment completion: it is Fulfilled when every remaining
 * item was served (Dining's served quantities, merged by the caller), which never closes it.
 */
function currentPhase(
  snapshot: ReturnType<typeof parseOrderStatusProjection>["snapshot"],
  merged: { readonly canonicalPhase: OrderStatusCanonicalPhase } | null,
): OrderStatusCanonicalPhase {
  if (snapshot.fulfillmentStatus === "Completed") return "Fulfilled";
  if (merged === null) return snapshot.canonicalPhase;
  return merged.canonicalPhase === "Fulfilled" && snapshot.orderType !== "DineIn"
    ? "Ready"
    : merged.canonicalPhase;
}

function customerView(
  projection: ReturnType<typeof parseOrderStatusProjection>,
  merged: { readonly canonicalPhase: OrderStatusCanonicalPhase } | null = null,
) {
  const snapshot = projection.snapshot;
  return Object.freeze({
    projectionName: projection.projectionName,
    projectionVersion: projection.projectionVersion,
    sourceCheckpoint: snapshot.sourceCheckpoint,
    projectedAt: projection.projectedAt,
    freshnessStatus: projection.freshnessStatus,
    order: Object.freeze({
      orderReference: snapshot.orderReference,
      orderNumber: snapshot.orderNumber,
      orderType: snapshot.orderType,
      canonicalPhase: currentPhase(snapshot, merged),
      paymentStatus: snapshot.paymentStatus,
      kitchenStatus: snapshot.kitchenStatus,
      fulfillmentStatus: snapshot.fulfillmentStatus,
      fulfilledAt: snapshot.fulfillmentCompletedAt,
      eta: snapshot.eta,
      submittedAt: snapshot.submittedAt,
      batches: snapshot.batches,
    }),
  });
}

export function createOrderStatusQueryService(ports: OrderStatusQueryPorts) {
  const mergedPhase = async (
    orderReference: string,
    snapshot: ReturnType<typeof parseOrderStatusProjection>["snapshot"],
  ) => {
    if (ports.phases === undefined) return null;
    return ports.phases
      .load(parseOrderingReference(orderReference), { orderType: snapshot.orderType })
      .catch(dependency);
  };
  return Object.freeze({
    async getCustomer(value: unknown) {
      const raw = exact(value, ["orderReference", "observedAt"]);
      let orderReference, observedAt;
      try {
        orderReference = parseOrderingReference(raw.orderReference);
        observedAt = parseOrderingInstant(raw.observedAt);
      } catch {
        return fail("ORDER_STATUS_INPUT_INVALID");
      }
      const authorized = await ports.authorization
        .authorizeCustomer({ orderReference, observedAt })
        .catch(dependency);
      if (!authorized) return fail("ORDER_STATUS_PERMISSION_DENIED");
      let guest;
      try {
        guest = assertGuestSessionUsable(createGuestSession(authorized.guestSession), observedAt);
      } catch {
        return fail("ORDER_STATUS_PERMISSION_DENIED");
      }
      const projection = await ports.projections.load(orderReference).catch(dependency);
      if (!projection) return fail("ORDER_STATUS_NOT_FOUND");
      const parsed = parseDependencyProjection(projection);
      if (
        parsed.snapshot.guestSessionReference !== parseOrderingReference(guest.sessionReference) ||
        parsed.snapshot.brandReference !== parseOrderingReference(guest.brandReference) ||
        parsed.snapshot.storeReference !== parseOrderingReference(guest.storeReference)
      )
        return fail("ORDER_STATUS_PERMISSION_DENIED");
      return customerView(parsed, await mergedPhase(orderReference, parsed.snapshot));
    },
    /**
     * WP-2423 Q8: the table's shared view of its dine-in Order for any current participant of that
     * dining session. Same customer-safe fields as getCustomer; the Order must be dine-in and in the
     * participant's Brand and Store.
     */
    async getDiningParticipant(value: unknown) {
      const raw = exact(value, ["orderReference", "observedAt"]);
      let orderReference, observedAt;
      try {
        orderReference = parseOrderingReference(raw.orderReference);
        observedAt = parseOrderingInstant(raw.observedAt);
      } catch {
        return fail("ORDER_STATUS_INPUT_INVALID");
      }
      const authorize = ports.authorization.authorizeDiningParticipant;
      if (authorize === undefined) return fail("ORDER_STATUS_PERMISSION_DENIED");
      const authorized = await authorize({ orderReference, observedAt }).catch(dependency);
      if (!authorized) return fail("ORDER_STATUS_PERMISSION_DENIED");
      let guest;
      try {
        guest = assertGuestSessionUsable(createGuestSession(authorized.guestSession), observedAt);
      } catch {
        return fail("ORDER_STATUS_PERMISSION_DENIED");
      }
      if (
        guest.channel !== "DineIn" ||
        guest.diningState !== "DiningBound" ||
        guest.diningSessionReference === null ||
        guest.diningParticipantReference === null
      )
        return fail("ORDER_STATUS_PERMISSION_DENIED");
      const projection = await ports.projections.load(orderReference).catch(dependency);
      if (!projection) return fail("ORDER_STATUS_NOT_FOUND");
      const parsed = parseDependencyProjection(projection);
      if (
        parsed.snapshot.orderReference !== orderReference ||
        parsed.snapshot.orderType !== "DineIn" ||
        parsed.snapshot.brandReference !== parseOrderingReference(guest.brandReference) ||
        parsed.snapshot.storeReference !== parseOrderingReference(guest.storeReference)
      )
        return fail("ORDER_STATUS_PERMISSION_DENIED");
      return customerView(parsed, await mergedPhase(orderReference, parsed.snapshot));
    },
    async listMerchant(value: unknown) {
      const raw = exact(value, [
        "brandReference",
        "storeReference",
        "observedAt",
        "exactReferenceOrNumber",
        "orderType",
        "sourceChannel",
        "canonicalPhase",
        "closureStatus",
        "paymentStatus",
        "limit",
      ]);
      let brandReference, storeReference, observedAt;
      try {
        brandReference = parseOrderingReference(raw.brandReference);
        storeReference = parseOrderingReference(raw.storeReference);
        observedAt = parseOrderingInstant(raw.observedAt);
      } catch {
        return fail("ORDER_STATUS_INPUT_INVALID");
      }
      const exactReferenceOrNumberValue = exactReferenceOrNumber(raw.exactReferenceOrNumber);
      const orderType = optionalChoice(raw.orderType, ["DineIn", "Pickup"] as const);
      const sourceChannel = optionalChoice(raw.sourceChannel, ["Api", "Pos", "Qr", "Web"] as const);
      const canonicalPhase = optionalChoice(raw.canonicalPhase, [
        "Submitted",
        "Accepted",
        "In Progress",
        "Ready",
        "Fulfilled",
        "Rejected",
        "Cancelled",
      ] as const);
      const closureStatus = optionalChoice(raw.closureStatus, ["Open"] as const);
      const paymentStatus = optionalChoice(raw.paymentStatus, ["NotReported"] as const);
      const limit = raw.limit;
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
        return fail("ORDER_STATUS_INPUT_INVALID");
      const authorized = await ports.authorization
        .authorizeMerchant({
          brandReference,
          storeReference,
          purpose: "OrderStatusRead",
          observedAt,
        })
        .catch(dependency);
      if (!authorized) return fail("ORDER_STATUS_PERMISSION_DENIED");
      const rows = await ports.projections
        .list({
          brandReference,
          storeReference,
          exactReferenceOrNumber: exactReferenceOrNumberValue,
          orderType,
          sourceChannel,
          canonicalPhase,
          closureStatus,
          paymentStatus,
          limit: limit as number,
        })
        .catch(dependency);
      if (rows.length > (limit as number)) return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      const parsedRows = rows.map(parseDependencyProjection);
      for (let index = 0; index < parsedRows.length; index += 1) {
        const parsed = parsedRows[index];
        if (parsed === undefined) return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
        const snapshot = parsed.snapshot;
        const previous = parsedRows[index - 1]?.snapshot;
        const outOfOrder =
          previous !== undefined &&
          (Date.parse(previous.submittedAt) < Date.parse(snapshot.submittedAt) ||
            (previous.submittedAt === snapshot.submittedAt &&
              previous.orderReference.localeCompare(snapshot.orderReference) > 0));
        const searchMismatch =
          exactReferenceOrNumberValue !== null &&
          snapshot.orderReference !== exactReferenceOrNumberValue &&
          snapshot.orderNumber !== exactReferenceOrNumberValue;
        if (
          snapshot.brandReference !== brandReference ||
          snapshot.storeReference !== storeReference ||
          (orderType !== null && snapshot.orderType !== orderType) ||
          (sourceChannel !== null && snapshot.sourceChannel !== sourceChannel) ||
          (canonicalPhase !== null && snapshot.canonicalPhase !== canonicalPhase) ||
          (closureStatus !== null && snapshot.closureStatus !== closureStatus) ||
          (paymentStatus !== null && snapshot.paymentStatus !== paymentStatus) ||
          searchMismatch ||
          outOfOrder
        )
          return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      const phases: ({ readonly canonicalPhase: OrderStatusCanonicalPhase } | null)[] = [];
      for (const parsed of parsedRows)
        phases.push(await mergedPhase(parsed.snapshot.orderReference, parsed.snapshot));
      return Object.freeze(
        parsedRows.map((parsed, index) => {
          const view = customerView(parsed, phases[index] ?? null);
          return Object.freeze({
            ...view,
            order: Object.freeze({
              ...view.order,
              brandReference: parsed.snapshot.brandReference,
              storeReference: parsed.snapshot.storeReference,
              sourceChannel: parsed.snapshot.sourceChannel,
              closureStatus: parsed.snapshot.closureStatus,
            }),
          });
        }),
      );
    },
  });
}
