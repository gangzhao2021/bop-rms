import { expect, it, vi } from "vitest";
import { createCurrentBrandConfigurationContentSource } from "./current-brand-configuration-content.js";

it("refuses malformed observation before acquiring owning sources", async () => {
  const withRecordedConfiguration = vi.fn();
  const source = createCurrentBrandConfigurationContentSource({ withRecordedConfiguration });
  const getter = vi.fn(() => "unrestricted");
  const input = Object.defineProperty({}, "brandReference", { get: getter });
  const work = vi.fn();
  await expect(source.withCurrentContent(input as never, work)).rejects.toThrow(
    "CURRENT_BRAND_CONFIGURATION_UNAVAILABLE",
  );
  expect(withRecordedConfiguration).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it("does not replace an unavailable actual owning source with defaults", async () => {
  const withRecordedConfiguration = vi.fn(async () => {
    throw new Error("synthetic unavailable owner");
  });
  const source = createCurrentBrandConfigurationContentSource({ withRecordedConfiguration });
  const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const work = vi.fn();
  await expect(
    source.withCurrentContent(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(20),
        purposeCode: "CATALOG_PRODUCT_CONTENT",
        configurationVersionReference: id(10),
        expectedBrandVersion: 1,
        originalIntentDigest: "sha256:" + "a".repeat(64),
        observedAt: "2026-09-11T10:00:00.000Z",
        validUntil: "2026-09-11T10:00:30.000Z",
      },
      work,
    ),
  ).rejects.toThrow("CURRENT_BRAND_CONFIGURATION_UNAVAILABLE");
  expect(work).not.toHaveBeenCalled();
});
