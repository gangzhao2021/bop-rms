import { expect, it } from "vitest";
import { refundActionLines } from "./RefundDeadlineWatch.js";
import { refundWarnings, type RefundDeadline } from "./refund-deadline-warning.js";

const now = Date.parse("2026-11-05T20:00:00.000Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const warnings = (deadlines: readonly RefundDeadline[]) => refundWarnings(deadlines, now);
const kitchenOnly = { signedOut: false, unsure: false, canAccept: false, onOrders: false };
const signedOut = { signedOut: true, unsure: false, canAccept: true, onOrders: false };
const lost: RefundDeadline = {
  orderNumber: "12",
  acceptBy: at(3),
  kitchenStart: true,
  notReached: true,
};
const sent: RefundDeadline = { orderNumber: "13", acceptBy: at(3), kitchenStart: true };
const ordinary: RefundDeadline = { orderNumber: "14", acceptBy: at(3) };

it("an automatically sent pickup that never arrived asks for Making it by hand, never Accept", () => {
  for (const where of [kitchenOnly, signedOut, { ...signedOut, canAccept: false }]) {
    const lines = refundActionLines(warnings([lost]), where);
    expect(lines.accept).toBeNull();
    expect(lines.kitchen).toContain("Making it by hand");
    expect(lines.kitchen).not.toMatch(/accept/iu);
  }
  // On Orders, the button is right there.
  expect(refundActionLines(warnings([lost]), { ...kitchenOnly, onOrders: true })).toEqual({
    accept: null,
    kitchen: null,
  });
});

it("one that reached the kitchen asks for a step on the ticket; ordinary pickups still say Accept", () => {
  expect(refundActionLines(warnings([sent]), kitchenOnly).kitchen).toContain(
    "Tap a step on the ticket",
  );
  expect(refundActionLines(warnings([sent]), signedOut).kitchen).toContain(
    "Tap a step on the ticket",
  );
  expect(refundActionLines(warnings([sent]), signedOut).accept).toBeNull();
  const mixed = refundActionLines(warnings([ordinary, lost]), kitchenOnly);
  expect(mixed.accept).toBe("Ask someone at the counter to accept it on Orders.");
  expect(mixed.kitchen).toContain("Making it by hand");
  expect(refundActionLines(warnings([ordinary]), signedOut).accept).toBe("Sign in to accept it.");
  expect(refundActionLines(warnings([ordinary]), { ...signedOut, unsure: true }).accept).toBe(
    "Sign in to check.",
  );
});
