import { validateAuditRecord } from "@bop/audit";
import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  CartError,
  parseCartAggregate,
  parseCartOptionSelection,
  parseCustomerNote,
  parseOrderingReference,
  parseOrderingInstant,
  parseOrderingHash,
} from "../domain/cart.js";
import { assertCartLifecycleActive } from "../domain/cart-lifecycle.js";
import { createCartItemCommandService } from "./cart-item-command-service.js";
import {
  createDiningCartAuthority,
  type DiningCartAuthorityPorts,
  type DiningCartAuthoritySnapshot,
} from "./dining-cart-authority.js";
import type {
  CartItemCommandPorts,
  CartItemOperationAction,
  CartItemOperationRecord,
} from "./ports/cart-item-command-ports.js";
import type { PickupCartRemovalOptions } from "./pickup-cart-removal-service.js";
import type { PickupCartItemOptions, PickupCartItemResult } from "./pickup-cart-item-service.js";

export interface DiningCartItemOptions {
  readonly scope: DiningCartAuthorityPorts["scope"];
  readonly sessions: PickupCartRemovalOptions["sessions"];
  readonly participation: DiningCartAuthorityPorts["participation"];
  readonly now: () => string;
  readonly catalog: CartItemCommandPorts["catalog"];
  readonly references: CartItemCommandPorts["references"];
  /** Owner adapter must scope aggregate reads by DiningSession and history by Cart and Guest. */
  readonly repository: (
    scope: Readonly<{
      brandReference: string;
      storeReference: string;
      diningSessionReference: string;
      guestSessionReference: string;
      cartReference: string;
    }>,
  ) => CartItemCommandPorts["repository"];
  readonly audit: (
    input: Omit<Parameters<PickupCartItemOptions["audit"]>[0], "action"> & {
      readonly action: CartItemOperationAction;
    },
  ) => ReturnType<PickupCartItemOptions["audit"]>;
}
function invalid(): never {
  throw new CartError("CART_INPUT_INVALID");
}
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function denied(): never {
  throw new CartError("CART_PERMISSION_DENIED");
}
function input(value: unknown, action: CartItemOperationAction) {
  try {
    const raw = readClosedRecord(
      value,
      [
        "sessionCredential",
        "csrfCredential",
        "cartReference",
        "expectedAggregateVersion",
        action === "Add" ? "sellableReference" : "cartItemReference",
        ...(action === "Remove" ? [] : ["quantity", "optionSelections", "customerNote"]),
        "operationReference",
      ],
      "ACTOR_SHAPE_INVALID",
    );
    if (
      typeof raw.expectedAggregateVersion !== "number" ||
      !Number.isInteger(raw.expectedAggregateVersion) ||
      raw.expectedAggregateVersion < 1 ||
      raw.expectedAggregateVersion > 2147483647 ||
      (action !== "Remove" &&
        (typeof raw.quantity !== "number" ||
          !Number.isInteger(raw.quantity) ||
          raw.quantity < 1 ||
          raw.quantity > 999))
    )
      return invalid();
    const selections = action === "Remove" ? [] : raw.optionSelections;
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
      quantity: action === "Remove" ? 1 : raw.quantity,
      optionSelections: Object.freeze(options),
      customerNote: action === "Remove" ? null : parseCustomerNote(raw.customerNote),
    });
  } catch {
    return invalid();
  }
}

