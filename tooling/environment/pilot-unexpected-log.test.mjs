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
