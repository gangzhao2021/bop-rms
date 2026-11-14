import { expect, it } from "vitest";
import type { OrderAcceptanceHold } from "@rms/ordering";
import { pickupAcceptanceDeadline } from "./pickup-acceptance-deadline.js";

const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hold = (
  resolutions: { resolution: "StoreBackOnline" | "StaffRefund"; decideBy: string }[],
): OrderAcceptanceHold =>
  ({
    holdReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    paymentEventReference: id(6),
    sequence: 1,
    lapsedDeadline: "2026-10-17T13:30:00.000Z",
    storeLastSeenAt: null,
    heldAt: "2026-10-17T13:31:00.000Z",
    resolutions: resolutions.map((entry) => ({
      ...entry,
      storeBackOnlineAt: null,
      actorReference: null,
      recordedAt: "2026-10-17T13:43:00.000Z",
    })),
  }) as unknown as OrderAcceptanceHold;

it("uses the capacity expiry when the order was never held", () => {
  expect(pickupAcceptanceDeadline("2026-10-17T13:30:00.000Z", null)).toEqual({
    acceptBy: "2026-10-17T13:30:00.000Z",
    decideBy: null,
    refundChosen: false,
  });
});

it("has no deadline while the store is offline, then the earliest decision deadline", () => {
  expect(pickupAcceptanceDeadline("2026-10-17T13:30:00.000Z", hold([])).acceptBy).toBeNull();
  // v15 order 9 (2026-10-17): the deferral moved the deadline to 13:58Z.
  expect(
    pickupAcceptanceDeadline(
      "2026-10-17T13:30:00.000Z",
      hold([
        { resolution: "StoreBackOnline", decideBy: "2026-10-17T14:05:00.000Z" },
        { resolution: "StoreBackOnline", decideBy: "2026-10-17T13:58:00.000Z" },
      ]),
    ),
  ).toEqual({
    acceptBy: "2026-10-17T13:58:00.000Z",
    decideBy: "2026-10-17T13:58:00.000Z",
    refundChosen: false,
  });
});

it("marks a refund a manager chose", () => {
  expect(
    pickupAcceptanceDeadline(
      null,
      hold([{ resolution: "StaffRefund", decideBy: "2026-10-17T13:58:00.000Z" }]),
    ).refundChosen,
  ).toBe(true);
});
