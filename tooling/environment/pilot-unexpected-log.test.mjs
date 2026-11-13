import console from "node:console";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logUnexpected, reportUnexpected } from "./pilot-merchant-pickup.mjs";
import {
  createMerchantRequestReporter,
  reportUnexpected as reportPilotUnexpected,
  storeOfDirectory,
} from "./pilot-unexpected.mjs";

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

describe("a merchant request that failed for a reason that is not a refusal (WP-2423 item 10)", () => {
  const missingGrant = () =>
    Object.assign(new Error("permission denied for table membership: guest Sam"), {
      code: "TENANT_DATABASE_TRANSACTION_FAILED",
      diagnostic: { sqlState: "42501", table: "membership", constraint: null, closed: false },
    });

  it("names its route, Store, SQLSTATE and table, never message text", () => {
    const lines = logged();
    createMerchantRequestReporter({ store: "stores/tea" })("/dining/tables", missingGrant());
    expect(lines()).toEqual([
      expect.objectContaining({
        event: "MERCHANT_REQUEST_UNEXPECTED",
        code: "TENANT_DATABASE_TRANSACTION_FAILED",
        route: "/dining/tables",
        store: "stores/tea",
        sqlState: "42501",
        table: "membership",
      }),
    ]);
    expect(JSON.stringify(lines())).not.toContain("Sam");
    expect(JSON.stringify(lines())).not.toContain("permission denied");
  });

  it("reads the identifiers of what a rewrite wraps, and of a failure riding on another error", () => {
    const lines = logged();
    const reporter = createMerchantRequestReporter();
    reporter("/a", Object.assign(new Error("X_UNAVAILABLE"), { cause: missingGrant() }));
    reporter(
      "/b",
      Object.defineProperty(new Error("Y_UNAVAILABLE"), Symbol.for("bop.database.failure"), {
        value: { sqlState: "23514", table: "product", constraint: "guard_check" },
        enumerable: false,
      }),
    );
    expect(
      lines().map(({ route, code, causes, sqlState, table, constraint }) => ({
        route,
        code,
        causes,
        sqlState,
        table,
        constraint,
      })),
    ).toEqual([
      {
        route: "/a",
        code: "X_UNAVAILABLE",
        causes: ["TENANT_DATABASE_TRANSACTION_FAILED"],
        sqlState: "42501",
        table: "membership",
        constraint: undefined,
      },
      {
        route: "/b",
        code: "Y_UNAVAILABLE",
        causes: undefined,
        sqlState: "23514",
        table: "product",
        constraint: "guard_check",
      },
    ]);
  });

  it("drops anything that is not identifier-shaped", () => {
    const lines = logged();
    createMerchantRequestReporter()(
      "/orders/01909a3c-0000 ; drop",
      Object.assign(new Error("safe"), {
        code: "X",
        diagnostic: { sqlState: "not a state", table: "Sam's table", constraint: "x y" },
      }),
    );
    const [line] = lines();
    expect(line.route).toBeUndefined();
    expect(line.sqlState).toBeUndefined();
    expect(line.table).toBeUndefined();
    expect(line.constraint).toBeUndefined();
  });

  it("does not say twice what a wrapper around the service already logged", async () => {
    const lines = logged();
    const failure = missingGrant();
    const wrapped = logUnexpected("INTERNAL_STORE_REPORTS_UNAVAILABLE", async () => {
      throw failure;
    });
    await expect(wrapped({})).rejects.toBe(failure);
    createMerchantRequestReporter()("/reports", failure);
    expect(lines().map(({ event }) => event)).toEqual(["INTERNAL_STORE_REPORTS_UNAVAILABLE"]);
  });

  it("writes a bounded number of lines however often it fails, and says how many", () => {
    const lines = logged();
    let at = 1_000_000;
    const reporter = createMerchantRequestReporter({ now: () => at });
    for (let n = 0; n < 100; n += 1) reporter("/orders", missingGrant());
    expect(lines()).toHaveLength(1);
    // Another route or another failure is its own line.
    reporter("/tables", missingGrant());
    reporter("/orders", new TypeError("a bug"));
    expect(lines()).toHaveLength(3);
    at += 60_000;
    reporter("/orders", missingGrant());
    expect(lines()).toHaveLength(4);
    expect(lines()[3]).toMatchObject({ route: "/orders", suppressed: 99 });
  });

  it("the routing read that every request asks first says so under its own event", () => {
    const lines = logged();
    const reporter = createMerchantRequestReporter({
      event: "PILOT_MERCHANT_STORE_ROUTING_UNAVAILABLE",
    });
    for (let n = 0; n < 50; n += 1) reporter("/store-routing", missingGrant());
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      event: "PILOT_MERCHANT_STORE_ROUTING_UNAVAILABLE",
      route: "/store-routing",
      sqlState: "42501",
    });
  });

  it("names the Store only from a served Store's directory", () => {
    expect(storeOfDirectory("/app/.local/pilot-v15/stores/tea")).toBe("stores/tea");
    expect(storeOfDirectory("/app/.local/pilot-v15/stores/tea/")).toBe("stores/tea");
    expect(storeOfDirectory("/app/.local/pilot-v15")).toBeUndefined();
  });
});

