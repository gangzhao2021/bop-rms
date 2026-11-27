import { describe, expect, it } from "vitest";
import {
  MerchantStoreOpeningError,
  parseMerchantStoreOpeningCommand,
} from "./merchant-store-opening.js";

const command = {
  operationReference: "01909a2e-1000-7000-8000-000000000010",
  code: "DEMO_02",
  displayName: "DEMO Store 2 – not production",
  timeZone: "America/Vancouver",
  locale: "en-CA",
};
describe("DEC-BRAND-MULTI-STORE-ONE-INSTALLATION: opening a Store", () => {
  it("accepts exactly the opening fields, a Canadian time zone and a Store language", () => {
    expect(parseMerchantStoreOpeningCommand(command)).toEqual(command);
  });
  it("refuses anything else, never trusting a scope or identity from the browser", () => {
    for (const bad of [
      null,
      [],
      { ...command, brandReference: "01909a2e-1000-7000-8000-000000000001" },
      { ...command, storeReference: "01909a2e-1000-7000-8000-000000000002" },
      { ...command, timeZone: "UTC" },
      { ...command, locale: "zh-CN" },
      { ...command, operationReference: "not-a-reference" },
      { ...command, displayName: "" },
      { ...command, displayName: "x".repeat(161) },
    ])
      expect(() => parseMerchantStoreOpeningCommand(bad), JSON.stringify(bad)).toThrow(
        MerchantStoreOpeningError,
      );
  });
});
