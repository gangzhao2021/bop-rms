import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeliveryDispatchBoard, DeliveryDispatchState } from "./DeliveryDispatchPage.js";
import { parseDeliveryDispatchView } from "./delivery-dispatch-pages.js";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const view = () => ({
  projectionName: "delivery_task_queue_v1",
  projectionVersion: 1,
  screenId: "FUL-DELIVERY-DISPATCH",
  storeLabel: "Demo Store",
  asOfUtc: "2026-08-14T12:00:00.000Z",
  freshness: "Current",
  partial: false,
  permissions: {
    mayAssign: true,
    mayAccept: true,
    mayStart: true,
    mayReassign: true,
    mayOpenException: true,
  },
  rows: [
    {
      taskReference: id(1),
      orderReference: id(2),
      aggregateVersion: 3,
      executionStatus: "Planned",
      assignmentStatus: "ReassignmentRequired",
      confirmedWindowReference: id(3),
      zoneReference: id(4),
      providerOrCourierReference: null,
      handoffState: "Ready",
      ageSeconds: 600,
      overdue: true,
      openExceptionCount: 1,
    },
  ],
});
describe("FUL-DELIVERY-DISPATCH", () => {
  it("renders canonical lanes and policy-bound reassign", () => {
    const html = renderToStaticMarkup(
      <DeliveryDispatchBoard view={parseDeliveryDispatchView(view())} />,
    );
    expect(html).toContain("Delivery dispatch");
    expect(html).toContain("one active offer");
    expect(html).toContain("Reassign under pinned policy");
    expect(html).toContain("Open exception");
  });
  it("rejects unknown assignment state", () => {
    expect(() =>
      parseDeliveryDispatchView({
        ...view(),
        rows: [{ ...view().rows[0], assignmentStatus: "Rejected" }],
      }),
    ).toThrow();
  });
  it("becomes read-only when stale", () => {
    const html = renderToStaticMarkup(
      <DeliveryDispatchBoard view={parseDeliveryDispatchView({ ...view(), freshness: "Stale" })} />,
    );
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
  });
  it("fails closed without Provider inference", () => {
    expect(renderToStaticMarkup(<DeliveryDispatchState state="Unavailable" />)).toContain(
      "No worker or Provider result is inferred",
    );
  });
});
