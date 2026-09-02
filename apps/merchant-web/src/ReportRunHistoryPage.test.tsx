import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReportRunHistory, ReportRunHistoryState } from "./ReportRunHistoryPage.js";
import { parseReportRunHistoryView } from "./report-run-history-page.js";
const ref = (suffix: string) => `018f9812-0000-7000-8000-${suffix.padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const first = <T,>(values: T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic run missing");
  return value;
};
const view = () => ({
  screenId: "RPT-RUN-HISTORY",
  queryName: "reporting_report_run_history_v1",
  queryVersion: 1,
  generatedAt: "2026-08-14T16:03:00.000Z",
  permissions: {
    mayRerun: true,
    mayCancel: true,
    mayDownload: true,
    mayRevoke: true,
    mayViewError: true,
  },
  filters: {
    runReference: null,
    reportReference: null,
    status: null,
    dateFrom: null,
    dateTo: null,
    requesterReference: null,
    triggerKind: null,
  },
  runs: [
    {
      runReference: ref("1"),
      reportReference: ref("2"),
      reportVersionReference: ref("3"),
      reportNameCode: "DAILY_OPERATIONS",
      scopeLabel: "Toronto · King",
      parameterSnapshotDigest: digest,
      status: "Completed",
      rowCount: 42,
      dataAsOf: "2026-08-14T16:00:00.000Z",
      generatedAt: "2026-08-14T16:02:00.000Z",
      durationMilliseconds: 120000,
      triggerKind: "Manual",
      requesterReference: ref("4"),
      errorCode: null,
      artifact: {
        revisionReference: ref("5"),
        format: "Csv",
        expiresAt: "2026-08-15T16:02:00.000Z",
        revoked: false,
      },
    },
  ],
});
describe("WP-2162 Report Run history", () => {
  it("renders immutable run, freshness, artifact and exact rerun actions", () => {
    const html = renderToStaticMarkup(
      <ReportRunHistory view={parseReportRunHistoryView(view())} />,
    );
    expect(html).toContain("Report Run history");
    expect(html).toContain("Rerun exact version and parameters");
    expect(html).toContain("Authorize download");
    expect(html).not.toContain("http");
  });
  it("rejects extra fields, unpinned refs, and failed runs without safe error code", () => {
    expect(() =>
      parseReportRunHistoryView({ ...view(), signedUrl: "https://example.invalid" }),
    ).toThrow();
    const invalid = view();
    invalid.runs[0] = { ...first(invalid.runs), reportVersionReference: "latest" };
    expect(() => parseReportRunHistoryView(invalid)).toThrow();
    const failed = view();
    failed.runs[0] = { ...first(failed.runs), status: "Failed", errorCode: null };
    expect(() => parseReportRunHistoryView(failed)).toThrow();
  });
  it("hides unavailable mutations and revoked download", () => {
    const value = view();
    value.permissions = {
      mayRerun: false,
      mayCancel: false,
      mayDownload: true,
      mayRevoke: true,
      mayViewError: false,
    };
    const item = first(value.runs);
    value.runs[0] = { ...item, artifact: { ...item.artifact, revoked: true } };
    const html = renderToStaticMarkup(<ReportRunHistory view={parseReportRunHistoryView(value)} />);
    expect(html).not.toContain("Authorize download");
    expect(html).not.toContain("Revoke artifact");
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
    expect(renderToStaticMarkup(<ReportRunHistoryState state={state} />)).toContain(
      'role="status"',
    );
  });
});
