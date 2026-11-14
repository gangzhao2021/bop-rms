import { describe, expect, it } from "vitest";
import {
  prepareDiningCheckoutCommitment,
  sealDiningCheckoutCommitment,
  expireDiningCheckoutCommitment,
  assertDiningCheckoutCommitmentUsable,
  parseDiningCheckoutCommitment,
  assertDiningCheckoutPreparedForOrdering,
  DINING_CHECKOUT_PREPARED_HOLD_MS,
  DiningCheckoutHeldError,
  diningCheckoutHeldUntil,
  isDiningCheckoutHeld,
  diningCheckoutPartyMovedOff,
} from "../domain/dining-checkout-commitment.js";

const id = (n: number) => "01900000-0000-7000-8000-" + n.toString().padStart(12, "0");
const at = "2026-09-10T12:00:00.000Z";
const requested = "2026-09-10T12:00:02.000Z";
const deadline = "2026-09-10T12:30:02.000Z";
function fixture() {
  const input = {
    commitmentReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    diningSessionReference: id(4),
    sessionVersion: 5,
    tableReference: id(6),
    tableAssignmentVersion: 7,
    participantReference: id(8),
    participantVersion: 1,
    guestSessionReference: id(9),
    cartReference: id(10),
    cartVersion: 3,
    quoteReference: id(11),
    submissionReference: id(12),
    orderReference: id(13),
    orderBatchReference: id(14),
    paymentOperationReference: id(15),
    intentHash: "a".repeat(64),
    preparedAt: at,
    preparationValidUntil: "2026-09-10T12:05:00.000Z",
  };
  const context = {
    session: {
      diningSessionReference: id(4),
      brandReference: id(2),
      storeReference: id(3),
      tableReference: id(6),
      tableAssignmentVersion: 7,
      phase: "Active",
      version: 5,
      startedByActorReference: id(20),
      startedAt: "2026-09-10T11:00:00.000Z",
      hostParticipantReference: id(8),
    },
    participant: {
      participantReference: id(8),
      diningSessionReference: id(4),
      status: "Active",
      version: 1,
      joinedAt: "2026-09-10T11:01:00.000Z",
      leftAt: null,
    },
  };
  const link = {
    commitmentReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    submissionReference: id(12),
    orderReference: id(13),
    orderBatchReference: id(14),
    cartReference: id(10),
    cartVersion: 3,
    quoteReference: id(11),
    paymentOperationReference: id(15),
    guestSessionReference: id(9),
    intentHash: "a".repeat(64),
    acknowledgedAt: "2026-09-10T12:00:01.000Z",
  };
  return { input, context, link };
}
function sealed() {
  const f = fixture();
  return {
    ...f,
    result: sealDiningCheckoutCommitment(
      prepareDiningCheckoutCommitment(f.input, f.context),
      f.context,
      f.link,
      requested,
      requested,
    ),
  };
}
describe("Dining checkout commitment", () => {
  it("seals exactly thirty minutes after original payment request following acknowledged Ordering linkage", () => {
    const f = sealed();
    expect(f.result.state).toBe("PaymentPending");
    expect(f.result.capacityExpiresAt).toBe(deadline);
    expect(f.result.orderingLinkedAt).toBe(f.link.acknowledgedAt);
    expect(assertDiningCheckoutCommitmentUsable(f.result, f.context, requested)).toEqual(f.result);
  });
  it.each(["Closing", "Closed", "Cancelled"])("rejects %s Sessions at preparation", (phase) => {
    const f = fixture();
    f.context.session.phase = phase;
    expect(() => prepareDiningCheckoutCommitment(f.input, f.context)).toThrow(
      expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }),
    );
  });
  it.each([
    "brandReference",
    "storeReference",
    "tableReference",
    "diningSessionReference",
  ] as const)("rejects changed %s at sealing", (key) => {
    const f = fixture(),
      prepared = prepareDiningCheckoutCommitment(f.input, f.context);
    f.context.session[key] = id(99);
    expect(() =>
      sealDiningCheckoutCommitment(prepared, f.context, f.link, requested, requested),
    ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }));
  });
  it("rejects a table move after sealing that names no recorded Move", () => {
    const f = sealed();
    f.context.session.tableAssignmentVersion++;
    expect(() => assertDiningCheckoutCommitmentUsable(f.result, f.context, requested)).toThrow(
      expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }),
    );
  });
  /**
   * WP-2423 table-move-payment (v15 fabf0261, 2026-11-06): a party staff moved keeps paying the
   * round it sent before the move, on Dining's recorded Move off the round's table.
   */
  describe("after staff move the party", () => {
    const later = "2026-09-10T12:00:03.000Z",
      afterMove = "2026-09-10T12:00:04.000Z";
    const movedContext = (
      f: ReturnType<typeof sealed>,
      move: unknown = { fromTableReference: id(6), movedAt: later },
    ) => ({
      session: { ...f.context.session, tableReference: id(60), tableAssignmentVersion: 2 },
      participant: f.context.participant,
      followedMove: move,
    });
    it("stays payable at the new table, and after moving back to the same table", () => {
      const f = sealed();
      expect(assertDiningCheckoutCommitmentUsable(f.result, movedContext(f), afterMove)).toEqual(
        f.result,
      );
      const back = {
        ...movedContext(f),
        session: { ...f.context.session, tableAssignmentVersion: 9 },
      };
      expect(assertDiningCheckoutCommitmentUsable(f.result, back, afterMove)).toEqual(f.result);
      // No move named: a context at the round's own table still works.
      expect(
        assertDiningCheckoutCommitmentUsable(f.result, { ...f.context, followedMove: null }, later),
      ).toEqual(f.result);
    });
    it.each([
      ["a move off another table", { fromTableReference: id(61), movedAt: later }],
      [
        "a move before the round was prepared",
        { fromTableReference: id(6), movedAt: "2026-09-10T11:59:59.000Z" },
      ],
      [
        "a move after this reading",
        { fromTableReference: id(6), movedAt: "2026-09-10T12:00:05.000Z" },
      ],
      ["no recorded move", null],
    ])("refuses %s", (_name, move) => {
      const f = sealed();
      expect(() =>
        assertDiningCheckoutCommitmentUsable(f.result, movedContext(f, move), afterMove),
      ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }));
    });
    it("refuses a move named while the party is still at the round's table", () => {
      const f = sealed();
      expect(() =>
        assertDiningCheckoutCommitmentUsable(
          f.result,
          { ...f.context, followedMove: { fromTableReference: id(6), movedAt: later } },
          afterMove,
        ),
      ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }));
    });
    it("still stops when the table is closing or the participant left", () => {
      const f = sealed();
      const closing = movedContext(f);
      closing.session = { ...closing.session, phase: "Closing" };
      expect(() => assertDiningCheckoutCommitmentUsable(f.result, closing, afterMove)).toThrow(
        expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }),
      );
      const left = movedContext(f);
      left.participant = {
        ...left.participant,
        status: "Left",
        version: 2,
        leftAt: later,
      } as never;
      expect(() => assertDiningCheckoutCommitmentUsable(f.result, left, afterMove)).toThrow(
        expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }),
      );
    });
    it("never lets preparing, sealing or the gate before Ordering follow a move", () => {
      const f = fixture();
      const prepared = prepareDiningCheckoutCommitment(f.input, f.context);
      const named = { ...f.context, followedMove: null };
      expect(() => prepareDiningCheckoutCommitment(f.input, named)).toThrow(
        expect.objectContaining({ code: "DINING_CHECKOUT_INPUT_INVALID" }),
      );
      expect(() =>
        sealDiningCheckoutCommitment(prepared, named, f.link, requested, requested),
      ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_INPUT_INVALID" }));
      expect(() => assertDiningCheckoutPreparedForOrdering(prepared, named, at)).toThrow(
        expect.objectContaining({ code: "DINING_CHECKOUT_INPUT_INVALID" }),
      );
    });
  });
  it("stays payable when someone else joins the session after sealing", () => {
    const f = sealed();
    f.context.session.version++;
    expect(assertDiningCheckoutCommitmentUsable(f.result, f.context, requested)).toEqual(f.result);
  });
  it("still needs the same Session version before it is sealed", () => {
    const f = fixture(),
      prepared = prepareDiningCheckoutCommitment(f.input, f.context);
    f.context.session.version++;
    expect(() => assertDiningCheckoutPreparedForOrdering(prepared, f.context, requested)).toThrow(
      expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }),
    );
  });
  it("rejects a Participant who has left before sealing", () => {
    const f = fixture(),
      prepared = prepareDiningCheckoutCommitment(f.input, f.context);
    const context = {
      ...f.context,
      participant: { ...f.context.participant, status: "Left", leftAt: requested },
    };
    expect(() =>
      sealDiningCheckoutCommitment(prepared, context, f.link, requested, requested),
    ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }));
  });
  it.each([
    "commitmentReference",
    "submissionReference",
    "orderReference",
    "orderBatchReference",
    "paymentOperationReference",
    "quoteReference",
    "guestSessionReference",
    "storeReference",
  ] as const)("rejects mismatched linked %s", (key) => {
    const f = fixture();
    f.link[key] = id(99);
    expect(() =>
      sealDiningCheckoutCommitment(
        prepareDiningCheckoutCommitment(f.input, f.context),
        f.context,
        f.link,
        requested,
        requested,
      ),
    ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_LINK_MISMATCH" }));
  });
  it("rejects backdating Payment before acknowledged Order linkage", () => {
    const f = fixture();
    expect(() =>
      sealDiningCheckoutCommitment(
        prepareDiningCheckoutCommitment(f.input, f.context),
        f.context,
        f.link,
        at,
        requested,
      ),
    ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_CLOCK_CONFLICT" }));
  });
  it("rechecks preparation expiry after a wait, even when request began before expiry", () => {
    const f = fixture();
    expect(() =>
      sealDiningCheckoutCommitment(
        prepareDiningCheckoutCommitment(f.input, f.context),
        f.context,
        f.link,
        requested,
        f.input.preparationValidUntil,
      ),
    ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_EXPIRED" }));
  });
  it("recovers an original seal after expiry without authorizing payment or extending its clock", () => {
    const f = sealed();
    expect(sealDiningCheckoutCommitment(f.result, f.context, f.link, requested, deadline)).toEqual(
      f.result,
    );
    expect(() => assertDiningCheckoutCommitmentUsable(f.result, f.context, deadline)).toThrow(
      expect.objectContaining({ code: "DINING_CHECKOUT_EXPIRED" }),
    );
    expect(() =>
      sealDiningCheckoutCommitment(
        f.result,
        f.context,
        f.link,
        "2026-09-10T12:00:03.000Z",
        deadline,
      ),
    ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_CLOCK_CONFLICT" }));
  });
  it("expiry preserves the full linkage and cannot change a table, Session, Participant or other paid Batch", () => {
    const f = sealed(),
      contextBefore = structuredClone(f.context);
    const expired = expireDiningCheckoutCommitment(f.result, deadline);
    expect(expired).toEqual({ ...f.result, state: "Expired" });
    expect(f.context).toEqual(contextBefore);
    expect(f.result.state).toBe("PaymentPending");
    expect(Object.isFrozen(expired)).toBe(true);
    expect(expireDiningCheckoutCommitment(expired, deadline)).toEqual(expired);
  });
  it("expires an unsealed preparation without fabricating a Payment clock", () => {
    const f = fixture();
    const expired = expireDiningCheckoutCommitment(
      prepareDiningCheckoutCommitment(f.input, f.context),
      f.input.preparationValidUntil,
    );
    expect(expired.paymentRequestedAt).toBeNull();
    expect(() =>
      sealDiningCheckoutCommitment(
        expired,
        f.context,
        f.link,
        requested,
        f.input.preparationValidUntil,
      ),
    ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_EXPIRED" }));
  });
  it("does not expire before the deadline", () => {
    const f = sealed();
    expect(() => expireDiningCheckoutCommitment(f.result, requested)).toThrow(
      expect.objectContaining({ code: "DINING_CHECKOUT_CLOCK_CONFLICT" }),
    );
  });
  it("rejects malformed or partially sealed facts and noncanonical clocks", () => {
    const f = sealed();
    for (const patch of [
      { capacityExpiresAt: null },
      { capacityExpiresAt: "2026-09-10T12:31:02.000Z" },
      { paymentRequestedAt: "2026-09-10T12:00:02Z" },
      { cartVersion: 0 },
      { state: "Prepared" },
      { orderingLinkedAt: "2026-09-10T11:59:59.000Z" },
      { extra: "unexpected" },
    ])
      expect(() => parseDiningCheckoutCommitment({ ...f.result, ...patch })).toThrow();
  });
  it("does not execute getters at the untrusted commitment boundary", () => {
    const f = sealed();
    let reads = 0;
    const input = { ...f.result };
    Object.defineProperty(input, "intentHash", {
      enumerable: true,
      get() {
        reads++;
        return "a".repeat(64);
      },
    });
    expect(() => parseDiningCheckoutCommitment(input)).toThrow();
    expect(reads).toBe(0);
  });
});

it("requires the exact current Prepared window before Ordering", () => {
  const f = fixture();
  const prepared = prepareDiningCheckoutCommitment(f.input, f.context);
  expect(assertDiningCheckoutPreparedForOrdering(prepared, f.context, requested)).toEqual(prepared);
  for (const when of ["2026-09-10T11:59:59.000Z", f.input.preparationValidUntil])
    expect(() => assertDiningCheckoutPreparedForOrdering(prepared, f.context, when)).toThrow();
  const pending = sealed();
  expect(() =>
    assertDiningCheckoutPreparedForOrdering(pending.result, pending.context, requested),
  ).toThrow();
  expect(() =>
    assertDiningCheckoutPreparedForOrdering(
      prepared,
      { ...f.context, participant: { ...f.context.participant, version: 2 } },
      requested,
    ),
  ).toThrow(expect.objectContaining({ code: "DINING_CHECKOUT_CONTEXT_CHANGED" }));
});

describe("DEC-DINING-ANY-PARTICIPANT-SUBMIT checkout hold of a Cart version", () => {
  it("holds while Prepared only briefly: the earlier of a minute and the preparation deadline", () => {
    const f = fixture();
    const prepared = prepareDiningCheckoutCommitment(f.input, f.context);
    // preparedAt 12:00:00, preparation deadline 12:05:00: an unsealed attempt holds one minute.
    expect(diningCheckoutHeldUntil(prepared, at)).toBe("2026-09-10T12:01:00.000Z");
    expect(diningCheckoutHeldUntil(prepared, "2026-09-10T12:00:59.999Z")).toBe(
      "2026-09-10T12:01:00.000Z",
    );
    expect(diningCheckoutHeldUntil(prepared, "2026-09-10T12:01:00.000Z")).toBeNull();
    const short = prepareDiningCheckoutCommitment(
      { ...f.input, preparationValidUntil: "2026-09-10T12:00:30.000Z" },
      f.context,
    );
    expect(diningCheckoutHeldUntil(short, at)).toBe("2026-09-10T12:00:30.000Z");
    expect(DINING_CHECKOUT_PREPARED_HOLD_MS).toBe(60_000);
  });
  it("holds while PaymentPending until the capacity deadline, never once Expired", () => {
    const f = fixture();
    const prepared = prepareDiningCheckoutCommitment(f.input, f.context);
    const pending = sealDiningCheckoutCommitment(prepared, f.context, f.link, requested, requested);
    expect(diningCheckoutHeldUntil(pending, requested)).toBe(deadline);
    expect(diningCheckoutHeldUntil(pending, deadline)).toBeNull();
    const expired = expireDiningCheckoutCommitment(pending, deadline);
    expect(diningCheckoutHeldUntil(expired, requested)).toBeNull();
  });
  it("recognizes the refusal from another copy of the module by its shape only", () => {
    expect(isDiningCheckoutHeld(new DiningCheckoutHeldError(at as never))).toBe(true);
    const copy = Object.assign(new Error("held"), { code: "DINING_CHECKOUT_HELD", heldUntil: at });
    expect(isDiningCheckoutHeld(copy)).toBe(true);
    expect(isDiningCheckoutHeld({ code: "DINING_CHECKOUT_HELD", heldUntil: at })).toBe(false);
    expect(
      isDiningCheckoutHeld(
        Object.assign(new Error(), { code: "DINING_CHECKOUT_HELD", heldUntil: "soon" }),
      ),
    ).toBe(false);
  });
});

/** WP-2423 table-move-send: only a Move of the still-seated party off the round's table counts. */
describe("diningCheckoutPartyMovedOff", () => {
  const { input, context } = fixture();
  const record = prepareDiningCheckoutCommitment(input, context);
  const seated = (session: object = {}, participant: object = {}) => ({
    session: { ...context.session, version: 6, ...session },
    participant: { ...context.participant, ...participant },
  });
  it.each([
    ["moved to another table", seated({ tableReference: id(60), tableAssignmentVersion: 1 }), true],
    ["moved away and back (A to B to A)", seated({ tableAssignmentVersion: 8 }), true],
    ["still at its table", seated(), false],
    ["the table is closing", seated({ tableReference: id(60), phase: "Closing" }), false],
    [
      "the participant left",
      seated(
        { tableReference: id(60) },
        { status: "Left", version: 2, leftAt: "2026-09-10T12:01:00.000Z" },
      ),
      false,
    ],
    [
      "another participant",
      seated({ tableReference: id(60) }, { participantReference: id(80) }),
      false,
    ],
    ["another session", seated({ tableReference: id(60), diningSessionReference: id(40) }), false],
    ["a malformed context", { session: context.session }, false],
  ])("%s", (_name, current, expected) => {
    expect(diningCheckoutPartyMovedOff(record, current)).toBe(expected);
  });
});
