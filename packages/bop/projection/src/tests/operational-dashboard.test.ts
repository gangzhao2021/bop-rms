import { describe, expect, it } from "vitest";
import {
  buildFulfillmentOperationalProjection,
  buildKitchenOperationalProjection,
  buildOperationalDashboardQuery,
  buildOrderExceptionProjection,
  buildOrderOperationalProjection,
  buildPaymentOperationalProjection,
  OperationalProjectionError,
} from "../index.js";

const r = (n: number) => `018f0f58-767a-7f3b-a1d0-${String(n).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const scope = { tenantReference: r(1), brandReference: r(2), storeReference: r(3) };
const base = {
  ...scope,
  businessDate: "2026-08-12",
  generationReference: r(4),
  sourceCheckpoint: r(5),
  asOfUtc: "2026-08-12T20:00:00.000Z",
  projectedAt: "2026-08-12T20:00:01.000Z",
  lastRebuiltAt: null,
};
const order = buildOrderOperationalProjection({
  ...base,
  orders: [
    {
      ...scope,
      orderReference: r(10),
      orderNumber: "ORDER-10",
      orderType: "Pickup",
      sourceChannel: "Qr",
      phase: "Fulfilled",
      submittedAt: "2026-08-12T19:00:00.000Z",
      sourceVersion: 2n,
      sourceDigest: digest,
    },
    {
      ...scope,
      orderReference: r(11),
      orderNumber: "ORDER-11",
      orderType: "DineIn",
      sourceChannel: "Pos",
      phase: "Submitted",
      submittedAt: "2026-08-12T19:30:00.000Z",
      sourceVersion: 1n,
      sourceDigest: digest,
    },
  ],
  collaborators: [],
});
const payment = buildPaymentOperationalProjection({
  ...base,
  sources: [
    {
      ...scope,
      paymentReference: r(20),
      attemptReference: r(21),
      orderReference: r(10),
      methodFamily: "OnlineCard",
      state: "PartiallyRefunded",
      currencyCode: "CAD",
      authorizedAmountMinor: "2500",
      capturedAmountMinor: "2500",
      refundedAmountMinor: "500",
      providerState: "Confirmed",
      reconciliationStatus: "NotChecked",
      settlementReference: null,
      exceptionReference: null,
      lastCheckedAt: null,
      updatedAt: "2026-08-12T19:45:00.000Z",
      sourceVersion: 2n,
      sourceDigest: digest,
    },
  ],
});
const kitchen = buildKitchenOperationalProjection({
  ...base,
  stationReference: null,
  sources: [
    {
      ...scope,
      ticketReference: r(30),
      workItemReference: r(31),
      orderReference: r(10),
      orderItemReference: r(32),
      stationReference: r(33),
      status: "Completed",
      requiredQuantity: 1,
      completedQuantity: 1,
      safetyCue: "None",
      exceptionReference: null,
      acceptedAt: "2026-08-12T19:05:00.000Z",
      startedAt: "2026-08-12T19:06:00.000Z",
      completedAt: "2026-08-12T19:10:00.000Z",
      orderItemReadyAt: "2026-08-12T19:10:00.000Z",
      updatedAt: "2026-08-12T19:10:00.000Z",
      sourceVersion: 3n,
      sourceDigest: digest,
    },
  ],
});
const fulfillment = buildFulfillmentOperationalProjection({
  ...base,
  sources: [
    {
      ...scope,
      fulfillmentReference: r(40),
      orderReference: r(10),
      fulfillmentType: "Pickup",
      phase: "Completed",
      orderedQuantity: 1,
      readyQuantity: 1,
      handedOverQuantity: 1,
      packageCount: 1,
      proofReadiness: "Validated",
      stagingLocationLabel: null,
      exceptionReference: null,
      readyAt: "2026-08-12T19:10:00.000Z",
      completedAt: "2026-08-12T19:15:00.000Z",
      updatedAt: "2026-08-12T19:15:00.000Z",
      sourceVersion: 4n,
      sourceDigest: digest,
    },
  ],
});
const exception = buildOrderExceptionProjection({
  ...scope,
  businessDate: "2026-08-12",
  checkpointReference: r(5),
  projectedAt: "2026-08-12T20:00:01.000Z",
  freshnessStatus: "Fresh",
  sources: [],
  deriveProjectionReference: () => r(50),
});
const query = (overrides = {}) => ({
  queryReference: r(60),
  permission: "reporting.read",
  purpose: "OperationalReporting",
  ...scope,
  businessDate: "2026-08-12",
  timezone: "America/Toronto",
  currencyCode: "CAD",
  sourceChannel: "All",
  orderType: "All",
  requestedAt: "2026-08-12T20:00:02.000Z",
  requestedByActorReference: r(61),
  ...overrides,
});
const sources = { order, payment, kitchen, fulfillment, exception };

describe("WP-1905 basic Merchant dashboard query", () => {
  it("aggregates exact CAD minor units and exposes source lineage", () => {
    expect(
      buildOperationalDashboardQuery({
        query: query(),
        authorizedPermissions: ["reporting.read"],
        sources,
        generatedAt: "2026-08-12T20:00:03.000Z",
      }),
    ).toMatchObject({
      completenessStatus: "Complete",
      metricVersions: { sales: "captured_sales.v1", orders: "order_count.v1" },
      dataAsOfUtc: "2026-08-12T20:00:00.000Z",
      sales: {
        capturedAmountMinor: "2500",
        refundedAmountMinor: "500",
        netCapturedAmountMinor: "2000",
      },
      orders: { total: 2, open: 1, fulfilled: 1 },
      payments: { attempts: 1 },
      kitchen: { completed: 1 },
      fulfillment: { completed: 1 },
      exceptions: { open: 0, critical: 0 },
    });
  });

  it("applies authorized channel and order-type filters to every KPI", () => {
    const result = buildOperationalDashboardQuery({
      query: query({ sourceChannel: "Pos", orderType: "DineIn" }),
      authorizedPermissions: ["reporting.read"],
      sources,
      generatedAt: "2026-08-12T20:00:03.000Z",
    });
    expect(result.orders).toMatchObject({ total: 1, open: 1 });
    expect(result.sales).toMatchObject({ capturedAmountMinor: "0", netCapturedAmountMinor: "0" });
    expect(result.kitchen).toMatchObject({ workItems: 0 });
  });

  it("labels a missing collaborating source and never substitutes zero KPI values", () => {
    const result = buildOperationalDashboardQuery({
      query: query(),
      authorizedPermissions: ["reporting.read"],
      sources: { ...sources, payment: null },
      generatedAt: "2026-08-12T20:00:03.000Z",
    });
    expect(result.completenessStatus).toBe("Partial");
    expect(result.sales).toBeNull();
    expect(result.payments).toBeNull();
    expect(result.lineage).toContainEqual({
      sourceName: "payment_operations_v1",
      sourceCheckpoint: null,
      asOfUtc: null,
      status: "Unavailable",
    });
  });

  it("fails closed on permission or cross-Store source scope", () => {
    expect(() =>
      buildOperationalDashboardQuery({
        query: query({ permission: "merchant.access" }),
        authorizedPermissions: ["reporting.read"],
        sources,
        generatedAt: "2026-08-12T20:00:03.000Z",
      }),
    ).toThrowError(new OperationalProjectionError("INPUT_INVALID"));
    expect(() =>
      buildOperationalDashboardQuery({
        query: query({ storeReference: r(99) }),
        authorizedPermissions: ["reporting.read"],
        sources,
        generatedAt: "2026-08-12T20:00:03.000Z",
      }),
    ).toThrowError(new OperationalProjectionError("SCOPE_MISMATCH"));
  });

  it("uses trusted authorization context and rejects missing reporting permission", () => {
    expect(() =>
      buildOperationalDashboardQuery({
        query: query(),
        authorizedPermissions: ["merchant.access"],
        sources,
        generatedAt: "2026-08-12T20:00:03.000Z",
      }),
    ).toThrowError(new OperationalProjectionError("PERMISSION_DENIED"));
  });
});
