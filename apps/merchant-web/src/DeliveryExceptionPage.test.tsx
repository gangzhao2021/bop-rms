import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeliveryExceptionState, DeliveryExceptionWorkbench } from "./DeliveryExceptionPage.js";
import { parseDeliveryExceptionView } from "./delivery-exception-pages.js";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const view = () => ({
  projectionName: "delivery_exception_workbench_v1",
  projectionVersion: 1,
  screenId: "FUL-DELIVERY-EXCEPTION",
  asOfUtc: "2026-08-14T12:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: {
    mayAcknowledge: true,
    mayAssign: true,
    mayReroute: true,
    mayRequestCancel: true,
    mayHandoffSupport: true,
    mayResolve: true,
  },
  rows: [
    {
      exceptionReference: id(1),
      taskReference: id(2),
      orderReference: id(3),
      aggregateVersion: 2,
      lifecycle: "ActionRequired",
      severity: "Critical",
      reason: "CUSTOMER_UNAVAILABLE",
      ownerReference: id(4),
      providerReference: null,
      resolutionDeadline: "2026-08-14T12:30:00.000Z",
      overdue: false,
      customerImpact: "ActionRequired",
      resolutionOrCompensationReference: null,
    },
  ],
});
describe("FUL-DELIVERY-EXCEPTION", () => {
  it("renders evidence-gated remedies and support handoff", () => {
    const html = renderToStaticMarkup(
      <DeliveryExceptionWorkbench view={parseDeliveryExceptionView(view())} />,
    );
    expect(html).toContain("Reroute / reattempt");
    expect(html).toContain("Request Ordering cancellation");
    expect(html).toContain("Resolve after source finality");
  });
  it("rejects unsafe or unknown fields", () => {
    expect(() => parseDeliveryExceptionView({ ...view(), customerPhone: "+1" })).toThrow();
    expect(() =>
      parseDeliveryExceptionView({
        ...view(),
        rows: [{ ...view().rows[0], lifecycle: "Refunded" }],
      }),
    ).toThrow();
  });
  it("is read-only when stale or partial", () => {
    const html = renderToStaticMarkup(
      <DeliveryExceptionWorkbench
        view={parseDeliveryExceptionView({ ...view(), partial: true })}
      />,
    );
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
  });
  it("does not infer cancellation, refund or compensation", () => {
    expect(renderToStaticMarkup(<DeliveryExceptionState state="Unavailable" />)).toContain(
      "No cancellation, refund or compensation is inferred",
    );
  });
});
