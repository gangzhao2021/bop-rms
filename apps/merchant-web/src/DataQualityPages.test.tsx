import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataQuality, DataQualityState, Reconciliation } from "./DataQualityPages.js";
import { parseDataQualityView, parseReconciliationView } from "./data-quality-pages.js";

const ref = (suffix: string) => `018f9932-0000-7000-8000-${suffix.padStart(12, "0")}`;
const quality = () => ({
  screenId: "BI-DATA-QUALITY",
  queryName: "reporting_data_quality_v1",
  queryVersion: 1,
  generatedAt: "2026-08-14T18:00:00.000Z",
  permissions: {
    mayAcknowledge: true,
    mayAssign: true,
    mayRunCheck: true,
    mayRequestBackfill: true,
    mayOpenIncident: true,
  },
  filters: {
    checkReference: null,
    datasetVersionReference: null,
    status: "Open",
    severity: "Critical",
    ownerReference: null,
    dateFrom: null,
  },
  issues: [
    {
      resultReference: ref("1"),
      checkReference: ref("2"),
      checkKind: "COMPLETENESS",
      datasetVersionReference: ref("3"),
      partitionCode: "BUSINESS_DATE_2026_08_14",
      severity: "Critical",
      status: "Open",
      firstFailureAt: "2026-08-14T17:00:00.000Z",
      lastFailureAt: "2026-08-14T18:00:00.000Z",
      affectedFrom: "2026-08-14T17:00:00.000Z",
      affectedUntil: "2026-08-14T18:00:00.000Z",
      scopeCode: "BRAND",
      ownerReference: null,
      reconciliationExceptionReference: ref("4"),
    },
  ],
});
const reconciliation = () => ({
  screenId: "BI-RECONCILIATION",
  queryName: "reporting_reconciliation_v1",
  queryVersion: 1,
  generatedAt: "2026-08-14T18:00:00.000Z",
  permissions: {
    mayRun: true,
    mayDrill: true,
    mayCreateException: true,
    mayRecordResolution: true,
  },
  filters: {
    control: "PaymentLedger",
    periodFrom: null,
    scopeCode: "BRAND",
    status: "Investigating",
    differenceOnly: true,
  },
  controls: [
    {
      runReference: ref("5"),
      exceptionReference: ref("6"),
      control: "PaymentLedger",
      periodFrom: "2026-08-14T17:00:00.000Z",
      periodUntil: "2026-08-14T18:00:00.000Z",
      differenceValue: "0.2",
      unitCode: "CAD",
      status: "Investigating",
      scopeCode: "BRAND",
      ownerReference: ref("7"),
    },
  ],
});

describe("WP-2164 Data Quality and Reconciliation", () => {
  it("renders canonical fields and source-safe actions", () => {
    const qualityPage = renderToStaticMarkup(
      <DataQuality view={parseDataQualityView(quality())} />,
    );
    const reconciliationPage = renderToStaticMarkup(
      <Reconciliation view={parseReconciliationView(reconciliation())} />,
    );
    expect(qualityPage).toContain("BI-DATA-QUALITY");
    expect(qualityPage).toContain("Request backfill");
    expect(reconciliationPage).toContain("BI-RECONCILIATION");
    expect(reconciliationPage).toContain("matched rerun");
    expect(reconciliationPage).not.toContain("Modify source");
  });

  it("rejects URLs, SQL, floats, extra fields and inconsistent difference states", () => {
    expect(() => parseDataQualityView({ ...quality(), sql: "select private_data" })).toThrow();
    expect(() =>
      parseReconciliationView({
        ...reconciliation(),
        controls: [{ ...reconciliation().controls[0], differenceValue: 0.2 }],
      }),
    ).toThrow();
    expect(() =>
      parseReconciliationView({
        ...reconciliation(),
        controls: [{ ...reconciliation().controls[0], status: "Matched" }],
      }),
    ).toThrow();
  });

  it("hides every action when permissions are absent", () => {
    const qualityValue = quality();
    qualityValue.permissions = {
      mayAcknowledge: false,
      mayAssign: false,
      mayRunCheck: false,
      mayRequestBackfill: false,
      mayOpenIncident: false,
    };
    const reconciliationValue = reconciliation();
    reconciliationValue.permissions = {
      mayRun: false,
      mayDrill: false,
      mayCreateException: false,
      mayRecordResolution: false,
    };
    expect(
      renderToStaticMarkup(<DataQuality view={parseDataQualityView(qualityValue)} />),
    ).not.toContain("Acknowledge");
    expect(
      renderToStaticMarkup(<Reconciliation view={parseReconciliationView(reconciliationValue)} />),
    ).not.toContain("Drill into");
  });

  it.each([
    "Loading",
    "PermissionDenied",
    "NotFound",
    "FeatureDisabled",
    "Stale",
    "Conflict",
    "CommandFailed",
    "Offline",
    "Unavailable",
  ] as const)("renders the %s state", (state) => {
    expect(renderToStaticMarkup(<DataQualityState state={state} />)).toContain('role="status"');
  });
});
