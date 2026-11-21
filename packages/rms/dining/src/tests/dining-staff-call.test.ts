import { describe, expect, it } from "vitest";
import { parseDiningInstant } from "../domain/dining-session.js";
import {
  diningStaffCallAvailableAt,
  diningStaffCallIntent,
  evaluateDiningStaffCallBudget,
  parseDiningStaffCallAnswerCommand,
  parseDiningStaffCallGuestCommand,
  parseDiningStaffCallReason,
} from "../domain/dining-staff-call.js";

const id = (n: number) => `01902423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (minute: number) =>
  parseDiningInstant(`2026-10-25T09:${String(minute).padStart(2, "0")}:00.000Z`);
const guest = (minute = 30) =>
  parseDiningStaffCallGuestCommand({
    operationReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    diningSessionReference: id(5),
    participantReference: id(6),
    observedAt: at(minute),
  });

describe("WP-2423 Q28 DEC-DINING-STAFF-CALL", () => {
  it("takes one of three reasons and no free text", () => {
    expect(parseDiningStaffCallReason("Question")).toBe("Question");
    expect(parseDiningStaffCallReason("TableNeeds")).toBe("TableNeeds");
    expect(parseDiningStaffCallReason("OrderProblem")).toBe("OrderProblem");
    expect(() => parseDiningStaffCallReason("I am allergic to nuts")).toThrow();
  });
  it("reads closed commands only", () => {
    expect(guest().diningSessionReference).toBe(id(5));
    expect(() => parseDiningStaffCallGuestCommand({ ...guest(), extra: 1 })).toThrow();
    expect(
      parseDiningStaffCallAnswerCommand({
        operationReference: id(1),
        callReference: id(7),
        actorReference: id(8),
        observedAt: at(1),
      }).callReference,
    ).toBe(id(7));
  });
  it("binds each request to its content", () => {
    const command = guest();
    expect(diningStaffCallIntent(command, { kind: "Call", reason: "Question" })).not.toBe(
      diningStaffCallIntent(command, { kind: "Call", reason: "TableNeeds" }),
    );
    expect(
      diningStaffCallIntent(command, {
        kind: "Withdraw",
        callReference: command.operationReference,
      }),
    ).toContain("Withdraw");
  });
  it("admits 6 calls in any 30 minutes and says when the next is admitted", () => {
    const five = [1, 5, 10, 15, 20].map(at);
    expect(evaluateDiningStaffCallBudget({ calledAt: five, observedAt: at(30) })).toBe("Admitted");
    const six = [...five, at(25)];
    expect(evaluateDiningStaffCallBudget({ calledAt: six, observedAt: at(30) })).toBe(
      "TooManyCalls",
    );
    expect(diningStaffCallAvailableAt({ calledAt: six, observedAt: at(30) })).toBe(at(31));
    // Calls older than the window do not count.
    expect(evaluateDiningStaffCallBudget({ calledAt: six, observedAt: at(31) })).toBe("Admitted");
    expect(diningStaffCallAvailableAt({ calledAt: five, observedAt: at(30) })).toBe(at(30));
    expect(() =>
      evaluateDiningStaffCallBudget({ calledAt: [at(40)], observedAt: guest().observedAt }),
    ).toThrow();
  });
});
