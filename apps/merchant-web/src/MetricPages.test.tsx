import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetricCatalog, MetricDetail, MetricState } from "./MetricPages.js";
import { parseMetricCatalogView, parseMetricDetailView } from "./metric-pages.js";

const ref = (suffix: string) => `018f9922-0000-7000-8000-${suffix.padStart(12, "0")}`;
const item = () => ({
  metricReference: ref("1"),
  stableCode: "NET_SALES",
  versionReference: ref("2"),
  versionNumber: 3,
  displayNameCode: "NET_SALES_NAME",
  businessDefinitionCode: "NET_SALES_DEFINITION_V1",
  ownerDomainCode: "ORDERING",
  businessOwnerReference: ref("3"),
  lifecycle: "Certified",
  grainCode: "STORE_BUSINESS_DATE_CURRENCY",
  lineageStatus: "Valid",
  dataFreshnessSeconds: 300,
  dataQualityStatus: "Pass",
  effectiveFrom: "2026-08-01T04:00:00.000Z",
  replacementMetricReference: null,
});
const catalog = () => ({
  screenId: "BI-METRIC-CATALOG",
  queryName: "reporting_metric_catalog_v1",
  queryVersion: 1,
  generatedAt: "2026-08-14T18:00:00.000Z",
  permissions: {
    mayCreate: true,
    mayCompare: true,
    mayValidate: true,
    maySubmit: true,
    mayCertify: true,
    mayDeprecate: true,
  },
  filters: {
    nameOrCode: null,
    domainCode: null,
    lifecycle: null,
    ownerReference: null,
    certified: null,
  },
  metrics: [item()],
});
const detail = () => ({
  screenId: "BI-METRIC-DETAIL",
  queryName: "reporting_metric_detail_v1",
  queryVersion: 1,
  generatedAt: "2026-08-14T18:00:00.000Z",
  metric: {
    ...item(),
    formulaReference: ref("4"),
    baseFactReference: ref("5"),
    allowedDimensionCodes: ["STORE", "BUSINESS_DATE", "CURRENCY"],
    requiredFilterCodes: ["STORE"],
    timeSemantics: "BusinessDate",
    timezone: "America/Toronto",
    currencySemantics: "OriginalCurrency",
    currencyCode: null,
    inclusionRuleCodes: ["COMPLETED_ORDER"],
    exclusionRuleCodes: ["VOIDED_ORDER"],
    nullPolicy: "Fail",
    exampleCodes: ["EXAMPLE_STANDARD_ORDER"],
    datasetVersionReferences: [ref("6")],
    transformationVersionReferences: [ref("7")],
    queryExpressionReference: ref("8"),
    dependencyMetricVersionReferences: [ref("9")],
    lastSuccessfulBuildAt: "2026-08-14T17:55:00.000Z",
    history: [
      {
        versionReference: ref("2"),
        versionNumber: 3,
        lifecycle: "Certified",
        effectiveFrom: "2026-08-01T04:00:00.000Z",
      },
    ],
  },
  permissions: {
    mayOpenSource: true,
    mayOpenDependentReports: true,
    mayCreateRevision: true,
    mayRunValidation: true,
  },
});

describe("WP-2163 Metric Catalog and Detail", () => {
  it("renders pinned semantic, lineage, quality and certification actions", () => {
    const list = renderToStaticMarkup(<MetricCatalog view={parseMetricCatalogView(catalog())} />);
    const page = renderToStaticMarkup(<MetricDetail view={parseMetricDetailView(detail())} />);
    expect(list).toContain("Metric catalog");
    expect(list).toContain("Deprecate Metric");
    expect(page).toContain("Semantic contract");
    expect(page).toContain("Lineage and quality");
    expect(page).not.toContain("http");
  });
  it("rejects SQL, URLs, extra fields and unpinned formula references", () => {
    expect(() => parseMetricCatalogView({ ...catalog(), sql: "select *" })).toThrow();
    const raw = detail();
    raw.metric = { ...raw.metric, formulaReference: "https://example.invalid/formula" };
    expect(() => parseMetricDetailView(raw)).toThrow();
  });
  it("hides mutation and private-navigation actions without permission", () => {
    const listValue = catalog();
    listValue.permissions = {
      mayCreate: false,
      mayCompare: false,
      mayValidate: false,
      maySubmit: false,
      mayCertify: false,
      mayDeprecate: false,
    };
    const detailValue = detail();
    detailValue.permissions = {
      mayOpenSource: false,
      mayOpenDependentReports: false,
      mayCreateRevision: false,
      mayRunValidation: false,
    };
    expect(
      renderToStaticMarkup(<MetricCatalog view={parseMetricCatalogView(listValue)} />),
    ).not.toContain("Deprecate Metric");
    expect(
      renderToStaticMarkup(<MetricDetail view={parseMetricDetailView(detailValue)} />),
    ).not.toContain("Open authorized source metadata");
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
    expect(renderToStaticMarkup(<MetricState state={state} />)).toContain('role="status"');
  });
});
