import { afterEach, describe, expect, it, vi } from "vitest";
import { paymentConfiguration } from "./payment-configuration.js";
import {
  loadRuntimePaymentConfiguration,
  paymentConfigurationPath,
  resetRuntimePaymentConfiguration,
  runtimePaymentConfiguration,
} from "./payment-runtime-configuration.js";

const local = { origin: "https://127.0.0.1:4443", hostname: "127.0.0.1" };
const hosted = { origin: "https://order.example.test", hostname: "order.example.test" };
const key = "pk_test_Abc123";
const returnUrl = "https://pay.example.test/return";
const stripe = { schemaVersion: 1, mode: "stripe", publishableKey: key, returnUrl };
const simulation = { schemaVersion: 1, mode: "simulation", internalTestEntry: true };

function jsonFetcher(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    ),
  );
}

afterEach(() => {
  resetRuntimePaymentConfiguration();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("runtime payment configuration", () => {
  it("requests the same-origin endpoint without caching", async () => {
    const fetcher = jsonFetcher(simulation);
    await loadRuntimePaymentConfiguration({ location: local, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] ?? [];
    expect(path).toBe(paymentConfigurationPath);
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).toBeUndefined();
  });

  it("accepts the internal simulation on the local InternalTest origin", async () => {
    const result = await loadRuntimePaymentConfiguration({
      location: local,
      fetcher: jsonFetcher(simulation),
    });
    expect(result).toEqual({ payment: { mode: "simulation" }, internalTestEntry: true });
    vi.stubGlobal("window", { location: local });
    expect(paymentConfiguration()).toEqual({ mode: "simulation" });
  });

  it("refuses the simulation on any other origin and falls back to the build", async () => {
    vi.stubEnv("VITE_BOP_INTERNAL_SIMULATED_PAYMENT", "1");
    vi.stubGlobal("window", { location: hosted });
    const result = await loadRuntimePaymentConfiguration({
      location: hosted,
      fetcher: jsonFetcher(simulation),
    });
    expect(result).toBeUndefined();
    expect(runtimePaymentConfiguration()).toBeUndefined();
    expect(paymentConfiguration()).toBeNull();
  });

  it.each([true, false])("accepts Stripe with internalTestEntry %s", async (entry) => {
    const result = await loadRuntimePaymentConfiguration({
      location: hosted,
      fetcher: jsonFetcher({ ...stripe, internalTestEntry: entry }),
    });
    expect(result).toEqual({
      payment: { mode: "stripe", publishableKey: key, returnUrl, wallets: false },
      internalTestEntry: entry,
    });
    vi.stubGlobal("window", { location: hosted });
    expect(paymentConfiguration()).toEqual({
      mode: "stripe",
      publishableKey: key,
      returnUrl,
      wallets: false,
    });
  });

  it.each([true, false])("carries the host's wallet decision %s", async (wallets) => {
    const result = await loadRuntimePaymentConfiguration({
      location: hosted,
      fetcher: jsonFetcher({ ...stripe, internalTestEntry: false, wallets }),
    });
    expect(result?.payment).toEqual({ mode: "stripe", publishableKey: key, returnUrl, wallets });
  });

  it("accepts a live publishable key", async () => {
    const result = await loadRuntimePaymentConfiguration({
      location: hosted,
      fetcher: jsonFetcher({ ...stripe, publishableKey: "pk_live_Z9", internalTestEntry: false }),
    });
    expect(result?.payment).toMatchObject({ mode: "stripe", publishableKey: "pk_live_Z9" });
  });

  it.each([
    ["null", null],
    ["array", [simulation]],
    ["string body", "not json"],
    ["wrong schema version", { ...simulation, schemaVersion: 2 }],
    ["missing schema version", { mode: "simulation", internalTestEntry: true }],
    ["unknown mode", { schemaVersion: 1, mode: "cash", internalTestEntry: true }],
    ["simulation extra key", { ...simulation, publishableKey: key }],
    ["simulation without entry", { schemaVersion: 1, mode: "simulation" }],
    ["simulation entry false", { ...simulation, internalTestEntry: false }],
    ["stripe extra key", { ...stripe, internalTestEntry: false, secretKey: "sk_test_x" }],
    ["stripe missing entry", stripe],
    ["stripe entry not boolean", { ...stripe, internalTestEntry: "true" }],
    ["wallets not boolean", { ...stripe, internalTestEntry: false, wallets: "yes" }],
    ["secret key", { ...stripe, publishableKey: "sk_test_Abc", internalTestEntry: false }],
    ["key with symbols", { ...stripe, publishableKey: "pk_test_a-b", internalTestEntry: false }],
    ["key wrong prefix", { ...stripe, publishableKey: "pk_prod_Abc", internalTestEntry: false }],
    [
      "http return",
      { ...stripe, returnUrl: "http://pay.example.test/r", internalTestEntry: false },
    ],
    [
      "credential return",
      { ...stripe, returnUrl: "https://u:p@pay.example.test/r", internalTestEntry: false },
    ],
    ["query return", { ...stripe, returnUrl: `${returnUrl}?a=1`, internalTestEntry: false }],
    ["hash return", { ...stripe, returnUrl: `${returnUrl}#a`, internalTestEntry: false }],
    ["relative return", { ...stripe, returnUrl: "/return", internalTestEntry: false }],
    [
      "same-host return",
      { ...stripe, returnUrl: "https://order.example.test/return", internalTestEntry: false },
    ],
  ])("rejects %s and falls back to the build", async (_name, body) => {
    vi.stubGlobal("window", { location: hosted });
    const result = await loadRuntimePaymentConfiguration({
      location: hosted,
      fetcher: jsonFetcher(body),
    });
    expect(result).toBeUndefined();
    expect(runtimePaymentConfiguration()).toBeUndefined();
    expect(paymentConfiguration()).toBeNull();
  });

  it.each([201, 202, 404, 500, 503])("ignores a valid body sent with HTTP %s", async (status) => {
    const result = await loadRuntimePaymentConfiguration({
      location: hosted,
      fetcher: jsonFetcher({ ...stripe, internalTestEntry: false }, status),
    });
    expect(result).toBeUndefined();
  });

  it("falls back to the build-time configuration after a network failure", async () => {
    vi.stubEnv("VITE_BOP_STRIPE_PUBLISHABLE_KEY", "pk_test_Build1");
    vi.stubEnv("VITE_BOP_PAYMENT_RETURN_URL", returnUrl);
    vi.stubGlobal("window", { location: hosted });
    const fetcher = vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("offline")));
    expect(await loadRuntimePaymentConfiguration({ location: hosted, fetcher })).toBeUndefined();
    expect(paymentConfiguration()).toEqual({
      mode: "stripe",
      publishableKey: "pk_test_Build1",
      returnUrl,
      wallets: false,
    });
  });

  it("gives up after the timeout and falls back", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        }),
    );
    const result = await loadRuntimePaymentConfiguration({
      location: hosted,
      fetcher,
      timeoutMilliseconds: 10,
    });
    expect(result).toBeUndefined();
  });

  it("keeps the build-time simulation when no runtime configuration loaded", async () => {
    vi.stubEnv("VITE_BOP_INTERNAL_SIMULATED_PAYMENT", "1");
    vi.stubGlobal("window", { location: local });
    await loadRuntimePaymentConfiguration({ location: local, fetcher: jsonFetcher({}, 404) });
    expect(paymentConfiguration()).toEqual({ mode: "simulation" });
  });

  it("replaces an earlier runtime configuration when a later load fails", async () => {
    await loadRuntimePaymentConfiguration({ location: local, fetcher: jsonFetcher(simulation) });
    expect(runtimePaymentConfiguration()).toBeDefined();
    await loadRuntimePaymentConfiguration({ location: local, fetcher: jsonFetcher({}, 500) });
    expect(runtimePaymentConfiguration()).toBeUndefined();
  });
});
