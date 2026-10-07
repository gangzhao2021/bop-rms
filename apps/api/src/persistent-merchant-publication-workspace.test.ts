import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createStoreConfigurationVersion } from "@rms/store";
import { parseMerchantWorkspaceSnapshot } from "./merchant-bff.js";
import {
  createPersistentMerchantBffService,
  type PersistentMerchantBffOptions,
} from "./persistent-merchant-bff.js";

const mocks = vi.hoisted(() => ({
  selected: vi.fn(),
  session: vi.fn(),
  proof: vi.fn(),
  operating: vi.fn(),
  allowed: vi.fn(),
}));
// Controlled identity and owner leaves exercise the real workspace composition;
// these assertions do not establish native IAM or released approval evidence.
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  BrowserSessionService: class {
    async bootstrap() {
      return { session: await mocks.session(), csrf: "controlled" };
    }
  },
  createPostgresBrowserSessionStore: () => ({}),
  createPostgresCurrentBrowserSessionSource: () => mocks.session,
}));
vi.mock("./merchant-selected-context.js", () => ({
  createMerchantSelectedContext: () => mocks.selected,
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<typeof import("@bop/membership")>()),
  createPostgresCurrentMembershipSource: () => ({
    findMemberships: async () => [],
    findStoreAssignments: async () => [],
  }),
  resolveActiveMembership: () => ({ membershipReference: "controlled" }),
  resolveActiveStoreAssignment: () => ({}),
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresCurrentPermissionPolicySource: () => ({ authorize: mocks.allowed }),
}));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPostgresCurrentStorePublicationProof: mocks.proof,
  createPostgresStoreOperatingStatusReader: mocks.operating,
}));
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z";
function configuration(modern = true) {
  const plain = {
    configurationReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    addressReference: id(5),
    contactReference: id(6),
    receiptReference: id(7),
    taxConfigurationReference: id(8),
    paymentConfigurationReference: id(9),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({
      isoWeekday: i + 1,
      intervals:
        i === 0
          ? [
              {
                startLocalTime: "09:00:00",
                endLocalTime: "17:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 0,
                leadTimeSeconds: 0,
              },
            ]
          : [],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "INTERNAL_TEST",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: id(12),
    publicationReference: id(13),
    liveGateEvidenceReference: id(14),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  return createStoreConfigurationVersion({
    ...plain,
    ...(modern
      ? {
          setupBasis: {
            profile: "StoreSetupConfigurationBasisV2",
            tenantReference: id(16),
            setupDraftReference: id(15),
            sourceRevision: 1,
            sourceSnapshotDigest: `sha256:${"a".repeat(64)}`,
            feeContexts: ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
              chargeType,
              state: "Disabled",
            })),
          },
        }
      : {}),
  });
}
type ProofOptions = Parameters<
  typeof import("@rms/store").createPostgresCurrentStorePublicationProof
