import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  materializeStoreSetupConfigurationVersionV2,
  parseStoreSetupDraft,
  storeSetupDraftOperationFields,
  type StoreSetupDraft,
  type StoreSetupDraftStoreOptions,
} from "@rms/store";
import {
  createMerchantStoreHoursSetupDraft,
  parseStoreHoursSetupDraftCommand,
} from "./merchant-store-hours-setup-draft.js";
import type { MerchantStoreConfigurationOptions } from "./merchant-store-configuration.js";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  setupStore: vi.fn(),
  authoring: vi.fn(),
  administration: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mocks.resolve }));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPostgresStoreSetupDraftStore: mocks.setupStore,
  createPostgresStoreConfigurationAuthoringSource: mocks.authoring,
  createPersistentStoreConfigurationAdministration: mocks.administration,
}));

const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const refs = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (text: string) => "sha256:" + sha256Hex(text),
};
const digest = (value: unknown) => refs.hashIntent(refs.canonicalize(value));
const publishedAt = "2026-10-01T12:00:00.000Z";
const now = "2026-10-15T15:00:00.000Z";
const owner = id(10),
  manager = id(11),
  tenant = id(40),
  brand = id(2),
  store = id(3);
const interval = (start: string, end: string) => ({
  startLocalTime: start,
  endLocalTime: end,
  endsNextDay: false,
  serviceModes: ["Pickup"],
  orderCutoffSeconds: 600,
  leadTimeSeconds: 600,
});
const configured = (value: unknown) => ({ state: "Configured", value });
const week = (start: string) =>
  Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals: [interval(start, "21:00:00")],
  }));
/** Revision 1 of the Store setup, saved and published by the Owner. */
const revision1: StoreSetupDraft = parseStoreSetupDraft({
  profile: "StoreSetupDraftV2",
  setupDraftReference: id(50),
  tenantReference: tenant,
  brandReference: brand,
  storeReference: store,
  revision: 1,
  authoredByReference: owner,
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  baseConfigurationReference: id(60),
  content: {
    feeContexts: configured(
      ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
        chargeType,
        state: "Disabled",
      })),
    ),
    source: configured("StoreOverride"),
    brandBaseVersionReference: configured(id(4)),
    timeZone: configured("America/Toronto"),
    businessDayStartLocalTime: configured("04:00:00"),
    addressReference: configured(id(5)),
    contactReference: configured(id(6)),
    receiptReference: configured(id(7)),
    taxConfigurationReference: configured(id(8)),
    paymentConfigurationReference: configured(id(9)),
    capacityConfigurationReference: configured(null),
    enabledServiceModes: configured(["Pickup"]),
    weeklySchedule: configured(week("11:00:00")),
    exceptions: configured([]),
    effectiveFrom: configured(publishedAt),
    effectiveUntil: configured(null),
  },
  createdAt: publishedAt,
  updatedAt: publishedAt,
  purposeCode: "STORE_SETUP_DRAFT",
  dataClassification: "ConfigurationMetadata",
});
const published = {
  ...materializeStoreSetupConfigurationVersionV2(
    revision1,
    {
      tenantReference: tenant,
      brandReference: brand,
      storeReference: store,
      actorReference: owner,
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      baseConfigurationReference: id(60),
    },
    {
      configurationReference: id(61),
      configurationVersion: 2,
      reasonCode: "STORE_SETUP_PUBLICATION",
      createdAt: publishedAt,
      updatedAt: publishedAt,
    },
    refs,
  ),
  lifecycle: "Published" as const,
  approvedByReference: id(12),
  approvalEvidenceReference: id(13),
  publicationReference: id(14),
  liveGateEvidenceReference: id(15),
};
const observedAt = "2026-10-15T14:59:00.000Z";
const request = (overrides: Record<string, unknown> = {}) => ({
  sessionCookie: "synthetic",
  csrf: "synthetic",
  command: {
    expectedSetup: {
      setupDraftReference: id(50),
      sourceRevision: 1,
      sourceSnapshotDigest: digest(revision1),
    },
    setupOperationReference: id(70),
    operationReference: id(71),
    auditReference: id(72),
    configurationReference: id(73),
    expectedVersion: 2,
    weeklySchedule: week("10:00:00"),
    exceptions: [{ localDate: "2026-12-25", kind: "Holiday", intervals: [] }],
    effectiveFrom: observedAt,
    ...overrides,
  },
});
beforeEach(() => vi.clearAllMocks());

