import { describe, expect, it } from "vitest";
import {
  OrganizationContractError,
  createBrand,
  createStore,
  parseOrganizationVersion,
  transitionBrand,
  transitionStore,
} from "../index.js";

const BRAND = "018f3f7a-8b1c-7a11-8d01-000000000001";
const STORE = "018f3f7a-8b1c-7a11-8d01-000000000002";
const NOW = "2026-07-28T12:00:00.000Z";
const LATER = "2026-07-28T12:01:00.000Z";
const brandInput = () => ({
  brandReference: BRAND,
  code: "NORTH",
  displayName: "Synthetic North",
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Draft",
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});
const storeInput = () => ({
  storeReference: STORE,
  brandReference: BRAND,
  code: "TORONTO_1",
  displayName: "Synthetic Toronto",
  timeZone: "America/Toronto",
  locale: "en-CA",
  currencyCode: "CAD",
  lifecycle: "Draft",
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

describe("Brand and Store aggregate contract", () => {
  it("creates frozen CAD-only aggregates with an immutable Store Brand reference", () => {
    const brand = createBrand(brandInput());
    const store = createStore(storeInput());
    expect(Object.isFrozen(brand)).toBe(true);
    expect(Object.isFrozen(store)).toBe(true);
    expect(store.brandReference).toBe(brand.brandReference);
    expect(store.currencyCode).toBe("CAD");
  });

  it("rejects unknown fields and non-plain input without invoking accessors", () => {
    expect(() => createBrand({ ...brandInput(), secret: "no" })).toThrowError(
      "brand shape is invalid",
    );
    let invoked = false;
    const input = Object.create(null);
    Object.defineProperty(input, "brandReference", {
      enumerable: true,
      get() {
        invoked = true;
        return BRAND;
      },
    });
    expect(() => createBrand(input)).toThrow(OrganizationContractError);
    expect(invoked).toBe(false);
  });

  it("rejects non-CAD currency, malformed UUIDv7, instant, locale, code and time zone", () => {
    for (const input of [
      { ...brandInput(), currencyCode: "USD" },
      { ...brandInput(), brandReference: "not-a-reference" },
      { ...brandInput(), createdAt: "2026-07-28T12:00:00Z" },
      { ...brandInput(), defaultLocale: "EN_ca" },
      { ...brandInput(), code: "lower" },
    ])
      expect(() => createBrand(input)).toThrow(OrganizationContractError);
    expect(() => createStore({ ...storeInput(), timeZone: "Toronto" })).toThrowError(
      "store shape is invalid",
    );
  });

  it("enforces expected version and the closed lifecycle graph", () => {
    const brand = createBrand(brandInput());
    expect(() => transitionBrand(brand, parseOrganizationVersion(2), "Active", LATER)).toThrowError(
      "organization version conflict",
    );
    const active = transitionBrand(brand, parseOrganizationVersion(1), "Active", LATER);
    expect(active).toMatchObject({ lifecycle: "Active", version: 2 });
    expect(brand.lifecycle).toBe("Draft");
    expect(() => transitionBrand(active, parseOrganizationVersion(2), "Draft", LATER)).toThrowError(
      "organization transition is invalid",
    );
  });

  it("rejects time regression and cannot revive an archived Store", () => {
    const store = createStore(storeInput());
    expect(() =>
      transitionStore(store, parseOrganizationVersion(1), "Active", "2026-07-28T11:59:59.000Z"),
    ).toThrowError("organization transition is invalid");
    const archived = transitionStore(store, parseOrganizationVersion(1), "Archived", LATER);
    expect(() =>
      transitionStore(archived, parseOrganizationVersion(2), "Active", LATER),
    ).toThrowError("organization transition is invalid");
  });
});
