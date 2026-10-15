import nodeConsole from "node:console";
import { beforeEach, expect, it, vi } from "vitest";

// WP-2423 Q7: the pilot's counter composition. Owner modules are doubles that record what the
// composition hands them; the counter's own rules (opening rule, entry view, details command)
// and the log formatter are the real code.
const seen = vi.hoisted(() => ({
  pipeline: null,
  commands: {},
  operating: null,
  tablePipeline: null,
  tableCode: null,
}));
const named =
  (name) =>
  (...args) => ({ name, args });
vi.mock("../../packages/bop/identity/src/index.ts", () => ({
  GuestSessionService: class {
    authorize = async () => ({ sessionReference: "guest" });
  },
  createPostgresGuestSessionEntryStore: named("guestStore"),
}));
vi.mock("../../packages/rms/catalog/src/index.ts", () => ({
  createCatalogSelectionDisplayQuery: named("display"),
  createCustomerMenuQueryService: named("menu"),
  createPostgresPublishedMenuQueryStore: named("projections"),
}));
vi.mock("../../packages/rms/ordering/src/index.ts", () => ({
  createCustomerCartViewQuery: named("cartView"),
  createPickupCartReadService: named("cartRead"),
  createPostgresAnyCartQuoteReader: named("quotes"),
  createPostgresPickupCartBindingReader: named("bindingReader"),
}));
vi.mock("../../packages/rms/inventory/src/index.ts", () => ({
  createPostgresSubmissionFinalValidationStore: named("finalValidation"),
}));
vi.mock("../../packages/rms/store/src/index.ts", () => ({
  createPostgresPublishedStoreOperatingStatusReader: () => async () => seen.operating,
}));
for (const [path, name] of [
  [
    "../../apps/api/dist/persistent-public-store-profile.js",
    "createPersistentPublicStoreProfileReader",
  ],
  [
    "../../apps/api/dist/customer-cart-binding-composition.js",
    "createCustomerCartBindingComposition",
  ],
  [
    "../../apps/api/dist/customer-cart-item-composition.js",
    "createCustomerCartItemWithCatalogComposition",
  ],
  ["../../apps/api/dist/customer-cart-read-composition.js", "createCustomerCartReadPort"],
  ["../../apps/api/dist/customer-checkout-session-read.js", "createCustomerCheckoutSessionRead"],
  [
    "../../apps/api/dist/customer-order-payment-admission.js",
    "createCustomerOrderPaymentClaimAdmission",
  ],
  [
    "../../apps/api/dist/customer-capacity-payment-admission.js",
    "createCustomerCapacityPaymentClaimAdmission",
  ],
  [
    "../../apps/api/dist/customer-inventory-payment-admission.js",
    "createCustomerInventoryPaymentClaimAdmission",
  ],
  [
    "../../apps/api/dist/customer-payment-workflow-action.js",
    "createCustomerIntactReservationPaymentAction",
  ],
  ["../../apps/api/dist/merchant-counter-menu.js", "createMerchantCounterMenu"],
])
  vi.doMock(path, () => ({ [name]: named(name) }));
