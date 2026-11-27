import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  resolve: vi.fn(),
  readCurrent: vi.fn(),
  publish: vi.fn(),
  publisherOptions: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => ports.resolve,
}));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPostgresPublicStoreProfilePublisher: (options: unknown) => {
    ports.publisherOptions(options);
    return { readCurrent: ports.readCurrent, publish: ports.publish };
  },
}));
import { PublicStoreProfileEditError } from "@rms/store";
import {
  createMerchantStorePublicProfile,
  MerchantStorePublicProfileError,
} from "./merchant-store-public-profile.js";

const id = (n: number) => "0190fb10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-15T12:00:00.000Z";
const profile = {
  profileReference: id(10),
  profileVersion: 2,
  supportedLocales: ["en-CA"],
  defaultLocale: "en-CA",
  localizedFields: { "en-CA": { brandDisplayName: "Brand", storeDisplayName: "Maple House" } },
  address: {
    countryCode: "CA",
    regionCode: "ON",
    locality: "Toronto",
    postalCode: "M5V 1A1",
    addressLines: ["100 King Street West"],
  },
  businessPhone: "+14165550100",
  publishingRelease: { createdAt: at, releaseId: id(11) },
};
function scope(actions: Record<string, boolean> = { "organization.store.publish": true }) {
  return {
    selected: { tenantReference: id(1) },
    context: {
      resolvedAt: at,
      brand: { brandReference: id(2), displayName: "Brand" },
    },
    store: { storeReference: id(3), locale: "en-CA", timeZone: "America/Toronto" },
    actorReference: id(4),
    allowed: vi.fn(async () => true),
    authorizeAction: vi.fn(async (action: string) => ({
      effect: actions[action] === true ? "Allow" : "Deny",
    })),
  };
}
function subject() {
  return createMerchantStorePublicProfile({
    persistence: {
      transactions: { run: async (work: (tx: unknown) => unknown) => work({ query: vi.fn() }) },
    } as never,
    authentication: { authorize: async () => ({ sessionReference: id(5) }) } as never,
  });
}
const command = {
  expectedVersion: 2,
  operationReference: id(20),
  details: {
    storeDisplayNames: { "en-CA": "Maple Noodle House" },
    address: {
      addressLines: ["100 King Street West"],
      locality: "Toronto",
      regionCode: "ON",
      postalCode: "M5V 1A1",
    },
    businessPhone: "(416) 555-0100",
  },
};
beforeEach(() => {
  vi.resetAllMocks();
});

describe("WP-2423 DEC-STORE-CUSTOMER-NAME merchant Store public profile", () => {
  it("shows staff with Store read the published name and whether they may change it", async () => {
    ports.resolve.mockResolvedValue(scope({}));
    ports.readCurrent.mockResolvedValue(profile);
    const view = await subject().read({ sessionCookie: "cookie" });
    expect(ports.resolve).toHaveBeenCalledWith(
      expect.anything(),
      "cookie",
      "organization.store.read",
    );
    expect(view).toMatchObject({
      canChange: false,
      locales: ["en-CA"],
      current: {
        version: 2,
        names: [{ locale: "en-CA", storeDisplayName: "Maple House" }],
        businessPhone: "+14165550100",
      },
    });
    // Only public fields leave the server: no references or publication history.
    expect(JSON.stringify(view)).not.toContain(id(10));
    expect(JSON.stringify(view)).not.toContain(id(11));
  });
  it("offers a first publication in the Store's own language", async () => {
    ports.resolve.mockResolvedValue(scope());
    ports.readCurrent.mockResolvedValue(null);
    await expect(subject().read({ sessionCookie: "cookie" })).resolves.toMatchObject({
      canChange: true,
      locales: ["en-CA"],
      current: null,
    });
  });
  it("refuses staff without Store read", async () => {
    ports.resolve.mockRejectedValue(new Error("STORE_SERVICE_PERMISSION_DENIED"));
    await expect(subject().read({ sessionCookie: "cookie" })).rejects.toMatchObject({
      code: "Denied",
    });
  });
  it("publishes only as the Owner, in the Owner's authorized transaction", async () => {
    ports.resolve.mockResolvedValue(scope());
    ports.publish.mockResolvedValue({ status: "Published", profile });
    const result = await subject()({ sessionCookie: "cookie", csrf: "csrf", command });
    expect(ports.resolve).toHaveBeenCalledWith(
      expect.anything(),
      "cookie",
      "organization.store.publish",
      id(5),
    );
    expect(result).toMatchObject({ status: "Published", current: { version: 2 } });
    const call = ports.publish.mock.calls[0]?.[1];
    expect(call).toMatchObject({
      actorReference: id(4),
      operationReference: id(20),
      expectedVersion: 2,
      recordedAt: at,
      edit: command.details,
      firstPublication: { defaultLocale: "en-CA", timeZone: "America/Toronto" },
    });
    // References derive from the operation, so a retry finds the same publication.
    expect(call.reference("release")).toBe(call.reference("release"));
    expect(call.reference("release")).not.toBe(call.reference("lifecycle"));
    expect(ports.publisherOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
      }),
    );
  });
  it("refuses staff who are not the Owner before anything is written", async () => {
    ports.resolve.mockRejectedValue(new Error("STORE_SERVICE_PERMISSION_DENIED"));
    await expect(
      subject()({ sessionCookie: "cookie", csrf: "csrf", command }),
    ).rejects.toMatchObject({ code: "Denied" });
    expect(ports.publish).not.toHaveBeenCalled();
  });
  it("rejects a malformed command without touching the Store", async () => {
    await expect(
      subject()({ sessionCookie: "cookie", csrf: "csrf", command: { ...command, extra: 1 } }),
    ).rejects.toBeInstanceOf(MerchantStorePublicProfileError);
    await expect(
      subject()({
        sessionCookie: "cookie",
        csrf: "csrf",
        command: { ...command, expectedVersion: -1 },
      }),
    ).rejects.toMatchObject({ code: "Invalid" });
    expect(ports.resolve).not.toHaveBeenCalled();
  });
  it.each([
    ["STORE_PUBLIC_PROFILE_VERSION_CONFLICT", "VersionConflict"],
    ["STORE_PUBLIC_PROFILE_NO_CHANGE", "NoChange"],
    ["STORE_PUBLIC_PROFILE_INVALID", "Invalid"],
    ["STORE_PUBLIC_PROFILE_OPERATION_CONFLICT", "Invalid"],
    ["STORE_PUBLIC_PROFILE_DENIED", "Denied"],
    ["STORE_PUBLIC_PROFILE_UNAVAILABLE", "Unavailable"],
  ] as const)("answers %s as %s", async (code, expected) => {
    ports.resolve.mockResolvedValue(scope());
    ports.publish.mockRejectedValue(new PublicStoreProfileEditError(code));
    await expect(
      subject()({ sessionCookie: "cookie", csrf: "csrf", command }),
    ).rejects.toMatchObject({ code: expected });
  });
});
