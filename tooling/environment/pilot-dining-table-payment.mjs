// WP-2423 DEC-DINE-IN-PAY-LATER S4: the guest pays the whole table on their phone, through this
// installation's Provider (Stripe test mode, or the TEST-ONLY simulator in InternalTest, whose
// confirm/decline buttons stand in for the card form). The routes come from the API package
// (its handlers own the HTTP parsing), never from a package imported here.
import {
  CustomerDiningTablePaymentHandler,
  createCustomerDiningTablePayment,
} from "../../apps/api/dist/customer-dining-table-payment.js";
import { createDiningTableOnlinePayments } from "../../apps/api/dist/dining-table-online-payment.js";
import { createRetrieveIntentRequest } from "../../packages/rms/payment/src/index.ts";
import { pilotProviderEnvironment } from "./pilot-environment.mjs";
import { isStripeProvider } from "./pilot-stripe-provider.mjs";

const ROUTE = "/api/v1/dine-in/table-payment";

/** The Provider-backed table payments for this Store (guest routes and the staff stop). */
export function createInternalDiningTablePayments(
  resources,
  provider,
  { providerAccountReference },
) {
  return createDiningTableOnlinePayments({
    scope: {
      tenantReference: resources.publicProfile.binding.tenantReference,
      ...resources.scope,
    },
    providerAccountReference,
    environment: pilotProviderEnvironment(),
    provider,
    transactions: resources.transactions,
    now: resources.now,
    nextReference: resources.credentials.reference,
  });
}

export function registerInternalDiningTablePayment(
  app,
  { resources, checkout, simulator, origin, providerAccountReference },
) {
  const payments = createInternalDiningTablePayments(resources, simulator.adapter, {
    providerAccountReference,
  });
  const port = createCustomerDiningTablePayment({
    access: checkout.accessOptions,
    payments,
    ...(isStripeProvider(simulator) ? { handoff: simulator.handoff } : {}),
    providerEnvironment: pilotProviderEnvironment(),
  });
  const handler = new CustomerDiningTablePaymentHandler({ allowedOrigin: origin, port });
  app.post(ROUTE, ...handler.handler());
  if (isStripeProvider(simulator)) app.post(ROUTE + "/handoff", ...handler.handoffHandler());
  // TEST-ONLY simulator: finish the guest's own open payment, approved or declined.
  if (simulator.simulation === true)
    for (const [path, confirmation] of [
      ["simulation-confirm", "SIMULATE_CAPTURE"],
      ["simulation-fail", "SIMULATE_FAILURE"],
    ])
      app.post(
        ROUTE + "/" + path,
        ...handler.simulationHandler(confirmation, async (attempt) => {
          const request = createRetrieveIntentRequest({
            operation: "RetrieveIntent",
            purpose: "RetrievePaymentIntent",
            context: {
              provider: "Stripe",
              environment: pilotProviderEnvironment(),
              brandReference: resources.scope.brandReference,
              storeReference: resources.scope.storeReference,
              paymentAttemptReference: attempt.onlinePaymentReference,
              operationReference: attempt.operationReference,
            },
            providerIntentReference: attempt.providerIntentReference,
          });
          if (confirmation === "SIMULATE_CAPTURE")
            await simulator.simulateCapture(request, confirmation);
          else await simulator.simulateFailure(request, confirmation);
        }),
      );
}
