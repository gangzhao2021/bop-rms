import { describe, expect, it } from "vitest";
import { createPostgresReceiptIssuerSource } from "../infrastructure/persistence/receipt-issuer-source.js";

const id = (n: number) => "0190ec02-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const at = "2026-09-12T12:00:00.000Z";
const row = {
  ...scope,
  assignmentReference: id(3),
  assignmentVersion: 1,
  operatingEntityReference: id(4),
  entityVersion: 2,
  legalName: "Synthetic legal entity",
};

describe("receipt issuer owner source", () => {
  it("denies before SQL and rechecks authorization after source access", async () => {
    let queries = 0;
    const transaction = {
      query: async () => {
        queries++;
        return { rows: [row] };
      },
    };
    const denied = createPostgresReceiptIssuerSource({ ...scope, authorize: async () => false });
    await expect(denied.resolve({ transaction, effectiveAt: at })).rejects.toMatchObject({
      code: "RECEIPT_ISSUER_PERMISSION_DENIED",
    });
    expect(queries).toBe(0);
    let authorizations = 0;
    const revoked = createPostgresReceiptIssuerSource({
      ...scope,
      authorize: async () => ++authorizations === 1,
    });
    await expect(revoked.resolve({ transaction, effectiveAt: at })).rejects.toMatchObject({
      code: "RECEIPT_ISSUER_PERMISSION_DENIED",
    });
  });

  it("returns only receipt facts and binds the authorization purpose", async () => {
    const source = createPostgresReceiptIssuerSource({
      ...scope,
      authorize: async (_tx, request) => {
        expect(request).toEqual({
          ...scope,
          businessFunction: "SalesReceiptIssuer",
          effectiveAt: at,
        });
        return true;
      },
    });
    const result = await source.resolve({
      effectiveAt: at,
      transaction: { query: async () => ({ rows: [{ ...row, settlementReference: id(9) }] }) },
    });
    expect(result).toEqual({ ...row, businessFunction: "SalesReceiptIssuer", effectiveAt: at });
    expect(result).not.toHaveProperty("settlementReference");
  });

  it("rejects ambiguity, foreign scope, malformed versions and dependency failures", async () => {
    const source = createPostgresReceiptIssuerSource({ ...scope, authorize: async () => true });
    for (const rows of [
      [row, row],
      [{ ...row, storeReference: id(9) }],
      [{ ...row, entityVersion: 0 }],
    ]) {
      await expect(
        source.resolve({ effectiveAt: at, transaction: { query: async () => ({ rows }) } }),
      ).rejects.toMatchObject({ code: "RECEIPT_ISSUER_UNAVAILABLE" });
    }
    await expect(
      source.resolve({
        effectiveAt: at,
        transaction: {
          query: async () => {
            throw new Error("synthetic dependency");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_ISSUER_UNAVAILABLE" });
    expect(
      await source.resolve({ effectiveAt: at, transaction: { query: async () => ({ rows: [] }) } }),
    ).toBeNull();
  });
});
