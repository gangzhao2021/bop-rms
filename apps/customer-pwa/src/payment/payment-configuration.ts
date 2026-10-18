/** The payment form this build uses: the internal simulator (test only) or Stripe. */
export function paymentConfiguration() {
  if (
    import.meta.env.VITE_BOP_INTERNAL_SIMULATED_PAYMENT === "1" &&
    typeof window !== "undefined" &&
    window.location.origin === "https://127.0.0.1:4443"
  )
    return { mode: "simulation" as const };
  const key: unknown = import.meta.env.VITE_BOP_STRIPE_PUBLISHABLE_KEY;
  const target: unknown = import.meta.env.VITE_BOP_PAYMENT_RETURN_URL;
  if (
    typeof key !== "string" ||
    typeof target !== "string" ||
    !/^pk_(?:test|live)_[A-Za-z0-9]+$/u.test(key)
  )
    return null;
  try {
    const url = new URL(target);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (typeof window !== "undefined" && url.hostname === window.location.hostname)
    )
      return null;
    return { mode: "stripe" as const, publishableKey: key, returnUrl: url.href };
  } catch {
    return null;
  }
}