function sameAuthority(first: DiningCartAuthoritySnapshot, next: DiningCartAuthoritySnapshot) {
  if (next.observedAt < first.observedAt) return unavailable();
  for (const key of [
    "sessionReference",
    "version",
    "brandReference",
    "storeReference",
    "publicStoreReference",
    "publicTableReference",
    "qrReference",
    "qrRevocationVersion",
    "diningState",
    "diningSessionReference",
    "diningParticipantReference",
    "locale",
  ] as const)
    if (first.session[key] !== next.session[key]) return denied();
  for (const key of [
    "brandReference",
    "storeReference",
    "diningSessionReference",
    "participantReference",
    "tableReference",
    "tableAssignmentVersion",
    "diningSessionVersion",
    "participantVersion",
  ] as const)
    if (first.participation[key] !== next.participation[key]) return denied();
}
function captureAudit(value: unknown, at: string) {
  const raw = readClosedRecord(value, [
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
  const actor = readClosedRecord(raw.actor, ["type"]);
  if (
    actor.type !== "System" ||
    Object.entries(raw).some(
      ([key, value]) =>
        key !== "actor" && key !== "retentionPolicyVersion" && typeof value !== "string",
    )
  )
    return unavailable();
  return validateAuditRecord(
    Object.freeze({ ...raw, actor: Object.freeze({ type: "System" as const }) }),
    Date.parse(at),
  );
}

/** Current observations bound each dependency/effect; they do not grant an atomic Closing lease. */
export function createDiningCartItemService(options: DiningCartItemOptions) {
  const scope = readClosedRecord(options.scope, ["brandReference", "storeReference"]);
  const brandReference = parseOrderingReference(scope.brandReference);
  const storeReference = parseOrderingReference(scope.storeReference);
  async function execute(
    action: CartItemOperationAction,
    value: unknown,
  ): Promise<PickupCartItemResult> {
    const raw = input(value, action);
    let guardFailure: CartError | null = null;
    const receiptState: { expiresAt: string | null } = { expiresAt: null };
    const authority = createDiningCartAuthority({
      scope: { brandReference, storeReference },
      participation: options.participation,
      now: options.now,
      sessions: {
        resolve: ({ sessionCredential, observedAt }) =>
          options.sessions.authorize(
            Object.freeze({ sessionCredential, csrfCredential: raw.csrfCredential, observedAt }),
          ),
      },
    });
    try {
      const result = await authority.run(raw.sessionCredential, async (first) => {
        const bound = Object.freeze({
          brandReference,
          storeReference,
          diningSessionReference: first.participation.diningSessionReference,
          guestSessionReference: String(first.session.sessionReference),
          cartReference: raw.cartReference,
        });
        const repository = options.repository(bound);
        function owned(value: unknown) {
          let cart;
          try {
            cart = parseCartAggregate(value);
          } catch {
            return unavailable();
          }
          if (
            cart.brandReference !== brandReference ||
            cart.storeReference !== storeReference ||
            cart.cartReference !== raw.cartReference ||
            cart.orderType !== "DineIn" ||
            cart.diningSessionReference !== bound.diningSessionReference ||
            !["Qr", "Web"].includes(cart.sourceChannel) ||
            cart.updatedAt > first.observedAt
          )
            return unavailable();
          return cart;
        }
        function record(value: unknown): CartItemOperationRecord {
          try {
            return parseRecord(value);
          } catch (error) {
            if (error instanceof CartError && error.code === "CART_IDEMPOTENCY_CONFLICT")
              throw new CartError(error.code);
            return unavailable();
          }
        }
        function parseRecord(value: unknown): CartItemOperationRecord {
          const saved = readClosedRecord(value, [
            "action",
            "operationReference",
            "operationIntentHash",
            "guestSessionReference",
            "cartReference",
            "cartItemReference",
            "result",
            "occurredAt",
            "expiresAt",
          ]);
          if (
            saved.action !== action ||
            saved.operationReference !== raw.operationReference ||
            saved.cartReference !== raw.cartReference ||
            saved.guestSessionReference !== bound.guestSessionReference
          )
            throw new CartError("CART_IDEMPOTENCY_CONFLICT");
          const occurredAt = parseOrderingInstant(saved.occurredAt);
          const expiresAt = parseOrderingInstant(saved.expiresAt);
          if (
            occurredAt > first.observedAt ||
            occurredAt < String(first.session.createdAt) ||
            Date.parse(expiresAt) - Date.parse(occurredAt) !== 86_400_000
          )
            return unavailable();
          const aggregate = owned(saved.result);
          const itemReference = parseOrderingReference(saved.cartItemReference);
          const item = aggregate.items.find(
            (candidate) => candidate.cartItemReference === itemReference,
          );
          if (
            aggregate.updatedAt !== occurredAt ||
            (action === "Remove"
              ? item !== undefined
              : item?.addedByParticipantReference !== first.participation.participantReference)
          )
            return unavailable();
          receiptState.expiresAt = expiresAt;
          return Object.freeze({
            action,
            operationReference: raw.operationReference,
            operationIntentHash: parseOrderingHash(saved.operationIntentHash),
            guestSessionReference: parseOrderingReference(bound.guestSessionReference),
            cartReference: raw.cartReference,
            cartItemReference: itemReference,
            result: aggregate,
            occurredAt,
            expiresAt,
          });
        }
        async function guarded<T>(effect: (current: DiningCartAuthoritySnapshot) => Promise<T>) {
          try {
            const checked = await authority.run(raw.sessionCredential, async (current) => {
              sameAuthority(first, current);
              return effect(current);
            });
            sameAuthority(first, checked.authority);
            return checked.value;
          } catch (error) {
            if (error instanceof CartError) guardFailure = new CartError(error.code);
            throw error;
          }
        }
        const audit = captureAudit(
          options.audit(
            Object.freeze({
              action,
              brandReference,
              storeReference,
              sessionReference: parseOrderingReference(bound.guestSessionReference),
              cartReference: raw.cartReference,
              operationReference: raw.operationReference,
              observedAt: first.observedAt,
            }),
          ),
          first.observedAt,
        );
        let loaded: ReturnType<typeof owned> | null = null;
        const service = createCartItemCommandService({
          catalog: options.catalog,
          references: options.references,
          authorization: { authorize: async () => ({ guestSession: first.session, audit }) },
          repository: {
            load: async (reference) => {
              const source = await repository.load(reference);
              loaded = source === null ? null : owned(source);
              return loaded;
            },
            resolveOperation: (reference) =>
              guarded(async () => {
                const prior = await repository.resolveOperation(reference);
                return prior === null ? null : record(prior);
              }),
            commit: (command) =>
              guarded(async (current) => {
                if (loaded === null) return unavailable();
                assertCartLifecycleActive(loaded.lifecycle, current.observedAt);
                return record(await repository.commit(command));
              }),
          },
        });
        const common = {
          cartReference: raw.cartReference,
          operationReference: raw.operationReference,
          expectedAggregateVersion: raw.expectedAggregateVersion,
          requestedAt: first.observedAt,
        };
        const configured = {
          ...common,
          quantity: raw.quantity,
          optionSelections: raw.optionSelections,
          customerNote: raw.customerNote,
        };
        const applied =
          action === "Add"
            ? await service.add({ ...configured, sellableReference: raw.targetReference })
            : action === "Update"
              ? await service.update({ ...configured, cartItemReference: raw.targetReference })
              : await service.remove({ ...common, cartItemReference: raw.targetReference });
        const aggregate = owned(applied.aggregate);
        return Object.freeze({
          status: applied.status,
          cartReference: aggregate.cartReference,
          cartItemReference: parseOrderingReference(applied.cartItemReference),
          aggregateVersion: aggregate.aggregateVersion,
        });
      });
      if (receiptState.expiresAt !== null && receiptState.expiresAt <= result.authority.observedAt)
        throw new CartError("CART_IDEMPOTENCY_CONFLICT");
      return result.value;
    } catch (error) {
      if (guardFailure !== null) throw guardFailure;
      if (error instanceof CartError) throw new CartError(error.code);
      return unavailable();
    }
  }
  return Object.freeze({
    add: (value: unknown) => execute("Add", value),
    update: (value: unknown) => execute("Update", value),
    remove: (value: unknown) => execute("Remove", value),
  });
}
