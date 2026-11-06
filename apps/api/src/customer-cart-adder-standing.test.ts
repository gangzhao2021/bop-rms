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

const brand = id(2),
  store = id(3);
const scope = { brandReference: brand, storeReference: store };
const departure = (
  participant: string,
  kind: "Left" | "Moved" | "Present",
  version = 2,
  active = true,
) => ({
  participantReference: participant,
  departure: kind,
  joinedTableQr: { version, active },
});
const sessionAt = (n: number, participant: string, qrRevocationVersion: number) =>
  ({ ...session(n, participant), qrRevocationVersion }) as unknown as GuestSession;

describe("WP-2423 same-table-ordering: has the phone that added a line left the table", () => {
  it("is AtTable while any live session passes the cart's own binding check, Gone only on a recorded departure", async () => {
    const phoneA = id(41),
      phoneB = id(42),
      phoneC = id(43),
      phoneD = id(44);
    const listBound = vi.fn(async () => [
      // A: an older session that no longer passes (QR replaced) and its current one that does.
      sessionAt(101, phoneA, 1),
      sessionAt(102, phoneA, 2),
      // B: removed by staff: its session fails the check and Dining records it Left.
      sessionAt(103, phoneB, 2),
      // D: its session fails the check, and Dining records nothing: an outage, not a departure.
      sessionAt(104, phoneD, 2),
      // C has no live session at all (its session ended).
    ]);
    const validate = vi.fn(async (value: GuestSession, when: string) =>
      String(value.sessionReference) === id(102) && when === at ? "Current" : "Unavailable",
    );
    const readDepartures = vi.fn(async () => [
      departure(phoneB, "Left"),
      departure(phoneD, "Present"),
    ]);
    const port = createCustomerCartAdderStanding({
      scope,
      sessions: { listBound },
      binding: { validate },
      departures: { readDepartures } as never,
    });
    await expect(
      port.standing({
        diningSessionReference: id(30),
        participantReferences: [phoneA, phoneB, phoneC, phoneD, phoneA],
        observedAt: at,
      }),
    ).resolves.toEqual([
      { participantReference: phoneA, standing: "AtTable" },
      { participantReference: phoneB, standing: "Gone" },
      { participantReference: phoneC, standing: "Gone" },
      { participantReference: phoneD, standing: "Unknown" },
    ]);
    expect(listBound).toHaveBeenCalledWith({
      diningSessionReference: id(30),
      participantReferences: [phoneA, phoneB, phoneC, phoneD],
      observedAt: at,
    });
    // Only the phones not shown at the table are asked about, in this Store.
    expect(readDepartures).toHaveBeenCalledWith({
      brandReference: brand,
      storeReference: store,
      diningSessionReference: id(30),
      participantReferences: [phoneB, phoneD],
    });
    // Each session is checked at the asked instant; A stops once one session passes.
    expect(
      validate.mock.calls.map(([value, when]) => [String(value.sessionReference), when]),
    ).toEqual([
      [id(101), at],
      [id(102), at],
      [id(103), at],
      [id(104), at],
    ]);
  });

  it("a replaced or turned-off code, or a move the phone did not follow, is a departure", async () => {
    const replaced = id(45),
      turnedOff = id(46),
      moved = id(47),
      rescanned = id(48);
    const port = createCustomerCartAdderStanding({
      scope,
      sessions: {
        listBound: async () => [
          sessionAt(105, replaced, 1),
          sessionAt(106, turnedOff, 2),
          sessionAt(107, moved, 2),
          // Scanned the current code (version 3) but the check failed for another reason.
          sessionAt(108, rescanned, 3),
        ],
      },
      binding: { validate: async () => "Unavailable" },
      departures: {
        readDepartures: async () => [
          departure(replaced, "Present", 2),
          departure(turnedOff, "Present", 2, false),
          departure(moved, "Moved"),
          departure(rescanned, "Present", 3),
        ],
      } as never,
    });
    await expect(
      port.standing({
        diningSessionReference: id(30),
        participantReferences: [replaced, turnedOff, moved, rescanned],
        observedAt: at,
      }),
    ).resolves.toEqual([
      { participantReference: replaced, standing: "Gone" },
      { participantReference: turnedOff, standing: "Gone" },
      { participantReference: moved, standing: "Gone" },
      { participantReference: rescanned, standing: "Unknown" },
    ]);
  });

  it("a binding check that throws, or a departure read that fails, never makes a phone Gone", async () => {
    const phone = id(49);
    const throwing = createCustomerCartAdderStanding({
      scope,
      sessions: { listBound: async () => [sessionAt(109, phone, 2)] },
      binding: {
        validate: async () => {
          throw new Error("synthetic lock timeout during a table move");
        },
      },
      departures: { readDepartures: async () => [departure(phone, "Present")] } as never,
    });
    await expect(
      throwing.standing({
        diningSessionReference: id(30),
        participantReferences: [phone],
        observedAt: at,
      }),
    ).resolves.toEqual([{ participantReference: phone, standing: "Unknown" }]);
    const unreadable = createCustomerCartAdderStanding({
      scope,
      sessions: { listBound: async () => [sessionAt(110, phone, 1)] },
      binding: { validate: async () => "Unavailable" },
      departures: {
        readDepartures: async () => {
          throw new Error("synthetic Dining outage");
        },
      } as never,
    });
    await expect(
      unreadable.standing({
        diningSessionReference: id(30),
        participantReferences: [phone],
        observedAt: at,
      }),
    ).resolves.toEqual([{ participantReference: phone, standing: "Unknown" }]);
    // Without Dining's facts, a failed check alone is never a departure.
    const blind = createCustomerCartAdderStanding({
      scope,
      sessions: { listBound: async () => [sessionAt(111, phone, 1)] },
      binding: { validate: async () => "Unavailable" },
    });
    await expect(
      blind.standing({
        diningSessionReference: id(30),
        participantReferences: [phone],
        observedAt: at,
      }),
    ).resolves.toEqual([{ participantReference: phone, standing: "Unknown" }]);
  });

  it("after a table move, a phone whose session still passes at the table keeps its lines", async () => {
    const moved = id(44);
    const readDepartures = vi.fn();
    const port = createCustomerCartAdderStanding({
      scope,
      sessions: { listBound: async () => [session(104, moved)] },
      binding: { validate: async () => "Current" },
      departures: { readDepartures } as never,
    });
    await expect(
      port.standing({
        diningSessionReference: id(30),
        participantReferences: [moved],
        observedAt: at,
      }),
    ).resolves.toEqual([{ participantReference: moved, standing: "AtTable" }]);
    expect(readDepartures).not.toHaveBeenCalled();
  });

  it("fails closed when the sessions can't be listed, and asks nothing for no lines", async () => {
    const failing = createCustomerCartAdderStanding({
      scope,
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
      scope,
      sessions: { listBound },
      binding: { validate: async () => "Current" },
    });
    await expect(
      empty.standing({ diningSessionReference: id(30), participantReferences: [], observedAt: at }),
    ).resolves.toEqual([]);
    expect(listBound).not.toHaveBeenCalled();
  });
  it("a view's Recorded check reads two owner facts for any number of phones and never runs the binding check", async () => {
    const phones = Array.from({ length: 8 }, (_, n) => id(60 + n));
    const listBound = vi.fn(async () =>
      // The first phone's session ended; every other phone has one live session.
      phones.slice(1).map((phone, n) => sessionAt(200 + n, phone, 2)),
    );
    const validate = vi.fn(async () => "Current");
    const readDepartures = vi.fn(async () => [
      departure(phones[1] as string, "Left"),
      departure(phones[2] as string, "Present", 3),
      ...phones.slice(3).map((phone) => departure(phone, "Present")),
    ]);
    const port = createCustomerCartAdderStanding({
      scope,
      sessions: { listBound },
      binding: { validate },
      departures: { readDepartures } as never,
    });
    const answers = await port.standing({
      diningSessionReference: id(30),
      participantReferences: phones,
      observedAt: at,
      check: "Recorded",
    });
    expect(answers.map((answer) => answer.standing)).toEqual([
      "Gone", // session ended
      "Gone", // staff removed it
      "Gone", // the code its session scanned was replaced
      ...phones.slice(3).map(() => "Unknown"), // nothing recorded: not marked
    ]);
    expect(validate).not.toHaveBeenCalled();
    expect(listBound).toHaveBeenCalledTimes(1);
    expect(readDepartures).toHaveBeenCalledTimes(1);
    // A failed Dining read leaves every phone with a live session unmarked.
    readDepartures.mockRejectedValueOnce(new Error("synthetic Dining outage"));
    const failed = await port.standing({
      diningSessionReference: id(30),
      participantReferences: phones,
      observedAt: at,
      check: "Recorded",
    });
    expect(failed.map((answer) => answer.standing)).toEqual([
      "Gone",
      ...phones.slice(1).map(() => "Unknown"),
    ]);
    expect(validate).not.toHaveBeenCalled();
  });
});
