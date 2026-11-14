import console from "node:console";
import {
  createPickupClosedPaymentSweep,
  createPickupPaymentWindowClosure,
  createPickupPaymentWindowDispatcher,
} from "../../apps/api/dist/pickup-payment-window-closure.js";
import {
  createOutboxWorkload,
  supervisedCycleFailures,
} from "../../apps/worker/dist/outbox-workload.js";
import { parseOrderingReference } from "../../packages/rms/ordering/src/index.ts";
import { isPilotRuntime, pilotProviderEnvironment } from "./pilot-environment.mjs";
import { createInternalOpenPaymentResolution } from "./pilot-open-payment-resolution.mjs";
import {
  createOrderAutoAcceptedPickupExpiry,
  createOrderAutoAcceptedPickupSweep,
} from "../../apps/api/dist/order-auto-accepted-pickup-expiry.js";
const unavailable = () => {
  throw new Error("INTERNAL_PICKUP_PAYMENT_EXPIRY_UNAVAILABLE");
};
/**
 * WP-2423 Q12: trusted local System composition. An unpaid pickup Order whose payment window ended
 * is cancelled by Ordering and its reserved stock released in one transaction. Same System actor
 * as the paid-outcome inventory release; Test provider environment only.
 */
export function createInternalPickupPaymentExpiry(
  resources,
  { systemActorReference, providerAccountReference },
) {
  if (!isPilotRuntime()) return unavailable();
  const binding = resources.publicProfile.binding;
  const scope = {
    tenantReference: String(parseOrderingReference(binding.tenantReference)),
    brandReference: String(parseOrderingReference(resources.scope.brandReference)),
    storeReference: String(parseOrderingReference(resources.scope.storeReference)),
    providerAccountReference: String(parseOrderingReference(providerAccountReference)),
    environment: pilotProviderEnvironment(),
  };
  if (
    binding.brandReference !== scope.brandReference ||
    binding.storeReference !== scope.storeReference
  )
    return unavailable();
  const active = () => isPilotRuntime() && resources.now() < binding.validUntil;
  return createPickupPaymentWindowClosure({
    scope,
    systemActorReference: String(parseOrderingReference(systemActorReference)),
    transactions: resources.transactions,
    now: resources.now,
    newReference: resources.credentials.reference,
    authorize: async () => active(),
    authorizeDiscovery: async (_tx, at) => active() && at <= resources.now(),
  });
}
/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: an automatically accepted pickup the kitchen has not touched 30
 * minutes after it was sent closes and refunds. Same System actor; it finds nothing at a Store that
 * never turned automatic sending on.
 */
export function createInternalAutoAcceptedPickupSweep(
  resources,
  { systemActorReference, providerAccountReference },
) {
  if (!isPilotRuntime()) return unavailable();
  const binding = resources.publicProfile.binding;
  const active = () => isPilotRuntime() && resources.now() < binding.validUntil;
  return createOrderAutoAcceptedPickupSweep({
    expiry: createOrderAutoAcceptedPickupExpiry({
      scope: {
        tenantReference: String(parseOrderingReference(binding.tenantReference)),
        brandReference: String(parseOrderingReference(resources.scope.brandReference)),
        storeReference: String(parseOrderingReference(resources.scope.storeReference)),
      },
      systemActorReference: String(parseOrderingReference(systemActorReference)),
      transactions: resources.transactions,
      now: resources.now,
      newReference: resources.credentials.reference,
      authorize: async () => active(),
      resolveRefundConfiguration: async () => ({
        providerAccountReference: String(parseOrderingReference(providerAccountReference)),
        environment: pilotProviderEnvironment(),
      }),
    }),
    now: resources.now,
    pageSize: 10,
    onFailure: (code) =>
      console.error(JSON.stringify({ event: "INTERNAL_AUTO_ACCEPTED_PICKUP_FAILED", code })),
  });
}
/**
 * WP-2423 abandoned pickup payment: the card payment of a pickup Order closed by its payment window
 * is settled with the (TEST-ONLY simulated) Provider, exactly as an unpaid dine-in round's is: an
 * attempt the guest never confirmed is cancelled there and recorded as failed. Null without a
 * Provider binding.
 */
export function createInternalPickupClosedPaymentSweep(
  resources,
  { createSimulatedProvider, providerAccountReference },
  { createResolution = createInternalOpenPaymentResolution } = {},
) {
  if (!isPilotRuntime()) return unavailable();
  if (createSimulatedProvider === undefined || providerAccountReference === undefined) return null;
  const binding = resources.publicProfile.binding;
  const resolution = createResolution(resources, {
    createSimulatedProvider,
    providerAccountReference: String(parseOrderingReference(providerAccountReference)),
  });
  return createPickupClosedPaymentSweep({
    scope: resources.scope,
    transactions: resources.transactions,
    now: resources.now,
    pageSize: 10,
    authorize: async (_tx, at) =>
      isPilotRuntime() && at <= resources.now() && resources.now() < binding.validUntil,
    resolve: (operation) => resolution.resolve(operation),
    onOutcome: (outcome) => {
      // Never log identifiers; the status alone tells operations what is happening.
      if (outcome.status !== "Failed" && outcome.status !== "Paid")
        console.error(
          JSON.stringify({ event: "INTERNAL_OPEN_PAYMENT_UNRESOLVED", status: outcome.status }),
        );
    },
  });
}
/** Always on: every poll rescans, so an Order whose window has not ended yet is rechecked. */
export function createInternalPickupPaymentExpiryWorkload(
  resources,
  onSnapshot,
  options,
  {
    createService = createInternalPickupPaymentExpiry,
    createPaymentSweep = createInternalPickupClosedPaymentSweep,
    createAutoAcceptedSweep = createInternalAutoAcceptedPickupSweep,
  } = {},
) {
  const closure = createService(resources, options);
  const closedPayments = createPaymentSweep(resources, options);
  const dispatcher = createPickupPaymentWindowDispatcher({
    closure,
    ...(closedPayments === null ? {} : { closedPayments }),
    autoAcceptedPickups: createAutoAcceptedSweep(resources, options),
    now: resources.now,
    pageSize: 10,
    onOutcome: (outcome) => {
      // Started stock stays reserved until staff settle it; never log identifiers.
      if (outcome.status === "Closed" && outcome.inventory.status === "NotReleasable")
        console.error(
          JSON.stringify({
            event: "INTERNAL_PICKUP_PAYMENT_EXPIRY_STOCK_LEFT",
            reason: outcome.inventory.reason,
          }),
        );
    },
    onFailure: (code) =>
      console.error(JSON.stringify({ event: "INTERNAL_PICKUP_PAYMENT_EXPIRY_FAILED", code })),
  });
  return createOutboxWorkload({
    dispatcher,
    pollIntervalMs: 15000,
    drainDeadlineMs: 25000,
    supervision: supervisedCycleFailures,
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}