vi.mock("../../apps/api/dist/persistent-customer-entry.js", () => ({
  createPersistentCustomerEntryComposition: (options) => ({ name: "entry", options }),
}));
vi.mock("../../apps/api/dist/customer-checkout-session-composition.js", () => ({
  createCustomerCheckoutSessionComposition: (options) => ({ name: "checkoutWrite", options }),
}));
vi.mock("../../apps/api/dist/counter-guest-pipeline.js", async () => {
  const actual = await import("../../apps/api/src/counter-guest-pipeline.ts");
  return {
    counterEntryOperatingReader: actual.counterEntryOperatingReader,
    createCounterGuestPipeline: (options) => {
      seen.pipeline = options;
      return { name: "pipeline" };
    },
  };
});
vi.mock("../../apps/api/dist/merchant-counter-order.js", async () => {
  const actual = await import("../../apps/api/src/merchant-counter-order.ts");
  return {
    counterTakesOrder: actual.counterTakesOrder,
    createMerchantCounterOrder: (options) => {
      seen.commands.order = options;
      return "order";
    },
  };
});
// WP-2423 Q7 slice 2: the staff dine-in round composition.
vi.mock("../../apps/api/dist/merchant-staff-dining-round.js", () => ({
  createMerchantStaffDiningRound: (options) => {
    seen.commands.staffRound = options;
    return "staffRound";
  },
}));
vi.mock("../../apps/api/dist/table-guest-pipeline.js", () => ({
  createStaffTableCode: (options) => {
    seen.tableCode = options;
    return "openTable";
  },
  createStaffTableGuestPipeline: (options) => {
    seen.tablePipeline = options;
    return { name: "tablePipeline" };
  },
}));
vi.mock("../../apps/api/dist/customer-store-open-gate.js", async () => {
  const actual = await import("../../apps/api/src/customer-store-open-gate.ts");
  return { storeTakesOrder: actual.storeTakesOrder };
});
for (const [path, name] of [
  ["../../apps/api/dist/merchant-dining-join-state.js", "createMerchantDiningJoinState"],
  [
    "../../apps/api/dist/customer-dining-join-composition.js",
    "createCustomerDiningJoinComposition",
  ],
  [
    "../../apps/api/dist/customer-dining-binding-composition.js",
    "createCustomerDiningBindingComposition",
  ],
  [
    "../../apps/api/dist/customer-dining-cart-composition.js",
    "createCustomerDiningCartWithCatalogInventoryComposition",
  ],
  [
    "../../apps/api/dist/customer-additional-dining-payment-store.js",
    "createCustomerAdditionalDiningPaymentAdmission",
  ],
])
  vi.doMock(path, () => ({ [name]: named(name) }));
vi.mock("../../packages/rms/dining/src/index.ts", () => ({
  createPostgresDiningTableStore: named("tables"),
}));
vi.mock("../../apps/api/dist/merchant-card-machine-payment.js", () => ({
  createMerchantCardMachinePayment: (options) => {
    seen.commands.payment = options;
    return "payment";
  },
}));
vi.mock("../../apps/api/dist/merchant-card-machine-refund.js", () => ({
  createMerchantCardMachineCancellationRefund: (options) => {
    seen.commands.refund = options;
    return "refund";
  },
}));
vi.mock("./pilot-payment-preparation.mjs", () => ({
  createInternalPaymentPreparation: () => ({ orders: "orders", tips: "tips" }),
}));
vi.mock("./pilot-expiry-cutoff.mjs", () => ({ createInternalExpiryCutoff: () => "cutoff" }));
vi.mock("./pilot-environment.mjs", () => ({
  matchesPilotEnvironment: (value) => value === "InternalTest",
}));

const { createInternalCounterOrder } = await import("./pilot-counter-order.mjs");

const scope = { brandReference: "brand", storeReference: "store" };
const details = { save: vi.fn() };
const pickupSessions = { validate: vi.fn(), name: "pickupCheckoutSessions" };
const sources = {
  qr: "qr",
  admission: "admission",
  binding: "binding",
  operatingReader: {
    readCurrent: async () => ({
      ...scope,
      evaluatedAt: "2026-10-13T18:00:00.000Z",
      state: "TemporarilyClosed",
      availableServiceModes: [],
    }),
  },
};
const customer = {
  createInternalCustomerEntry: async () => ({
    entry: {
      session: { name: "session" },
      persistent: { profile: "profile", transactions: "tx", sources: async () => sources },
    },
  }),
  createInternalTestItems: async (_r, channel) => ({ catalogCartItems: { channel } }),
  createInternalTestCart: () => ({ cartBinding: { ordering: { sourceChannel: "Qr" } } }),
  createInternalDiningCart: () => "diningCart",
  createInternalChannelQuote: async () => ({ configuredCartQuote: { pickup: "pickupQuote" } }),
  createInternalCheckout: () => ({ accessOptions: "access", checkoutSessions: pickupSessions }),
  createInternalCheckoutDetails: vi.fn(() => ({ checkoutDetails: details })),
  createInternalOrder: async () => "orders",
  // Must not be used by the counter: its checkout gate refuses while online ordering is paused.
  createInternalDiningCheckout: () => {
    throw new Error("the counter must not use the customer checkout gate");
  },
};
const resources = {
  scope,
  transactions: { run: async (work) => work({}) },
  now: () => "2026-10-13T18:00:00.000Z",
  credentials: { reference: () => "reference" },
  publicProfile: { binding: { tenantReference: "tenant", publicStoreReference: "public" } },
  operating: {},
  stores: {},
};
const compose = () =>
  createInternalCounterOrder(
    resources,
    { now: resources.now },
    {},
    {
      customer,
      loadPickupWorkflow: async () => ({
        environment: "InternalTest",
        database: "pilot",
        scope,
        workflow: { payment: "workflow" },
      }),
      loadPickupQrToken: async () => "qr",
      expectedDatabaseName: "pilot",
    },
  );

