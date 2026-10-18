import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
import {
  StaffCancelStatus,
  StaffOrderCancelAction,
  staffCancelBody,
  staffCancelOutcome,
  staffCancellationSummary,
} from "./StaffOrderCancelAction.js";

const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const order = (orderType: "Pickup" | "DineIn", canCancel: boolean) => ({
  orderReference: id(1),
  orderNumber: "ORD-1001",
  orderType,
  sourceChannel: "Qr",
  submittedAt: "2026-10-11T12:00:00.000Z",
  observedAt: "2026-10-11T12:05:00.000Z",
  initialBatchReference: id(90),
  batches: [
    {
      orderBatchReference: id(90),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  currentPhase: "Accepted",
  currentVersion: 3,
});
const parsed = (value: unknown) => {
  const item = parseCurrentOrderQueue({ items: [value], nextAfterOrderReference: null }).items[0];
  const batch = item?.batches[0];
  if (!item || !batch) throw new Error("fixture");
  return { item, batch };
};

it("WP-2423 Q6: sends cancel intent only, with the shown order version", () => {
  const { item, batch } = parsed(order("Pickup", true));
  const body = staffCancelBody(item, batch, {
    operationReference: id(500),
    reasonCode: "SOLD_OUT",
    expectedOrderVersion: 3,
  });
  expect(body).toEqual({
    orderReference: id(1),
    orderBatchReference: id(90),
    expectedOrderVersion: 3,
    operationReference: id(500),
    reasonCode: "SOLD_OUT",
  });
  const { item: closed, batch: closedBatch } = parsed(order("Pickup", false));
  expect(() =>
    staffCancelBody(closed, closedBatch, {
      operationReference: id(500),
      reasonCode: "SOLD_OUT",
      expectedOrderVersion: 3,
    }),
  ).toThrow();
});

it("WP-2423 Q6: maps the server's answer", () => {
  expect(staffCancelOutcome(200, null)).toBe("Cancelled");
  expect(staffCancelOutcome(409, "order_preparation_started")).toBe("PreparationStarted");
  expect(staffCancelOutcome(409, "order_version_conflict")).toBe("VersionConflict");
  expect(staffCancelOutcome(409, "order_not_cancellable")).toBe("NotCancellable");
  expect(staffCancelOutcome(409, "order_stock_not_releasable")).toBe("NotCancellable");
  expect(staffCancelOutcome(409, null)).toBe("NotCancellable");
  expect(staffCancelOutcome(404, "order_cancellation_not_found")).toBe("NotCancellable");
  expect(staffCancelOutcome(403, "request_denied")).toBe("Denied");
  expect(staffCancelOutcome(403, null)).toBe("Denied");
  expect(staffCancelOutcome(403, "full_sign_in_required")).toBe("FullSignInRequired");
  expect(staffCancelOutcome(503, "order_cancellation_unavailable")).toBe("Unknown");
  expect(staffCancelOutcome(500, null)).toBe("Unknown");
});

it("WP-2423 Q6: labels the action by order type and explains the refund", () => {
  const pickup = parsed(order("Pickup", true));
  const html = renderToStaticMarkup(
    <StaffOrderCancelAction
      order={pickup.item}
      batch={pickup.batch}
      csrf="synthetic"
      onSettled={() => undefined}
    />,
  );
  expect(html).toContain("Cancel order");
  expect(html).toContain(
    "Only before the kitchen starts. The customer is refunded in full, including tip.",
  );
  expect(html).toContain("Customer request");
  expect(html).toContain("Sold out");
  expect(html).toContain("Store error");
  expect(html).toContain("Duplicate order");
  const dining = parsed({ ...order("DineIn", true), orderType: "DineIn" });
  const dineHtml = renderToStaticMarkup(
    <StaffOrderCancelAction
      order={dining.item}
      batch={dining.batch}
      csrf="synthetic"
      onSettled={() => undefined}
    />,
  );
  expect(dineHtml).toContain("Cancel round");
  expect(dineHtml).toContain("Cancel round 1 of order ORD-1001");
});

it("WP-2423 Q6: summarises a cancelled pickup and a cancelled dine-in batch", () => {
  const cancellation = {
    reasonCode: "SOLD_OUT",
    cancelledAt: "2026-10-11T12:04:00.000Z",
    refundStatus: "Pending",
  };
  const pickup = parsed({
    ...order("Pickup", false),
    currentPhase: "Cancelled",
    currentVersion: 4,
    batches: [{ ...order("Pickup", false).batches[0], staffCancellation: cancellation }],
  });
  expect(staffCancellationSummary(pickup.item, pickup.batch)).toBe(
    "Cancelled by store · refund pending",
  );
  const dining = parsed({
    ...order("DineIn", false),
    batches: [
      {
        ...order("DineIn", false).batches[0],
        acceptanceStatus: "Cancelled",
        staffCancellation: { ...cancellation, refundStatus: "Refunded" },
      },
    ],
  });
  expect(staffCancellationSummary(dining.item, dining.batch)).toBe("Round 1 cancelled · refunded");
});

it("WP-2423: a PIN sign-in refusal asks the person to confirm it is them, not that they lack permission", () => {
  const html = renderToStaticMarkup(
    <StaffCancelStatus outcome="FullSignInRequired" csrf="synthetic-csrf" />,
  );
  expect(html).toContain("You signed in with a PIN");
  expect(html).toContain("Verify it&#x27;s you");
  expect(html).not.toContain("store manager or owner");
  expect(
    renderToStaticMarkup(<StaffCancelStatus outcome="Denied" csrf="synthetic-csrf" />),
  ).toContain("Only a store manager or owner can cancel a paid order");
});
