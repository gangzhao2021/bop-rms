import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
import {
  HeldStockNotice,
  HeldStockReleaseAction,
  heldStockReleaseBody,
  heldStockReleaseOutcome,
  heldStockText,
} from "./HeldStockNotice.js";

const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const row = (heldStock: unknown) => ({
  orderReference: id(1),
  orderNumber: "2",
  orderType: "Pickup",
  sourceChannel: "Qr",
  businessDate: "2026-10-10",
  listedBusinessDate: "2026-10-16",
  heldStock,
  submittedAt: "2026-10-10T21:33:01.000Z",
  observedAt: "2026-10-16T06:00:00.000Z",
  initialBatchReference: id(90),
  batches: [
    {
      orderBatchReference: id(90),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: true,
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
  currentVersion: 2,
});
const held = (state: "Open" | "Ended", productionStarted = false) => ({
  since: "2026-10-10T21:33:01.258Z",
  state,
  orderBatchReference: id(90),
  productionStarted,
});
const parse = (value: unknown) => {
  const item = parseCurrentOrderQueue({ items: [row(value)], nextAfterOrderReference: null })
    .items[0];
  if (item === undefined) throw new Error("no row");
  return item;
};

it("WP-2423 (2026-10-16): an earlier-day order holding stock tells staff what to do, without codes", () => {
  const open = parse(held("Open"));
  expect(open.heldStock?.state).toBe("Open");
  const text = heldStockText(open) ?? "";
  expect(text).toContain("Still open from an earlier day");
  expect(text).toContain(
    "cancel it — the guest is refunded and the ingredients go back into stock",
  );
  expect(text).not.toMatch(/[A-Z]{2,}_[A-Z]/u);
  expect(renderToStaticMarkup(<HeldStockNotice order={open} />)).toContain('role="note"');
  expect(heldStockText(parse(held("Ended")))).toContain("Release them to put them back");
  expect(heldStockText(parse(held("Ended", true)))).toContain("Mark it done on the kitchen board");
  expect(heldStockText(parse(null))).toBeNull();
  expect(() => parse({ ...held("Open"), state: "Leaking" })).toThrow();
  expect(() => parse({ ...held("Open"), extra: 1 })).toThrow();
});

it("releases only an ended order's stock, with intent only, and maps answers to staff words", () => {
  const ended = parse(held("Ended"));
  expect(heldStockReleaseBody(ended, id(5))).toEqual({
    orderReference: id(1),
    orderBatchReference: id(90),
    operationReference: id(5),
  });
  expect(() => heldStockReleaseBody(parse(held("Open")), id(5))).toThrow();
  expect(heldStockReleaseOutcome(200, null)).toBe("Released");
  expect(heldStockReleaseOutcome(403, "stock_release_permission_denied")).toBe("Denied");
  expect(heldStockReleaseOutcome(409, "order_preparation_started")).toBe("Started");
  expect(heldStockReleaseOutcome(409, "stock_not_releasable")).toBe("NotReleasable");
  expect(heldStockReleaseOutcome(503, "stock_release_unavailable")).toBe("Unknown");
  expect(
    renderToStaticMarkup(
      <HeldStockReleaseAction order={ended} csrf="c" onSettled={() => undefined} />,
    ),
  ).toContain("Release held ingredients");
});
