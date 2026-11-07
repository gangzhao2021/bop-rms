import { describe, expect, it } from "vitest";
import {
  decideOrderAcceptanceHold,
  orderAcceptanceDeadlineInstant,
  resolveOrderAcceptanceDeadline,
} from "../application/order-acceptance-hold.js";
import { isPaidOrderWithinAcceptanceWindow } from "../application/paid-order-time-window.js";

const id = (n: number) => "0190fa46-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const expires = "2026-10-14T10:30:00.000Z";
const hold = (overrides: Record<string, unknown> = {}) => ({
  holdReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  orderReference: id(4),
  orderBatchReference: id(5),
  paymentEventReference: id(6),
  sequence: 1,
  lapsedDeadline: expires,
  storeLastSeenAt: "2026-10-14T10:10:00.000Z",
  heldAt: "2026-10-14T10:30:01.000Z",
  resolutions: [],
  ...overrides,
});
const back = (at: string, recordedAt = at) => ({
  resolution: "StoreBackOnline",
  storeBackOnlineAt: at,
  decideBy: new Date(Date.parse(at) + 15 * 60_000).toISOString(),
  actorReference: null,
  recordedAt,
});

describe("order acceptance hold (WP-2423 Q9-G1)", () => {
  it("keeps the capacity expiry when nothing was held", () => {
    const deadline = resolveOrderAcceptanceDeadline({ capacityExpiresAt: expires, holds: [] });
    expect(deadline).toEqual({ kind: "Standard", deadline: expires });
    expect(orderAcceptanceDeadlineInstant(deadline)).toBe(expires);
  });

  it("has no deadline while held and back online + 15 minutes afterwards", () => {
    const held = resolveOrderAcceptanceDeadline({ capacityExpiresAt: expires, holds: [hold()] });
    expect(held.kind).toBe("Held");
    expect(orderAcceptanceDeadlineInstant(held)).toBeNull();
    const extended = resolveOrderAcceptanceDeadline({
      capacityExpiresAt: expires,
      holds: [hold({ resolutions: [back("2026-10-14T11:00:00.000Z")] })],
    });
    expect(extended).toMatchObject({
      kind: "Extended",
      deadline: "2026-10-14T11:15:00.000Z",
      refundChosen: false,
    });
  });

  it("ends the hold at once when a manager chooses to refund", () => {
    const deadline = resolveOrderAcceptanceDeadline({
      capacityExpiresAt: expires,
      holds: [
        hold({
          resolutions: [
            back("2026-10-14T11:00:00.000Z"),
            {
              resolution: "StaffRefund",
              storeBackOnlineAt: null,
              decideBy: "2026-10-14T11:02:00.000Z",
              actorReference: id(9),
              recordedAt: "2026-10-14T11:02:00.000Z",
            },
          ],
        }),
      ],
    });
    expect(deadline).toMatchObject({ deadline: "2026-10-14T11:02:00.000Z", refundChosen: true });
    // A refund the manager chose is never held again, even if staff go offline.
    expect(
      decideOrderAcceptanceHold({
        deadline,
        observedAt: "2026-10-14T11:03:00.000Z",
        storeOnlineAtDeadline: false,
        storeLastSeenBeforeDeadline: null,
        storeBackOnlineAt: null,
      }),
    ).toEqual({ action: "None" });
  });

  it("refuses a broken chain (wrong deadline, gap in sequence, fresh activity)", () => {
    expect(() =>
      resolveOrderAcceptanceDeadline({
        capacityExpiresAt: expires,
        holds: [hold({ lapsedDeadline: "2026-10-14T10:31:00.000Z" })],
      }),
    ).toThrow();
    expect(() =>
      resolveOrderAcceptanceDeadline({
        capacityExpiresAt: expires,
        holds: [hold({ sequence: 2 })],
      }),
    ).toThrow();
    expect(() =>
      resolveOrderAcceptanceDeadline({
        capacityExpiresAt: expires,
        holds: [hold({ storeLastSeenAt: "2026-10-14T10:26:00.000Z" })],
      }),
    ).toThrow();
  });

  it("continues the chain when the extended deadline also passes offline", () => {
    const first = hold({ resolutions: [back("2026-10-14T11:00:00.000Z")] });
    const deadline = resolveOrderAcceptanceDeadline({ capacityExpiresAt: expires, holds: [first] });
    expect(
      decideOrderAcceptanceHold({
        deadline,
        observedAt: "2026-10-14T11:15:01.000Z",
        storeOnlineAtDeadline: false,
        storeLastSeenBeforeDeadline: "2026-10-14T11:05:00.000Z",
        storeBackOnlineAt: null,
      }),
    ).toEqual({
      action: "Hold",
      sequence: 2,
      lapsedDeadline: "2026-10-14T11:15:00.000Z",
      storeLastSeenAt: "2026-10-14T11:05:00.000Z",
    });
    const second = resolveOrderAcceptanceDeadline({
      capacityExpiresAt: expires,
      holds: [
        first,
        hold({
          holdReference: id(7),
          sequence: 2,
          lapsedDeadline: "2026-10-14T11:15:00.000Z",
          storeLastSeenAt: "2026-10-14T11:05:00.000Z",
          heldAt: "2026-10-14T11:15:01.000Z",
        }),
      ],
    });
    expect(second.kind).toBe("Held");
  });

  it("holds only when the Store was offline at the deadline", () => {
    const standard = resolveOrderAcceptanceDeadline({ capacityExpiresAt: expires, holds: [] });
    const input = {
      deadline: standard,
      observedAt: "2026-10-14T10:30:02.000Z",
      storeLastSeenBeforeDeadline: "2026-10-14T10:29:00.000Z",
      storeBackOnlineAt: null,
    };
    expect(decideOrderAcceptanceHold({ ...input, storeOnlineAtDeadline: true })).toEqual({
      action: "None",
    });
    expect(
      decideOrderAcceptanceHold({
        ...input,
        observedAt: "2026-10-14T10:29:59.999Z",
        storeOnlineAtDeadline: false,
      }),
    ).toEqual({ action: "None" });
    expect(
      decideOrderAcceptanceHold({
        ...input,
        storeOnlineAtDeadline: false,
        storeLastSeenBeforeDeadline: null,
      }),
    ).toMatchObject({ action: "Hold", sequence: 1, lapsedDeadline: expires });
  });

  it("resumes with the first return after the held deadline, never before it", () => {
    const deadline = resolveOrderAcceptanceDeadline({
      capacityExpiresAt: expires,
      holds: [hold()],
    });
    const base = {
      deadline,
      observedAt: "2026-10-14T11:01:00.000Z",
      storeOnlineAtDeadline: false,
      storeLastSeenBeforeDeadline: null,
    };
    expect(decideOrderAcceptanceHold({ ...base, storeBackOnlineAt: null })).toEqual({
      action: "None",
    });
    expect(decideOrderAcceptanceHold({ ...base, storeBackOnlineAt: expires })).toEqual({
      action: "None",
    });
    expect(
      decideOrderAcceptanceHold({ ...base, storeBackOnlineAt: "2026-10-14T11:00:00.000Z" }),
    ).toMatchObject({
      action: "Resume",
      storeBackOnlineAt: "2026-10-14T11:00:00.000Z",
      decideBy: "2026-10-14T11:15:00.000Z",
    });
  });

  it("keeps a held pickup acceptable and an extended one until its new deadline", () => {
    const base = {
      orderType: "Pickup",
      committedAt: "2026-10-14T10:00:00.000Z",
      capacityExpiresAt: expires,
      terminalOccurredAt: "2026-10-14T10:05:00.000Z",
      observedAt: "2026-10-14T11:10:00.000Z",
    };
    expect(isPaidOrderWithinAcceptanceWindow(base)).toBe(false);
    expect(isPaidOrderWithinAcceptanceWindow({ ...base, acceptanceDeadline: null })).toBe(true);
    expect(
      isPaidOrderWithinAcceptanceWindow({
        ...base,
        acceptanceDeadline: "2026-10-14T11:15:00.000Z",
      }),
    ).toBe(true);
    expect(
      isPaidOrderWithinAcceptanceWindow({
        ...base,
        observedAt: "2026-10-14T11:15:00.000Z",
        acceptanceDeadline: "2026-10-14T11:15:00.000Z",
      }),
    ).toBe(false);
    // A payment captured after the original window is never held.
    expect(
      isPaidOrderWithinAcceptanceWindow({
        ...base,
        terminalOccurredAt: expires,
        acceptanceDeadline: null,
      }),
    ).toBe(false);
  });
});
