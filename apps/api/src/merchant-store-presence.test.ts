import nodeConsole from "node:console";
import { afterEach, expect, it, vi } from "vitest";
import { createMerchantStorePresence } from "./merchant-store-presence.js";

const scope = {
  brandReference: "0190fa01-0000-7000-8000-000000000001",
  storeReference: "0190fa01-0000-7000-8000-000000000002",
};
afterEach(() => vi.restoreAllMocks());

it("WP-2423 Q9-G1: writes Store presence at most once a minute and never fails the staff read", async () => {
  let now = Date.parse("2026-10-14T12:00:00.000Z");
  const queries: string[] = [];
  const run = vi.fn(async (work: (tx: never) => Promise<unknown>) =>
    work({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 1 };
      },
    } as never),
  );
  const presence = createMerchantStorePresence({
    transactions: { run } as never,
    now: () => new Date(now).toISOString(),
    newReference: () => "0190fa01-0000-7000-8000-000000000003",
  });
  const read = presence.wrap(scope, async (value: number) => value * 2);
  expect(await read(2)).toBe(4);
  expect(run).toHaveBeenCalledTimes(1);
  now += 30_000;
  expect(await read(3)).toBe(6);
  expect(run).toHaveBeenCalledTimes(1);
  now += 31_000;
  await read(1);
  expect(run).toHaveBeenCalledTimes(2);
  // A failed write is logged as a code only, retried on the next read, and the read still answers.
  const error = vi.spyOn(nodeConsole, "error").mockImplementation(() => undefined);
  run.mockRejectedValueOnce(Object.assign(new Error("secret detail"), { code: "XX000" }));
  now += 61_000;
  expect(await read(5)).toBe(10);
  expect(error).toHaveBeenCalledWith(
    JSON.stringify({ event: "STORE_PRESENCE_UNAVAILABLE", code: "XX000" }),
  );
  expect(String(error.mock.calls)).not.toContain("secret");
  await read(5);
  expect(run).toHaveBeenCalledTimes(4);
  // A failing read is not counted as presence.
  await expect(
    presence.wrap(scope, async () => Promise.reject(new Error("denied")))(),
  ).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(4);
  expect(queries.every((sql) => !sql.includes("DELETE"))).toBe(true);
});
