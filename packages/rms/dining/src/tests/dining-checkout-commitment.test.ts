import { describe, expect, it } from "vitest";
import {
  prepareDiningCheckoutCommitment,
  sealDiningCheckoutCommitment,
  expireDiningCheckoutCommitment,
  assertDiningCheckoutCommitmentUsable,
  parseDiningCheckoutCommitment,
  assertDiningCheckoutPreparedForOrdering,
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
  it.each(["version", "tableAssignmentVersion"] as const)("rejects changed Session %s", (key) => {
    const f = sealed();
    f.context.session[key]++;
    expect(() => assertDiningCheckoutCommitmentUsable(f.result, f.context, requested)).toThrow(
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
