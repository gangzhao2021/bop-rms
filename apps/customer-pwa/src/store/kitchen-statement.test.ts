import { describe, expect, it } from "vitest";
import { kitchenStatementText } from "./StoreIdentity.js";
import { parseStoreProfile } from "./store-profile-client.js";

const profile = (kitchenStatement?: unknown) => ({
  schemaVersion: 1,
  store: {
    ...(kitchenStatement === undefined ? {} : { kitchenStatement }),
    storeDisplayName: "Synthetic Store",
    brandDisplayName: "Synthetic Brand",
    timeZone: "America/Toronto",
    address: {
      addressLines: ["1 Test St"],
      locality: "Toronto",
      regionCode: "ON",
      postalCode: "M5V 1A1",
      countryCode: "CA",
    },
    phone: null,
    hours: null,
  },
});

describe("WP-2423 (M178): the kitchen's cross-contact statement for guests", () => {
  it("reads the statement and says it in one sentence; nothing when none is set", () => {
    const read = parseStoreProfile(
      profile({
        handled: [
          { code: "PEANUT", name: "peanuts" },
          { code: "SESAME", name: "sesame" },
        ],
        sharedEquipment: ["Woks", "FryerOil"],
      }),
    );
    expect(kitchenStatementText(read.kitchenStatement)).toBe(
      "Our kitchen uses peanuts, sesame, and shares woks, fryer oil. Any dish may contain traces.",
    );
    expect(kitchenStatementText(parseStoreProfile(profile(null)).kitchenStatement)).toBeNull();
    expect(kitchenStatementText(parseStoreProfile(profile()).kitchenStatement)).toBeNull();
    expect(() =>
      parseStoreProfile(profile({ handled: [], sharedEquipment: ["Our wok"] })),
    ).toThrow();
  });
});
