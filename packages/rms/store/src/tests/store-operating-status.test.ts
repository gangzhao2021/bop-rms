import { describe, expect, it, vi } from "vitest";
import {
  createStoreOperatingStatusService,
  type StoreOperatingStatusPorts,
  type StoreOperatingStatusResolutionEvidence,
} from "../index.js";

const ids = {
  publicStore: "00000000-0000-7000-8000-000000000101",
  brand: "00000000-0000-7000-8000-000000000102",
  store: "00000000-0000-7000-8000-000000000103",
  lookup: "00000000-0000-7000-8000-000000000104",
  configuration: "00000000-0000-7000-8000-000000000105",
  lifecycle: "00000000-0000-7000-8000-000000000106",
  family: "00000000-0000-7000-8000-000000000107",
  release: "00000000-0000-7000-8000-000000000108",
  timing: "00000000-0000-7000-8000-000000000109",
  periodFamily: "00000000-0000-7000-8000-00000000010a",
  approval: "00000000-0000-7000-8000-00000000010b",
  closure: "00000000-0000-7000-8000-00000000010c",
  closureTwo: "00000000-0000-7000-8000-00000000010d",
} as const;

const contentDigest = `sha256:${"c".repeat(64)}`;
const periodDigest = `sha256:${"d".repeat(64)}`;
const request = {
  publicStoreReference: ids.publicStore,
  evaluatedAt: "2026-01-15T17:00:00.000Z",
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
    validUntil: "2027-01-01T00:00:00.000Z",
  } as unknown as StoreOperatingStatusResolutionEvidence;
}

function interval(
  startLocalTime: string,
  endLocalTime: string,
  serviceModes = ["DineIn", "Pickup", "Delivery"],
  endsNextDay = false,
) {
  return { startLocalTime, endLocalTime, endsNextDay, serviceModes };
}

function emptyWeek() {
  return Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals: [] as ReturnType<typeof interval>[],
  }));
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("synthetic fixture index is missing");
  return value;
}

