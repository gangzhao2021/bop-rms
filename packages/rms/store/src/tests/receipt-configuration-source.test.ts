import { describe, expect, it, vi } from "vitest";
import { createPostgresStoreReceiptConfigurationSource } from "../infrastructure/receipt-configuration-source.js";
const id = (n: number) => "0190ed13-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-13T00:00:00.000Z";
describe("current Store receipt configuration", () => {
  const source = (allowed: boolean) =>
    createPostgresStoreReceiptConfigurationSource({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      timeZone: "America/Toronto",
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "RECEIPT_ISSUANCE",
      requiredLiveGateRequirementCodes: ["STORE_READY"],
      authorize: async () => allowed,
      hashContent: () => "sha256:" + "a".repeat(64),
    });
  it("does not read a configuration when current permission is denied", async () => {
    const query = vi.fn();
    await expect(source(false)({ query }, at)).rejects.toThrow(
      "STORE_RECEIPT_CONFIGURATION_UNAVAILABLE",
    );
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects missing current configuration instead of accepting a supplied receipt default", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(source(true)({ query }, at)).rejects.toThrow(
      "STORE_RECEIPT_CONFIGURATION_UNAVAILABLE",
    );
  });
});