beforeEach(() => {
  seen.pipeline = null;
  seen.commands = {};
  seen.operating = null;
});

it("composes the counter with the customer's checkout details owner (every pickup Order needs one)", async () => {
  await compose();
  expect(customer.createInternalCheckoutDetails).toHaveBeenCalledWith(
    resources,
    expect.objectContaining({ session: { name: "session" } }),
  );
  expect(seen.pipeline.details).toBe(details);
});

it("keeps taking counter orders while online ordering is paused, not after pickup hours", async () => {
  await compose();
  // Checkout is the pickup checkout without the customer's open gate.
  expect(seen.pipeline.checkout).toBeDefined();
  const entry = seen.pipeline.entry.options;
  const counterSources = await entry.sources({}, {});
  expect(await counterSources.operatingReader.readCurrent({})).toMatchObject({
    state: "Open",
    availableServiceModes: ["Pickup"],
  });
  seen.operating = {
    state: "TemporarilyClosed",
    availableServiceModes: [],
    scheduledServiceModes: ["Pickup"],
  };
  expect(await seen.pipeline.takesOrder({ recordedAfterOutage: false })).toBe(true);
  seen.operating = { state: "Closed", availableServiceModes: [], scheduledServiceModes: [] };
  expect(await seen.pipeline.takesOrder({ recordedAfterOutage: false })).toBe(false);
  expect(await seen.pipeline.takesOrder({ recordedAfterOutage: true })).toBe(true);
});

it("logs an unexpected failure as its code and source frames only", async () => {
  await compose();
  const log = vi.spyOn(nodeConsole, "error").mockImplementation(() => undefined);
  try {
    const error = Object.assign(new Error("guest Jane Doe +1 202 555 0123"), {
      code: "ORDER_CREATE_UNAVAILABLE",
    });
    error.stack =
      "Error\n    at select (/app/packages/rms/ordering/src/infrastructure/persistence/order-creation-store.ts:1021:9)";
    seen.commands.order.onUnexpected(error);
    seen.commands.payment.onUnexpected(new Error("CARD_MACHINE_SOMETHING"));
    seen.commands.refund.onUnexpected(new Error("free text"));
    const lines = log.mock.calls.map(([line]) => JSON.parse(line));
    expect(lines).toEqual([
      {
        event: "INTERNAL_COUNTER_ORDER_UNAVAILABLE",
        code: "ORDER_CREATE_UNAVAILABLE",
        frames: [
          "packages/rms/ordering/src/infrastructure/persistence/order-creation-store.ts:1021:9",
        ],
      },
      expect.objectContaining({
        event: "INTERNAL_CARD_MACHINE_PAYMENT_UNAVAILABLE",
        code: "CARD_MACHINE_SOMETHING",
      }),
      expect.objectContaining({ event: "INTERNAL_CARD_MACHINE_REFUND_UNAVAILABLE", code: "Error" }),
    ]);
    expect(log.mock.calls.join("\n")).not.toMatch(/Jane|555|free text/u);
  } finally {
    log.mockRestore();
  }
});

// WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): staff-entered table rounds.
it("composes the staff table round from the dine-in customer path, without the guest open gate", async () => {
  const diningCheckout = vi.fn((_r, _e, _base, options) => ({
    checkoutSessions: { name: "diningCheckoutSessions" },
    preparation: "diningPreparation",
    options,
  }));
  const diningDetails = { save: vi.fn() };
  const payment = { prepare: vi.fn() };
  const owner = { credentials: "diningCredentials", start: vi.fn(), regenerate: vi.fn() };
  const dineInCustomer = {
    ...customer,
    createInternalCustomerEntry: async () => ({
      entry: {
        session: { name: "session" },
        persistent: { profile: "profile", transactions: "tx", sources: async () => sources },
      },
      dining: { currentToken: async (table) => (table === "table-1" ? "table-qr" : null) },
      diningOwner: owner,
      diningAdmission: {
        join: { name: "join" },
        binding: { name: "binding" },
        resolveRequestContext: async () => "abuse",
      },
    }),
    createInternalDiningCart: () => ({ catalogDiningCart: { name: "diningCart" } }),
    createInternalChannelQuote: async () => ({
      configuredCartQuote: { pickup: "pickupQuote", dining: "diningQuote" },
    }),
    createInternalDiningCheckout: diningCheckout,
    createInternalCheckoutDetails: vi.fn((_r, _e, preparation) =>
      preparation === "diningPreparation"
        ? { channelCheckoutDetails: { dining: diningDetails } }
        : { checkoutDetails: details },
    ),
    createInternalCartReplacement: () => "replacement",
    createInternalChannelPayment: vi.fn(async (_r, _b, _d, _p, _o, provider) => {
      expect(provider.simulation).toBe(true);
      // No Provider is ever called for a staff-entered round.
      await expect(provider.adapter.createPaymentIntent({})).rejects.toThrow(
        "INTERNAL_STAFF_ROUND_NO_PROVIDER",
      );
      return payment;
    }),
  };
  const counter = await createInternalCounterOrder(
    resources,
    { now: resources.now },
    {},
    {
      customer: dineInCustomer,
      loadPickupWorkflow: async () => ({
        environment: "InternalTest",
        database: "pilot",
        scope,
        workflow: { payment: "workflow" },
      }),
      loadDiningWorkflow: async () => ({
        environment: "InternalTest",
        database: "pilot",
        scope,
        workflow: { payment: "diningWorkflow" },
      }),
      loadPickupQrToken: async () => "qr",
      expectedDatabaseName: "pilot",
    },
  );
  expect(counter.staffDiningRound).toBe("staffRound");
  // The dine-in checkout without the customer's open gate (the staff rule decides).
  expect(diningCheckout.mock.calls[0]?.[3]).toEqual({ openGate: false });
  const p = seen.tablePipeline;
  expect(p.details).toBe(diningDetails);
  expect(p.quote).toBe("diningQuote");
  expect(p.payment).toBe(payment);
  expect(p.openTable).toBe("openTable");
  expect(await p.tableQrToken("table-1")).toBe("table-qr");
  await expect(p.tableQrToken("table-2")).rejects.toThrow("INTERNAL_TABLE_QR_UNAVAILABLE");
  expect(await p.joinRequest()).toBe("abuse");
  // Entry with the table QR while closed (paper rounds): the staff command's rule decides.
  const entered = await p.entry.options.sources({}, {});
  expect(await entered.operatingReader.readCurrent({})).toMatchObject({
    state: "Open",
    availableServiceModes: ["DineIn"],
  });
  // The dine-in rule: a new round while the Store is open, a paper round at any time.
  seen.operating = { state: "TemporarilyClosed", availableServiceModes: [] };
  expect(await p.takesOrder({ recordedAfterOutage: false })).toBe(true);
  seen.operating = { state: "Closed", availableServiceModes: [] };
  expect(await p.takesOrder({ recordedAfterOutage: false })).toBe(false);
  expect(await p.takesOrder({ recordedAfterOutage: true })).toBe(true);
  // Starting a session or issuing a fresh code goes through the Dining owner's staff commands.
  await seen.tableCode.start({ sessionCookie: "c", csrf: "x" }, { tableReference: "table-1" });
  expect(owner.start).toHaveBeenCalledWith({
    sessionCookie: "c",
    csrf: "x",
    command: { tableReference: "table-1" },
  });
  // The card-machine payment passes the dine-in later-round admission for a later round.
  const admission = seen.commands.payment.admission({
    scope: { tenantReference: "tenant", ...scope },
    preparation: { submissionReference: "submission", guestSessionReference: "guest" },
    allowed: async () => true,
    kind: "DiningAdditional",
  });
  expect(admission.name).toBe("createCustomerAdditionalDiningPaymentAdmission");
  expect(admission.args[0].inventory.workflow).toBe("diningWorkflow");
  // An unexpected failure logs the event name and code only.
  const log = vi.spyOn(nodeConsole, "error").mockImplementation(() => undefined);
  try {
    seen.commands.staffRound.onUnexpected(
      Object.assign(new Error("table T4 guest Jane"), { code: "STAFF_SOMETHING" }),
    );
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      event: "INTERNAL_STAFF_DINING_ROUND_UNAVAILABLE",
      code: "STAFF_SOMETHING",
    });
    expect(log.mock.calls.join("\n")).not.toMatch(/Jane|T4/u);
  } finally {
    log.mockRestore();
  }
});
