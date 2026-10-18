import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresPaymentCaptureWindowSource } from "../index.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const input = {
  startsAt: "2026-09-20T08:00:00.000Z",
  endsAt: "2026-09-21T08:00:00.000Z",
  observedAt: "2026-09-22T00:00:00.000Z",
};
function fixture() {
  const rows: Record<string, unknown>[] = [
    {
      reference: id(1),
      brand: id(2),
      store: id(3),
      account: id(4),
      environment: "Test",
      amount: "9007199254740993",
      currency: "CAD",
      occurred_at: new Date(input.startsAt),
      recorded_at: new Date(input.endsAt),
      digest: "sha256:" + "a".repeat(64),
    },
  ];
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM rms_payment") ? rows : [],
    rowCount: 0,
  }));
  const tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true);
  return {
    rows,
    query,
    tx,
    authorize,
    read: createPostgresPaymentCaptureWindowSource({
      scope: {
        brandReference: id(2),
        storeReference: id(3),
        providerAccountReference: id(4),
        environment: "Test",
      },
      authorize,
    }),
  };
}
it("reads exact bigint captures using occurrence range and recorded observation cutoff", async () => {
  const f = fixture(),
    r = await f.read(f.tx, input);
  expect(r.capturedAmountMinor).toBe(9007199254740993n);
  expect(r.captureCount).toBe(1);
  expect(f.query.mock.calls[1]?.[0]).toContain(
    "occurred_at >= $5 AND occurred_at < $6 AND recorded_at <= $7",
  );
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each([
  { brand: id(9) },
  { account: id(9) },
  { environment: "Live" },
  { amount: "1.2" },
  { currency: "USD" },
  { occurred_at: new Date(input.endsAt) },
  { recorded_at: new Date("2026-09-23T00:00:00.000Z") },
])("rejects malformed or out-of-scope stored evidence %j", async (change) => {
  const f = fixture();
  f.rows[0] = { ...f.rows[0], ...change };
  await expect(f.read(f.tx, input)).rejects.toThrow();
});
it("rejects duplicate facts and overflow instead of double counting or truncating", async () => {
  const f = fixture();
  f.rows.push({ ...f.rows[0] });
  await expect(f.read(f.tx, input)).rejects.toThrow();
  f.rows.length = 100001;
  await expect(f.read(f.tx, input)).rejects.toThrow();
});
it("rejects current authorization loss and incomplete window", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.tx, input)).rejects.toThrow();
  await expect(f.read(f.tx, { ...input, observedAt: input.startsAt })).rejects.toThrow();
});
it("returns an actual empty source with zero counts", async () => {
  const f = fixture();
  f.rows.length = 0;
  expect(await f.read(f.tx, input)).toMatchObject({ captureCount: 0, capturedAmountMinor: 0n });
});
