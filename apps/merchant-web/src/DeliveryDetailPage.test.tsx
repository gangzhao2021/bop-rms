import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeliveryDetail, DeliveryDetailState } from "./DeliveryDetailPage.js";
import { parseDeliveryDetailView } from "./delivery-detail-pages.js";
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const view = () => ({
  projectionName: "delivery_task_detail_v1",
  projectionVersion: 1,
  screenId: "FUL-DELIVERY-DETAIL",
  taskReference: id(1),
  orderReference: id(2),
  aggregateVersion: 4,
  asOfUtc: "2026-08-14T12:00:00.000Z",
  freshness: "Current",
  partial: false,
  executionStatus: "Planned",
  assignmentStatus: "Accepted",
  maskedAddress: "12•• Main St · Unit ••",
  maskedContact: "•••-•••-0199",
  requestedWindow: { startUtc: "2026-08-14T12:10:00.000Z", endUtc: "2026-08-14T12:20:00.000Z" },
  confirmedWindow: { startUtc: "2026-08-14T12:15:00.000Z", endUtc: "2026-08-14T12:25:00.000Z" },
  feeMinor: 799,
  currency: "CAD",
  providerOrCourierReference: id(3),
  proofReferences: [id(4)],
  contactAttemptReferences: [id(5)],
  timelineReferences: [id(6)],
  permissions: {
    mayRevise: true,
    mayDispatch: true,
    mayCancel: true,
    mayReassign: true,
    mayRecordException: true,
  },
});
describe("FUL-DELIVERY-DETAIL", () => {
  it("renders only masked snapshot and controlled actions", () => {
    const html = renderToStaticMarkup(<DeliveryDetail view={parseDeliveryDetailView(view())} />);
    expect(html).toContain("12•• Main St");
    expect(html).toContain("Revise before cutoff");
    expect(html).toContain("append-only revisions");
  });
  it("rejects extra fields and negative money", () => {
    expect(() => parseDeliveryDetailView({ ...view(), rawAddress: "secret" })).toThrow();
    expect(() => parseDeliveryDetailView({ ...view(), feeMinor: -1 })).toThrow();
  });
  it("is read-only when partial", () => {
    const html = renderToStaticMarkup(
      <DeliveryDetail view={parseDeliveryDetailView({ ...view(), partial: true })} />,
    );
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
  });
  it("does not infer address or Provider facts", () => {
    expect(renderToStaticMarkup(<DeliveryDetailState state="Unavailable" />)).toContain(
      "No address, price or Provider fact is inferred",
    );
  });
});
