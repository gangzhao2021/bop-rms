import { beforeEach, expect, it, vi } from "vitest";

// WP-2423 item 4: one Guest Session binding check runs all of its owner reads in one transaction
// the composition lends to the pickup and table bindings, the Dining participation store and the
// shared binding policy. The owner modules are doubles that record what they were handed.
const seen = vi.hoisted(() => ({ composed: [], stores: [], answer: "Current" }));
vi.mock("./pilot-dining-binding.mjs", () => ({
  createInternalDiningBinding: () => ({ options: { scope: {}, session: {}, now: () => "" } }),
}));
vi.mock("./pilot-dining-join.mjs", () => ({
  createInternalDiningJoinRequestContext: async () => ({}),
}));
vi.mock("../../apps/api/dist/customer-dining-binding-composition.js", () => ({
  createCustomerDiningSessionBinding: (options) => {
    seen.composed.push(options);
    return {
      validate: async (session, at) => {
        // The shared policy reads through the lent runner, as each owner port does.
        await options.repository.runner.run(async () => undefined);
        if (seen.answer instanceof Error) throw seen.answer;
        await options.binding.validate(session, at);
        return seen.answer;
      },
    };
  },
}));
vi.mock("../../packages/rms/dining/src/index.ts", () => ({
  createPostgresDiningGuestBindingStore: (runner, scope) => {
    seen.stores.push({ runner, scope });
    return { runner };
  },
}));
const { createInternalCustomerEntry } = await import("./pilot-customer-entry.mjs");

const tx = { query: async () => ({ rows: [] }) };
let runs = 0;
const runner = {
  run: async (work) => {
    runs += 1;
    return work(tx);
  },
};
const lent = [];
const owners = {
  createInternalPickupEntry: async () => ({
    binding: (r) => ({ validate: async () => (lent.push(["pickup", r]), "Current") }),
    entry: { persistent: {} },
  }),
  createInternalDiningEntries: async () => ({
    binding: (r, options) => ({
      validate: async () => (lent.push(["dining", r, options]), "Current"),
      resolve: async () => null,
    }),
  }),
  createInternalDiningSession: async () => ({
    scope: { tenantReference: "tenant" },
    stores: { join: {} },
    credentials: {},
  }),
  createInternalMerchantSession: async () => ({}),
};
const resources = {
  scope: { brandReference: "brand", storeReference: "store" },
  transactions: runner,
  credentials: { sessions: {} },
  now: () => "2026-10-19T14:00:00.000Z",
};
beforeEach(() => {
  seen.composed = [];
  seen.stores = [];
  seen.answer = "Current";
  lent.length = 0;
  runs = 0;
});

it("runs one binding check in one transaction lent to every owner read", async () => {
  const entry = await createInternalCustomerEntry(resources, owners);
  const at = "2026-10-19T14:00:00.000Z";
  expect(await entry.entry.session.binding.validate({ channel: "DineIn" }, at)).toBe("Current");
  expect(await entry.entry.session.binding.validate({ channel: "Pickup" }, at)).toBe("Current");
  // One outer transaction per check; everything inside joins it.
  expect(runs).toBe(2);
  for (const { runner: store } of seen.stores) {
    let joined = null;
    await store.run(async (inner) => {
      joined = inner;
    });
    expect(joined).toBe(tx);
  }
  expect(runs).toBe(2);
  expect(lent.map(([kind]) => kind)).toEqual(["dining", "pickup"]);
  for (const [, r] of lent) expect(r).not.toBe(runner);
  // The table binding is told it has the check's single transaction.
  expect(lent[0][2]).toEqual({ oneTransaction: true });
  // A fresh composition per check: nothing is carried from one check to the next.
  expect(seen.composed.length).toBe(2);
});

it("answers Unavailable only for what the records say, never for a check that couldn't run", async () => {
  const entry = await createInternalCustomerEntry(resources, owners);
  seen.answer = "Unavailable";
  expect(await entry.entry.session.binding.validate({ channel: "DineIn" }, "t")).toBe(
    "Unavailable",
  );
  // A registration that can't fit the phone's code stays an answer (the phone scans again).
  seen.answer = new Error("DINING_QR_REGISTRATION_INVALID");
  expect(await entry.entry.session.binding.validate({ channel: "DineIn" }, "t")).toBe(
    "Unavailable",
  );
  seen.answer = "Current";
  // v15 2026-11-12: no free connection within the request's budget (a rush) is a passing fault,
  // thrown as one, so the guest is told "busy, try again" and keeps the cart.
  const busy = Object.assign(new Error("TENANT_DATABASE_ACQUIRE_FAILED"), {
    code: "TENANT_DATABASE_ACQUIRE_FAILED",
    diagnostic: { sqlState: "08006" },
  });
  const failing = await createInternalCustomerEntry(
    {
      ...resources,
      transactions: {
        run: async () => {
          throw busy;
        },
      },
    },
    owners,
  );
  const thrown = await failing.entry.session.binding.validate({ channel: "DineIn" }, "t").then(
    () => null,
    (error) => error,
  );
  expect(thrown?.dependencyFailure).toBe(true);
  expect(thrown?.cause).toBe(busy);
});

it("lends a caller's transaction through the same binding (no nested transaction)", async () => {
  const entry = await createInternalCustomerEntry(resources, owners);
  const outer = { query: async () => ({ rows: [] }) };
  const joined = entry.binding({ run: (work) => work(outer) });
  expect(await joined.validate({ channel: "DineIn" }, "t")).toBe("Current");
  expect(runs).toBe(0);
});
