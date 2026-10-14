import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ getPublicStore: vi.fn(), ports: vi.fn() }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPublicStoreProfileService: () => ({ getPublicStore: f.getPublicStore }),
}));
vi.mock("./persistent-public-store-profile.js", () => ({
  createPersistentPublicStoreProfilePorts: f.ports,
}));
import { readCustomerStoreContact, storeContactJson } from "./customer-store-contact.js";

const publicStoreReference = "0190fa21-0000-7000-8000-000000000004";
const options = {} as Parameters<typeof readCustomerStoreContact>[1];
const tx = { query: vi.fn() } as unknown as Parameters<typeof readCustomerStoreContact>[0];
beforeEach(() => {
  f.getPublicStore.mockResolvedValue({
    status: "Available",
    profile: {
      brandDisplayName: "DEMO Brand",
      storeDisplayName: "DEMO Store",
      businessPhone: "+14165550123",
      website: null,
      address: {
        countryCode: "CA",
        regionCode: "ON",
        locality: "Toronto",
        postalCode: "M5V 1A1",
        addressLines: ["DEMO 100 Test Street"],
      },
    },
  });
});

it("WP-2423 Q10: reads only the published phone and address for the Guest's Store", async () => {
  const contact = await readCustomerStoreContact(
    tx,
    options,
    { publicStoreReference, locale: "en-CA" },
    "2026-10-14T12:00:00.000Z",
  );
  expect(contact).toEqual({
    phone: "+14165550123",
    addressLines: ["DEMO 100 Test Street"],
    locality: "Toronto",
    regionCode: "ON",
    postalCode: "M5V 1A1",
  });
  expect(f.ports).toHaveBeenCalledWith(
    tx,
    options,
    expect.objectContaining({ publicStoreReference, purpose: "CustomerCart" }),
  );
  expect(Object.keys(storeContactJson(contact as NonNullable<typeof contact>))).toEqual([
    "phone",
    "addressLines",
    "locality",
    "regionCode",
    "postalCode",
  ]);
});

it("omits the card instead of inventing facts when the profile is not available", async () => {
  f.getPublicStore.mockResolvedValue({ status: "StoreUnavailable" });
  expect(
    await readCustomerStoreContact(
      tx,
      options,
      { publicStoreReference, locale: "en-CA" },
      "2026-10-14T12:00:00.000Z",
    ),
  ).toBeNull();
});
