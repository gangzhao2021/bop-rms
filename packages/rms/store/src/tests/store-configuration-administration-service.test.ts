import { describe, expect, it } from "vitest";
import {
  createStoreConfigurationAdministrationService,
  StoreConfigurationAdministrationServiceError,
} from "../application/store-configuration-administration-service.js";
import type {
  StoreConfigurationAdministrationPorts,
  StoreConfigurationOperation,
} from "../application/ports/store-configuration-administration-ports.js";
import {
  createStoreConfigurationVersion,
  parseStoreAdministrationReference,
} from "../contracts/store-configuration-administration.js";

const id = (n: number) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T14:00:00.000Z";
const configuration = (lifecycle: "Draft" | "PendingApproval" | "Approved" | "Published") => ({
  configurationReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle,
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
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals:
      index === 0
        ? [
            {
              startLocalTime: "09:00:00",
              endLocalTime: "17:00:00",
              endsNextDay: false,
              serviceModes: ["Pickup"],
              orderCutoffSeconds: 0,
              leadTimeSeconds: 600,
            },
          ]
        : [],
  })),
  exceptions: [],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: lifecycle === "Approved" || lifecycle === "Published" ? id(11) : null,
  approvalEvidenceReference: lifecycle === "Approved" || lifecycle === "Published" ? id(12) : null,
  publicationReference: lifecycle === "Published" ? id(13) : null,
  liveGateEvidenceReference: lifecycle === "Published" ? id(14) : null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
});
const command = (value: unknown, operationReference = id(20), actorReference = id(10)) => ({
  operationReference,
  actorReference,
  purposeCode: "STORE.CONFIGURATION",
  auditReference: id(21),
  expectedVersion: 0,
  occurredAt: at,
  configuration: value,
});

function ports(current: ReturnType<typeof createStoreConfigurationVersion> | null = null) {
  const operations = new Map<string, StoreConfigurationOperation>();
  const value: StoreConfigurationAdministrationPorts = {
    authorization: {
      async authorize() {
        return true;
      },
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadLatest() {
        return current;
      },
      async commit(input) {
        operations.set(input.operation.operationReference, input.operation);
        return input.operation;
      },
    },
    references: {
      hashIntent(input) {
        return `sha256:${input.length.toString(16).padStart(64, "0")}`;
      },
      equals(left, right) {
        return left === right;
      },
      async validateControlledReferences() {
        return true;
      },
      async validateBrandBaseCompatibility() {
        return true;
      },
    },
    approval: {
      async validate() {
        return true;
      },
    },
    publishing: {
      async validate() {
        return true;
      },
    },
    liveGate: {
      async validate() {
        return true;
      },
    },
  };
  return { value, operations };
}