>[0];
beforeEach(() => vi.resetAllMocks());
function runtime(modern: boolean, inventory?: readonly string[]) {
  const candidate = configuration(modern);
  const tx = { query: async () => ({ rows: [] }) };
  const scope = { brandLabel: "Brand", storeLabel: "Store", storeReference: id(3) };
  mocks.session.mockResolvedValue({ sessionReference: id(20) });
  mocks.selected.mockResolvedValue({
    tenantReference: id(16),
    context: {
      actor: { actorReference: id(10) },
      brand: { brandReference: id(2), displayName: "Brand" },
      store: { storeReference: id(3), displayName: "Store", timeZone: "America/Toronto" },
      resolvedAt: at,
    },
  });
  mocks.allowed.mockResolvedValue({ effect: "Allow" });
  let captured: ProofOptions | undefined;
  mocks.proof.mockImplementation((options: ProofOptions) => {
    captured = options;
    return async (actual: unknown, observedAt: string) => {
      expect(actual).toBe(tx);
      expect(observedAt).toBe(at);
      return {
        configuration: candidate,
        contentDigest: options.hashContent(candidate),
        businessDayStartSource: "PlatformDefault",
      };
    };
  });
  mocks.operating.mockImplementation(
    (options: {
      publicationProof: (actual: unknown, value: unknown, at: string) => Promise<unknown>;
    }) =>
      async () => {
        await options.publicationProof(tx, candidate, at);
        return { businessDate: { businessDate: "2026-10-05" }, state: "Closed" };
      },
  );
  const service = createPersistentMerchantBffService({
    identity: {
      configuration: {
        environment: "InternalTest",
        redirectUri: "https://merchant.invalid/callback",
        allowedPostLoginPaths: ["/app"],
      },
    },
    transactions: { run: async (work: (actual: typeof tx) => Promise<unknown>) => work(tx) },
    now: () => at,
    currentActor: async () => undefined,
    validateAssociation: async () => true,
    publication: {
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      requiredLiveGateRequirementCodes: ["STORE_READY"],
      ...(inventory === undefined ? {} : { requiredValidationCheckCodes: inventory }),
    },
    workspace: async () => ({
      screenId: "HOME-OVERVIEW",
      selectedScope: scope,
      authorizedStores: [scope],
      businessDate: "2026-10-04",
      storeStatus: "Unavailable",
      freshness: "Stale",
      dashboardAvailability: "UnavailableUntilWP1905",
      navigation: [],
    }),
  } as unknown as PersistentMerchantBffOptions);
  return {
    service,
    candidate,
    proof: () => {
      if (!captured) throw Error("proof not called");
      return captured;
    },
  };
}
it.each([false, true])(
  "uses the owning publication hash in ordinary workspace for V2=%s",
  async (modern) => {
    const inventory = Object.freeze(["REFERENCE_VALID", "STORE_SOURCE_VALID"]);
    const f = runtime(modern, inventory);
    const result = await f.service.bootstrap("controlled");
    expect(parseMerchantWorkspaceSnapshot(result.workspace).storeStatus).toBe("Closed");
    const options = f.proof();
    expect(options.tenantReference).toBe(id(16));
    expect(options.configurationReference).toBe(f.candidate.configurationReference);
    expect(options.requiredValidationCheckCodes).toBe(inventory);
    const changed = createStoreConfigurationVersion({
      ...f.candidate,
      updatedAt: "2026-10-05T10:01:00.000Z",
      publicationReference: id(90),
    });
    if (modern) expect(options.hashContent(changed)).toBe(options.hashContent(f.candidate));
    else {
      expect(options.hashContent(f.candidate)).toBe(
        "sha256:" + sha256Hex(canonicalizeRfc8785(f.candidate)),
      );
      expect(options.hashContent(changed)).not.toBe(options.hashContent(f.candidate));
    }
    const ports = options.setupSnapshotReferences;
    expect(ports?.hashIntent(ports.canonicalize(f.candidate))).toBe(
      "sha256:" + sha256Hex(canonicalizeRfc8785(f.candidate)),
    );
    expect(await options.authorize({} as never, at)).toBe(true);
    mocks.allowed.mockResolvedValue({ effect: "Deny" });
    expect(await options.authorize({} as never, at)).toBe(false);
  },
);
it("does not turn Live Gate requirement codes into a missing review inventory", async () => {
  const f = runtime(true);
  await f.service.bootstrap("controlled");
  expect(Object.hasOwn(f.proof(), "requiredValidationCheckCodes")).toBe(false);
});
it("rejects current workspace denial before reading publication", async () => {
  const f = runtime(true);
  mocks.allowed.mockResolvedValue({ effect: "Deny" });
  await expect(f.service.bootstrap("controlled")).rejects.toThrow("MERCHANT_BFF_UNAVAILABLE");
  expect(mocks.proof).not.toHaveBeenCalled();
});
