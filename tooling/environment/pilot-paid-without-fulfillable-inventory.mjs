import console from "node:console";
import { supervisedCycleFailures } from "../../apps/worker/dist/outbox-workload.js";
import { createPaidWithoutFulfillableInventoryRelease } from "../../apps/api/dist/paid-without-fulfillable-inventory-release.js";
import { createPaymentCompensationWorkload } from "../../apps/worker/dist/payment-compensation-workload.js";
import {
  createPostgresPaidAcceptanceLapseClosure,
  parseOrderingReference,
} from "../../packages/rms/ordering/src/index.ts";
import { createInternalCompensationCandidates } from "./pilot-compensation-candidates.mjs";
import { isPilotRuntime } from "./pilot-environment.mjs";
const unavailable = () => {
  throw new Error("INTERNAL_PAID_WITHOUT_FULFILLABLE_INVENTORY_UNAVAILABLE");
};
/**
 * WP-2423 Q12: trusted local System composition. Each paid submission Ordering decided it cannot
 * fulfil returns its reserved stock; the release re-reads the disposition and every Inventory fact
 * in one transaction. Same System actor as the dining cancellation release.
 */
export function createInternalPaidWithoutFulfillableInventory(resources, { systemActorReference }) {
  if (!isPilotRuntime()) return unavailable();
  const binding = resources.publicProfile.binding;
  const scope = {
    tenantReference: String(parseOrderingReference(binding.tenantReference)),
    brandReference: String(parseOrderingReference(resources.scope.brandReference)),
    storeReference: String(parseOrderingReference(resources.scope.storeReference)),
  };
  if (
    binding.brandReference !== scope.brandReference ||
    binding.storeReference !== scope.storeReference
  )
    return unavailable();
  const active = () => isPilotRuntime() && resources.now() < binding.validUntil;
  const candidates = createInternalCompensationCandidates(resources);
  const release = createPaidWithoutFulfillableInventoryRelease({
    scope,
    systemActorReference: String(parseOrderingReference(systemActorReference)),
    now: resources.now,
    authorize: async (_tx, disposition) =>
      active() &&
      disposition.brandReference === scope.brandReference &&
      disposition.storeReference === scope.storeReference,
  });
  // WP-2423 item 5: a paid pickup the Store did not accept in time (CapacityExpired, including an
  // outage hold that expired) is also closed as an Order, in the same transaction as its stock
  // release; the refund stays with Payment's compensation. Complete rescans cover earlier orders.
  const closure = createPostgresPaidAcceptanceLapseClosure({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: async () => active(),
  });
  return Object.freeze({
    discover: (input) => candidates.discover(input),
    release: (disposition) => {
      if (!active()) return unavailable();
      return resources.transactions.run(async (tx) => {
        const released = await release(tx, disposition);
        if (disposition.reason === "CapacityExpired")
          await closure.close(tx, {
            paymentEventReference: disposition.paymentEventReference,
            closedAt: resources.now(),
            terminationReference: resources.credentials.reference(),
            auditReference: resources.credentials.reference(),
          });
        return released;
      });
    },
  });
}
/** Always on: discovery repeats complete scans, so a late or failed release is retried. */
export function createInternalPaidWithoutFulfillableInventoryWorkload(
  resources,
  onSnapshot,
  options,
  { createService = createInternalPaidWithoutFulfillableInventory } = {},
) {
  const service = createService(resources, options);
  return createPaymentCompensationWorkload({
    discover: (input) => service.discover(input),
    execute: (candidate) => service.release(candidate),
    afterExecute: async (_candidate, result) => {
      // Started or consumed stock stays reserved until staff settle it; never log identifiers.
      if (result?.status === "NotReleasable")
        console.error(
          JSON.stringify({ event: "INTERNAL_INVENTORY_RELEASE_LEFT", reason: result.reason }),
        );
    },
    recordFailure: async (_candidate, code) => {
      console.error(JSON.stringify({ event: "INTERNAL_INVENTORY_RELEASE_FAILED", code }));
    },
    pageSize: 10,
    pollIntervalMs: 5000,
    // An unchanged result (released, no-op or left for staff) is rechecked at most every 5 minutes.
    unchangedBackoffMaxMs: 300_000,
    drainDeadlineMs: 25000,
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
