import { ids, digest, candidate } from "./public-store-profile.fixture.js";
import { describe, expect, it, vi } from "vitest";
import {
  createPublicStoreProfileService,
  type PublicStoreProfilePorts,
  type PublicStoreResolutionEvidence,
} from "../index.js";

const request = {
  publicStoreReference: ids.publicStore,
  requestedLocale: "fr-CA",
  evaluatedAt: "2026-01-15T12:00:00.000Z",
  purpose: "CustomerEntry",
};

function resolutionEvidence() {
  return {
    publicStoreReference: ids.publicStore,
    brandReference: ids.brand,
    storeReference: ids.store,
    brandLifecycle: "Active",
    storeLifecycle: "Active",
    lookupEvidenceReference: ids.lookup,
    validUntil: "2026-02-01T00:00:00.000Z",
  } as unknown as PublicStoreResolutionEvidence;
}

function harness(options?: {
  evidence?: PublicStoreResolutionEvidence | null;
  candidates?: unknown;
  resolutionFailure?: boolean;
  profileFailure?: boolean;
}) {
  const calls = { resolution: 0, profiles: 0 };
  const telemetry: unknown[] = [];
  const ports: PublicStoreProfilePorts = {
    resolution: {
      async resolve() {
        calls.resolution += 1;
        if (options?.resolutionFailure) throw new Error("synthetic dependency failure");
        return options && "evidence" in options ? (options.evidence ?? null) : resolutionEvidence();
      },
    },
    profiles: {
      async loadCandidates() {
        calls.profiles += 1;
        if (options?.profileFailure) throw new Error("synthetic dependency failure");
        return options && "candidates" in options ? options.candidates : [candidate()];
      },
    },
    telemetry: { record: (labels) => void telemetry.push(labels) },
  };
  return {
    calls,
    telemetry,
    get: (input: unknown = request) => createPublicStoreProfileService(ports).getPublicStore(input),
  };
}

