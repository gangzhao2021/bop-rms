// WP-2423 DEC-STRIPE-PILOT-WIRING: the pilot's Stripe Provider binding and the configured
// selection between it and the TEST-ONLY internal simulator. The Stripe binding exposes the same
// surface the pilot composition already consumes from the simulator (adapter, terminal
// occurrence, capture journal, settlement window) so every Payment owner path is unchanged.
import {
  createCancelIntentRequest,
  createPaymentProviderFailure,
  createRefundPaymentRequest,
  createRetrieveIntentRequest,
  createStripeCaptureJournal,
  createStripeOnlineClientHandoff,
  createStripeOnlineIntentAdapter,
  createStripeOrdinaryRefundAdapter,
  createStripeSettlementWindowSource,
  createStripeTerminalObservationReader,
} from "../../packages/rms/payment/src/index.ts";
import {
  currentPilotEnvironment,
  isInternalTest,
  isPilotRuntime,
  pilotProviderEnvironment,
} from "./pilot-environment.mjs";
import { loadPilotPaymentConfig, readStripeSecretKey } from "./pilot-payment-config.mjs";
import { createInternalSimulatedProvider } from "./pilot-payment-provider.mjs";

const STRIPE_BASE = "https://api.stripe.com";

/**
 * Either configured Provider of this process: the TEST-ONLY simulator (InternalTest only), or the
 * Stripe binding whose mode is this process's Provider environment (test mode in InternalTest,
 * live mode in a Pilot Store). A Provider of the other environment is never accepted.
 */
export function isPilotPaymentProvider(provider) {
  if (provider === null || typeof provider !== "object" || !isPilotRuntime()) return false;
  if (provider.simulation === true) return isInternalTest();
  return provider.providerKind === "Stripe" && provider.environment === pilotProviderEnvironment();
}
export const isStripeProvider = (provider) =>
  isPilotPaymentProvider(provider) && provider.providerKind === "Stripe";

/** TEST-ONLY: routes the adapters' fixed Stripe origin to the loopback stand-in. */
function loopbackFetch(base) {
  return (input, init) => {
    const target = String(input);
    if (!target.startsWith(STRIPE_BASE + "/")) throw Error("PILOT_STRIPE_ORIGIN_UNEXPECTED");
    return globalThis.fetch(base + target.slice(STRIPE_BASE.length), init);
  };
}

/**
 * The Stripe binding for one Store. `scope` is the installation's bound Brand/Store; every
 * request outside it is refused before any Provider call.
 */