describe("WP-2192 Store configuration administration service", () => {
  it("authorizes, validates references, commits a versioned draft and replays idempotently", async () => {
    const harness = ports(),
      service = createStoreConfigurationAdministrationService(harness.value);
    const input = command(configuration("Draft"));
    await expect(service.saveDraft(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(service.saveDraft(input)).resolves.toMatchObject({ status: "AlreadyApplied" });
    await expect(service.saveDraft({ ...input, purposeCode: "OTHER" })).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_IDEMPOTENCY_CONFLICT",
    });
  });

  it("does not commit a publication whose holiday enables an unsupported service mode", async () => {
    const exceptions = [
      {
        localDate: "2026-12-25",
        kind: "Holiday",
        intervals: [
          {
            startLocalTime: "09:00:00",
            endLocalTime: "17:00:00",
            endsNextDay: false,
            serviceModes: ["Delivery"],
            orderCutoffSeconds: 0,
            leadTimeSeconds: 600,
          },
        ],
      },
    ];
    const approved = createStoreConfigurationVersion({
      ...configuration("Approved"),
      exceptions,
    });
    const harness = ports(approved);
    const service = createStoreConfigurationAdministrationService(harness.value);
    const next = {
      ...configuration("Published"),
      exceptions,
      updatedAt: "2026-08-15T15:00:00.000Z",
    };
    await expect(
      service.publish({
        ...command(next, id(24), id(11)),
        expectedVersion: 1,
      }),
    ).rejects.toThrow();
    expect(harness.operations.size).toBe(0);
  });

  it("requires exact version and fail-closed Publishing and Live Gate validation", async () => {
    const approved = createStoreConfigurationVersion(configuration("Approved"));
    const harness = ports(approved),
      service = createStoreConfigurationAdministrationService(harness.value);
    const next = { ...configuration("Published"), updatedAt: "2026-08-15T15:00:00.000Z" };
    const input = { ...command(next, id(22), id(11)), expectedVersion: 1 };
    harness.value.liveGate.validate = async () => false;
    await expect(service.publish(input)).rejects.toMatchObject({
      code: "STORE_CONFIGURATION_LIVE_GATE_INVALID",
    });
    harness.value.liveGate.validate = async () => true;
    await expect(service.publish(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(
      service.publish({ ...input, operationReference: id(23), expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(StoreConfigurationAdministrationServiceError);
  });
});

const basis = () => ({
  profile: "StoreSetupConfigurationBasisV2",
  tenantReference: id(50),
  setupDraftReference: id(51),
  sourceRevision: 1,
  sourceSnapshotDigest: `sha256:${"a".repeat(64)}`,
  feeContexts: [
    { chargeType: "ServiceCharge", state: "Disabled" },
    { chargeType: "DeliveryFee", state: "Disabled" },
    { chargeType: "Tip", state: "Disabled" },
  ],
});
describe("complete configuration fee basis lifecycle", () => {
  it("refuses both lifecycle injection and removal of the reviewed basis", async () => {
    const old = ports(createStoreConfigurationVersion(configuration("Draft")));
    const oldPorts = {
      ...old.value,
      prepareFresh: async (
        _command: string,
        input: { configuration: ReturnType<typeof createStoreConfigurationVersion> },
      ) => input.configuration,
    };
    await expect(
      createStoreConfigurationAdministrationService(oldPorts).submit({
        ...command({ ...configuration("PendingApproval"), setupBasis: basis() }),
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_LIFECYCLE_CONFLICT" });
    const current = ports(
      createStoreConfigurationVersion({ ...configuration("Draft"), setupBasis: basis() }),
    );
    await expect(
      createStoreConfigurationAdministrationService(current.value).submit({
        ...command(configuration("PendingApproval")),
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_LIFECYCLE_CONFLICT" });
    expect(old.operations.size + current.operations.size).toBe(0);
  });
  it("refuses fresh V2-to-V1 Save while retaining exact original replay", async () => {
    const current = createStoreConfigurationVersion({
      ...configuration("Draft"),
      setupBasis: basis(),
    });
    const h = ports(current),
      service = createStoreConfigurationAdministrationService(h.value);
    await expect(
      service.saveDraft({
        ...command({
          ...configuration("Draft"),
          configurationReference: id(60),
          configurationVersion: 2,
          supersedesConfigurationReference: id(1),
        }),
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_LIFECYCLE_CONFLICT" });
    const first = command(configuration("Draft"));
    h.operations.set(first.operationReference, {
      command: "SaveDraft",
      operationReference: parseStoreAdministrationReference(first.operationReference),
      brandReference: current.brandReference,
      storeReference: current.storeReference,
      intentDigest: h.value.references.hashIntent(
        JSON.stringify({
          command: "SaveDraft",
          operationReference: first.operationReference,
          actorReference: first.actorReference,
          purposeCode: first.purposeCode,
          auditReference: first.auditReference,
          expectedVersion: first.expectedVersion,
          configuration: createStoreConfigurationVersion(first.configuration),
        }),
      ),
      resultingVersion: current.configurationVersion,
      configuration: createStoreConfigurationVersion(first.configuration),
    });
    await expect(service.saveDraft(first)).resolves.toMatchObject({ status: "AlreadyApplied" });
  });
});

it("retains the exact fee basis through Submit and allows a new V1-to-V2 complete draft", async () => {
  const setup = basis();
  const retained = ports(
    createStoreConfigurationVersion({ ...configuration("Draft"), setupBasis: setup }),
  );
  await expect(
    createStoreConfigurationAdministrationService({
      ...retained.value,
      prepareFresh: async (_command, input) => input.configuration,
    }).submit({
      ...command({ ...configuration("PendingApproval"), setupBasis: setup }),
      expectedVersion: 1,
    }),
  ).resolves.toMatchObject({
    status: "Applied",
    operation: { configuration: { setupBasis: setup } },
  });
  const old = ports(createStoreConfigurationVersion(configuration("Published")));
  await expect(
    createStoreConfigurationAdministrationService(old.value).saveDraft({
      ...command({
        ...configuration("Draft"),
        configurationReference: id(61),
        configurationVersion: 2,
        supersedesConfigurationReference: id(1),
        setupBasis: setup,
      }),
      expectedVersion: 1,
    }),
  ).resolves.toMatchObject({ status: "Applied" });
});

describe("fresh server preparation", () => {
  it("prepares after original arbitration and CAS, retaining original input and intent", async () => {
    const current = createStoreConfigurationVersion({
      ...configuration("Draft"),
      setupBasis: basis(),
    });
    const h = ports(current),
      order: string[] = [];
    const raw = { ...command(current), expectedVersion: 1 };
    const originalDigest = h.value.references.hashIntent(
      JSON.stringify({
        command: "Submit",
        operationReference: raw.operationReference,
        actorReference: raw.actorReference,
        purposeCode: raw.purposeCode,
        auditReference: raw.auditReference,
        expectedVersion: raw.expectedVersion,
        configuration: current,
      }),
    );
    let captured:
      Parameters<StoreConfigurationAdministrationPorts["repository"]["commit"]>[0] | undefined;
    const service = createStoreConfigurationAdministrationService({
      ...h.value,
      repository: {
        ...h.value.repository,
        resolveOperation: async (reference) => {
          order.push("original");
          return h.value.repository.resolveOperation(reference);
        },
        loadLatest: async (brand, store) => {
          order.push("current");
          return h.value.repository.loadLatest(brand, store);
        },
        commit: async (input) => {
          order.push("commit");
          captured = input;
          return h.value.repository.commit(input);
        },
      },
      prepareFresh: async (stage, input, previous) => {
        order.push("prepare");
        expect(stage).toBe("Submit");
        expect(previous).toEqual(current);
        return createStoreConfigurationVersion({
          ...input.configuration,
          lifecycle: "PendingApproval",
          updatedAt: "2026-08-15T14:00:01.000Z",
        });
      },
    });
    const result = await service.submit(raw);
    expect(order).toEqual(["original", "current", "prepare", "commit"]);
    expect(result.operation.intentDigest).toBe(originalDigest);
    expect(result.operation.configuration.lifecycle).toBe("PendingApproval");
    expect(captured?.originalInput?.configuration).toEqual(current);
    order.length = 0;
    expect((await service.submit(raw)).status).toBe("AlreadyApplied");
    expect(order).toEqual(["original"]);
  });
  it("never calls preparation for denial, original replay, or stale CAS", async () => {
    const h = ports(createStoreConfigurationVersion(configuration("Draft")));
    let calls = 0;
    const prepared = {
      ...h.value,
      prepareFresh: async (
        _stage: string,
        input: { configuration: ReturnType<typeof createStoreConfigurationVersion> },
      ) => {
        calls++;
        return input.configuration;
      },
    };
    await expect(
      createStoreConfigurationAdministrationService(prepared).submit(
        command(configuration("PendingApproval")),
      ),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_VERSION_CONFLICT" });
    await expect(
      createStoreConfigurationAdministrationService({
        ...prepared,
        authorization: { authorize: async () => false },
      }).submit(command(configuration("PendingApproval"))),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_PERMISSION_DENIED" });
    expect(calls).toBe(0);
    expect(h.operations.size).toBe(0);
  });
  it("requires V2 lifecycle preparation and refuses business or basis drift", async () => {
    const current = createStoreConfigurationVersion({
        ...configuration("Draft"),
        setupBasis: basis(),
      }),
      h = ports(current);
    const raw = { ...command({ ...current, lifecycle: "PendingApproval" }), expectedVersion: 1 };
    await expect(
      createStoreConfigurationAdministrationService(h.value).submit(raw),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE" });
    for (const changed of [
      { addressReference: id(90) },
      { authoredByReference: id(90) },
      { setupBasis: { ...basis(), sourceRevision: 2 } },
    ]) {
      const service = createStoreConfigurationAdministrationService({
        ...h.value,
        prepareFresh: async (_stage, input) =>
          createStoreConfigurationVersion({ ...input.configuration, ...changed }),
      });
      await expect(service.submit(raw)).rejects.toMatchObject({
        code: "STORE_CONFIGURATION_COMMAND_INVALID",
      });
    }
    expect(h.operations.size).toBe(0);
  });
  it("propagates preparation refusal without persisting an operation", async () => {
    const h = ports(createStoreConfigurationVersion(configuration("Draft")));
    await expect(
      createStoreConfigurationAdministrationService({
        ...h.value,
        prepareFresh: async () => {
          throw new Error("controlled dependency refusal");
        },
      }).submit({ ...command(configuration("PendingApproval")), expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE" });
    expect(h.operations.size).toBe(0);
  });
});
