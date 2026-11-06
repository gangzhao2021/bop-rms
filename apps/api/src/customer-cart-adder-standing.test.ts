import { describe, expect, it, vi } from "vitest";
import type { GuestSession } from "@bop/identity";
import { createCustomerCartAdderStanding } from "./customer-cart-adder-standing.js";

const id = (n: number) => `01902423-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-11-06T16:00:00.000Z";
const session = (n: number, participant: string) =>
  ({
    sessionReference: id(n),
    diningSessionReference: id(30),
    diningParticipantReference: participant,
  }) as unknown as GuestSession;

describe("WP-2423 same-table-ordering: has the phone that added a line left the table", () => {
  it("is AtTable while any live session of that phone passes the cart's own binding check", async () => {
    const phoneA = id(41),
      phoneB = id(42),
      phoneC = id(43);
    const listBound = vi.fn(async () => [
      // A: an older session that no longer passes (QR replaced) and its current one that does.
      session(101, phoneA),
      session(102, phoneA),
      // B: removed by staff, so its only session fails the binding check (participant Left).
      session(103, phoneB),
      // C has no live session at all (its session ended).
    ]);
    const validate = vi.fn(async (value: GuestSession, when: string) =>
      String(value.sessionReference) === id(102) && when === at ? "Current" : "Unavailable",
    );
    const port = createCustomerCartAdderStanding({
      sessions: { listBound },
      binding: { validate },
    });
    await expect(
      port.standing({
        diningSessionReference: id(30),
        participantReferences: [phoneA, phoneB, phoneC, phoneA],
        observedAt: at,
      }),
    ).resolves.toEqual([
      { participantReference: phoneA, standing: "AtTable" },
      { participantReference: phoneB, standing: "Gone" },
      { participantReference: phoneC, standing: "Gone" },
    ]);
    expect(listBound).toHaveBeenCalledWith({
      diningSessionReference: id(30),
      participantReferences: [phoneA, phoneB, phoneC],
      observedAt: at,
    });
    // Each session is checked at the asked instant; A stops once one session passes.
    expect(
      validate.mock.calls.map(([value, when]) => [String(value.sessionReference), when]),
    ).toEqual([
      [id(101), at],
      [id(102), at],
      [id(103), at],
    ]);
  });

  it("after a table move, a phone whose session still passes at the table keeps its lines", async () => {
    // Whatever the move does, the answer follows the binding check: a phone that can still act
    // at this table is AtTable; one that would have to scan again is Gone.
    const moved = id(44);
    const port = createCustomerCartAdderStanding({
      sessions: { listBound: async () => [session(104, moved)] },
      binding: { validate: async () => "Current" },
    });
    await expect(
      port.standing({
        diningSessionReference: id(30),
        participantReferences: [moved],
        observedAt: at,
      }),
    ).resolves.toEqual([{ participantReference: moved, standing: "AtTable" }]);
  });

  it("fails closed when the sessions can't be listed, and asks nothing for no lines", async () => {
    const failing = createCustomerCartAdderStanding({
      sessions: {
        listBound: async () => {
          throw new Error("synthetic Identity outage");
        },
      },
      binding: { validate: async () => "Current" },
    });
    await expect(
      failing.standing({
        diningSessionReference: id(30),
        participantReferences: [id(41)],
        observedAt: at,
      }),
    ).rejects.toThrow();
    const listBound = vi.fn(async () => []);
    const empty = createCustomerCartAdderStanding({
      sessions: { listBound },
      binding: { validate: async () => "Current" },
    });
    await expect(
      empty.standing({ diningSessionReference: id(30), participantReferences: [], observedAt: at }),
    ).resolves.toEqual([]);
    expect(listBound).not.toHaveBeenCalled();
  });
});
