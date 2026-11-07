import { describe, expect, it, vi } from "vitest";
import {
  createStorePublicProfileClient,
  StorePublicProfileClientError,
} from "./store-public-profile-client.js";
import {
  formatStorePhone,
  storePublicProfileFieldErrors,
  type StorePublicProfileFields,
} from "./StorePublicProfilePanel.js";

const csrf = "A".repeat(43);
// TEST-ONLY Store facts.
const current = {
  version: 1,
  publishedAt: "2026-10-14T11:00:00.000Z",
  defaultLocale: "en-CA",
  names: [{ locale: "en-CA", storeDisplayName: "DEMO Store" }],
  address: {
    addressLines: ["100 Example Street"],
    locality: "Exampleville",
    regionCode: "ON",
    postalCode: "A1A 1A1",
    countryCode: "CA",
  },
  businessPhone: "+14165550100",
};
const view = {
  observedAt: "2026-10-15T12:00:00.000Z",
  canChange: true,
  locales: ["en-CA"],
  current,
  regionCodes: ["AB", "ON", "QC"],
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const body = {
  expectedVersion: 1,
  operationReference: "01902501-0000-7000-8000-000000000001",
  details: {
    storeDisplayNames: { "en-CA": "Maple Noodle House" },
    address: {
      addressLines: ["100 Example Street"],
      locality: "Exampleville",
      regionCode: "ON",
      postalCode: "A1A 1A1",
    },
    businessPhone: "(416) 555-0100",
  },
};

describe("WP-2423 DEC-STORE-CUSTOMER-NAME store name and contact client", () => {
  it("loads the published details and publishes what the Owner typed with the version seen", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(200, view))
      .mockResolvedValueOnce(
        json(200, {
          status: "Published",
          current: {
            ...current,
            version: 2,
            names: [{ locale: "en-CA", storeDisplayName: "Maple Noodle House" }],
          },
        }),
      );
    const client = createStorePublicProfileClient({ csrf, fetcher });
    expect((await client.load()).current?.names[0]?.storeDisplayName).toBe("DEMO Store");
    expect((await client.save(body)).version).toBe(2);
    const [url, init] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/merchant/store/public-profile");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-BOP-CSRF"]).toBe(csrf);
    expect(JSON.parse(String(init.body))).toEqual(body);
  });
  it("loads a Store that has not published yet", async () => {
    const client = createStorePublicProfileClient({
      csrf,
      fetcher: vi.fn().mockResolvedValue(json(200, { ...view, current: null })),
    });
    expect((await client.load()).current).toBeNull();
  });
  it.each([
    [403, null, "PermissionDenied"],
    [422, { error: "invalid_details" }, "Invalid"],
    [409, { error: "profile_changed" }, "Conflict"],
    [409, { error: "no_change" }, "NoChange"],
    [503, null, "Unavailable"],
    [500, null, "OutcomeUnknown"],
  ] as const)("answers %i %j as %s", async (status, answer, code) => {
    const client = createStorePublicProfileClient({
      csrf,
      fetcher: vi.fn().mockResolvedValue(json(status, answer)),
    });
    await expect(client.save(body)).rejects.toMatchObject({ code });
  });
  it("treats a lost answer as unknown so the same publication is retried", async () => {
    const client = createStorePublicProfileClient({
      csrf,
      fetcher: vi.fn().mockRejectedValue(new TypeError("offline")),
    });
    await expect(client.save(body)).rejects.toBeInstanceOf(StorePublicProfileClientError);
    await expect(client.save(body)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  });
  it("refuses a malformed view instead of showing invented details", async () => {
    const client = createStorePublicProfileClient({
      csrf,
      fetcher: vi.fn().mockResolvedValue(json(200, { ...view, locales: [] })),
    });
    await expect(client.load()).rejects.toMatchObject({ code: "Unavailable" });
  });
});

describe("store name and contact form rules", () => {
  const fields: StorePublicProfileFields = {
    names: { "en-CA": "Maple Noodle House", "fr-CA": "Maison Maple" },
    addressLines: ["100 Example Street", ""],
    locality: "Exampleville",
    regionCode: "ON",
    postalCode: "a1a1a1",
    phone: "416-555-0100",
  };
  it("accepts ordinary Canadian details", () => {
    expect(storePublicProfileFieldErrors(fields)).toEqual({});
    expect(storePublicProfileFieldErrors({ ...fields, phone: "" })).toEqual({});
  });
  it("names each problem next to its field in plain words", () => {
    const errors = storePublicProfileFieldErrors({
      names: { "en-CA": " ", "fr-CA": "Maple #1" },
      addressLines: ["", "Unit #4"],
      locality: "",
      regionCode: "",
      postalCode: "90210",
      phone: "555-0100",
    });
    expect(Object.keys(errors).sort()).toEqual([
      "line-0",
      "line-1",
      "locality",
      "name-en-CA",
      "name-fr-CA",
      "phone",
      "postalCode",
      "regionCode",
    ]);
    expect(errors["name-fr-CA"]).toContain("no #");
    expect(errors.postalCode).toContain("K1A 0B1");
  });
  it("shows a stored phone number the way people write it", () => {
    expect(formatStorePhone("+14165550100")).toBe("(416) 555-0100");
    expect(formatStorePhone("+442071234567")).toBe("+442071234567");
    expect(formatStorePhone(null)).toBe("");
  });
});
