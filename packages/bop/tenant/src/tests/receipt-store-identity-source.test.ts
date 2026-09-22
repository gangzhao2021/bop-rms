import { describe, expect, it } from "vitest";
import { createPostgresReceiptStoreIdentitySource } from "../infrastructure/persistence/receipt-store-identity-source.js";
const id = (n: number) => "0190ec03-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const at = "2026-09-12T12:00:00.000Z";
const row = {
  ...scope,
  code: "SYNTHETIC",
  displayName: "Synthetic Store",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Active",
  version: 1,
  createdAt: at,
  updatedAt: at,
};
describe("receipt Store identity source", () => {
  it("requires receipt purpose authority before SQL and after the read", async () => {
    let queries = 0,
      checks = 0;
    const transaction = {
      query: async () => {
        queries++;
        return { rows: [row] };
      },
    };
    await expect(
      createPostgresReceiptStoreIdentitySource({ ...scope, authorize: async () => false }).resolve({
        transaction,
        evaluatedAt: at,
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_STORE_PERMISSION_DENIED" });
    expect(queries).toBe(0);
    const source = createPostgresReceiptStoreIdentitySource({
      ...scope,
      authorize: async (_tx, request) => {
        expect(request).toEqual({ ...scope, purpose: "ReceiptIssuance", evaluatedAt: at });
        return ++checks === 1;
      },
    });
    await expect(source.resolve({ transaction, evaluatedAt: at })).rejects.toMatchObject({
      code: "RECEIPT_STORE_PERMISSION_DENIED",
    });
  });
  it("returns canonical identity and version without administrative fields", async () => {
    const source = createPostgresReceiptStoreIdentitySource({
      ...scope,
      authorize: async () => true,
    });
    expect(
      await source.resolve({
        evaluatedAt: at,
        transaction: {
          query: async () => ({
            rows: [
              {
                ...row,
                createdAt: new Date(at),
                updatedAt: new Date(at),
              },
            ],
          }),
        },
      }),
    ).toEqual({
      ...scope,
      purpose: "ReceiptIssuance",
      evaluatedAt: at,
      storeVersion: 1,
      storeDisplayName: "Synthetic Store",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
    });
  });
  it("rejects foreign, inactive, future, malformed or ambiguous owner data", async () => {
    const source = createPostgresReceiptStoreIdentitySource({
      ...scope,
      authorize: async () => true,
    });
    for (const rows of [
      [{ ...row, brandReference: id(9) }],
      [{ ...row, lifecycle: "Suspended" }],
      [{ ...row, updatedAt: "2026-09-13T12:00:00.000Z" }],
      [{ ...row, locale: "invalid" }],
      [row, row],
    ]) {
      await expect(
        source.resolve({ evaluatedAt: at, transaction: { query: async () => ({ rows }) } }),
      ).rejects.toMatchObject({ code: "RECEIPT_STORE_UNAVAILABLE" });
    }
    expect(
      await source.resolve({ evaluatedAt: at, transaction: { query: async () => ({ rows: [] }) } }),
    ).toBeNull();
  });
});
