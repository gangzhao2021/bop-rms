import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderExceptionScreen, parseOrderExceptionView } from "./OrderExceptionPage.js";
const fixture = () => ({
  screenId: "OPS-ORDER-EXCEPTION",
  projectionName: "merchant_order_exception_v1",
  storeLabel: "Synthetic Training Store",
  businessDate: "2026-08-12",
  projectedAt: "2026-08-12T16:14:00.000Z",
  freshnessStatus: "Fresh",
  items: [
    {
      exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000901",
      orderReference: "018f0f58-767a-7f3b-a1d0-000000000902",
      kind: "PaidWithoutFulfillableOrder",
      severity: "Critical",
      status: "Open",
      providerState: "Unknown",
      compensationStatus: "Pending",
      sourceOwner: "Payment",
      createdAt: "2026-08-12T16:00:00.000Z",
      dueAt: "2026-08-12T16:15:00.000Z",
      ownerStatus: "Unassigned",
      sourceFinal: false,
    },
  ],
});
describe("WP-1809 Order Exception Workbench", () => {
  it("renders bounded source facts and owning-domain actions", () => {
    const html = renderToStaticMarkup(
      <OrderExceptionScreen view={parseOrderExceptionView(fixture())} />,
    );
    for (const value of [
      "OPS-ORDER-EXCEPTION",
      "Critical",
      "PaidWithoutFulfillableOrder",
      "Unknown",
      "Request owning-domain compensation / retry",
      "Resolve from final source evidence",
    ])
      expect(html).toContain(value);
  });
  it("rejects client-resolved rows without source finality", () => {
    const input = fixture();
    expect(() =>
      parseOrderExceptionView({ ...input, items: [{ ...input.items[0], status: "Resolved" }] }),
    ).toThrow("ORDER_EXCEPTION_INVALID");
  });
});