function candidate() {
  const scope = {
    kind: "Store",
    brandReference: ids.brand,
    storeReference: ids.store as string,
  };
  const weeklySchedule = emptyWeek();
  at(weeklySchedule, 3).intervals = [interval("11:00:00", "22:00:00")];
  return {
    configurationReference: ids.configuration,
    configurationVersion: 1,
    brandReference: ids.brand,
    storeReference: ids.store as string,
    classification: "Public",
    timeZone: "America/Toronto",
    weeklySchedule,
    exceptions: [] as {
      localDate: string;
      intervals: ReturnType<typeof interval>[];
    }[],
    temporaryClosures: [] as {
      closureReference: string;
      effectiveFrom: string;
      effectiveUntil: string;
      serviceModes: string[] | null;
    }[],
    contentDigest,
    publishingLifecycle: {
      lifecycleId: ids.lifecycle,
      familyReference: ids.family,
      configurationType: "STORE_OPERATING_HOURS",
      purposeCode: "CUSTOMER_ENTRY",
      snapshotReference: ids.configuration,
      snapshotDigest: contentDigest,
      scope,
      version: 1,
      state: "Published",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      changedAt: "2026-01-01T00:00:00.000Z",
    },
    publishingRelease: {
      releaseId: ids.release,
      familyReference: ids.family,
      configurationType: "STORE_OPERATING_HOURS",
      purposeCode: "CUSTOMER_ENTRY",
      snapshotReference: ids.configuration,
      snapshotDigest: contentDigest,
      scope,
      sequence: 1,
      sourceLifecycleId: ids.lifecycle,
      kind: "Publish",
      previousReleaseId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    effectiveVersion: {
      timingVersionReference: ids.timing as string,
      familyReference: ids.periodFamily,
      configurationReference: ids.configuration,
      releaseReference: ids.release,
      snapshotReference: ids.configuration,
      snapshotDigest: contentDigest,
      configurationType: "STORE_OPERATING_HOURS",
      purposeCode: "CUSTOMER_ENTRY",
      scope,
      version: 1,
      period: {
        timeZone: "America/Toronto",
        effectiveFrom: {
          instant: "2026-01-01T05:00:00.000Z",
          localDateTime: "2026-01-01T00:00:00.000",
          utcOffsetMinutes: -300,
        },
        effectiveUntil: {
          instant: "2027-01-01T05:00:00.000Z",
          localDateTime: "2027-01-01T00:00:00.000",
          utcOffsetMinutes: -300,
        },
      },
      periodDigest,
      approvalEvidenceReference: ids.approval,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function harness(options?: {
  evidence?: StoreOperatingStatusResolutionEvidence | null;
  candidates?: unknown;
  resolutionFailure?: boolean;
  configurationFailure?: boolean;
}) {
  const calls = { resolution: 0, configurations: 0 };
  const telemetry: unknown[] = [];
  const ports: StoreOperatingStatusPorts = {
    resolution: {
      async resolve() {
        calls.resolution += 1;
        if (options?.resolutionFailure) throw new Error("synthetic dependency failure");
        return options && "evidence" in options ? (options.evidence ?? null) : resolutionEvidence();
      },
    },
    configurations: {
      async loadCandidates() {
        calls.configurations += 1;
        if (options?.configurationFailure) throw new Error("synthetic dependency failure");
        return options && "candidates" in options ? options.candidates : [candidate()];
      },
    },
    telemetry: { record: (labels) => void telemetry.push(labels) },
  };
  return {
    calls,
    telemetry,
    get: (input: unknown = request) =>
      createStoreOperatingStatusService(ports).getStoreOperatingStatus(input),
  };
}

describe("WP-1001 Store Operating Status Query", () => {
  it("returns one immutable customer-safe open status", async () => {
    const test = harness();
    const result = await test.get();
    expect(result).toEqual({
      status: "Available",
      operatingStatus: {
        configurationReference: ids.configuration,
        configurationVersion: 1,
        releaseReference: ids.release,
        contentDigest,
        evaluatedAt: request.evaluatedAt,
        timeZone: "America/Toronto",
        localDate: "2026-01-15",
        localTime: "12:00:00",
        state: "Open",
        availableServiceModes: ["DineIn", "Pickup", "Delivery"],
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.status === "Available" && Object.isFrozen(result.operatingStatus)).toBe(true);
    expect(
      result.status === "Available" &&
        Object.isFrozen(result.operatingStatus.availableServiceModes),
    ).toBe(true);
    expect(test.calls).toEqual({ resolution: 1, configurations: 1 });
  });

  it.each([
    ["bad reference", { ...request, publicStoreReference: "not-a-reference" }],
    ["bad instant", { ...request, evaluatedAt: "2026-01-15" }],
    ["bad purpose", { ...request, purpose: "Directory" }],
    ["extra field", { ...request, storeReference: ids.store }],
  ])("rejects malformed request before dependencies: %s", async (_name, value) => {
    const test = harness();
    await expect(test.get(value)).resolves.toEqual({ status: "InvalidRequest" });
    expect(test.calls).toEqual({ resolution: 0, configurations: 0 });
  });

  it("does not treat a valid internal Store ID as public authority", async () => {
    const test = harness();
    await expect(test.get({ ...request, publicStoreReference: ids.store })).resolves.toEqual({
      status: "StoreUnavailable",
    });
    expect(test.calls).toEqual({ resolution: 1, configurations: 0 });
  });

  it.each(["Draft", "Suspended", "Archived"])(
    "uniformly hides %s Store lifecycle",
    async (lifecycle) => {
      const evidence = {
        ...resolutionEvidence(),
        storeLifecycle: lifecycle,
      } as unknown as StoreOperatingStatusResolutionEvidence;
      const test = harness({ evidence });
      await expect(test.get()).resolves.toEqual({ status: "StoreUnavailable" });
      expect(test.calls).toEqual({ resolution: 1, configurations: 0 });
    },
  );

  it("uniformly hides missing, mismatched, expired and malformed scope evidence", async () => {
    await expect(harness({ evidence: null }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const mismatch = {
      ...resolutionEvidence(),
      publicStoreReference: "00000000-0000-7000-8000-000000000110",
    } as unknown as StoreOperatingStatusResolutionEvidence;
    await expect(harness({ evidence: mismatch }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const expired = {
      ...resolutionEvidence(),
      validUntil: request.evaluatedAt,
    } as unknown as StoreOperatingStatusResolutionEvidence;
    await expect(harness({ evidence: expired }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    await expect(
      harness({
        evidence: {
          ...resolutionEvidence(),
          internalId: ids.store,
        } as unknown as StoreOperatingStatusResolutionEvidence,
      }).get(),
    ).resolves.toEqual({ status: "StoreUnavailable" });
  });

  it("returns unavailable for zero, future, expired and conflicting effective versions", async () => {
    await expect(harness({ candidates: [] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const future = candidate();
    future.effectiveVersion.period.effectiveFrom = {
      instant: "2026-01-16T05:00:00.000Z",
      localDateTime: "2026-01-16T00:00:00.000",
      utcOffsetMinutes: -300,
    };
    await expect(harness({ candidates: [future] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const expired = candidate();
    expired.effectiveVersion.period.effectiveUntil = {
      instant: request.evaluatedAt,
      localDateTime: "2026-01-15T12:00:00.000",
      utcOffsetMinutes: -300,
    };
    await expect(harness({ candidates: [expired] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const overlap = candidate();
    overlap.effectiveVersion.timingVersionReference = "00000000-0000-7000-8000-000000000111";
    await expect(harness({ candidates: [candidate(), overlap] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("uses half-open adjacent effective boundaries", async () => {
    const first = candidate();
    first.effectiveVersion.period.effectiveUntil = {
      instant: request.evaluatedAt,
      localDateTime: "2026-01-15T12:00:00.000",
      utcOffsetMinutes: -300,
    };
    const second = candidate();
    second.effectiveVersion.timingVersionReference = "00000000-0000-7000-8000-000000000111";
    second.effectiveVersion.period.effectiveFrom = {
      instant: request.evaluatedAt,
      localDateTime: "2026-01-15T12:00:00.000",
      utcOffsetMinutes: -300,
    };
    await expect(harness({ candidates: [first, second] }).get()).resolves.toMatchObject({
      status: "Available",
    });
  });

  it.each(["Draft", "InReview", "Approved", "Archived", "Superseded"])(
    "uniformly rejects %s publication state",
    async (state) => {
      const value = candidate();
      value.publishingLifecycle.state = state;
      await expect(harness({ candidates: [value] }).get()).resolves.toEqual({
        status: "StoreUnavailable",
      });
    },
  );

  it("rejects publication, effective-period and Tenant scope drift", async () => {
    const publication = candidate();
    publication.publishingRelease.snapshotDigest = `sha256:${"e".repeat(64)}`;
    await expect(harness({ candidates: [publication] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const timing = candidate();
    timing.effectiveVersion.configurationType = "STORE_PROFILE";
    await expect(harness({ candidates: [timing] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    const crossStore = candidate();
    crossStore.storeReference = "00000000-0000-7000-8000-000000000110";
    await expect(harness({ candidates: [crossStore] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("reports Closed outside weekly hours", async () => {
    const result = await harness().get({
      ...request,
      evaluatedAt: "2026-01-15T15:59:59.000Z",
    });
    expect(result).toMatchObject({
      status: "Available",
      operatingStatus: { localTime: "10:59:59", state: "Closed", availableServiceModes: [] },
    });
  });

  it("evaluates the previous weekday overnight tail", async () => {
    const value = candidate();
    at(value.weeklySchedule, 2).intervals = [interval("22:00:00", "02:00:00", ["Pickup"], true)];
    at(value.weeklySchedule, 3).intervals = [];
    const result = await harness({ candidates: [value] }).get({
      ...request,
      evaluatedAt: "2026-01-15T06:30:00.000Z",
    });
    expect(result).toMatchObject({
      status: "Available",
      operatingStatus: {
        localDate: "2026-01-15",
        localTime: "01:30:00",
        state: "Open",
        availableServiceModes: ["Pickup"],
      },
    });
  });

  it("uses an exact-date exception as full replacement, including explicit closure", async () => {
    const open = candidate();
    open.exceptions = [
      {
        localDate: "2026-01-15",
        intervals: [interval("12:00:00", "14:00:00", ["Delivery"])],
      },
    ];
    await expect(harness({ candidates: [open] }).get()).resolves.toMatchObject({
      status: "Available",
      operatingStatus: { state: "Open", availableServiceModes: ["Delivery"] },
    });
    const closed = candidate();
    closed.exceptions = [{ localDate: "2026-01-15", intervals: [] }];
    await expect(harness({ candidates: [closed] }).get()).resolves.toMatchObject({
      status: "Available",
      operatingStatus: { state: "Closed", availableServiceModes: [] },
    });
  });

  it("applies a prior-date exception overnight tail unless the current date replaces it", async () => {
    const value = candidate();
    at(value.weeklySchedule, 3).intervals = [];
    value.exceptions = [
      {
        localDate: "2026-01-14",
        intervals: [interval("23:00:00", "03:00:00", ["DineIn"], true)],
      },
    ];
    await expect(
      harness({ candidates: [value] }).get({
        ...request,
        evaluatedAt: "2026-01-15T06:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "Available",
      operatingStatus: { state: "Open", availableServiceModes: ["DineIn"] },
    });
    value.exceptions.push({ localDate: "2026-01-15", intervals: [] });
    await expect(
      harness({ candidates: [value] }).get({
        ...request,
        evaluatedAt: "2026-01-15T06:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "Available",
      operatingStatus: { state: "Closed", availableServiceModes: [] },
    });
  });

  it("suppresses a partial mode and reports all-mode temporary closure", async () => {
    const partial = candidate();
    partial.temporaryClosures = [
      {
        closureReference: ids.closure,
        effectiveFrom: "2026-01-15T16:00:00.000Z",
        effectiveUntil: "2026-01-15T18:00:00.000Z",
        serviceModes: ["Pickup"],
      },
    ];
    await expect(harness({ candidates: [partial] }).get()).resolves.toMatchObject({
      status: "Available",
      operatingStatus: {
        state: "Open",
        availableServiceModes: ["DineIn", "Delivery"],
      },
    });
    const all = candidate();
    all.temporaryClosures = [
      {
        closureReference: ids.closure,
        effectiveFrom: "2026-01-15T16:00:00.000Z",
        effectiveUntil: "2026-01-15T18:00:00.000Z",
        serviceModes: null,
      },
    ];
    await expect(harness({ candidates: [all] }).get()).resolves.toMatchObject({
      status: "Available",
      operatingStatus: { state: "TemporarilyClosed", availableServiceModes: [] },
    });
  });

  it("uses half-open temporary closure boundaries", async () => {
    const value = candidate();
    value.temporaryClosures = [
      {
        closureReference: ids.closure,
        effectiveFrom: "2026-01-15T16:00:00.000Z",
        effectiveUntil: request.evaluatedAt,
        serviceModes: null,
      },
    ];
    await expect(harness({ candidates: [value] }).get()).resolves.toMatchObject({
      status: "Available",
      operatingStatus: { state: "Open" },
    });
  });

  it("maps supplied UTC instants uniquely across DST spring gap and fall overlap", async () => {
    const spring = candidate();
    spring.weeklySchedule = emptyWeek();
    at(spring.weeklySchedule, 6).intervals = [interval("03:00:00", "04:00:00", ["Pickup"])];
    await expect(
      harness({ candidates: [spring] }).get({
        ...request,
        evaluatedAt: "2026-03-08T07:30:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "Available",
      operatingStatus: {
        localDate: "2026-03-08",
        localTime: "03:30:00",
        state: "Open",
      },
    });

    const fall = candidate();
    fall.weeklySchedule = emptyWeek();
    at(fall.weeklySchedule, 6).intervals = [interval("01:00:00", "02:00:00", ["Pickup"])];
    const first = await harness({ candidates: [fall] }).get({
      ...request,
      evaluatedAt: "2026-11-01T05:30:00.000Z",
    });
    const second = await harness({ candidates: [fall] }).get({
      ...request,
      evaluatedAt: "2026-11-01T06:30:00.000Z",
    });
    expect(first).toMatchObject({
      status: "Available",
      operatingStatus: { localTime: "01:30:00", state: "Open" },
    });
    expect(second).toMatchObject({
      status: "Available",
      operatingStatus: { localTime: "01:30:00", state: "Open" },
    });
  });

  it.each([
    ["unknown field", () => ({ ...candidate(), internalNote: "hidden" })],
    ["bad zone", () => ({ ...candidate(), timeZone: "Local/Guess" })],
    [
      "missing weekday",
      () => ({ ...candidate(), weeklySchedule: candidate().weeklySchedule.slice(0, 6) }),
    ],
    [
      "duplicate mode",
      () => {
        const value = candidate();
        at(at(value.weeklySchedule, 3).intervals, 0).serviceModes = ["Pickup", "Pickup"];
        return value;
      },
    ],
    [
      "noncanonical mode order",
      () => {
        const value = candidate();
        at(at(value.weeklySchedule, 3).intervals, 0).serviceModes = ["Delivery", "Pickup"];
        return value;
      },
    ],
    [
      "invalid same-day interval",
      () => {
        const value = candidate();
        at(value.weeklySchedule, 3).intervals = [interval("22:00:00", "11:00:00")];
        return value;
      },
    ],
    [
      "overlapping interval",
      () => {
        const value = candidate();
        at(value.weeklySchedule, 3).intervals = [
          interval("11:00:00", "14:00:00"),
          interval("13:00:00", "15:00:00"),
        ];
        return value;
      },
    ],
    [
      "cross-day overlap",
      () => {
        const value = candidate();
        at(value.weeklySchedule, 2).intervals = [
          interval("23:00:00", "12:30:00", ["Pickup"], true),
        ];
        return value;
      },
    ],
    [
      "duplicate exception",
      () => {
        const value = candidate();
        value.exceptions = [
          { localDate: "2026-01-15", intervals: [] },
          { localDate: "2026-01-15", intervals: [] },
        ];
        return value;
      },
    ],
    [
      "exception overnight overlap with following weekly day",
      () => {
        const value = candidate();
        value.exceptions = [
          {
            localDate: "2026-01-14",
            intervals: [interval("23:00:00", "12:30:00", ["Pickup"], true)],
          },
        ];
        return value;
      },
    ],
    [
      "invalid local date",
      () => {
        const value = candidate();
        value.exceptions = [{ localDate: "2026-02-30", intervals: [] }];
        return value;
      },
    ],
    [
      "zero closure",
      () => {
        const value = candidate();
        value.temporaryClosures = [
          {
            closureReference: ids.closure,
            effectiveFrom: request.evaluatedAt,
            effectiveUntil: request.evaluatedAt,
            serviceModes: null,
          },
        ];
        return value;
      },
    ],
    [
      "duplicate closure reference",
      () => {
        const value = candidate();
        value.temporaryClosures = [
          {
            closureReference: ids.closure,
            effectiveFrom: "2026-01-15T15:00:00.000Z",
            effectiveUntil: "2026-01-15T16:00:00.000Z",
            serviceModes: null,
          },
          {
            closureReference: ids.closure,
            effectiveFrom: "2026-01-15T16:00:00.000Z",
            effectiveUntil: "2026-01-15T18:00:00.000Z",
            serviceModes: null,
          },
        ];
        return value;
      },
    ],
  ])("fails closed on configuration shape: %s", async (_name, createValue) => {
    await expect(harness({ candidates: [createValue()] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("rejects accessors and malformed candidate collections without invoking them", async () => {
    const value = candidate();
    const accessor = vi.fn(() => ids.configuration);
    Object.defineProperty(value, "configurationReference", {
      enumerable: true,
      get: accessor,
    });
    await expect(harness({ candidates: [value] }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    expect(accessor).not.toHaveBeenCalled();
    await expect(harness({ candidates: { values: [] } }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("normalizes dependency exceptions to StoreUnavailable", async () => {
    await expect(harness({ resolutionFailure: true }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
    await expect(harness({ configurationFailure: true }).get()).resolves.toEqual({
      status: "StoreUnavailable",
    });
  });

  it("emits only bounded telemetry and ignores telemetry failure", async () => {
    const test = harness();
    await test.get();
    expect(test.telemetry).toEqual([
      {
        operation: "GetStoreOperatingStatus",
        outcome: "AVAILABLE",
        reason: "STATUS_AVAILABLE",
      },
    ]);
    const serialized = JSON.stringify(test.telemetry);
    expect(serialized).not.toContain(ids.publicStore);
    expect(serialized).not.toContain("America/Toronto");
    expect(serialized).not.toContain("Pickup");
    expect(serialized).not.toContain("2026-01-15");

    const record = vi.fn(() => {
      throw new Error("synthetic telemetry failure");
    });
    const ports: StoreOperatingStatusPorts = {
      resolution: { resolve: async () => resolutionEvidence() },
      configurations: { loadCandidates: async () => [candidate()] },
      telemetry: { record },
    };
    await expect(
      createStoreOperatingStatusService(ports).getStoreOperatingStatus(request),
    ).resolves.toMatchObject({ status: "Available" });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("does not expose internal scope or claim excluded operating authority", async () => {
    const result = await harness().get();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(ids.brand);
    expect(serialized).not.toContain(ids.store);
    expect(serialized).not.toMatch(
      /businessDate|businessDayStart|cutoff|leadTime|capacity|catalog|inventory|featureFlag|qr|session|permission|provider|internalNote/iu,
    );
  });
});
