import { describe, expect, it, vi } from "vitest";
import { createReceiptIssuanceSources } from "./receipt-issuance-sources.js";

const id = (n: number) => "0190ec09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-12T12:00:00.000Z";
const request = { orderReference: id(3), receiptReference: id(4), observedAt: at, freshAfter: at };
describe("receipt issuance source boundary", () => {
  it("denies unauthorized issuance before owner reads or SQL", async () => {
    const read = vi.fn(async (): Promise<never> => {
      throw new Error("must not read");
    });
    const query = vi.fn();
    const source = createReceiptIssuanceSources({
      scope: {
        tenantReference: id(8),
        brandReference: id(1),
        storeReference: id(2),
        providerAccountReference: id(5),
        environment: "Test",
      },
      authorize: async () => false,
      order: read,
      template: read,
    });
    await expect(source({ query }, request)).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
    });
    expect(read).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects a future freshness boundary before accessing dependencies", async () => {
    const read = vi.fn(async (): Promise<never> => {
      throw new Error("must not read");
    });
    const authorize = vi.fn(async () => true);
    const query = vi.fn();
    const source = createReceiptIssuanceSources({
      scope: {
        tenantReference: id(8),
        brandReference: id(1),
        storeReference: id(2),
        providerAccountReference: id(5),
        environment: "Test",
      },
      authorize,
      order: read,
      template: read,
    });
    await expect(
      source({ query }, { ...request, freshAfter: "2026-09-12T12:00:01.000Z" }),
    ).rejects.toMatchObject({ code: "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE" });
    expect(authorize).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
