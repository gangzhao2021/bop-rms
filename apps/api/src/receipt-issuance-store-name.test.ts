import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({ snapshot: vi.fn() }));
const id = (n: number) => "0190ec09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-12T12:00:00.000Z";
const scope = { brandReference: id(1), storeReference: id(2) };
const order = {
  orderReference: id(3),
  ...scope,
  batches: [{ orderBatchReference: id(6) }],
  items: [],
};
vi.mock("./receipt-charged-order.js", () => ({
  receiptChargedOrder: async (_tx: unknown, _scope: unknown, value: unknown) => value,
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresReceiptStoreIdentitySource: () => ({
    resolve: async () => ({ storeDisplayName: "Store record name", currencyCode: "CAD" }),
  }),
}));
vi.mock("@bop/operating-entity", () => ({
  createPostgresReceiptIssuerSource: () => ({
    resolve: async () => ({ operatingEntityReference: id(7), legalName: "Synthetic Issuer Ltd." }),
  }),
}));
vi.mock("@rms/payment", () => ({
  createPostgresPaymentReceiptCoverageSource: () => ({
    resolve: async () => ({
      batches: [{ orderBatchReference: id(6) }],
      captured: { amountMinor: 0n, currencyCode: "CAD" },
      tip: { amountMinor: 0n, currencyCode: "CAD" },
      refunded: { amountMinor: 0n, currencyCode: "CAD" },
      refundDisposition: "NonePending",
    }),
  }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  parseReceiptOrderSnapshot: (value: unknown) => value,
  createOriginalReceiptSnapshotFromCurrentOrder: ports.snapshot,
}));
import { createReceiptIssuanceSources } from "./receipt-issuance-sources.js";

function source(storeDisplayName: string | null | undefined) {
  return createReceiptIssuanceSources({
    scope: {
      tenantReference: id(8),
      ...scope,
      providerAccountReference: id(5),
      environment: "Test",
    },
    authorize: async () => true,
    order: async () => order,
    template: async () => ({
      evidenceReference: id(9),
      evidenceDigest: "sha256:" + "a".repeat(64),
      template: { ...scope, locale: "en-CA", version: "RECEIPT_V1" } as never,
    }),
    receiptDetails: async () => ({
      ...(storeDisplayName === undefined ? {} : { storeDisplayName }),
      businessAddress: null,
      taxRegistrations: [],
    }),
  });
}
const request = { orderReference: id(3), receiptReference: id(4), observedAt: at, freshAfter: at };

beforeEach(() => {
  ports.snapshot.mockReset();
  ports.snapshot.mockReturnValue({ synthetic: true });
});
describe("WP-2423 DEC-STORE-CUSTOMER-NAME: the Store name a new receipt freezes", () => {
  it("is the published name customers see on every page", async () => {
    await source("Maple Noodle House")({ query: vi.fn() } as never, request);
    expect(ports.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        store: expect.objectContaining({ displayName: "Maple Noodle House" }),
      }),
    );
  });
  it("is the Store record name only when no public profile is published", async () => {
    await source(null)({ query: vi.fn() } as never, request);
    expect(ports.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        store: expect.objectContaining({ displayName: "Store record name" }),
      }),
    );
  });
});
