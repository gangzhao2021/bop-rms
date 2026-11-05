import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
import { logUnexpected, reportUnexpected } from "./pilot-merchant-pickup.mjs";

/**
 * v15 2026-10-31: opening a Store answered 503 and the pilot logged nothing; the database had
 * raised STORE_REFERENCE_SOURCE_INVALID (SQLSTATE 55000). Unexpected failures are logged with
 * their code and, when the message is itself a code, that code too; never other message text,
 * and expected business refusals are not logged.
 */
afterEach(() => vi.restoreAllMocks());
const logged = () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => spy.mock.calls.map(([line]) => JSON.parse(String(line)));
};

it("names a database error's code and its code-shaped message, never other text", () => {
  const lines = logged();
  const database = Object.assign(new Error("STORE_REFERENCE_SOURCE_INVALID"), { code: "55000" });
  reportUnexpected("INTERNAL_STORE_OPENING_UNAVAILABLE", database);
  reportUnexpected(
    "EVENT",
    Object.assign(new Error("guest Sam ordered at table 4"), { code: "23505" }),
  );
  expect(lines().map(({ event, code, reason }) => ({ event, code, reason }))).toEqual([
    {
      event: "INTERNAL_STORE_OPENING_UNAVAILABLE",
      code: "55000",
      reason: "STORE_REFERENCE_SOURCE_INVALID",
    },
    { event: "EVENT", code: "23505", reason: undefined },
  ]);
  expect(JSON.stringify(lines())).not.toContain("Sam");
});

it("logs unexpected failures of a wrapped call and passes expected refusals through silently", async () => {
  const lines = logged();
  class MerchantStoreOpeningError extends Error {
    constructor() {
      super("MERCHANT_STORE_OPENING_PERMISSIONDENIED");
      this.name = "MerchantStoreOpeningError";
    }
  }
  const refused = logUnexpected("E", async () => Promise.reject(new MerchantStoreOpeningError()));
  await expect(refused({})).rejects.toBeInstanceOf(MerchantStoreOpeningError);
  expect(lines()).toEqual([]);
  const broken = logUnexpected("INTERNAL_STORE_OPENING_UNAVAILABLE", async () =>
    Promise.reject(Object.assign(new Error("STORE_REFERENCE_SOURCE_INVALID"), { code: "55000" })),
  );
  await expect(broken({})).rejects.toThrow("STORE_REFERENCE_SOURCE_INVALID");
  expect(lines()).toEqual([
    expect.objectContaining({
      event: "INTERNAL_STORE_OPENING_UNAVAILABLE",
      code: "55000",
      reason: "STORE_REFERENCE_SOURCE_INVALID",
    }),
  ]);
});

it("names a refused Store switch's failing step, never ids or other text (v15 2026-10-31)", () => {
  const lines = logged();
  const refused = new Error("MERCHANT_BFF_STORE_SWITCH_DENIED");
  reportUnexpected("MERCHANT_STORE_SWITCH_DENIED", refused, { step: "Workspace" });
  reportUnexpected("MERCHANT_STORE_SWITCH_DENIED", refused, {
    step: "01909a3c-0000-7000-8000-000000000003",
  });
  expect(lines().map(({ event, step }) => ({ event, step }))).toEqual([
    { event: "MERCHANT_STORE_SWITCH_DENIED", step: "Workspace" },
    { event: "MERCHANT_STORE_SWITCH_DENIED", step: undefined },
  ]);
  expect(JSON.stringify(lines())).not.toContain("01909a3c");
});

it("names a failed outbox consumer and the codes its error wraps (v15 2026-11-01)", () => {
  const lines = logged();
  const cause = Object.assign(new Error("KITCHEN_ROUTING_UNAVAILABLE"), { code: "KITCHEN" });
  const wrapped = new Error("CONSUMER_TEMPORARY_FAILURE", { cause });
  reportUnexpected("OUTBOX_CONSUMER_FAILED", wrapped, {
    step: "OrderConfirmed",
    consumer: "kitchen.confirmed-order:v1",
  });
  reportUnexpected("OUTBOX_CONSUMER_FAILED", new Error("guest Sam"), {
    consumer: "not a consumer name",
  });
  expect(
    lines().map(({ event, code, causes, step, consumer }) => ({
      event,
      code,
      causes,
      step,
      consumer,
    })),
  ).toEqual([
    {
      event: "OUTBOX_CONSUMER_FAILED",
      code: "CONSUMER_TEMPORARY_FAILURE",
      causes: ["KITCHEN"],
      step: "OrderConfirmed",
      consumer: "kitchen.confirmed-order:v1",
    },
    {
      event: "OUTBOX_CONSUMER_FAILED",
      code: "Error",
      causes: undefined,
      step: undefined,
      consumer: undefined,
    },
  ]);
  expect(JSON.stringify(lines())).not.toContain("Sam");
});

it("names the Workflow rule from anywhere in the wrapped chain, never other text (2026-11-05)", () => {
  const lines = logged();
  // The order path as it fails: Ordering wraps Inventory, which wraps Workflow.
  const refused = Object.assign(new Error("Workflow definition is unavailable"), {
    code: "WORKFLOW_DEFINITION_UNAVAILABLE",
    rule: "TwoBrandVersions",
  });
  const inventory = Object.assign(new Error("source", { cause: refused }), {
    code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
  });
  reportUnexpected(
    "EVENT",
    Object.assign(new Error("order", { cause: inventory }), {
      code: "ORDER_CREATE_DEPENDENCY_UNAVAILABLE",
    }),
  );
  reportUnexpected("EVENT", refused);
  reportUnexpected("EVENT", Object.assign(new Error("x"), { code: "C", rule: "guest Sam at 4" }));
  reportUnexpected("EVENT", Object.assign(new Error("x"), { code: "C", rule: 7 }));
  reportUnexpected("EVENT", new Error("no rule here"));
  expect(lines().map(({ causes, rule }) => ({ causes, rule }))).toEqual([
    {
      causes: ["CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE", "WORKFLOW_DEFINITION_UNAVAILABLE"],
      rule: "TwoBrandVersions",
    },
    { causes: undefined, rule: "TwoBrandVersions" },
    { causes: undefined, rule: undefined },
    { causes: undefined, rule: undefined },
    { causes: undefined, rule: undefined },
  ]);
  expect(JSON.stringify(lines())).not.toContain("Sam");
});
