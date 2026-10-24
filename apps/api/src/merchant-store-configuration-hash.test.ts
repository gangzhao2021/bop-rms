import { expect, it } from "vitest";
import { isSetupBasedConfiguration } from "./merchant-store-configuration.js";

it("WP-2423 Q4: digests interval content with the publication hash, never parsing it as a configuration", () => {
  const interval = ["11:00:00", "21:30:00", false, ["Pickup"], 0, 0, "ConfigurationMetadata"];
  expect(isSetupBasedConfiguration(interval)).toBe(false);
  expect(isSetupBasedConfiguration([interval])).toBe(false);
  expect(isSetupBasedConfiguration({ localDate: "2026-12-25" })).toBe(false);
  expect(isSetupBasedConfiguration(null)).toBe(false);
  expect(isSetupBasedConfiguration("2026-12-25")).toBe(false);
});