function setup(options: { head?: StoreSetupDraft | null; decision?: "Allow" | "Deny" } = {}) {
  const allow = (action: string) =>
    Object.freeze({ effect: options.decision ?? "Allow", action, scopeKind: "Store" });
  const scope = {
    selected: { tenantReference: tenant },
    context: { brand: { brandReference: brand } },
    store: { storeReference: store, locale: "en-CA", currencyCode: "CAD" },
    actorReference: manager,
    allowed: vi.fn(async () => true),
    authorizationValidUntil: () => "2026-10-15T15:10:00.000Z",
    authorizeActions: vi.fn(
      async (actions: readonly string[]) => new Map(actions.map((a) => [a, allow(a)])),
    ),
  };
  mocks.resolve.mockResolvedValue(scope);
  mocks.authoring.mockReturnValue(async () => null);
  let saved: StoreSetupDraft | undefined;
  const setupStore = {
    readCurrent: vi.fn(async () => ({
      snapshot: options.head === undefined ? revision1 : options.head,
    })),
    readRevision: vi.fn(async () => revision1),
    // The owner's hours-only revision: based on the latest configuration, by the Store Manager.
    save: vi.fn(async (command: { content: unknown }) => {
      saved ??= parseStoreSetupDraft({
        ...revision1,
        revision: 2,
        authoredByReference: manager,
        baseConfigurationReference: id(61),
        content: command.content,
        updatedAt: now,
      });
      return { snapshot: saved };
    }),
    assertFinalized: vi.fn(() => now),
  };
  const held: unknown[] = [];
  mocks.setupStore.mockImplementation((storeOptions: StoreSetupDraftStoreOptions) => {
    // As the owner does: a before-commit guard that holds the run's authority once more.
    void storeOptions.registerBeforeCommit(
      storeOptions.transaction,
      async () => {
        held.push(
          await storeOptions.authority.holdUntilTransactionCompletes(storeOptions.transaction, {
            tenantReference: tenant,
            brandReference: brand,
            storeReference: store,
            actorReference: manager,
            permission: "store.service.save-draft",
            purposeCode: "STORE_SETUP_DRAFT",
            mode: "Read",
            requiredFields: storeSetupDraftOperationFields,
            command: null,
            observedAt: now,
            validUntil: storeOptions.originalValidUntil,
          }),
        );
      },
      () => undefined,
    );
    return setupStore;
  });
  const saveDraft = vi.fn(async (input: { configuration: { configurationVersion: number } }) => ({
    status: "Applied",
    operation: { resultingVersion: input.configuration.configurationVersion },
  }));
  mocks.administration.mockReturnValue({ saveDraft });
  const configure = vi.fn(() => ({
    publication: { authorize: async () => true, hashContent: () => "sha256:" + "b".repeat(64) },
    ports: () => ({}),
    publishedBaseline: async () => published,
    nextReference: () => id(90),
  }));
  const service = createMerchantStoreHoursSetupDraft({
    persistence: {
      now: () => now,
      transactions: { run: async (work: (tx: object) => Promise<unknown>) => work({}) },
    },
    authentication: { authorize: async () => ({ sessionReference: id(30) }) },
    actionPermissions: {
      saveDraft: "store.service.save-draft",
      validate: "store.service.validate",
      submit: "store.service.submit",
      approve: "store.service.approve",
      publish: "store.service.publish",
    },
    configure,
  } as unknown as MerchantStoreConfigurationOptions);
  return { service, scope, setupStore, saveDraft, configure, held };
}

