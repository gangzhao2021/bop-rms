import { describe, expect, it, vi } from "vitest";
import { createPersistentPublicStoreProfileReader } from "./persistent-public-store-profile.js";

const request = {
  publicStoreReference: "01909a1b-0000-7000-8000-000000000001",
  evaluatedAt: "2026-11-04T12:00:00.000Z",
  purpose: "CustomerEntry",
  requestedLocale: "en-CA",
};
const conflict = Object.assign(new Error("conflict"), {
  code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
});

/** Owner 2026-11-04: guests kept seeing "no menu" while a menu was being listed. */
describe("the public store read while the database is busy", () => {
  it("says busy, not gone, when it has no recent answer; any other failure stays unavailable", async () => {
    const run = vi.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(new Error("other"));
    const reader = createPersistentPublicStoreProfileReader({ transactions: { run } } as never);
    await expect(reader.getPublicStore(request)).resolves.toEqual({
      status: "StoreUnavailable",
      busy: true,
    });
    await expect(reader.getPublicStore(request)).resolves.toEqual({ status: "StoreUnavailable" });
  });

  it("answers from a recent read for five minutes, then says busy; a closed Store is forgotten", async () => {
    const available = { status: "Available", profile: { name: "TEST" } };
    let now = 0;
    const run = vi
      .fn()
      .mockResolvedValueOnce(available)
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce({ status: "StoreUnavailable" })
      .mockRejectedValueOnce(conflict);
    const reader = createPersistentPublicStoreProfileReader({
      transactions: { run },
      clock: () => now,
    } as never);
    await expect(reader.getPublicStore(request)).resolves.toBe(available);
    now = 299_000;
    await expect(reader.getPublicStore(request)).resolves.toBe(available);
    now = 301_000;
    await expect(reader.getPublicStore(request)).resolves.toMatchObject({ busy: true });
    await expect(reader.getPublicStore(request)).resolves.toBe(available);
    await expect(reader.getPublicStore(request)).resolves.toEqual({ status: "StoreUnavailable" });
    await expect(reader.getPublicStore(request)).resolves.toMatchObject({ busy: true });
  });
});
