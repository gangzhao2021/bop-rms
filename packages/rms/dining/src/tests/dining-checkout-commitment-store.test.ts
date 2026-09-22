import { expect, it } from "vitest";
import { createPostgresDiningCheckoutCommitmentStore } from "../infrastructure/persistence/dining-checkout-commitment-store.js";
const id = (n: number) => "01902402-0000-7000-8000-" + n.toString().padStart(12, "0");
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const clock = { now: () => "2026-09-10T12:00:00.000Z" };
it("normalizes a driver failure without exposing its detail or cause", async () => {
  const owner = createPostgresDiningCheckoutCommitmentStore(
    {
      run: async () => {
        throw new Error("synthetic unrestricted driver detail");
      },
    },
    scope,
    clock,
  );
  try {
    await owner.load(id(4));
    throw new Error("expected denial");
  } catch (error) {
    expect(error).toMatchObject({
      code: "DINING_CHECKOUT_STORE_UNAVAILABLE",
      message: "dining checkout storage is unavailable",
    });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("driver detail");
  }
});
it("captures requests without invoking getters or opening a transaction", async () => {
  let reads = 0,
    transactions = 0;
  const owner = createPostgresDiningCheckoutCommitmentStore(
    {
      run: async () => {
        transactions++;
        throw new Error("unexpected transaction");
      },
    },
    scope,
    clock,
  );
  const input = {
    expectedVersion: 0,
    audit: {},
    get record() {
      reads++;
      return {};
    },
  };
  await expect(owner.append(input)).rejects.toMatchObject({
    code: "DINING_CHECKOUT_STORE_UNAVAILABLE",
  });
  expect(reads).toBe(0);
  expect(transactions).toBe(0);
});
it("rejects a malformed historical row without returning unchecked dependency data", async () => {
  const owner = createPostgresDiningCheckoutCommitmentStore(
    {
      run: async (action) =>
        action({
          query: async (sql) => ({
            rows: sql.startsWith("SELECT record_json") ? [{ record: {}, version: "1" }] : [],
          }),
        }),
    },
    scope,
    clock,
  );
  await expect(owner.load(id(4))).rejects.toMatchObject({ code: "DINING_CHECKOUT_INPUT_INVALID" });
});
it("rejects oversized historical results", async () => {
  const owner = createPostgresDiningCheckoutCommitmentStore(
    {
      run: async (action) =>
        action({
          query: async (sql) => ({
            rows: sql.startsWith("SELECT record_json") ? [{}, {}, {}, {}] : [],
          }),
        }),
    },
    scope,
    clock,
  );
  await expect(owner.load(id(4))).rejects.toMatchObject({
    code: "DINING_CHECKOUT_STORE_UNAVAILABLE",
  });
});
it("rejects database result accessors without executing them", async () => {
  let reads = 0;
  const owner = createPostgresDiningCheckoutCommitmentStore(
    {
      run: async (action) =>
        action({
          query: async (sql) =>
            sql.startsWith("SELECT record_json")
              ? {
                  get rows() {
                    reads++;
                    return [];
                  },
                }
              : { rows: [] },
        }),
    },
    scope,
    clock,
  );
  await expect(owner.load(id(4))).rejects.toMatchObject({
    code: "DINING_CHECKOUT_STORE_UNAVAILABLE",
  });
  expect(reads).toBe(0);
});

it("rejects ambiguous submission lookup instead of selecting an arbitrary commitment", async () => {
  const owner = createPostgresDiningCheckoutCommitmentStore(
    {
      run: async (action) =>
        action({
          query: async (sql) => ({
            rows: sql.startsWith("SELECT commitment_id")
              ? [{ reference: id(5) }, { reference: id(6) }]
              : [],
          }),
        }),
    },
    scope,
    clock,
  );
  await expect(owner.loadSubmission(id(4))).rejects.toMatchObject({
    code: "DINING_CHECKOUT_STORE_UNAVAILABLE",
  });
});
it("requires validated history after a submission locator resolves", async () => {
  const owner = createPostgresDiningCheckoutCommitmentStore(
    {
      run: async (action) =>
        action({
          query: async (sql) => ({
            rows: sql.startsWith("SELECT commitment_id") ? [{ reference: id(5) }] : [],
          }),
        }),
    },
    scope,
    clock,
  );
  await expect(owner.loadSubmission(id(4))).rejects.toMatchObject({
    code: "DINING_CHECKOUT_STORE_UNAVAILABLE",
  });
});
