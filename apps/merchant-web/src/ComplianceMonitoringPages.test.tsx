import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CleaningLog,
  ComplianceMonitoringState,
  TemperatureLog,
} from "./ComplianceMonitoringPages.js";
import { parseCleaningLogView, parseTemperatureLogView } from "./compliance-monitoring-pages.js";
const ref = (value: string) => `018f9951-0000-7000-8000-${value.padStart(12, "0")}`;
const at = "2026-08-14T20:00:00.000Z";
const before = "2026-08-14T19:00:00.000Z";
const first = <T,>(values: T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic monitoring item missing");
  return value;
};
const temperature = () => ({
  screenId: "CMP-TEMP-LOG",
  queryName: "compliance_temperature_log_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions: {
    mayRecordManual: true,
    mayAcknowledgeExcursion: true,
    mayOpenIncident: true,
    mayCreateCorrectiveAction: true,
  },
  filters: {
    targetReference: null,
    deviceReference: null,
    thresholdResult: null,
    method: null,
    dateFrom: null,
    dateTo: null,
    unverifiedOnly: false,
  },
  readings: [
    {
      readingReference: ref("1"),
      correctionOfReadingReference: null,
      targetReference: ref("2"),
      targetCode: "COOLER_1",
      measurementTypeCode: "FOOD_TEMPERATURE",
      value: "9.25",
      unitCode: "CELSIUS",
      measuredAt: before,
      capturedAt: at,
      method: "Sensor",
      operatorReference: ref("3"),
      deviceReference: ref("4"),
      policyVersionReference: ref("5"),
      thresholdResult: "AboveRange",
      calibrationReference: ref("6"),
      excursion: {
        excursionReference: ref("7"),
        severity: "Critical",
        status: "Contained",
        containmentReference: ref("8"),
        dispositionReference: null,
      },
    },
  ],
});
const cleaning = () => ({
  screenId: "CMP-CLEANING",
  queryName: "compliance_cleaning_log_v1",
  queryVersion: 1,
  generatedAt: at,
  sourceAsOf: before,
  freshness: "Current",
  completeness: "Complete",
  permissions: {
    mayComplete: true,
    mayReportCannotComplete: true,
    mayVerify: true,
    mayEscalateMissed: true,
  },
  filters: {
    targetReference: null,
    status: null,
    assigneeReference: null,
    dueDisposition: null,
    missedOnly: false,
  },
  records: [
    {
      cleaningReference: ref("9"),
      scheduleReference: ref("10"),
      taskReference: ref("11"),
      targetReference: ref("2"),
      targetCode: "PREP_AREA",
      procedureVersionReference: ref("12"),
      assigneeReference: ref("13"),
      dueAt: at,
      dueTimezone: "America/Toronto",
      severity: "Major",
      status: "Completed",
      performedByReference: ref("3"),
      startedAt: before,
      completedAt: at,
      methodCode: "SANITIZE",
      chemicalResult: "OutsideRequirement",
      evidenceReferenceCount: "2",
      verificationResult: "Pending",
      verifierReference: null,
      safetyReviewReference: ref("14"),
      missed: false,
    },
  ],
});
describe("WP-2173 monitoring screens", () => {
  it("renders Excursion controls without asserting Inventory disposition", () => {
    const html = renderToStaticMarkup(
      <TemperatureLog view={parseTemperatureLogView(temperature())} />,
    );
    expect(html).toContain("Critical Excursion");
    expect(html).toContain("disposition Not confirmed");
    expect(html).toContain("Create Corrective Action");
  });
  it("renders Cleaning completion separately from Verification and Safety Review", () => {
    const html = renderToStaticMarkup(<CleaningLog view={parseCleaningLogView(cleaning())} />);
    expect(html).toContain("Completed");
    expect(html).toContain("Verification Pending");
    expect(html).toContain("Verify independently");
    expect(html).toContain("Safety Review");
  });
  it("rejects binary floats, impossible missing values, restricted extras, and unbounded readings", () => {
    const float = temperature();
    float.readings[0] = { ...first(float.readings), value: 9.25 } as never;
    expect(() => parseTemperatureLogView(float)).toThrow();
    const missing = temperature();
    missing.readings[0] = {
      ...first(missing.readings),
      thresholdResult: "Missing",
      value: "4",
    } as never;
    expect(() => parseTemperatureLogView(missing)).toThrow();
    expect(() => parseTemperatureLogView({ ...temperature(), rawEvidence: [] })).toThrow();
    const huge = temperature();
    huge.readings = Array.from({ length: 501 }, () => temperature().readings[0] as never);
    expect(() => parseTemperatureLogView(huge)).toThrow();
  });
  it("rejects failed Verification without exact status and outside chemical state without review", () => {
    const failed = cleaning();
    failed.records[0] = {
      ...first(failed.records),
      verificationResult: "Failed",
      verifierReference: ref("15"),
    } as never;
    expect(() => parseCleaningLogView(failed)).toThrow();
    const unsafe = cleaning();
    unsafe.records[0] = {
      ...first(unsafe.records),
      safetyReviewReference: null,
    } as never;
    expect(() => parseCleaningLogView(unsafe)).toThrow();
  });
  it("hides unauthorized mutation controls", () => {
    const value = cleaning();
    value.permissions = {
      mayComplete: false,
      mayReportCannotComplete: false,
      mayVerify: false,
      mayEscalateMissed: false,
    };
    const html = renderToStaticMarkup(<CleaningLog view={parseCleaningLogView(value)} />);
    expect(html).not.toMatch(/Complete with|Report cannot|Verify independently|Escalate missed/);
  });
  it.each([
    "Loading",
    "PermissionDenied",
    "NotFound",
    "Stale",
    "Conflict",
    "CommandFailed",
    "Offline",
    "Unavailable",
  ] as const)("renders %s", (state) => {
    expect(renderToStaticMarkup(<ComplianceMonitoringState state={state} />)).toContain(
      'role="status"',
    );
  });
});