it("saves an hours-only Store setup revision and the draft configuration made from it", async () => {
  const f = setup();
  await expect(f.service(request())).resolves.toEqual({ status: "Applied", resultingVersion: 3 });
  // One permission packet at the start and one full re-check before the commit.
  expect(f.scope.authorizeActions.mock.calls).toEqual([
    [["store.service.save-draft"]],
    [["store.service.save-draft"]],
  ]);
  expect(f.scope.allowed).not.toHaveBeenCalled();
  const options = mocks.setupStore.mock.calls[0]?.[0];
  expect(options).toMatchObject({ changeScope: "Hours", actorReference: manager });
  const command = f.setupStore.save.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(command).toMatchObject({
    profile: "StoreSetupSaveV2",
    operationReference: id(70),
    expectedSetupReference: id(50),
    expectedRevision: 1,
    content: {
      ...revision1.content,
      weeklySchedule: configured(week("10:00:00")),
      exceptions: configured([{ localDate: "2026-12-25", kind: "Holiday", intervals: [] }]),
      effectiveFrom: configured(observedAt),
      effectiveUntil: configured(null),
    },
  });
  const input = f.saveDraft.mock.calls[0]?.[0] as unknown as Record<string, unknown> & {
    configuration: Record<string, unknown>;
  };
  expect(input).toMatchObject({
    operationReference: id(71),
    auditReference: id(72),
    actorReference: manager,
    expectedVersion: 2,
  });
  expect(input.configuration).toMatchObject({
    configurationReference: id(73),
    configurationVersion: 3,
    lifecycle: "Draft",
    supersedesConfigurationReference: id(61),
    reasonCode: "STORE_HOURS_UPDATE",
    authoredByReference: manager,
    effectiveFrom: observedAt,
    createdAt: now,
    timeZone: "America/Toronto",
    taxConfigurationReference: id(8),
    setupBasis: { setupDraftReference: id(50), sourceRevision: 2, tenantReference: tenant },
  });
  expect(f.setupStore.assertFinalized).toHaveBeenCalledOnce();
  // The owner's before-commit hold runs after the run's full re-check and is answered.
  expect(f.held).toHaveLength(1);
});

it("rebuilds the identical change when the same request is retried", async () => {
  const f = setup();
  await f.service(request());
  await f.service(request());
  const [first, second] = f.saveDraft.mock.calls.map(
    (call) => call[0] as { configuration: unknown },
  );
  expect(second?.configuration).toEqual(first?.configuration);
  expect(f.setupStore.save.mock.calls[1]?.[0]).toEqual(f.setupStore.save.mock.calls[0]?.[0]);
});

it("refuses when Store setup holds saved changes the latest configuration does not include", async () => {
  const f = setup({
    head: parseStoreSetupDraft({ ...revision1, revision: 2, updatedAt: now }),
  });
  await expect(f.service(request())).rejects.toMatchObject({
    code: "STORE_SETUP_OPERATION_UNPUBLISHED_CHANGES",
  });
  expect(f.setupStore.save).not.toHaveBeenCalled();
  expect(f.saveDraft).not.toHaveBeenCalled();
});

it("refuses a caller without the hours permission before any Store setup read", async () => {
  const f = setup({ decision: "Deny" });
  await expect(f.service(request())).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_PERMISSION_DENIED",
  });
  expect(mocks.setupStore).not.toHaveBeenCalled();
  expect(f.configure).not.toHaveBeenCalled();
});

it("leaves a configuration that did not come from Store setup to the hours editor", async () => {
  const f = setup();
  const { setupBasis, ...installed } = published;
  void setupBasis;
  f.configure.mockReturnValue({
    ...f.configure(),
    publishedBaseline: async () => installed as typeof published,
  });
  await expect(f.service(request())).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_LIFECYCLE_CONFLICT",
  });
  expect(f.setupStore.save).not.toHaveBeenCalled();
});

it.each([
  ["a start before the published hours", { effectiveFrom: "2026-09-30T12:00:00.000Z" }],
  ["a start in the future", { effectiveFrom: "2026-10-16T12:00:00.000Z" }],
])("rejects %s without saving", async (_label, overrides) => {
  const f = setup();
  await expect(f.service(request(overrides))).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_COMMAND_INVALID",
  });
  expect(f.setupStore.save).not.toHaveBeenCalled();
});

it.each([
  ["an unknown field", { reasonCode: "OTHER" }],
  ["a reused reference", { auditReference: id(70) }],
  ["six days of hours", { weeklySchedule: week("10:00:00").slice(0, 6) }],
  [
    "a bad setup digest",
    {
      expectedSetup: { setupDraftReference: id(50), sourceRevision: 1, sourceSnapshotDigest: "x" },
    },
  ],
])("rejects a request with %s before reading anything", async (_label, overrides) => {
  const f = setup();
  expect(() => parseStoreHoursSetupDraftCommand(request(overrides).command)).toThrow(
    expect.objectContaining({ code: "STORE_CONFIGURATION_COMMAND_INVALID" }),
  );
  await expect(f.service(request(overrides))).rejects.toMatchObject({
    code: "STORE_CONFIGURATION_COMMAND_INVALID",
  });
  expect(mocks.resolve).not.toHaveBeenCalled();
});
