import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./pilot-payment-preparation.mjs", () => ({
  createInternalPaymentPreparation: () => ({}),
}));
vi.mock("../../apps/api/dist/customer-checkout-session-read.js", () => ({
  createCustomerCheckoutSessionRead: () => ({ read: mocks.read }),
}));
import { OrderCreationError } from "../../packages/rms/ordering/src/index.ts";
import { createInternalPaymentIntent } from "./pilot-payment-intent.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function payment() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "InternalTest");
  const scope = { brandReference: "brand", storeReference: "store" };
  return createInternalPaymentIntent(
    {
      scope,
      transactions: {},
      now: () => "2026-11-11T12:00:00.000Z",
      credentials: { reference: () => "ref" },
      publicProfile: { binding: { tenantReference: "tenant" } },
    },
    { accessOptions: {} },
    {},
    { simulation: true },
    "DineIn",
    {
      loadWorkflow: async () => ({ environment: "InternalTest", database: "db", scope }),
      expectedDatabaseName: "db",
      controlReference: "control",
    },
  );
}

/**
 * WP-2423 staff-wording-and-expected-refusals: the first round's payment meets the same ordinary
 * refusals (a dish ran out, staff moved the table); information with its own code, not an error.
 */
it.each([
  ["ORDER_CREATE_STOCK_SHORT", "ITEMS_SHORT"],
  ["ORDER_CREATE_TABLE_MOVED", "TABLE_MOVED"],
])("a first-round payment refused with %s is logged as information", async (code, refusal) => {
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const refused = new OrderCreationError(code);
  mocks.read.mockRejectedValueOnce(refused);
  await expect((await payment()).create({})).rejects.toBe(refused);
  expect(error).not.toHaveBeenCalled();
  expect(JSON.parse(info.mock.calls[0][0])).toEqual({
    level: 30,
    time: expect.any(String),
    event: "CUSTOMER_ROUND_REFUSED",
    code: refusal,
  });
});

it("a real failure of a first-round payment is still reported as unexpected", async () => {
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failure = new OrderCreationError("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  mocks.read.mockRejectedValueOnce(failure);
  await expect((await payment()).create({})).rejects.toBe(failure);
  expect(info).not.toHaveBeenCalled();
  expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
    event: "CUSTOMER_PAYMENT_INTENT_UNAVAILABLE",
    code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
  });
});
