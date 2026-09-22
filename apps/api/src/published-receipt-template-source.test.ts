import { describe, expect, it, vi } from "vitest";
import { createPublishedReceiptTemplateSource } from "./published-receipt-template-source.js";
const id = (n: number) => "0190ed16-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T00:00:00.000Z";
describe("published receipt template source admission", () => {
  it.each([false, true])(
    "rejects denied or foreign-scope input before owner reads (%s)",
    async (allowed) => {
      const source = createPublishedReceiptTemplateSource({
        store: {
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          timeZone: "America/Toronto",
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["STORE_READY"],
          authorize: async () => true,
          hashContent: () => "sha256:" + "a".repeat(64),
        },
        templatePublication: {
          tenantReference: id(1),
          templateReference: id(4),
          familyReference: id(5),
          configurationType: "RECEIPT_TEMPLATE",
          purposeCode: "RECEIPT_ISSUANCE",
          authorize: async () => true,
        },
        authorize: async () => allowed,
      });
      const query = vi.fn();
      await expect(
        source(
          { query },
          {
            brandReference: id(2),
            storeReference: allowed ? id(9) : id(3),
            orderReference: id(6),
            receiptReference: id(7),
            observedAt: at,
            freshAfter: at,
            currencyCode: "CAD",
          },
        ),
      ).rejects.toMatchObject({ code: "DIGITAL_RECEIPT_PERMISSION_DENIED" });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("rejects a template publication bound to another Tenant", () => {
    expect(() =>
      createPublishedReceiptTemplateSource({
        store: {
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          timeZone: "America/Toronto",
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["STORE_READY"],
          authorize: async () => true,
          hashContent: () => "sha256:" + "a".repeat(64),
        },
        templatePublication: {
          tenantReference: id(99),
          templateReference: id(4),
          familyReference: id(5),
          configurationType: "RECEIPT_TEMPLATE",
          purposeCode: "RECEIPT_ISSUANCE",
          authorize: async () => true,
        },
        authorize: async () => true,
      }),
    ).toThrow("DIGITAL_RECEIPT_INPUT_INVALID");
  });
});
