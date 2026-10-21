import {
  internalSimulationOrigin,
  runtimePaymentConfiguration,
  stripePaymentConfiguration,
  type PaymentConfiguration,
} from "./payment-runtime-configuration.js";

/** The build-time payment form, used when no runtime configuration was loaded (dev, tests). */
function buildTimePaymentConfiguration(): PaymentConfiguration | null {
  if (
    import.meta.env.VITE_BOP_INTERNAL_SIMULATED_PAYMENT === "1" &&
    typeof window !== "undefined" &&
    window.location.origin === internalSimulationOrigin
  )
    return { mode: "simulation" };
  return stripePaymentConfiguration(
    import.meta.env.VITE_BOP_STRIPE_PUBLISHABLE_KEY,
    import.meta.env.VITE_BOP_PAYMENT_RETURN_URL,
    typeof window !== "undefined" ? window.location.hostname : undefined,
  );
}

/**
 * The payment form this deployment uses: the internal simulator (test only) or Stripe. The
 * runtime configuration loaded at startup wins; otherwise the build-time configuration applies.
 */
export function paymentConfiguration(): PaymentConfiguration | null {
  return runtimePaymentConfiguration()?.payment ?? buildTimePaymentConfiguration();
}
