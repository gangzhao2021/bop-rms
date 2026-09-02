import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ComplianceTraceability,
  ComplianceTraceabilityState,
} from "./ComplianceTraceabilityPage.js";
import { parseComplianceTraceabilityView } from "./compliance-traceability-page.js";

const ref = (value: string) => `018f9981-0000-7000-8000-${value.padStart(12, "0")}`;
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const generated = "2026-08-14T20:00:00.000Z";
const source = "2026-08-14T19:00:00.000Z";
const first = <T,>(values: readonly T[]): T => {
  const value = values[0];
  if (value === undefined) throw new Error("synthetic trace item missing");
  return value;
};
const view = () => ({
  screenId: "TRACE-EXPLORER",
  queryName: "compliance_traceability_v1",
  queryVersion: 1,
  generatedAt: generated,
  sourceAsOf: source,
  freshness: "Current",
  completeness: "Complete",
  projectionVersionReference: ref("1"),
  permissions: {
    mayPinEvidenceSet: true,
    mayExportRestrictedArtifact: true,
    mayOpenRecall: true,
  },
  filters: {
    direction: "Forward",
    seedKind: "Supplier",
    seedReference: ref("2"),
    periodFrom: "2026-08-14T16:00:00.000Z",
    periodTo: "2026-08-14T18:00:00.000Z",
    storeReference: null,
  },
  result: {
    runReference: ref("3"),
    requestedAt: "2026-08-14T18:00:00.000Z",
    completedAt: "2026-08-14T18:00:01.000Z",
    nodes: [
      {
        nodeReference: ref("4"),
        kind: "Supplier",
        sourceReference: ref("5"),
        ownerDomain: "Procurement",
        occurredAt: "2026-08-14T16:30:00.000Z",
        snapshotDigest: hash("a"),
        accessClass: "Internal",
      },
      {
        nodeReference: ref("6"),
        kind: "PurchaseOrder",
        sourceReference: ref("7"),
        ownerDomain: "Procurement",
        occurredAt: "2026-08-14T16:31:00.000Z",
        snapshotDigest: hash("b"),
        accessClass: "Internal",
      },
    ],
    edges: [
      {
        edgeReference: ref("8"),
        fromNodeReference: ref("4"),
        toNodeReference: ref("6"),
        relationship: "SuppliedOn",
        occurredAt: "2026-08-14T16:31:00.000Z",
      },
    ],
    gaps: [],
    evidenceSet: null,
    exportReceipt: null,
    recallOutcome: null,
  },
});

describe("WP-2176 TRACE-EXPLORER", () => {
  it("renders an exact Trace Run and permission-gated actions", () => {
    const html = renderToStaticMarkup(
      <ComplianceTraceability view={parseComplianceTraceabilityView(view())} />,
    );
    expect(html).toContain("TRACE-EXPLORER");
    expect(html).toContain("Complete chain");
    expect(html).toContain("Supplied On");
    expect(html).toContain("Pin restricted Evidence Set");
    expect(html).toContain("Open Recall from Trace");
  });

  it("renders explicit partial Gaps and never claims completeness", () => {
    const partial = view();
    partial.completeness = "Partial";
    partial.result.gaps = [
      {
        gapReference: ref("9"),
        adjacentNodeReference: ref("6"),
        expectedKind: "GoodsReceipt",
        direction: "Forward",
        reason: "PermissionTrimmed",
        detectedAt: "2026-08-14T18:00:01.000Z",
      },
    ] as never;
    const html = renderToStaticMarkup(
      <ComplianceTraceability view={parseComplianceTraceabilityView(partial)} />,
    );
    expect(html).toContain("Partial chain");
    expect(html).toContain("Trace gaps require review");
    expect(html).toContain("Permission Trimmed");
  });

  it("masks Customer source identity and rejects unrestricted Customer nodes", () => {
    const restricted = view();
    restricted.result.nodes = [
      {
        ...first(restricted.result.nodes),
        nodeReference: ref("10"),
        kind: "Customer",
        sourceReference: null,
        ownerDomain: "Customer",
        accessClass: "Restricted",
      },
    ] as never;
    restricted.result.edges = [];
    expect(
      renderToStaticMarkup(
        <ComplianceTraceability view={parseComplianceTraceabilityView(restricted)} />,
      ),
    ).toContain("Restricted Customer reference");
    const exposed = view();
    exposed.result.nodes = [
      {
        ...first(restricted.result.nodes),
        sourceReference: ref("11"),
      },
    ] as never;
    exposed.result.edges = [];
    expect(() => parseComplianceTraceabilityView(exposed)).toThrow();
  });

  it("rejects invented links, hidden Gaps, unsafe extras, and unbounded graphs", () => {
    const topology = view();
    topology.result.edges[0] = {
      ...first(topology.result.edges),
      relationship: "CompletedByFulfillment",
    } as never;
    expect(() => parseComplianceTraceabilityView(topology)).toThrow();
    const hidden = view();
    hidden.completeness = "Partial";
    expect(() => parseComplianceTraceabilityView(hidden)).toThrow();
    expect(() => parseComplianceTraceabilityView({ ...view(), customerEmail: "x" })).toThrow();
    const huge = view();
    huge.result.nodes = Array.from({ length: 501 }, () => first(view().result.nodes)) as never;
    expect(() => parseComplianceTraceabilityView(huge)).toThrow();
  });

  it("renders an explicit empty result", () => {
    const empty = view();
    empty.result = null as never;
    expect(
      renderToStaticMarkup(
        <ComplianceTraceability view={parseComplianceTraceabilityView(empty)} />,
      ),
    ).toContain("No trace result");
  });

  it("shows pinned Evidence and opaque export/Recall outcomes without artifact bytes", () => {
    const completed = view();
    completed.result.evidenceSet = {
      evidenceSetReference: ref("12"),
      revision: 1,
      caseReference: ref("13"),
      selectedNodeCount: "2",
      selectedEdgeCount: "1",
      selectedGapCount: "0",
      retentionPolicyReference: ref("14"),
      legalHold: true,
      accessClass: "Restricted",
    } as never;
    completed.result.exportReceipt = {
      artifactReference: ref("15"),
      artifactDigest: hash("c"),
      recordedAt: generated,
      accessClass: "Restricted",
    } as never;
    completed.result.recallOutcome = {
      recallReference: ref("16"),
      recordedAt: generated,
    } as never;
    const html = renderToStaticMarkup(
      <ComplianceTraceability view={parseComplianceTraceabilityView(completed)} />,
    );
    expect(html).toContain("Restricted Evidence Set");
    expect(html).toContain(`Restricted artifact ${ref("15")}`);
    expect(html).toContain(`Recall owner outcome ${ref("16")}`);
    expect(html).not.toMatch(/https?:\/\//u);
  });

  it("hides mutations without exact permissions", () => {
    const denied = view();
    denied.permissions = {
      mayPinEvidenceSet: false,
      mayExportRestrictedArtifact: false,
      mayOpenRecall: false,
    };
    const html = renderToStaticMarkup(
      <ComplianceTraceability view={parseComplianceTraceabilityView(denied)} />,
    );
    expect(html).not.toMatch(/Pin restricted|Export restricted|Open Recall/u);
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
  ] as const)("renders %s", (state) => {
    expect(renderToStaticMarkup(<ComplianceTraceabilityState state={state} />)).toContain(
      'role="status"',
    );
  });
});
