import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
import { OrderCreationError } from "../../packages/rms/ordering/src/index.ts";
import { createInternalAdditionalPayment } from "./pilot-additional-payment.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function payment(refusal) {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("BOP_PILOT_ENVIRONMENT", "InternalTest");
  const scope = { brandReference: "brand", storeReference: "store" };
  return createInternalAdditionalPayment(
    {
      scope,
      transactions: {},
      now: () => "2026-11-11T12:00:00.000Z",
      credentials: { reference: () => "ref" },
      publicProfile: { binding: { tenantReference: "tenant" } },
    },
    {},
    {},
    {},
    {},
    { simulation: true },
    {
      resolve: async () => {
        throw refusal;
      },
    },
    {
      saved: {
        environment: "InternalTest",
        database: "db",
        scope: { tenantReference: "tenant", ...scope },
        workflow: { payment: {} },
      },
      expectedDatabaseName: "db",
      controlReference: "control",
    },
  );
}

/**
 * WP-2423 staff-wording-and-expected-refusals (v15 2026-11-11): staff moving the table while a guest
 * pays for another round is ordinary service. The guest is told the table moved (the handler's
 * 409 table_moved); the log says so as information with its own code, not as an error.
 */
it("a round refused because staff moved the table is logged as information, not an error", async () => {
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const refusal = new OrderCreationError("ORDER_CREATE_TABLE_MOVED");
  await expect((await payment(refusal)).create({})).rejects.toBe(refusal);
  expect(error).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledTimes(1);
  expect(JSON.parse(info.mock.calls[0][0])).toEqual({
    level: 30,
    time: expect.any(String),
    event: "CUSTOMER_ADDITIONAL_ROUND_REFUSED",
    code: "TABLE_MOVED",
  });
});

it("a real failure of an additional round payment is still logged as an error", async () => {
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const failure = new OrderCreationError("ORDER_CREATE_DEPENDENCY_UNAVAILABLE");
  await expect((await payment(failure)).create({})).rejects.toBe(failure);
  expect(info).not.toHaveBeenCalled();
  expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
    event: "INTERNAL_ADDITIONAL_PAYMENT_UNAVAILABLE",
    code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
  });
});
