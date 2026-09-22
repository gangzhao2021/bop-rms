import { describe, expect, it, vi } from "vitest";
import { createAdditionalReceiptIssuance } from "./additional-receipt-issuance.js";
const id = (n: number) => "0190ec09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-12T12:00:00.000Z";
const request = { orderReference: id(3), observedAt: at, freshAfter: at };
function fixture(allowed: boolean) {
  const read = vi.fn(async (): Promise<never> => {
    throw new Error("source unavailable");
  });
  const identities = vi.fn(() => ({
    recordReference: id(4),
    receiptReference: id(5),
    operationReference: id(6),
  }));
  const issue = createAdditionalReceiptIssuance({
    sources: {
      scope: {
        tenantReference: id(8),
        brandReference: id(1),
        storeReference: id(2),
        providerAccountReference: id(7),
        environment: "Test",
      },
      authorize: async () => allowed,
      order: read,
      template: read,
    },
    authorize: async () => allowed,
    identities,
    audit: read,
  });
  return { issue, identities, read };
}
describe("additional receipt issuance boundary", () => {
  it("rejects a denied issuer before SQL, identity allocation or source reads", async () => {
    const f = fixture(false),
      query = vi.fn();
    await expect(f.issue({ query }, request)).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
    });
    expect(query).not.toHaveBeenCalled();
    expect(f.identities).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it("rejects impossible freshness before starting issuance", async () => {
    const f = fixture(true),
      query = vi.fn();
    await expect(
      f.issue({ query }, { ...request, freshAfter: "2026-09-12T12:00:01.000Z" }),
    ).rejects.toMatchObject({ code: "DIGITAL_RECEIPT_INPUT_INVALID" });
    expect(query).not.toHaveBeenCalled();
    expect(f.identities).not.toHaveBeenCalled();
  });
});
