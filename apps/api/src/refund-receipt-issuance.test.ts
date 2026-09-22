import { it, expect, vi } from "vitest";
import { createRefundReceiptIssuance } from "./refund-receipt-issuance.js";
const id = (n: number) => "0190ec09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T12:00:00.000Z";
const input = { orderReference: id(3), observedAt: at, freshAfter: at };
function fixture() {
  const denied = vi.fn(async () => false);
  const unused = vi.fn(async (): Promise<never> => {
    throw new Error("must not read");
  });
  const identities = vi.fn(() => ({ recordReference: id(7), operationReference: id(8) }));
  return {
    denied,
    unused,
    identities,
    issue: createRefundReceiptIssuance({
      scope: {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(4),
        providerAccountReference: id(5),
        environment: "Test",
      },
      authorize: denied,
      authorizeSources: unused,
      authorizeOrder: unused,
      identities,
      audit: unused,
    }),
  };
}
it("rejects unauthorized refund receipt writes before reads or identity allocation", async () => {
  const f = fixture(),
    query = vi.fn();
  await expect(f.issue({ query }, input)).rejects.toMatchObject({
    code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
  });
  expect(query).not.toHaveBeenCalled();
  expect(f.unused).not.toHaveBeenCalled();
  expect(f.identities).not.toHaveBeenCalled();
});
it("rejects injected amounts and future freshness before authority or SQL", async () => {
  const f = fixture(),
    query = vi.fn();
  for (const value of [
    { ...input, amountMinor: 1n },
    { ...input, freshAfter: "2026-09-13T12:00:01.000Z" },
  ])
    await expect(f.issue({ query }, value)).rejects.toMatchObject({
      code: "DIGITAL_RECEIPT_INPUT_INVALID",
    });
  expect(query).not.toHaveBeenCalled();
  expect(f.denied).not.toHaveBeenCalled();
});
