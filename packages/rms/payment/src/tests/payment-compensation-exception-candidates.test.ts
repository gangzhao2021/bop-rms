import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresPaymentCompensationExceptionCandidates } from "../infrastructure/persistence/payment-compensation-exception-source.js";
const id = (n: number) => "0190fa81-0000-7000-8000-" + String(n).padStart(12, "0");
function fixture(values: unknown[] = [id(10), id(11), id(12)]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("case_history") ? values.map((case_reference) => ({ case_reference })) : [],
    rowCount: 0,
  }));
  const tx = { query } as unknown as ConsumerTransaction;
  const authorize = vi.fn(async () => true);
  const read = createPostgresPaymentCompensationExceptionCandidates({
    scope: { brandReference: id(1), storeReference: id(2) },
    authorize,
  });
  return { query, tx, authorize, read };
}
it("discovers distinct scoped history including closed cases with a lookahead cursor", async () => {
  const f = fixture();
  expect(await f.read(f.tx, { afterCaseReference: id(9), limit: 2 })).toEqual({
    items: [id(10), id(11)],
    nextAfterCaseReference: id(11),
  });
  expect(f.query.mock.calls[1]?.[0]).toContain("SELECT DISTINCT case_id::text");
  expect(f.query.mock.calls[1]?.[0]).not.toMatch(/state|record_json/);
  expect(f.query).toHaveBeenLastCalledWith(expect.stringContaining("brand_id=$1 AND store_id=$2"), [
    id(1),
    id(2),
    id(9),
    3,
  ]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenLastCalledWith(f.tx, {
    brandReference: id(1),
    storeReference: id(2),
    purpose: "DiscoverOrderExceptions",
  });
});
it("terminates empty and exact-size final pages", async () => {
  for (const values of [[], [id(10), id(11)]]) {
    const f = fixture(values);
    expect(await f.read(f.tx, { afterCaseReference: null, limit: 2 })).toEqual({
      items: values,
      nextAfterCaseReference: null,
    });
  }
});
it("rejects invalid limits and cursors before querying", async () => {
  for (const limit of [0, 101, 1.5, NaN]) {
    const f = fixture();
    await expect(f.read(f.tx, { afterCaseReference: null, limit })).rejects.toMatchObject({
      code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
    });
    expect(f.query).not.toHaveBeenCalled();
  }
  const f = fixture();
  await expect(f.read(f.tx, { afterCaseReference: "invalid", limit: 2 })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("refuses duplicate, reversed, cursor-repeating, malformed and oversized results", async () => {
  for (const values of [
    [id(10), id(10)],
    [id(11), id(10)],
    [id(9)],
    ["invalid"],
    [id(10), id(11), id(12), id(13)],
  ]) {
    const f = fixture(values);
    await expect(f.read(f.tx, { afterCaseReference: id(9), limit: 2 })).rejects.toThrow();
  }
});
it("enforces initial authorization and revocation after the read", async () => {
  const denied = fixture();
  denied.authorize.mockResolvedValue(false);
  await expect(
    denied.read(denied.tx, { afterCaseReference: null, limit: 2 }),
  ).rejects.toMatchObject({ code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" });
  expect(denied.query).not.toHaveBeenCalled();
  const revoked = fixture();
  revoked.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    revoked.read(revoked.tx, { afterCaseReference: null, limit: 2 }),
  ).rejects.toMatchObject({ code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" });
});
it("bounds dependency errors without exposing database details", async () => {
  const f = fixture();
  f.query.mockRejectedValue(new Error("private database detail"));
  await expect(f.read(f.tx, { afterCaseReference: null, limit: 2 })).rejects.toMatchObject({
    code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
    message: "payment compensation is unavailable",
  });
});
