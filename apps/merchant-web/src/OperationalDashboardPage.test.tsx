import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationalDashboard, OperationalDashboardState } from "./OperationalDashboardPage.js";
import { parseOperationalDashboardView } from "./operational-dashboard-page.js";

const r = (n: number) => `018f0f58-767a-7f3b-a1d0-${String(n).padStart(12, "0")}`;
const view = (overrides: Record<string, unknown> = {}) => ({
  screenId: "RPT-OPS-DASHBOARD",
  queryName: "reporting_operations_dashboard_v1",
  queryVersion: 1,
  scope: {
    tenantReference: r(1),
    brandReference: r(2),
    brandLabel: "North Brand",
    storeReference: r(3),
    storeLabel: "King Store",
  },
  authorizedScopes: [
    {
      brandReference: r(2),
      brandLabel: "North Brand",
      storeReference: r(3),
      storeLabel: "King Store",
    },
  ],
  businessDate: "2026-08-14",
  timezone: "America/Toronto",
  currencyCode: "CAD",
  sourceChannel: "All",
  orderType: "All",
  generatedAt: "2026-08-15T03:00:00.000Z",
  dataAsOfUtc: "2026-08-15T02:59:00.000Z",
  completenessStatus: "Complete",
  permissions: {
    mayChangeScope: false,
    mayDrill: true,
    maySaveView: true,
    mayExport: true,
    maySchedule: false,
  },
  metricVersions: {
    sales: "captured_sales.v1",
    orders: "order_count.v1",
    payments: "payment_operations_count.v1",
    kitchen: "kitchen_work_count.v1",
    fulfillment: "fulfillment_count.v1",
    exceptions: "order_exception_count.v1",
  },
  lineage: [
    ["merchant_order_queue_v1", "/operations/orders"],
    ["payment_operations_v1", "/app/operations/payments"],
    ["kitchen_operations_v1", "/operations/kitchen"],
    ["fulfillment_operations_v1", "/operations/pickup"],
    ["merchant_order_exception_v1", "/operations/order-exceptions"],
  ].map(([sourceName, drillTarget], index) => ({
    sourceName,
    sourceCheckpoint: r(20 + index),
    asOfUtc: "2026-08-15T02:59:00.000Z",
    status: "Present",
    drillTarget,
  })),
  sales: {
    capturedAmountMinor: "2500",
    refundedAmountMinor: "500",
    netCapturedAmountMinor: "2000",
  },
  orders: { total: 2, open: 1, fulfilled: 1, rejected: 0, cancelled: 0 },
  payments: { attempts: 2, pending: 1, providerUnknown: 0, reconciliationDifferences: 0 },
  kitchen: { workItems: 2, queued: 1, inProgress: 0, completed: 1, exceptions: 0 },
  fulfillment: {
    fulfillments: 1,
    pending: 0,
    ready: 0,
    inProgress: 0,
    completed: 1,
    exceptions: 0,
  },
  exceptions: { open: 1, critical: 0 },
  ...overrides,
});

describe("Operational Dashboard page", () => {
  it("renders exact scope, metric versions, CAD minor units, freshness and authorized drills", () => {
    const html = renderToStaticMarkup(
      <OperationalDashboard view={parseOperationalDashboardView(view())} />,
    );
    for (const value of [
      "Operational dashboard",
      "King Store · Business Date 2026-08-14",
      "CAD 20.00",
      "Metric captured_sales.v1",
      "Create export job",
      "Open authorized source facts",
    ])
      expect(html).toContain(value);
    expect(html.match(/Open authorized source facts/gu)).toHaveLength(5);
    expect(html).not.toContain("Schedule report");
  });

  it("keeps partial results read-only and labels missing KPI values as unavailable, not zero", () => {
    const complete = view();
    const partial = view({
      completenessStatus: "Partial",
      sales: null,
      payments: null,
      lineage: complete.lineage.map((item) =>
        item.sourceName === "payment_operations_v1"
          ? {
              ...item,
              sourceCheckpoint: null,
              asOfUtc: null,
              status: "Unavailable",
              drillTarget: null,
            }
          : item,
      ),
    });
    const html = renderToStaticMarkup(
      <OperationalDashboard view={parseOperationalDashboardView(partial)} />,
    );
    expect(html).toContain("Projection stale");
    expect(html.match(/Unavailable — not zero/gu)).toHaveLength(2);
    expect(html).toContain("disabled");
    expect(html.match(/Open authorized source facts/gu)).toHaveLength(4);
  });

  it("rejects unauthorized scope expansion, unsafe drill targets, hidden drills and extra fields", () => {
    expect(() => parseOperationalDashboardView(view({ authorizedScopes: [] }))).toThrow();
    const original = view();
    expect(() =>
      parseOperationalDashboardView(
        view({
          lineage: original.lineage.map((item, index) =>
            index === 0 ? { ...item, drillTarget: "https://example.invalid/private" } : item,
          ),
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationalDashboardView(
        view({ permissions: { ...original.permissions, mayDrill: false } }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationalDashboardView({ ...view(), providerPayload: "prohibited" }),
    ).toThrow();
    expect(() =>
      parseOperationalDashboardView(
        view({
          sales: {
            capturedAmountMinor: "2500",
            refundedAmountMinor: "500",
            netCapturedAmountMinor: "2501",
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseOperationalDashboardView(
        view({
          completenessStatus: "Partial",
          lineage: original.lineage.map((item) =>
            item.sourceName === "payment_operations_v1"
              ? {
                  ...item,
                  sourceCheckpoint: null,
                  asOfUtc: null,
                  status: "Unavailable",
                  drillTarget: null,
                }
              : item,
          ),
        }),
      ),
    ).toThrow();
  });

  it("renders all fail-closed route states", () => {
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const) {
      expect(renderToStaticMarkup(<OperationalDashboardState state={state} />)).toContain("status");
    }
  });
});