it("v15 b12: a staff send that failed is logged with its level, time and the owner's answer as its cause", () => {
  const lines = logged();
  // The guest pipeline names the owner's answer (a status word) as the cause of its failure.
  const pipeline = new Error("COUNTER_GUEST_PIPELINE_UNAVAILABLE", {
    cause: { code: "VersionConflict" },
  });
  reportUnexpected("INTERNAL_STAFF_DINING_ROUND_UNAVAILABLE", pipeline);
  expect(lines()).toEqual([
    expect.objectContaining({
      level: 50,
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
      event: "INTERNAL_STAFF_DINING_ROUND_UNAVAILABLE",
      code: "COUNTER_GUEST_PIPELINE_UNAVAILABLE",
      causes: ["VersionConflict"],
    }),
  ]);
});

it("v15 b12: a failure carrying a guest's visit cookies or CSRF value logs none of them", () => {
  const lines = logged();
  const guest = "__Host-bop-guest=" + "g".repeat(43),
    visits = "__Host-bop-visits=" + "v".repeat(43),
    csrf = "c".repeat(43);
  const leaky = () =>
    Object.assign(new Error(`cookie ${guest}; ${visits} x-bop-csrf ${csrf}`), {
      headers: { cookie: `${guest}; ${visits}`, "x-bop-csrf": csrf },
      cause: Object.assign(new Error(csrf), { csrf }),
    });
  reportPilotUnexpected("CUSTOMER_CONTACT_REMOVAL_UNAVAILABLE", leaky());
  createMerchantRequestReporter({ store: "stores/demo-2" })("/orders/:orderReference", leaky());
  const text = JSON.stringify(lines());
  expect(lines()).toHaveLength(2);
  for (const canary of [guest, visits, csrf, "__Host-bop", "x-bop-csrf", "cookie"])
    expect(text).not.toContain(canary);
});

describe("WP-2423 (rush-reads-and-orders-changes): a staff request the rush turned away", () => {
  it("is logged as a wait (level 40, HTTP_RETRY_LATER); a real fault stays level 50", async () => {
    const { noteRequestFault, noteRequestShed, runWithRequestAcquireBudget } =
      await import("../../packages/database/src/request-acquire-budget.ts");
    const lines = logged();
    const report = createMerchantRequestReporter({ store: "stores/demo" });
    const acquire = () =>
      Object.assign(new Error("acquire"), { code: "TENANT_DATABASE_ACQUIRE_FAILED" });
    // No connection within the request's wait (a full pool in a burst): a wait.
    await runWithRequestAcquireBudget(1000, async () => {
      noteRequestShed();
      report("/orders", acquire());
      reportPilotUnexpected("INTERNAL_ORDER_QUEUE_UNAVAILABLE", acquire());
    });
    // A database that could not be reached met the same request first: a fault, as before.
    await runWithRequestAcquireBudget(1000, async () => {
      noteRequestFault();
      noteRequestShed();
      report("/kitchen", acquire());
    });
    // Outside any request (a worker), and a request nothing turned away: level 50.
    report("/tables", acquire());
    expect(
      lines().map(({ level, resultCode, event, route }) => ({ level, resultCode, event, route })),
    ).toEqual([
      {
        level: 40,
        resultCode: "HTTP_RETRY_LATER",
        event: "MERCHANT_REQUEST_UNEXPECTED",
        route: "/orders",
      },
      {
        level: 40,
        resultCode: "HTTP_RETRY_LATER",
        event: "INTERNAL_ORDER_QUEUE_UNAVAILABLE",
        route: undefined,
      },
      { level: 50, resultCode: undefined, event: "MERCHANT_REQUEST_UNEXPECTED", route: "/kitchen" },
      { level: 50, resultCode: undefined, event: "MERCHANT_REQUEST_UNEXPECTED", route: "/tables" },
    ]);
  });
});
