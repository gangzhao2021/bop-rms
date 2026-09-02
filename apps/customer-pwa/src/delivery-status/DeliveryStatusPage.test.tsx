import { MemoryRouter } from "react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeliveryTrackingContent } from "./DeliveryStatusPage.js";
import { parseCustomerDeliveryTracking } from "./delivery-status-client.js";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const view = () => ({
  projectionName: "customer_delivery_tracking_v1",
  projectionVersion: 1,
  screenId: "CUST-DELIVERY-STATUS",
  publicOrderReference: id(1),
  asOfUtc: "2026-08-14T12:00:00.000Z",
  freshness: "Current",
  partial: false,
  status: "OnTheWay",
  eta: { earliestUtc: "2026-08-14T12:15:00.000Z", latestUtc: "2026-08-14T12:30:00.000Z" },
  handoffSummary: "WithCourier",
  proofSummary: "NotAvailable",
  supportPath: "/support?from=delivery",
  instructionUpdateAllowed: true,
  instructionCutoffUtc: "2026-08-14T12:10:00.000Z",
});
describe("CUST-DELIVERY-STATUS", () => {
  it("renders only coarse customer-safe tracking and support", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DeliveryTrackingContent view={parseCustomerDeliveryTracking(view())} />
      </MemoryRouter>,
    );
    expect(html).toContain("OnTheWay");
    expect(html).toContain("Courier contact and precise location are never shown");
    expect(html).toContain("Contact support");
  });
  it("rejects unrestricted courier/location fields", () => {
    expect(() => parseCustomerDeliveryTracking({ ...view(), courierPhone: "+1" })).toThrow();
    expect(() => parseCustomerDeliveryTracking({ ...view(), latitude: 43.7 })).toThrow();
  });
  it("makes stale tracking instruction updates read-only", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DeliveryTrackingContent
          view={parseCustomerDeliveryTracking({ ...view(), freshness: "Stale" })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Status may be delayed");
    expect(html).toContain("disabled");
  });
  it("rejects reversed ETA and unsafe support routes", () => {
    expect(() =>
      parseCustomerDeliveryTracking({
        ...view(),
        eta: { earliestUtc: "2026-08-14T12:30:00.000Z", latestUtc: "2026-08-14T12:15:00.000Z" },
      }),
    ).toThrow();
    expect(() =>
      parseCustomerDeliveryTracking({ ...view(), supportPath: "https://tracker.example" }),
    ).toThrow();
  });
});
