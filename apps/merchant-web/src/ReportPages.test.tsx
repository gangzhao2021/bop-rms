import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportBuilder, ReportCatalog, ReportPageState } from "./ReportPages.js";
import { parseReportBuilderView, parseReportCatalogView } from "./report-pages.js";

const ref = (suffix: string) => `018f9801-0000-7000-8000-${suffix.padStart(12, "0")}`;
const catalog = () => ({
  screenId: "RPT-REPORT-CATALOG",
  queryName: "reporting_report_catalog_v1",
  queryVersion: 1,
  generatedAt: "2026-08-14T16:00:00.000Z",
  scopeLabel: "Toronto · King",
  filters: {
    nameCode: null,
    domain: null,
    certifiedOnly: false,
    ownerReference: null,
    scheduledOnly: false,
  },
  permissions: { mayCreate: true, mayEdit: true, mayCertify: true, maySchedule: true },
  reports: [
    {
      reportReference: ref("1"),
      nameCode: "DAILY_SALES",
      domain: "SALES",
      certificationStatus: "Certified",
      ownerReference: ref("2"),
      scope: "Store",
      lastRunAt: null,
      scheduleStatus: "Active",
    },
  ],
});
const builder = () => ({
  screenId: "RPT-REPORT-BUILDER",
  queryName: "reporting_report_builder_v1",
  queryVersion: 1,
  reportReference: ref("1"),
  aggregateVersion: 3,
  versionReference: ref("3"),
  nameCode: "DAILY_SALES",
  lifecycle: "Published",
  certificationStatus: "Certified",
  datasetVersionReferences: [ref("4")],
  metricVersionReferences: [ref("5")],
  dimensions: ["BUSINESS_DATE"],
  filters: [{ fieldCode: "CHANNEL", operator: "In", valueCodes: ["WEB"] }],
  sorts: [{ fieldCode: "BUSINESS_DATE", direction: "Descending" }],
  visualization: "Table",
  rowLimit: 1000,
  scopePolicy: "Store",
  schedule: { status: "Active", cadence: "Daily", format: "Csv" },
  validation: { status: "Passed", checkedAt: "2026-08-14T16:00:00.000Z" },
  preview: { status: "Ready", rowCount: 25, generatedAt: "2026-08-14T16:00:00.000Z" },
  permissions: { mayEdit: true, maySubmitReview: false, mayCertify: false, maySchedule: true },
});

describe("WP-2161 report pages", () => {
  it("renders the catalog contract and constructs the only edit target", () => {
    const html = renderToStaticMarkup(<ReportCatalog view={parseReportCatalogView(catalog())} />);
    expect(html).toContain("Report catalog");
    expect(html).toContain(`/app/reports/${ref("1")}/edit`);
    expect(html).toContain("Schedule");
  });
  it("renders pinned builder inputs, validation, preview, and schedule metadata", () => {
    const html = renderToStaticMarkup(<ReportBuilder view={parseReportBuilderView(builder())} />);
    expect(html).toContain("Approved sources");
    expect(html).toContain("Validation Passed");
    expect(html).toContain("Daily");
  });
  it("rejects extra fields and injected or non-version references", () => {
    expect(() => parseReportCatalogView({ ...catalog(), rawSql: "select *" })).toThrow();
    expect(() => parseReportBuilderView({ ...builder(), dimensions: ["<script>"] })).toThrow();
    expect(() =>
      parseReportBuilderView({ ...builder(), datasetVersionReferences: ["latest"] }),
    ).toThrow();
  });
  it("hides mutation actions when permissions are absent", () => {
    const value = catalog();
    value.permissions = { mayCreate: false, mayEdit: false, mayCertify: false, maySchedule: false };
    const html = renderToStaticMarkup(<ReportCatalog view={parseReportCatalogView(value)} />);
    expect(html).not.toContain("Create report draft");
    expect(html).not.toContain("Open builder");
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
    expect(renderToStaticMarkup(<ReportPageState state={state} />)).toContain('role="status"');
  });
});