describe("WP-1000 Store Public Profile Query", () => {
  it("returns one immutable selected-locale Public profile", async () => {
    const test = harness();
    const result = await test.get();
    expect(result).toEqual({
      status: "Available",
      profile: {
        profileReference: ids.profile,
        profileVersion: 1,
        releaseReference: ids.release,
        contentDigest: digest,
        defaultLocale: "en-CA",
        selectedLocale: "fr-CA",
        currencyCode: "CAD",
        timeZone: "UTC",
        brandDisplayName: "Marque synthétique",
        storeDisplayName: "Port synthétique",
        address: {
          countryCode: "CA",
          regionCode: "ON",
          locality: "Exampleville",
          postalCode: "A1A 1A1",
          addressLines: ["100 Example Avenue"],
        },
        businessPhone: "+14165550100",
        website: "https://example.test/store",
        logoAssetVersionReference: ids.assetVersion,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "Available" && Object.isFrozen(result.profile)).toBe(true);
    expect(test.calls).toEqual({ resolution: 1, profiles: 1 });
  });

  it("falls back only to the declared default locale", async () => {
    const result = await harness().get({ ...request, requestedLocale: "es-CA" });
    expect(result.status).toBe("Available");
    if (result.status === "Available") {
      expect(result.profile.selectedLocale).toBe("en-CA");
      expect(result.profile.storeDisplayName).toBe("Synthetic Harbour");
    }
  });

  it.each([
    ["bad reference", { ...request, publicStoreReference: "not-a-reference" }],
    ["bad locale", { ...request, requestedLocale: "EN_ca" }],
    ["bad instant", { ...request, evaluatedAt: "2026-01-15" }],
    ["bad purpose", { ...request, purpose: "Directory" }],
    ["extra field", { ...request, storeReference: ids.store }],
  ])("rejects malformed request before dependencies: %s", async (_name, input) => {
    const test = harness();
    await expect(test.get(input)).resolves.toEqual({ status: "InvalidRequest" });
    expect(test.calls).toEqual({ resolution: 0, profiles: 0 });
  });

  it("does not treat a valid-shaped internal Store ID as public authority", async () => {
    const test = harness();
    await expect(test.get({ ...request, publicStoreReference: ids.store })).resolves.toEqual({
      status: "StoreUnavailable",
    });
    expect(test.calls).toEqual({ resolution: 1, profiles: 0 });
  });

  it.each(["Draft", "Suspended", "Archived"])(
    "uniformly hides %s Tenant lifecycle",
    async (lifecycle) => {
      const evidence = {
        ...resolutionEvidence(),
        storeLifecycle: lifecycle,
      } as unknown as PublicStoreResolutionEvidence;
      const test = harness({ evidence });
      await expect(test.get()).resolves.toEqual({ status: "StoreUnavailable" });
      expect(test.calls).toEqual({ resolution: 1, profiles: 0 });
    },
  );

  it("uniformly hides missing, mismatched and expired resolution evidence", async () => {
    await expect(harness({ evidence: null }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const mismatch = {
      ...resolutionEvidence(),
      publicStoreReference: "00000000-0000-7000-8000-000000000010",
    } as unknown as PublicStoreResolutionEvidence;
    await expect(harness({ evidence: mismatch }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const expired = {
      ...resolutionEvidence(),
      validUntil: request.evaluatedAt,
    } as unknown as PublicStoreResolutionEvidence;
    await expect(harness({ evidence: expired }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("returns unavailable for zero, future, expired and conflicting effective versions", async () => {
    await expect(harness({ candidates: [] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const future = candidate();
    future.effectiveVersion.period.effectiveFrom = {
      instant: "2026-01-16T00:00:00.000Z",
      localDateTime: "2026-01-16T00:00:00.000",
      utcOffsetMinutes: 0,
    };
    await expect(harness({ candidates: [future] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const expired = candidate();
    expired.effectiveVersion.period.effectiveUntil = {
      instant: "2026-01-15T12:00:00.000Z",
      localDateTime: "2026-01-15T12:00:00.000",
      utcOffsetMinutes: 0,
    };
    await expect(harness({ candidates: [expired] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const overlapping = candidate();
    overlapping.effectiveVersion.timingVersionReference = "00000000-0000-7000-8000-000000000011";
    await expect(harness({ candidates: [candidate(), overlapping] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("uses half-open adjacent effective boundaries deterministically", async () => {
    const first = candidate();
    first.effectiveVersion.period.effectiveUntil = {
      instant: request.evaluatedAt,
      localDateTime: "2026-01-15T12:00:00.000",
      utcOffsetMinutes: 0,
    };
    const second = candidate();
    second.effectiveVersion.timingVersionReference = "00000000-0000-7000-8000-000000000011";
    second.effectiveVersion.period.effectiveFrom = {
      instant: request.evaluatedAt,
      localDateTime: "2026-01-15T12:00:00.000",
      utcOffsetMinutes: 0,
    };
    const result = await harness({ candidates: [first, second] }).get();
    expect(result.status).toBe("Available");
  });

  it.each(["Draft", "InReview", "Approved", "Archived", "Superseded"])(
    "rejects %s publishing lifecycle uniformly",
    async (state) => {
      const value = candidate();
      value.publishingLifecycle.state = state;
      await expect(harness({ candidates: [value] }).get()).resolves.toEqual({
        status: "StoreUnavailable",
      });
    },
  );

  it("rejects publishing and scope evidence mismatch", async () => {
    const value = candidate();
    value.publishingRelease.snapshotDigest = `sha256:${"c".repeat(64)}`;
    await expect(harness({ candidates: [value] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const crossStore = candidate();
    crossStore.storeReference = "00000000-0000-7000-8000-000000000010";
    await expect(harness({ candidates: [crossStore] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it.each([
    ["unknown field", () => ({ ...candidate(), internalNote: "hidden" })],
    ["wrong currency", () => ({ ...candidate(), currencyCode: "USD" })],
    [
      "markup",
      () => ({
        ...candidate(),
        localizedFields: {
          ...candidate().localizedFields,
          "en-CA": {
            brandDisplayName: "<b>Synthetic</b>",
            storeDisplayName: "Synthetic Harbour",
          },
        },
      }),
    ],
    ["bad zone", () => ({ ...candidate(), timeZone: "Local/Guess" })],
    ["bad phone", () => ({ ...candidate(), businessPhone: "416-555-0100" })],
    ["unsafe website", () => ({ ...candidate(), website: "https://user:pass@example.test/" })],
    [
      "unknown localized field",
      () => ({
        ...candidate(),
        localizedFields: {
          ...candidate().localizedFields,
          "en-CA": {
            ...candidate().localizedFields["en-CA"],
            privateLabel: "hidden",
          },
        },
      }),
    ],
  ])("fails closed on profile shape: %s", async (_name, createValue) => {
    await expect(harness({ candidates: [createValue()] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("accepts no logo and rejects dynamic, unready and cross-scope Media", async () => {
    const none = candidate();
    none.logo = null as unknown as ReturnType<typeof candidate>["logo"];
    const available = await harness({ candidates: [none] }).get();
    expect(
      available.status === "Available"
        ? available.profile.logoAssetVersionReference
        : "unavailable",
    ).toBeNull();

    const dynamic = candidate();
    dynamic.logo.reference = {
      kind: "Dynamic",
      assetId: ids.asset,
      assetVersionId: null,
    };
    await expect(harness({ candidates: [dynamic] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const unready = candidate();
    unready.logo.version.readinessState = "Pending";
    await expect(harness({ candidates: [unready] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const crossScope = candidate();
    crossScope.logo.asset.scope = {
      kind: "Store",
      brandReference: ids.brand,
      storeReference: "00000000-0000-7000-8000-000000000010",
    };
    await expect(harness({ candidates: [crossScope] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });

    const staleMalformed = candidate();
    staleMalformed.effectiveVersion.period.effectiveUntil = {
      instant: request.evaluatedAt,
      localDateTime: "2026-01-15T12:00:00.000",
      utcOffsetMinutes: 0,
    };
    staleMalformed.logo.reference = {
      kind: "Dynamic",
      assetId: ids.asset,
      assetVersionId: null,
    };
    const current = candidate();
    current.effectiveVersion.timingVersionReference = "00000000-0000-7000-8000-000000000011";
    current.effectiveVersion.period.effectiveFrom = {
      instant: request.evaluatedAt,
      localDateTime: "2026-01-15T12:00:00.000",
      utcOffsetMinutes: 0,
    };
    await expect(harness({ candidates: [staleMalformed, current] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("normalizes dependency exceptions and malformed responses", async () => {
    await expect(harness({ resolutionFailure: true }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    await expect(harness({ profileFailure: true }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    await expect(harness({ candidates: { values: [] } }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("emits only bounded telemetry labels and ignores telemetry failure", async () => {
    const test = harness();
    await test.get();
    expect(test.telemetry).toEqual([
      {
        operation: "GetPublicStore",
        outcome: "AVAILABLE",
        reason: "PROFILE_AVAILABLE",
      },
    ]);
    expect(JSON.stringify(test.telemetry)).not.toContain(ids.publicStore);

    const record = vi.fn(() => {
      throw new Error("synthetic telemetry failure");
    });
    const ports: PublicStoreProfilePorts = {
      resolution: { resolve: async () => resolutionEvidence() },
      profiles: { loadCandidates: async () => [candidate()] },
      telemetry: { record },
    };
    await expect(
      createPublicStoreProfileService(ports).getPublicStore(request),
    ).resolves.toMatchObject({ status: "Available" });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("does not expose internal scope or operating/session authority", async () => {
    const result = await harness().get();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ids.brand);
    expect(serialized).not.toContain(ids.store);
    expect(serialized).not.toMatch(
      /hours|operatingStatus|open|closed|qr|session|permission|internalNote/iu,
    );
  });
});

it("supports explicit CustomerCart consumption of the existing published public branding", async () => {
  const resolve = vi.fn(async () => resolutionEvidence());
  const service = createPublicStoreProfileService({
    resolution: { resolve },
    profiles: { loadCandidates: async () => [candidate()] },
    telemetry: { record: () => undefined },
  });
  expect((await service.getPublicStore({ ...request, purpose: "CustomerCart" })).status).toBe(
    "Available",
  );
  expect(resolve).toHaveBeenCalledWith({
    publicStoreReference: ids.publicStore,
    evaluatedAt: request.evaluatedAt,
    purpose: "CustomerCart",
  });
  const invalid = candidate();
  invalid.publishingLifecycle.purposeCode = "CUSTOMER_CART";
  invalid.publishingRelease.purposeCode = "CUSTOMER_CART";
  invalid.effectiveVersion.purposeCode = "CUSTOMER_CART";
  expect(
    await harness({ candidates: [invalid] }).get({ ...request, purpose: "CustomerCart" }),
  ).toEqual({ status: "StoreUnavailable" });
});
