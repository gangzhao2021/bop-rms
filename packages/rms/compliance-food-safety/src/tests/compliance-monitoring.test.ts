import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  ComplianceMonitoringError,
  createCleaningRecord,
  createComplianceMonitoringService,
  createTemperatureReadingRecord,
  type CleaningRecord,
  type ComplianceMonitoringOperation,
  type ComplianceMonitoringPorts,
  type TemperatureExcursionRecord,
  type TemperatureReadingRecord,
} from "../index.js";

const id = (n: number) => `018f9950-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = {
  tenant: id(1),
  brand: id(2),
  actor: id(3),
  verifier: id(4),
  policy: id(5),
  audit: id(6),
  correlation: id(7),
  target: id(8),
  reading1: id(9),
  reading2: id(10),
  calibration: id(11),
  device: id(12),
  excursion: id(13),
  excursionRevision1: id(14),
  containment: id(15),
  cleaning: id(16),
  cleaningRevision1: id(17),
  cleaningRevision2: id(18),
  schedule: id(19),
  task: id(20),
  procedure: id(21),
  assignee: id(22),
  evidence: id(23),
  safetyReview: id(24),
};
const at = "2026-08-14T18:00:00.000Z";
const later = "2026-08-14T19:00:00.000Z";
const latest = "2026-08-14T20:00:00.000Z";
const tomorrow = "2026-08-15T20:00:00.000Z";
const scope = { tenantReference: ids.tenant, brandReference: ids.brand, storeReference: null };
function tenant(observedAt: string, actorReference: string) {
  return createTenantContext(
    {
      actorType: "User",
      actorReference,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: observedAt,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "COMPLIANCE",
      displayName: "Synthetic Compliance Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    null,
    observedAt,
  );
}
function reading(options: Record<string, unknown> = {}): TemperatureReadingRecord {
  return {
    readingReference: ids.reading1,
    correctionOfReadingReference: null,
    scope,
    sequence: 1,
    policyVersionReference: ids.policy,
    targetScope: { kind: "DeviceSensor", reference: ids.target, snapshotCode: "COOLER_1" },
    measurementTypeCode: "FOOD_TEMPERATURE",
    value: "4.25",
    unitCode: "CELSIUS",
    measuredAt: at,
    capturedAt: later,
    method: "Sensor",
    operatorReference: ids.actor,
    deviceReference: ids.device,
    thresholdResult: "WithinRange",
    calibrationReference: ids.calibration,
    recordedAt: later,
    ...options,
  } as never;
}
function excursion(options: Record<string, unknown> = {}): TemperatureExcursionRecord {
  return {
    excursionReference: ids.excursion,
    revisionReference: ids.excursionRevision1,
    priorRevisionReference: null,
    scope,
    recordVersion: 1,
    policyVersionReference: ids.policy,
    readingReference: ids.reading1,
    caseReference: null,
    severity: "Critical",
    status: "Open",
    startedAt: at,
    endedAt: null,
    minimumDeviation: "1.25",
    maximumDeviation: "3.50",
    deviationUnitCode: "CELSIUS",
    affectedScope: { kind: "InventoryLotBatch", reference: ids.target, snapshotCode: "LOT_SCOPE" },
    detectionSourceCode: "POLICY_THRESHOLD",
    containmentReference: null,
    dispositionReference: null,
    rootCauseCode: null,
    resolutionCode: null,
    recordedAt: later,
    actorReference: ids.actor,
    ...options,
  } as never;
}
function cleaning(options: Record<string, unknown> = {}): CleaningRecord {
  return {
    cleaningReference: ids.cleaning,
    revisionReference: ids.cleaningRevision1,
    priorRevisionReference: null,
    scope,
    recordVersion: 1,
    scheduleReference: ids.schedule,
    taskReference: ids.task,
    policyVersionReference: ids.policy,
    procedureVersionReference: ids.procedure,
    targetScope: { kind: "OperationalLocation", reference: ids.target, snapshotCode: "PREP_AREA" },
    assigneeReference: ids.assignee,
    dueAt: tomorrow,
    dueTimezone: "America/Toronto",
    severity: "Major",
    status: "Scheduled",
    performedByReference: null,
    startedAt: null,
    completedAt: null,
    methodCode: "SANITIZE",
    chemicalCode: "QUAT",
    concentration: "200",
    concentrationUnitCode: "PPM",
    chemicalResult: "WithinRequirement",
    evidenceReferences: [],
    exceptionCode: null,
    independentVerificationRequired: true,
    verificationResult: "Pending",
    verifierReference: null,
    verifiedAt: null,
    safetyReviewReference: null,
    recordedAt: at,
    actorReference: ids.actor,
    ...options,
  } as never;
}
function fixture() {
  let actorReference = ids.actor;
  const readings = new Map<string, TemperatureReadingRecord>();
  let latestReading: TemperatureReadingRecord | null = null;
  let latestExcursion: TemperatureExcursionRecord | null = null;
  let latestCleaning: CleaningRecord | null = null;
  const operations = new Map<string, ComplianceMonitoringOperation>();
  const committed: ComplianceMonitoringOperation[] = [];
  const ports: ComplianceMonitoringPorts = {
    authorization: {
      async authorize(input) {
        const permission = {
          RecordReading: "compliance.temperature.record",
          RecordExcursion: "compliance.temperature.excursion.record",
          UpdateExcursion: "compliance.temperature.excursion.manage",
          RecordCleaning: "compliance.cleaning.record",
          UpdateCleaning: "compliance.cleaning.manage",
        } as const;
        const targetType =
          input.command === "RecordReading"
            ? "TemperatureReading"
            : input.command.includes("Excursion")
              ? "TemperatureExcursion"
              : "CleaningRecord";
        return {
          tenantReference: ids.tenant,
          tenantContext: tenant(input.observedAt, actorReference),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: permission[input.command],
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: actorReference },
            actionCode: `COMPLIANCE_MONITORING_${input.command.toUpperCase()}`,
            targetType,
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: {
      hashIntent: (value) => `intent:${value}`,
      equals: (left, right) => left === right,
    },
    repository: {
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async loadReading(reference) {
        return readings.get(reference) ?? null;
      },
      async loadLatestReading() {
        return latestReading;
      },
      async loadLatestExcursion() {
        return latestExcursion;
      },
      async loadLatestCleaning() {
        return latestCleaning;
      },
      async commit(input) {
        const operation = input.operation;
        if (operation.reading) {
          readings.set(operation.reading.readingReference, operation.reading);
          latestReading = operation.reading;
        }
        if (operation.excursion) latestExcursion = operation.excursion;
        if (operation.cleaning) latestCleaning = operation.cleaning;
        operations.set(operation.operationReference, operation);
        committed.push(operation);
        return operation;
      },
    },
  };
  return {
    service: createComplianceMonitoringService(ports),
    committed,
    seedReading(value = reading()) {
      readings.set(value.readingReference, value);
      latestReading = value;
    },
    setActor(value: string) {
      actorReference = value;
    },
  };
}

describe("WP-2173 Compliance monitoring", () => {
  it("appends exact-decimal Sensor readings idempotently and rejects binary floats", async () => {
    const f = fixture();
    const input = {
      operationReference: id(30),
      expectedSequence: 0,
      reading: reading(),
      purposeCode: "TEMPERATURE_CONTROL",
      occurredAt: later,
    };
    await expect(f.service.recordReading(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(f.service.recordReading(input)).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    expect(f.committed).toHaveLength(1);
    expect(() => createTemperatureReadingRecord({ ...reading(), value: 4.25 })).toThrow();
    expect(createTemperatureReadingRecord(reading({ value: "-4.25" })).value).toBe("-4.25");
    expect(() => createTemperatureReadingRecord(reading({ value: "-0.00" }))).toThrow();
  });
  it("records Missing and DeviceFault without inventing a measured value", () => {
    expect(
      createTemperatureReadingRecord(reading({ value: null, thresholdResult: "DeviceFault" }))
        .value,
    ).toBeNull();
    expect(() =>
      createTemperatureReadingRecord(reading({ value: "4", thresholdResult: "DeviceFault" })),
    ).toThrow();
  });
  it("accepts only a same-stream Manual correction and preserves its source", async () => {
    const f = fixture();
    const source = reading();
    f.seedReading(source);
    const corrected = reading({
      readingReference: ids.reading2,
      correctionOfReadingReference: ids.reading1,
      sequence: 2,
      method: "Manual",
      deviceReference: null,
      calibrationReference: null,
      value: "3.75",
      recordedAt: latest,
    });
    await expect(
      f.service.recordReading({
        operationReference: id(31),
        expectedSequence: 1,
        reading: corrected,
        purposeCode: "CONTROLLED_CORRECTION",
        occurredAt: latest,
      }),
    ).resolves.toMatchObject({ status: "Applied" });
    expect(f.committed[0]?.reading?.correctionOfReadingReference).toBe(ids.reading1);
  });
  it("publishes one Excursion fact without asserting Inventory disposition", async () => {
    const f = fixture();
    f.seedReading();
    await expect(
      f.service.recordExcursion({
        command: "RecordExcursion",
        operationReference: id(32),
        expectedVersion: 0,
        excursion: excursion(),
        purposeCode: "EXCURSION_CONTROL",
        occurredAt: later,
      }),
    ).resolves.toMatchObject({ status: "Applied" });
    expect(f.committed[0]?.events[0]?.eventType).toBe("TemperatureExcursionDetected");
    expect(f.committed[0]?.excursion?.dispositionReference).toBeNull();
  });
  it("requires Safety Review for outside chemical concentration", () => {
    expect(() =>
      createCleaningRecord(cleaning({ chemicalResult: "OutsideRequirement" })),
    ).toThrow();
    expect(
      createCleaningRecord(
        cleaning({ chemicalResult: "OutsideRequirement", safetyReviewReference: ids.safetyReview }),
      ).safetyReviewReference,
    ).toBe(ids.safetyReview);
  });
  it("separates Cleaning completion from independent verification and emits failure", async () => {
    const f = fixture();
    await f.service.recordCleaning({
      command: "RecordCleaning",
      operationReference: id(33),
      expectedVersion: 0,
      cleaning: cleaning(),
      purposeCode: "CLEANING_CONTROL",
      occurredAt: at,
    });
    const progress = cleaning({
      revisionReference: ids.cleaningRevision2,
      priorRevisionReference: ids.cleaningRevision1,
      recordVersion: 2,
      status: "InProgress",
      performedByReference: ids.actor,
      startedAt: later,
      recordedAt: later,
    });
    await f.service.recordCleaning({
      command: "UpdateCleaning",
      operationReference: id(34),
      expectedVersion: 1,
      cleaning: progress,
      purposeCode: "CLEANING_CONTROL",
      occurredAt: later,
    });
    const completed = cleaning({
      revisionReference: id(40),
      priorRevisionReference: ids.cleaningRevision2,
      recordVersion: 3,
      status: "Completed",
      performedByReference: ids.actor,
      startedAt: later,
      completedAt: latest,
      evidenceReferences: [ids.evidence],
      recordedAt: latest,
    });
    await f.service.recordCleaning({
      command: "UpdateCleaning",
      operationReference: id(35),
      expectedVersion: 2,
      cleaning: completed,
      purposeCode: "CLEANING_CONTROL",
      occurredAt: latest,
    });
    f.setActor(ids.verifier);
    const failed = cleaning({
      revisionReference: id(41),
      priorRevisionReference: id(40),
      recordVersion: 4,
      status: "VerificationFailed",
      performedByReference: ids.actor,
      startedAt: later,
      completedAt: latest,
      evidenceReferences: [ids.evidence],
      verificationResult: "Failed",
      verifierReference: ids.verifier,
      verifiedAt: tomorrow,
      recordedAt: tomorrow,
      actorReference: ids.verifier,
    });
    await expect(
      f.service.recordCleaning({
        command: "UpdateCleaning",
        operationReference: id(36),
        expectedVersion: 3,
        cleaning: failed,
        purposeCode: "CLEANING_VERIFICATION",
        occurredAt: tomorrow,
      }),
    ).resolves.toMatchObject({ status: "Applied" });
    expect(f.committed.at(-1)?.events[0]?.eventType).toBe("CleaningVerificationFailed");
  });
  it("fails closed on stale stream sequence", async () => {
    const f = fixture();
    await expect(
      f.service.recordReading({
        operationReference: id(37),
        expectedSequence: 2,
        reading: reading(),
        purposeCode: "TEMPERATURE_CONTROL",
        occurredAt: later,
      }),
    ).rejects.toBeInstanceOf(ComplianceMonitoringError);
  });
});
