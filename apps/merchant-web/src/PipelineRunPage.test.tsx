import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PipelineRunList, PipelineRunState } from "./PipelineRunPage.js";
import { parsePipelineRunView } from "./pipeline-run-page.js";
const ref = (suffix: string) => `018f9915-0000-7000-8000-${suffix.padStart(12, "0")}`;
const first = <T,>(values: T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic Pipeline Run missing");
  return value;
};
const view = () => ({
  screenId: "BI-PIPELINE-RUN",
  queryName: "reporting_pipeline_run_v1",
  queryVersion: 1,
  generatedAt: "2026-08-14T18:00:00.000Z",
  permissions: {
    mayRetry: true,
    mayRequestBackfill: true,
    mayApproveBackfill: true,
    mayOpenIncident: true,
  },
  filters: {
    pipelineReference: null,
    runReference: null,
    status: null,
    environmentCode: null,
    dateFrom: null,
    dateTo: null,
  },
  runs: [
    {
      runReference: ref("1"),
      pipelineReference: ref("2"),
      pipelineVersionReference: ref("3"),
      transformationVersionReference: ref("4"),
      inputCheckpointReference: ref("5"),
      outputDatasetVersionReference: ref("6"),
      outputPartitionCode: "BUSINESS_DATE_2026_08_14",
      environmentCode: "TEST",
      executionKind: "Retry",
      status: "Failed",
      watermarkOccurredAt: "2026-08-14T17:59:00.000Z",
      recordsLate: "2",
      recordsRejected: "1",
      durationMilliseconds: 9000,
      dataQualityResultReference: null,
      preReconciliationRunReference: null,
      postReconciliationRunReference: null,
      backfillRequestVersionReference: ref("7"),
      errorCode: "STAGE_FAILED",
    },
  ],
});
describe("WP-2165 Pipeline Run", () => {
  it("renders pinned lineage, bounded counts and gated Data Operations actions", () => {
    const html = renderToStaticMarkup(<PipelineRunList view={parsePipelineRunView(view())} />);
    expect(html).toContain("Pipeline Runs");
    expect(html).toContain("Retry idempotent stage");
    expect(html).toContain("Review Backfill approval");
    expect(html).toContain("Lineage:");
    expect(html).not.toContain("select ");
  });
  it("rejects extra payloads, unpinned versions and failure without an opaque code", () => {
    expect(() => parsePipelineRunView({ ...view(), rawRows: [] })).toThrow();
    const unpinned = view();
    unpinned.runs[0] = { ...first(unpinned.runs), pipelineVersionReference: "latest" };
    expect(() => parsePipelineRunView(unpinned)).toThrow();
    const missing = view();
    missing.runs[0] = { ...first(missing.runs), errorCode: null as never };
    expect(() => parsePipelineRunView(missing)).toThrow();
  });
  it("hides mutations without current permissions", () => {
    const denied = view();
    denied.permissions = {
      mayRetry: false,
      mayRequestBackfill: false,
      mayApproveBackfill: false,
      mayOpenIncident: false,
    };
    const html = renderToStaticMarkup(<PipelineRunList view={parsePipelineRunView(denied)} />);
    expect(html).not.toContain("Retry idempotent stage");
    expect(html).not.toContain("Request Backfill");
    expect(html).not.toContain("Open incident");
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
    expect(renderToStaticMarkup(<PipelineRunState state={state} />)).toContain('role="status"');
  });
});
