export const internalSimulationOrigin = "https://127.0.0.1:4443";

export type PaymentConfiguration =
  | { readonly mode: "simulation" }
  | { readonly mode: "stripe"; readonly publishableKey: string; readonly returnUrl: string };

/**
 * Validates a Stripe publishable key and return URL. The return URL must be HTTPS, carry no
 * credentials, query or fragment, and point at a host other than the customer app itself.
 */
export function stripePaymentConfiguration(
  key: unknown,
  target: unknown,
  currentHostname: string | undefined,
): PaymentConfiguration | null {
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
      (currentHostname !== undefined && url.hostname === currentHostname)
    )
      return null;
    return { mode: "stripe", publishableKey: key, returnUrl: url.href };
  } catch {
    return null;
  }
}

/** Deployment payment mode served by the customer host; held in memory only, never persisted. */
export interface RuntimePaymentConfiguration {
  readonly payment: PaymentConfiguration;
  readonly internalTestEntry: boolean;
}

interface RuntimeLocation {
  readonly origin: string;
  readonly hostname: string;
}

export const paymentConfigurationPath = "/bff/customer/payment-configuration";

let loaded: RuntimePaymentConfiguration | undefined;

export function runtimePaymentConfiguration(): RuntimePaymentConfiguration | undefined {
  return loaded;
}

/** Test seam: forget the configuration loaded by a previous test. */
export function resetRuntimePaymentConfiguration(): void {
  loaded = undefined;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

export function parseRuntimePaymentConfiguration(
  value: unknown,
  location: RuntimeLocation,
): RuntimePaymentConfiguration | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return undefined;
  if (record.mode === "simulation") {
    if (
      !hasExactKeys(record, ["schemaVersion", "mode", "internalTestEntry"]) ||
      record.internalTestEntry !== true ||
      location.origin !== internalSimulationOrigin
    )
      return undefined;
    return { payment: { mode: "simulation" }, internalTestEntry: true };
  }
  if (record.mode === "stripe") {
    if (
      !hasExactKeys(record, [
        "schemaVersion",
        "mode",
        "publishableKey",
        "returnUrl",
        "internalTestEntry",
      ]) ||
      typeof record.internalTestEntry !== "boolean"
    )
      return undefined;
    const payment = stripePaymentConfiguration(
      record.publishableKey,
      record.returnUrl,
      location.hostname,
    );
    return payment ? { payment, internalTestEntry: record.internalTestEntry } : undefined;
  }
  return undefined;
}

/**
 * Loads the deployment payment mode once at startup. Any failure leaves no runtime configuration,
 * so the build-time configuration applies.
 */
export async function loadRuntimePaymentConfiguration({
  location,
  fetcher,
  timeoutMilliseconds = 5000,
}: {
  readonly location: RuntimeLocation;
  readonly fetcher: typeof fetch;
  readonly timeoutMilliseconds?: number;
}): Promise<RuntimePaymentConfiguration | undefined> {
  loaded = undefined;
  try {
    const response = await fetcher(paymentConfigurationPath, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    if (response.status !== 200) return undefined;
    const text = await response.text();
    if (text.length > 4096) return undefined;
    loaded = parseRuntimePaymentConfiguration(JSON.parse(text), location);
  } catch {
    /* Network failure, timeout or malformed body: the build-time configuration applies. */
  }
  return loaded;
}
