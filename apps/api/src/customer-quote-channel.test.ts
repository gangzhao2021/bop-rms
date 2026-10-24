import { createGuestSession, GuestSessionError } from "@bop/identity";
import { expect, it, vi } from "vitest";
import { createCustomerQuoteChannelPort } from "./customer-quote-channel.js";
import { createCustomerEntryComposition } from "./customer-entry-composition.js";
import { fixture, id, now } from "../test-support/customer-entry-composition-fixture.js";
async function setup(channel: "Pickup" | "DineIn" = "DineIn") {
  const f = fixture();
  if (channel === "Pickup") {
    f.payload.channel = f.context.channel = channel;
    f.payload.publicTableReference =
      f.context.publicTableReference =
      f.context.tableReference =
        null;
    f.context.tableLifecycle = f.context.assignmentState = null;
  }
  await createCustomerEntryComposition(f.options).establish(f.input());
  const record = [...f.records.values()][0];
  if (!record) throw new Error("missing entry");
  const session =
    channel === "Pickup"
      ? record.session
      : {
          ...record.session,
          diningState: "DiningBound" as const,
          diningSessionReference: id(810),
          diningParticipantReference: id(811),
        };
  const authorize = vi.fn(async () => createGuestSession(session));
  const pickup = { quoteCart: vi.fn(async () => ({ status: "VersionConflict" as const })) };
  const dining = { quoteCart: vi.fn(async () => ({ status: "NotFound" as const })) };
  const clock = vi.fn(() => now);
  const port = createCustomerQuoteChannelPort({
    scope: { brandReference: id(1), storeReference: id(2) },
    sessions: { authorize },
    now: clock,
    pickup,
    dining,
  });
  const input = {
    cartReference: id(820) as never,
    expectedCartVersion: 2,
    guestCredential: "a".repeat(43),
    csrfCredential: "b".repeat(43),
    idempotencyKey: id(821),
    requestedAt: now,
  };
  return { port, input, authorize, pickup, dining, session, clock };
}
it.each(["Pickup", "DineIn"] as const)(
  "routes authorized %s preserving downstream outcomes",
  async (channel) => {
    const f = await setup(channel);
    expect(await f.port.quoteCart(f.input)).toEqual({
      status: channel === "Pickup" ? "VersionConflict" : "NotFound",
    });
    expect((channel === "Pickup" ? f.pickup : f.dining).quoteCart).toHaveBeenCalledWith(f.input);
    expect((channel === "Pickup" ? f.dining : f.pickup).quoteCart).not.toHaveBeenCalled();
    expect(f.authorize).toHaveBeenCalledWith({
      sessionCredential: f.input.guestCredential,
      csrfCredential: f.input.csrfCredential,
      observedAt: now,
    });
  },
);
it("denies current credential/CSRF failure before either quote owner", async () => {
  const f = await setup();
  f.authorize.mockRejectedValue(new Error("denied"));
  expect(await f.port.quoteCart(f.input)).toEqual({ status: "Unavailable" });
  expect(f.pickup.quoteCart).not.toHaveBeenCalled();
  expect(f.dining.quoteCart).not.toHaveBeenCalled();
});
it("preserves concealed not-found for rejected current sessions", async () => {
  const f = await setup();
  f.authorize.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  expect(await f.port.quoteCart(f.input)).toEqual({ status: "NotFound" });
  expect(f.pickup.quoteCart).not.toHaveBeenCalled();
  expect(f.dining.quoteCart).not.toHaveBeenCalled();
});
it("denies foreign Store and context-only Dining sessions", async () => {
  const f = await setup();
  f.authorize.mockResolvedValue({ ...f.session, storeReference: id(999) } as never);
  expect(await f.port.quoteCart(f.input)).toEqual({ status: "NotFound" });
  f.authorize.mockResolvedValue({
    ...f.session,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
  } as never);
  expect(await f.port.quoteCart(f.input)).toEqual({ status: "NotFound" });
  expect(f.dining.quoteCart).not.toHaveBeenCalled();
});
it("denies a backwards clock without selecting an owner", async () => {
  const f = await setup();
  f.clock.mockReturnValueOnce(now).mockReturnValueOnce(new Date(Date.parse(now) - 1).toISOString());
  expect(await f.port.quoteCart(f.input)).toEqual({ status: "Unavailable" });
  expect(f.dining.quoteCart).not.toHaveBeenCalled();
});
