import { expect, it } from "vitest";
import {
  diningGuestInvitationAvailableAt,
  diningGuestInvitationIntent,
  diningGuestInvitationMaximumPerWindow,
  diningGuestInvitationWindowMs,
  evaluateDiningGuestInvitationAuthority,
  evaluateDiningGuestInvitationBudget,
  evaluateDiningGuestInvitationCodeState,
  parseDiningGuestInvitationCommand,
  parseDiningInstant,
  parseDiningSession,
} from "../index.js";

const id = (n: number) => "0190fa41-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = (minute: number, second = 0) =>
  new Date(Date.UTC(2026, 9, 17, 18, minute, second)).toISOString();
const command = (overrides: Record<string, unknown> = {}) =>
  parseDiningGuestInvitationCommand({
    operationReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    diningSessionReference: id(5),
    participantReference: id(6),
    observedAt: at(30),
    ...overrides,
  });
const session = (overrides: Record<string, unknown> = {}) =>
  parseDiningSession({
    diningSessionReference: id(5),
    brandReference: id(3),
    storeReference: id(4),
    tableReference: id(9),
    tableAssignmentVersion: 2,
    phase: "Active",
    version: 3,
    startedByActorReference: id(10),
    startedAt: at(0),
    hostParticipantReference: id(6),
    ...overrides,
  });

it("accepts only a closed command with exact references and instant", () => {
  expect(command().participantReference).toBe(id(6));
  expect(() => command({ extra: true })).toThrow();
  expect(() => command({ observedAt: "2026-10-17T18:30:00Z" })).toThrow();
  expect(() => command({ participantReference: "not-a-reference" })).toThrow();
  const { observedAt: _omitted, ...missing } = { ...command() };
  void _omitted;
  expect(() => parseDiningGuestInvitationCommand(missing)).toThrow();
  // The operation is bound to one Host and one Session, never to a time or a code.
  expect(diningGuestInvitationIntent(command())).toBe(`GuestInvitation:${id(5)}:${id(6)}`);
  expect(diningGuestInvitationIntent(command({ observedAt: at(31) }))).toBe(
    diningGuestInvitationIntent(command()),
  );
});

it("lets only the current Host of an Active Session invite (Handoff 6.11)", () => {
  expect(
    evaluateDiningGuestInvitationAuthority({
      command: command(),
      session: session(),
      participantStatus: "Active",
    }),
  ).toBe("Allowed");
  // Another participant at the same table.
  expect(
    evaluateDiningGuestInvitationAuthority({
      command: command({ participantReference: id(7) }),
      session: session(),
      participantStatus: "Active",
    }),
  ).toBe("NotHost");
  // No Host yet (only staff have issued codes), a Host who left, a closing table.
  for (const [overrides, status] of [
    [{ hostParticipantReference: null }, "Active"],
    [{}, "Left"],
    [{ phase: "Closing" }, "Active"],
    [{ phase: "Closed" }, "Active"],
  ] as const)
    expect(
      evaluateDiningGuestInvitationAuthority({
        command: command(),
        session: session(overrides),
        participantStatus: status,
      }),
    ).toBe("NotHost");
  // A Session of another Store or another Session is a programming error, never a refusal.
  expect(() =>
    evaluateDiningGuestInvitationAuthority({
      command: command(),
      session: session({ storeReference: id(40) }),
      participantStatus: "Active",
    }),
  ).toThrow();
  expect(() =>
    evaluateDiningGuestInvitationAuthority({
      command: command(),
      session: session({ diningSessionReference: id(41) }),
      participantStatus: "Active",
    }),
  ).toThrow();
});

it("bounds guest issuance per Session per rolling window", () => {
  expect(diningGuestInvitationWindowMs).toBe(600_000);
  expect(diningGuestInvitationMaximumPerWindow).toBe(10);
  const now = parseDiningInstant(at(30));
  const nine = Array.from({ length: 9 }, (_, n) => at(21 + n));
  expect(evaluateDiningGuestInvitationBudget({ issuedAt: nine, observedAt: now })).toBe("Admitted");
  expect(diningGuestInvitationAvailableAt({ issuedAt: nine, observedAt: now })).toBe(now);
  const ten = [at(20, 30), ...nine];
  expect(evaluateDiningGuestInvitationBudget({ issuedAt: ten, observedAt: now })).toBe(
    "TooManyInvitations",
  );
  // The oldest counted issuance leaves the window ten minutes after it was issued.
  expect(diningGuestInvitationAvailableAt({ issuedAt: ten, observedAt: now })).toBe(at(30, 30));
  // Exactly ten minutes old no longer counts.
  const aged = [at(20), ...nine];
  expect(evaluateDiningGuestInvitationBudget({ issuedAt: aged, observedAt: now })).toBe("Admitted");
  // A record from the future is corrupt history, not a reason to admit or refuse.
  expect(() =>
    evaluateDiningGuestInvitationBudget({ issuedAt: [at(31)], observedAt: now }),
  ).toThrow();
  expect(() =>
    evaluateDiningGuestInvitationBudget({ issuedAt: ["yesterday"], observedAt: now }),
  ).toThrow();
});

it("tells the Host what became of a code without the code (v15 42e95248)", () => {
  const observedAt = parseDiningInstant(at(30));
  const state = (status: "Active" | "Consumed" | "Revoked" | "Expired", expiresAt = at(40)) =>
    evaluateDiningGuestInvitationCodeState({ status, expiresAt, observedAt });
  expect(state("Active")).toBe("Live");
  expect(state("Consumed")).toBe("Used");
  expect(state("Revoked")).toBe("Replaced");
  expect(state("Expired")).toBe("Expired");
  // An Active row past its 15 minutes is already expired for the guest.
  expect(state("Active", at(30))).toBe("Expired");
  expect(state("Active", at(29))).toBe("Expired");
});
