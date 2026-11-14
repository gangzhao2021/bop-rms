import { describe, expect, it } from "vitest";
import {
  normalizeCanadianPostalCode,
  normalizeStoreBusinessPhone,
  parsePublicStoreProfileEdit,
} from "../contracts/public-store-profile-edit.js";
import {
  publicStoreProfileEditOf,
  storeZonedBoundary,
} from "../infrastructure/public-store-profile-publisher.js";
import { parsePublicStoreProfileCandidateShape } from "../contracts/public-store-profile.js";
import { createEffectivePeriod } from "@bop/effective-period";
import { candidate } from "./public-store-profile.fixture.js";

const edit = {
  storeDisplayNames: { "en-CA": "Maple Noodle House", "fr-CA": "Maison des nouilles Maple" },
  address: {
    addressLines: ["  100 King  Street West ", ""],
    locality: "Toronto",
    regionCode: "ON",
    postalCode: "m5v1a1",
  },
  businessPhone: "(416) 555-0100",
};
const invalid = { code: "STORE_PUBLIC_PROFILE_INVALID" };

describe("WP-2423 DEC-STORE-CUSTOMER-NAME Owner edit of the Store public profile", () => {
  it("accepts what an Owner types and stores it in the profile's canonical form", () => {
    expect(parsePublicStoreProfileEdit(edit, ["en-CA", "fr-CA"])).toEqual({
      storeDisplayNames: {
        "en-CA": "Maple Noodle House",
        "fr-CA": "Maison des nouilles Maple",
      },
      address: {
        countryCode: "CA",
        regionCode: "ON",
        locality: "Toronto",
        postalCode: "M5V 1A1",
        addressLines: ["100 King Street West"],
      },
      businessPhone: "+14165550100",
    });
  });
  it("needs exactly one name per language the profile offers", () => {
    expect(() => parsePublicStoreProfileEdit(edit, ["en-CA"])).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() =>
      parsePublicStoreProfileEdit(
        { ...edit, storeDisplayNames: { "en-CA": "Maple", "fr-CA": " " } },
        ["en-CA", "fr-CA"],
      ),
    ).toThrow(expect.objectContaining(invalid));
  });
  it("refuses markup characters, an empty street, a foreign region and unknown fields", () => {
    for (const value of [
      { ...edit, storeDisplayNames: { "en-CA": "<b>Maple</b>", "fr-CA": "Maple" } },
      { ...edit, address: { ...edit.address, addressLines: [" "] } },
      { ...edit, address: { ...edit.address, regionCode: "NY" } },
      { ...edit, address: { ...edit.address, postalCode: "90210" } },
      { ...edit, website: "https://example.test" },
    ])
      expect(() => parsePublicStoreProfileEdit(value, ["en-CA", "fr-CA"])).toThrow(
        expect.objectContaining(invalid),
      );
  });
  it("normalizes Canadian phone numbers and postal codes", () => {
    expect(normalizeStoreBusinessPhone("416-555-0100")).toBe("+14165550100");
    expect(normalizeStoreBusinessPhone("+1 (416) 555 0100")).toBe("+14165550100");
    expect(normalizeStoreBusinessPhone("1 416 555 0100")).toBe("+14165550100");
    expect(normalizeStoreBusinessPhone("  ")).toBeNull();
    expect(normalizeStoreBusinessPhone(null)).toBeNull();
    for (const bad of ["555-0100", "016-555-0100", "call us", "+1 416 055 0100"])
      expect(() => normalizeStoreBusinessPhone(bad)).toThrow(expect.objectContaining(invalid));
    expect(normalizeCanadianPostalCode(" k1a-0b1 ")).toBe("K1A 0B1");
    expect(() => normalizeCanadianPostalCode("D1A 0B1")).toThrow(expect.objectContaining(invalid));
  });
  it("reads back the editable fields of a saved profile", () => {
    const profile = parsePublicStoreProfileCandidateShape({ ...candidate(), logo: null });
    expect(publicStoreProfileEditOf(profile)).toEqual({
      storeDisplayNames: { "en-CA": "Synthetic Harbour", "fr-CA": "Port synthétique" },
      address: profile.address,
      businessPhone: "+14165550100",
    });
  });
  it("starts the new version's effective period at the Store's local time", () => {
    for (const [instant, timeZone] of [
      ["2026-10-15T16:04:05.123Z", "America/Toronto"],
      ["2026-01-15T03:00:00.000Z", "America/Vancouver"],
      ["2026-03-08T07:30:00.000Z", "America/Toronto"],
    ] as const) {
      const effectiveFrom = storeZonedBoundary(instant, timeZone);
      // The Effective Period owner accepts it as an exact local reading of the instant.
      expect(
        createEffectivePeriod({ timeZone, effectiveFrom, effectiveUntil: null } as never)
          .effectiveFrom,
      ).toEqual(effectiveFrom);
    }
    expect(storeZonedBoundary("2026-10-15T16:04:05.123Z", "America/Toronto")).toEqual({
      instant: "2026-10-15T16:04:05.123Z",
      localDateTime: "2026-10-15T12:04:05.123",
      utcOffsetMinutes: -240,
    });
  });
});
