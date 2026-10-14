import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import {
  ItemRefundCheck,
  StaffItemCancelAction,
  itemCancelFailureText,
  itemCancelPreviewText,
  itemCancellationStatus,
} from "./StaffItemCancelAction.js";

const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const line = (n: number, name: string, extra: Record<string, unknown> = {}) => ({
  orderItemReference: id(200 + n),
  orderBatchReference: id(90),
  name,
  options: [],
  quantity: 1,
  customerNote: null,
  unitPrice: money("1000"),
  subtotal: money("1000"),
  discount: money("0"),
  tax: money("130"),
  fee: money("0"),
  total: money("1130"),
  canCancel: false,
  cancellation: null,
  ...extra,
});
const detail = (orderType: "Pickup" | "DineIn") =>
  parseCurrentOrderDetail(
    {
      screenId: "OPS-ORDER-DETAIL",
      pickupContact: null,
      order: {
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
            canCancel: true,
            staffCancellation: null,
            canCancelItems: true,
          },
        ],
        canRequestAcceptance: false,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
        currentPhase: "Accepted",
        currentVersion: 3,
      },
      lines: {
        items: [
          line(1, "Synthetic rice bowl", { canCancel: true }),
          line(2, "Synthetic soup"),
          line(3, "Synthetic tea", {
            cancellation: {
              reasonCode: "SOLD_OUT",
              cancelledAt: "2026-10-11T12:04:00.000Z",
              refundStatus: "Pending",
              refund: money("1130"),
            },
          }),
        ],
        totals: {
          subtotal: money("3000"),
          discount: money("0"),
          tax: money("390"),
          fee: money("0"),
          total: money("3390"),
        },
      },
    },
    id(1),
  );
const render = (orderType: "Pickup" | "DineIn") => {
  const { order, lines } = detail(orderType);
  const batch = order.batches[0];
  if (!batch) throw new Error("fixture");
  return renderToStaticMarkup(
    <StaffItemCancelAction
      order={order}
      batch={batch}
      lines={lines.items}
      csrf="synthetic"
      onSettled={() => undefined}
    />,
  );
};

it("WP-2423 Q6 step 2: offers the batch's uncancelled items with a required reason", () => {
  const html = render("Pickup");
  expect(html).toContain("Cancel items");
  expect(html).toContain("Cancel items from order ORD-1001");
  expect(html).toContain("1 × Synthetic rice bowl");
  // A line the kitchen started (or otherwise not cancellable) is shown but cannot be chosen.
  expect(html).toMatch(
    /<input type="checkbox" disabled=""[^>]*\/><span class="order-item-cancel-name">1 × Synthetic soup<span class="order-item-cancel-unavailable">Not available/u,
  );
  // An already cancelled line is not offered again.
  expect(html).not.toContain("Synthetic tea");
  for (const reason of ["Customer request", "Sold out", "Store error", "Duplicate order"])
    expect(html).toContain(reason);
  expect(html).toContain("Select the items to cancel.");
  expect(html).toContain('aria-live="polite"');
  // Nothing can be confirmed before a selection, a reason and the server's refund preview.
  expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Cancel item and refund<\/button>/u);
  expect(html).toContain("Keep items");
  expect(render("DineIn")).toContain("Cancel items from batch 1 of order ORD-1001");
});

it("WP-2423 Q6 step 2: explains the refund the server previewed", () => {
  const pickup = detail("Pickup").order;
  const dining = detail("DineIn").order;
  const refund = {
    amountMinor: "1130",
    currencyCode: "CAD" as const,
    includesTip: false,
    netAmountMinor: "1000",
    taxAmountMinor: "130",
  };
  expect(itemCancelPreviewText(pickup, { scope: "Items", refund })).toBe(
    "Refund $11.30 (items and tax; the tip is not refunded).",
  );
  const last = {
    ...refund,
    amountMinor: "1380",
    includesTip: true,
    netAmountMinor: "0",
    taxAmountMinor: "0",
  };
  expect(itemCancelPreviewText(pickup, { scope: "Batch", refund: last })).toBe(
    "These are the last items: the whole order is cancelled and the remaining payment of $13.80 is refunded, including any tip.",
  );
  expect(itemCancelPreviewText(dining, { scope: "Batch", refund: last })).toBe(
    "These are the last items of this batch: the whole batch is cancelled and its remaining payment of $13.80 is refunded, including any tip.",
  );
});

it("WP-2423 Q6 step 2: says what to do for every refusal", () => {
  const pickup = detail("Pickup").order;
  const dining = detail("DineIn").order;
  expect(itemCancelFailureText(pickup, "LegacyStock")).toContain("Cancel the whole order instead.");
  expect(itemCancelFailureText(dining, "LegacyStock")).toContain("Cancel the whole batch instead.");
  expect(itemCancelFailureText(pickup, "VersionConflict")).toContain("Close to refresh it");
  expect(itemCancelFailureText(pickup, "PreparationStarted")).toContain("use a refund");
  expect(itemCancelFailureText(pickup, "NotCancellable")).toContain("can no longer be cancelled");
  expect(itemCancelFailureText(pickup, "Denied")).toContain("store manager or owner");
  expect(itemCancelFailureText(pickup, "Unknown")).toContain("Retry the same cancellation");
});

it("WP-2423 Q6 step 2: summarises a cancelled line and offers a refund check", () => {
  const cancellation = detail("Pickup").lines.items[2]?.cancellation;
  if (!cancellation) throw new Error("fixture");
  expect(itemCancellationStatus(cancellation)).toBe("Cancelled · refund pending · $11.30");
  expect(itemCancellationStatus({ ...cancellation, refundStatus: "Refunded" })).toBe(
    "Cancelled · refunded · $11.30",
  );
  const html = renderToStaticMarkup(
    <ItemRefundCheck
      orderReference={id(1)}
      cancellationReference={id(700)}
      csrf="synthetic"
      onChecked={() => undefined}
    />,
  );
  expect(html).toContain("Check refund");
  expect(html).toContain('role="status"');
});
