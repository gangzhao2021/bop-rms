import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const composed = vi.hoisted(() => ({ options: null }));
vi.mock("../../apps/api/dist/local-customer-runtime.js", () => ({
  createLocalCustomerRuntime: (options) => {
    composed.options = options;
    return { shutdown: async () => undefined };
  },
}));
vi.mock("../../apps/api/dist/health-readiness.js", () => ({
  HealthReadinessController: function HealthReadinessController(options) {
    this.options = options;
  },
}));
vi.mock("../../apps/api/dist/customer-store-open-gate.js", () => ({
  CustomerStoreClosedError: class extends Error {},
}));
const { createRuntime } = await import("./pilot-api.mjs");

/** Every optional port of the local customer runtime (absent: unavailable or read-only). */
function optionalPorts() {
  const source = readFileSync(
    fileURLToPath(import.meta.resolve("../../apps/api/src/local-customer-runtime.ts")),
    "utf8",
  );
  const body = source.slice(source.indexOf("export interface LocalCustomerRuntimeOptions {"));
  const end = body.indexOf("\n}\n");
  return [...body.slice(0, end).matchAll(/^ {2}readonly (\w+)\?:/gm)].map((match) => match[1]);
}

/**
 * Optional ports the pilot customer runtime leaves out on purpose, each with the port that serves
 * the same route instead. Anything else left out is a route guests reach that cannot work.
 */
const servedOtherwise = {
  merchantRuntime: null, // the merchant API is its own process (pilot-merchant.mjs)
  orderSubmission: "channelOrderSubmission",
  checkoutDetails: "channelCheckoutDetails",
  payment: "paymentIntent",
  diningCart: "catalogDiningCart",
  cartItems: "catalogCartItems",
  cartQuote: "configuredCartQuote",
};

const port = (name) => ({ port: name });
function dependencies() {
  const transactions = port("transactions");
  const resources = {
    publicProfile: { binding: { tenantReference: "tenant", publicStoreReference: "public" } },
    scope: { brandReference: "brand", storeReference: "store" },
    store: { displayName: "Store" },
    credentials: { pickup: port("pickup"), reference: () => "reference" },
    transactions,
    requestAdmission: port("admission"),
    database: { probe: port("probe") },
    stores: port("stores"),
    now: () => "2026-10-17T12:00:00.000Z",
    close: vi.fn(async () => undefined),
  };
  const catalogCartItems = {
    writeTransactions: transactions,
    references: port("references"),
    audit: port("audit"),
  };
  return {
    resources,
    deps: {
      createInternalTestResources: async () => resources,
      createInternalCustomerEntry: async () => ({
        entry: port("entry"),
        diningAdmission: port("diningAdmission"),
        binding: port("binding"),
      }),
      createInternalTestItems: async () => ({ catalogCartItems }),
      createInternalDiningCart: () => ({ catalogDiningCart: port("diningCart") }),
      createInternalChannelQuote: async () => ({
        configuredCartQuote: { pickup: port("q"), dining: port("q") },
      }),
      createInternalCheckout: () => port("checkout"),
      createInternalDiningCheckout: () => ({
        checkoutSessions: port("sessions"),
        preparation: port("preparation"),
        takesOrder: async () => true,
      }),
      createInternalOrder: async () => ({ orderSubmission: port("submission") }),
      createInternalSimulatedProvider: async () => ({ close: vi.fn() }),
      createInternalChannelPayment: () => ({ create: async () => null }),
      createInternalPaymentTerminal: () => ({ resultOptions: port("result") }),
      createInternalPickupReadiness: () => ({ storeOptions: port("readiness") }),
      createInternalPickupProof: () => ({ storeOptions: port("proof") }),
      createInternalCartReplacement: () => port("replacement"),
      createInternalTestCart: () => ({
        cartTransactions: transactions,
        cartBinding: port("cartBinding"),
      }),
      createInternalCheckoutDetails: () => ({
        channelCheckoutDetails: { pickup: port("d"), dining: port("d") },
      }),
      createInternalMenuStoreFacts: async () => port("facts"),
      providerAccountReference: "account",
    },
  };
}

it("WP-2423: the pilot customer runtime wires every optional port, so no guest route stays read-only or unavailable", async () => {
  const { deps } = dependencies();
  await createRuntime({ port: 0 }, deps);
  const options = composed.options;
  const ports = optionalPorts();
  expect(ports).toContain("cartRemoval");
  const missing = ports.filter(
    (name) =>
      options[name] === undefined &&
      !(
        name in servedOtherwise &&
        (servedOtherwise[name] === null || options[servedOtherwise[name]] !== undefined)
      ),
  );
  expect(missing).toEqual([]);
  // Pickup removal uses the same Cart writes, references and audit as adding an item.
  const items = (await deps.createInternalTestItems()).catalogCartItems;
  expect(options.cartRemoval).toEqual({
    writeTransactions: items.writeTransactions,
    references: items.references,
    audit: items.audit,
  });
});
