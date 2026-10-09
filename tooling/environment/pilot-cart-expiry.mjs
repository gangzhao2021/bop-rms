import { createHash } from "node:crypto";
import {
  CartError,
  createPostgresDueCartSource,
  createPostgresCartQueryStore,
  createPostgresCartLifecycleStore,
  createCartLifecycleCommandService,
} from "../../packages/rms/ordering/src/index.ts";
import { createCartExpiryWorkload } from "../../apps/worker/dist/cart-expiry-workload.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
export function createInternalCartExpiryPorts(resources) {
  const { scope, transactions, now, publicProfile } = resources;
  const allowed = () => isPilotRuntime() && now() < publicProfile.binding.validUntil;
  const derive = (value) => {
    const d = createHash("sha256").update(value).digest("hex");
    return (
      d.slice(0, 8) +
      "-" +
      d.slice(8, 12) +
      "-7" +
      d.slice(13, 16) +
      "-8" +
      d.slice(17, 20) +
      "-" +
      d.slice(20, 32)
    );
  };
  const references = {
    hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    equals: (left, right) => left === right,
  };
  const source = createPostgresDueCartSource(transactions, scope);
  const reader = createPostgresCartQueryStore(transactions, scope);
  const store = createPostgresCartLifecycleStore(transactions, scope, references);
  const service = createCartLifecycleCommandService({
    references,
    repository: {
      resolveOperation: store.resolveOperation,
      load: reader.load,
      commit: (input) => {
        if (!allowed()) throw new Error("INTERNAL_CART_EXPIRY_UNAVAILABLE");
        return store.commit(input);
      },
    },
    authorization: {
      authorize: async (input) => {
        if (!allowed() || input.action !== "Expire" || input.observedAt > now()) return null;
        return {
          guestSession: null,
          audit: {
            auditId: derive("audit:" + input.operationReference),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "ORDERING_CART_EXPIRE",
            targetType: "OrderingCart",
            targetId: input.cartReference,
            occurredAt: input.observedAt,
            correlationId: input.operationReference,
            reasonCode: "CART_DEADLINE_REACHED",
            sourceChannel: "SYSTEM",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        };
      },
    },
  });
  return Object.freeze({
    discover: (limit, after) => {
      if (!allowed()) throw new Error("INTERNAL_CART_EXPIRY_UNAVAILABLE");
      return source.discover({ evaluatedAt: now(), limit, after });
    },
    expire: async (candidate) => {
      const operationReference = derive(
        JSON.stringify([
          "pilot-cart-expiry-v1",
          scope.brandReference,
          scope.storeReference,
          candidate.cartReference,
          candidate.expectedAggregateVersion,
        ]),
      );
      try {
        await service.expire({ ...candidate, operationReference, evaluatedAt: now() });
        return "Applied";
      } catch (error) {
        if (
          error instanceof CartError &&
          [
            "CART_VERSION_CONFLICT",
            "CART_EXPIRED",
            "CART_ABANDONED",
            "CART_EXPIRATION_NOT_DUE",
          ].includes(error.code)
        )
          return "Stale";
        throw error;
      }
    },
  });
}
export function createInternalCartExpiryWorkload(resources) {
  return createCartExpiryWorkload({
    ...createInternalCartExpiryPorts(resources),
    pageSize: 10,
    pollIntervalMs: 5000,
    drainDeadlineMs: 25000,
  });
}
