import type { AppendAuditRecordInput } from "@bop/audit";
import {
  assertGuestSessionUsable,
  createGuestSession,
  parseGuestRawCredential,
  readClosedRecord,
  type GuestSession,
} from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseCartOptionSelection,
  parseCustomerNote,
  parseOrderingInstant,
  parseOrderingReference,
  type CartAggregate,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import { createCartItemCommandService } from "./cart-item-command-service.js";
import type { CartItemCommandPorts } from "./ports/cart-item-command-ports.js";
import type { PickupCartRemovalOptions } from "./pickup-cart-removal-service.js";
export interface PickupCartItemOptions {
  readonly scope: PickupCartRemovalOptions["scope"];
  readonly sessions: PickupCartRemovalOptions["sessions"];
  readonly binding: PickupCartRemovalOptions["binding"];
  readonly repository: CartItemCommandPorts["repository"];
  readonly references: CartItemCommandPorts["references"];
  readonly catalog: CartItemCommandPorts["catalog"];
  readonly audit: (input: {
    readonly action: "Add" | "Update";
    readonly brandReference: OrderingReference;
    readonly storeReference: OrderingReference;
    readonly sessionReference: OrderingReference;
    readonly cartReference: OrderingReference;
    readonly operationReference: OrderingReference;
    readonly observedAt: OrderingInstant;
  }) => AppendAuditRecordInput;
  readonly now: () => string;
}
export interface PickupCartItemResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly cartReference: OrderingReference;
  readonly cartItemReference: OrderingReference;
  readonly aggregateVersion: number;
}
function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function input(value: unknown, action: "Add" | "Update") {
  try {
    const raw = readClosedRecord(
      value,
      [
        "sessionCredential",
        "csrfCredential",
        "cartReference",
        "expectedAggregateVersion",
        action === "Add" ? "sellableReference" : "cartItemReference",
        "quantity",
        "optionSelections",
        "customerNote",
        "operationReference",
      ],
      "ACTOR_SHAPE_INVALID",
    );
    if (
      typeof raw.expectedAggregateVersion !== "number" ||
      !Number.isInteger(raw.expectedAggregateVersion) ||
      raw.expectedAggregateVersion < 1 ||
      raw.expectedAggregateVersion > 2147483647 ||
      typeof raw.quantity !== "number" ||
      !Number.isInteger(raw.quantity) ||
      raw.quantity < 1 ||
      raw.quantity > 999
    )
      return invalid();
    const selections = raw.optionSelections;
    if (
      !Array.isArray(selections) ||
      selections.length > 100 ||
      Reflect.ownKeys(selections).length !== selections.length + 1
    )
      return invalid();
    const options = [];
    for (let i = 0; i < selections.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(selections, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
      options.push(parseCartOptionSelection(descriptor.value));
    }
    if (new Set(options.map((x) => x.optionReference)).size !== options.length) return invalid();
    return Object.freeze({
      sessionCredential: parseGuestRawCredential(raw.sessionCredential),
      csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      cartReference: parseOrderingReference(raw.cartReference),
      operationReference: parseOrderingReference(raw.operationReference),
      targetReference: parseOrderingReference(
        raw[action === "Add" ? "sellableReference" : "cartItemReference"],
      ),
      expectedAggregateVersion: raw.expectedAggregateVersion,
      quantity: raw.quantity,
      optionSelections: Object.freeze(options),
      customerNote: parseCustomerNote(raw.customerNote),
    });
  } catch {
    return invalid();
  }
}
export function createPickupCartItemService(options: PickupCartItemOptions) {
  const rawScope = readClosedRecord(
    options.scope,
    ["brandReference", "storeReference"],
    "ACTOR_SHAPE_INVALID",
  );
  const brandReference = parseOrderingReference(rawScope.brandReference);
  const storeReference = parseOrderingReference(rawScope.storeReference);
  function now() {
    try {
      return parseOrderingInstant(options.now());
    } catch {
      return unavailable();
    }
  }
  async function authorize(raw: ReturnType<typeof input>, observedAt: OrderingInstant) {
    try {
      const session = assertGuestSessionUsable(
        createGuestSession(
          await options.sessions.authorize({
            sessionCredential: raw.sessionCredential,
            csrfCredential: raw.csrfCredential,
            observedAt,
          }),
        ),
        observedAt,
      );
      if (
        String(session.brandReference) !== brandReference ||
        String(session.storeReference) !== storeReference ||
        session.channel !== "Pickup" ||
        session.diningState !== "ContextOnly" ||
        session.diningSessionReference !== null ||
        session.diningParticipantReference !== null
      )
        throw new Error();
      return session;
    } catch {
      throw new CartError("CART_PERMISSION_DENIED");
    }
  }
  function owned(
    value: unknown,
    session: GuestSession,
    observedAt: OrderingInstant,
  ): CartAggregate {
    let cart: CartAggregate;
    try {
      cart = parseCartAggregate(value);
    } catch {
      return unavailable();
    }
    if (
      cart.brandReference !== brandReference ||
      cart.storeReference !== storeReference ||
      cart.orderType !== "Pickup" ||
      cart.diningSessionReference !== null ||
      !["Qr", "Web"].includes(cart.sourceChannel) ||
      cart.createdByActorReference !== String(session.sessionReference) ||
      cart.updatedAt > observedAt
    )
      return unavailable();
    return cart;
  }
  async function execute(action: "Add" | "Update", value: unknown): Promise<PickupCartItemResult> {
    const raw = input(value, action);
    let boundaryFailure: CartError | undefined;
    try {
      const requestedAt = now();
      const session = await authorize(raw, requestedAt);
      const bound = await options.binding.current(session, requestedAt);
      let snapshot: CartAggregate | null;
      try {
        snapshot = bound === null ? null : parseCartAggregate(bound);
      } catch {
        return unavailable();
      }
      const checkedAt = now();
      if (checkedAt < requestedAt) return unavailable();
      const current = await authorize(raw, checkedAt);
      if (JSON.stringify(current) !== JSON.stringify(session))
        throw new CartError("CART_PERMISSION_DENIED");
      let lastObservedAt = checkedAt;
      let loadedForMutation: CartAggregate | null = null;
      async function assertCurrentAuthority(newWork: boolean) {
        try {
          const observedAt = now();
          if (observedAt < lastObservedAt) return unavailable();
          lastObservedAt = observedAt;
          const latest = await authorize(raw, observedAt);
          const completedAt = now();
          if (completedAt < lastObservedAt) return unavailable();
          lastObservedAt = completedAt;
          try {
            assertGuestSessionUsable(latest, completedAt);
          } catch {
            throw new CartError("CART_PERMISSION_DENIED");
          }
          if (JSON.stringify(latest) !== JSON.stringify(current))
            throw new CartError("CART_PERMISSION_DENIED");
          if (newWork) {
            if (loadedForMutation === null) return unavailable();
            assertCartLifecycleActive(loadedForMutation.lifecycle, completedAt);
          }
        } catch (error) {
          boundaryFailure =
            error instanceof CartError ? error : new CartError("CART_DEPENDENCY_UNAVAILABLE");
          throw boundaryFailure;
        }
      }
      if (snapshot === null || snapshot.cartReference !== raw.cartReference)
        throw new CartError("CART_UNAVAILABLE");
      const cart = owned(snapshot, current, checkedAt);
      const audit = options.audit({
        action,
        brandReference,
        storeReference,
        sessionReference: parseOrderingReference(current.sessionReference),
        cartReference: raw.cartReference,
        operationReference: raw.operationReference,
        observedAt: checkedAt,
      });
      const service = createCartItemCommandService({
        authorization: { authorize: async () => ({ guestSession: current, audit }) },
        references: options.references,
        catalog: {
          async validateSelection(selection) {
            await assertCurrentAuthority(true);
            const result = await options.catalog.validateSelection(selection);
            await assertCurrentAuthority(true);
            return result;
          },
        },
        repository: {
          resolveOperation: (reference) => options.repository.resolveOperation(reference),
          async commit(command) {
            await assertCurrentAuthority(true);
            return options.repository.commit(command);
          },
          load: async (reference) => {
            const loaded = await options.repository.load(reference);
            if (loaded === null) return null;
            const latest = owned(loaded, current, checkedAt);
            if (
              latest.aggregateVersion < cart.aggregateVersion ||
              latest.updatedAt < cart.updatedAt ||
              latest.createdAt !== cart.createdAt ||
              latest.sourceChannel !== cart.sourceChannel ||
              (latest.aggregateVersion === cart.aggregateVersion &&
                JSON.stringify(latest) !== JSON.stringify(cart))
            )
              return unavailable();
            loadedForMutation = latest;
            return latest;
          },
        },
      });
      const command = {
        cartReference: raw.cartReference,
        expectedAggregateVersion: raw.expectedAggregateVersion,
        quantity: raw.quantity,
        optionSelections: raw.optionSelections,
        customerNote: raw.customerNote,
        operationReference: raw.operationReference,
        requestedAt: checkedAt,
      };
      const result =
        action === "Add"
          ? await service.add({ ...command, sellableReference: raw.targetReference })
          : await service.update({ ...command, cartItemReference: raw.targetReference });
      await assertCurrentAuthority(false);
      return Object.freeze({
        status: result.status,
        cartReference: result.aggregate.cartReference,
        cartItemReference: result.cartItemReference,
        aggregateVersion: result.aggregate.aggregateVersion,
      });
    } catch (error) {
      if (boundaryFailure !== undefined) throw boundaryFailure;
      if (error instanceof CartError) throw error;
      return unavailable();
    }
  }
  return Object.freeze({
    add: (value: unknown) => execute("Add", value),
    update: (value: unknown) => execute("Update", value),
  });
}