export function createPilotStripeProvider({
  stripe,
  secretKey,
  scope,
  now = () => new Date().toISOString(),
  fetch,
}) {
  // The configured mode is the Provider environment; a key of the other mode never gets here.
  const environment = stripe.environment;
  if (environment !== "Test" && environment !== "Live") throw Error("PILOT_STRIPE_MODE_INVALID");
  const options = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    environment,
    apiVersion: stripe.apiVersion,
    secretKey,
    connectedAccount: stripe.connectedAccount,
    now,
    ...(fetch !== undefined
      ? { fetch }
      : stripe.testApiBaseUrl !== null
        ? { fetch: loopbackFetch(stripe.testApiBaseUrl) }
        : {}),
  };
  const intents = createStripeOnlineIntentAdapter(options),
    refunds = createStripeOrdinaryRefundAdapter(options),
    reader = createStripeTerminalObservationReader(options);
  const inScope = (context) => {
    if (
      context?.environment !== environment ||
      context.brandReference !== scope.brandReference ||
      context.storeReference !== scope.storeReference
    )
      throw Error("PILOT_STRIPE_SCOPE_DENIED");
  };
  const unknown = (context) =>
    createPaymentProviderFailure({
      kind: "Failure",
      context,
      code: "Unknown",
      retryDisposition: "Unknown",
      safeReasonCode: "STRIPE_RESULT_UNRESOLVED",
    });
  return Object.freeze({
    simulation: false,
    providerKind: "Stripe",
    environment,
    publishableKey: stripe.publishableKey,
    returnUrl: stripe.returnUrl,
    /**
     * The domain on which Apple Pay / Google Pay may show (registered and verified with Stripe,
     * confirmed by the operator), or null: the card form stays card-only.
     */
    walletDomain:
      stripe.walletsEnabled === true && typeof stripe.paymentMethodDomain === "string"
        ? stripe.paymentMethodDomain
        : null,
    adapter: Object.freeze({
      async createIntent(value) {
        inScope(value.context);
        return intents.createIntent(value);
      },
      async retrieveIntent(value) {
        inScope(value.context);
        return intents.retrieveIntent(value);
      },
      async cancelIntent(value) {
        inScope(value.context);
        return intents.cancelIntent(value);
      },
      async captureIntent() {
        // Online card payments capture automatically; Terminal capture is not in the pilot.
        throw Error("PILOT_STRIPE_OPERATION_UNAVAILABLE");
      },
      async refundPayment(value) {
        const request = createRefundPaymentRequest(value);
        inScope(request.context);
        const result = await refunds.refundPayment(request);
        // Compensation consumes the common Provider Snapshot contract (the intent's refunded
        // total), exactly as with the simulator; ordinary refunds consume the refund evidence.
        if (request.idempotencyKey !== "compensation-refund:" + request.context.operationReference)
          return result;
        if (result.kind !== "RefundObservation") return unknown(request.context);
        return intents.retrieveIntent(
          createRetrieveIntentRequest({
            operation: "RetrieveIntent",
            purpose: "RetrievePaymentIntent",
            context: request.context,
            providerIntentReference: request.providerIntentReference,
          }),
        );
      },
      async lookupRefund(value) {
        inScope(value.context);
        return refunds.lookupRefund(value);
      },
    }),
    /** Client credential for the current Guest's Payment Element (never stored or logged). */
    handoff: createStripeOnlineClientHandoff(options),
    /** Original time of a terminal outcome, as the simulator's `readTerminalOccurrence`. */
    async readTerminalOccurrence(value) {
      inScope(value.context);
      const { occurrence } = await reader.read(value);
      if (occurrence === null) throw Error("PILOT_STRIPE_TERMINAL_UNAVAILABLE");
      return Object.freeze({ status: occurrence.status, occurredAt: occurrence.occurredAt });
    },
    async readTerminalObservation(value, extra = {}) {
      inScope(value.context);
      return reader.read(value, extra);
    },
    /** Best effort: a declined attempt's intent is cancelled so its old credential can't pay. */
    async cancelDeclinedIntent(context, providerIntentReference) {
      inScope(context);
      try {
        return await intents.cancelIntent(
          createCancelIntentRequest({
            operation: "CancelIntent",
            purpose: "CancelPaymentIntent",
            context,
            providerIntentReference,
            idempotencyKey: "cancel-declined:" + context.paymentAttemptReference,
          }),
        );
      } catch {
        return null;
      }
    },
    readCaptureJournal: createStripeCaptureJournal({
      ...options,
      lookbackDays: stripe.captureLookbackDays,
    }),
    readSettlementWindow: createStripeSettlementWindowSource(options),
    close() {
      // Stateless HTTPS client: nothing to release (the simulator closes its database).
    },
  });
}

/**
 * The configured payment Provider of this installation: Stripe (test mode in InternalTest, live
 * mode in a Pilot Store) when payment.json says so (secret key read from its private file now),
 * otherwise the TEST-ONLY internal simulator. The Stripe mode must be this process's Provider
 * environment, so a Pilot Store never runs on test keys and InternalTest never on live keys.
 */
export async function createPilotPaymentProvider(
  options = {},
  { directory, path, loadProfile, expectedDatabaseName, loadConfig = loadPilotPaymentConfig },
) {
  const environment = currentPilotEnvironment();
  const config = await loadConfig(directory, { environment });
  if (config.provider === "simulated")
    return createInternalSimulatedProvider(options, { path, loadProfile, expectedDatabaseName });
  const profile = await loadProfile();
  if (profile.database !== expectedDatabaseName) throw Error("PILOT_STRIPE_PROFILE_MISMATCH");
  if (config.stripe.environment !== pilotProviderEnvironment())
    throw Error("PILOT_STRIPE_MODE_ENVIRONMENT_MISMATCH");
  return createPilotStripeProvider({
    stripe: config.stripe,
    secretKey: await readStripeSecretKey(directory, config.stripe),
    scope: {
      brandReference: profile.binding.brandReference,
      storeReference: profile.binding.storeReference,
    },
  });
}
