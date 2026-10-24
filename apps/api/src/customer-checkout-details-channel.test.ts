import { createGuestSession, GuestSessionError } from "@bop/identity";
import { expect, it, vi } from "vitest";
import { createCustomerCheckoutDetailsChannel } from "./customer-checkout-details-channel.js";
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
  if (!record) throw new Error("missing fixture session");
  const session = createGuestSession(
    channel === "Pickup"
      ? record.session
      : {
          ...record.session,
          diningState: "DiningBound",
          diningSessionReference: id(810),
          diningParticipantReference: id(811),
        },
  );
  const authorize = vi.fn(async () => session);
  const port = () => ({
    quoteVersion: 2 as const,
    read: vi.fn(async () => ({ marker: "read" }) as never),
    policy: vi.fn(async () => ({ marker: "policy" }) as never),
    save: vi.fn(async () => ({ marker: "save" }) as never),
  });
  const options = {
    scope: { brandReference: id(1), storeReference: id(2) },
    sessions: { authorize },
    now: vi.fn(() => now),
    pickup: port(),
    dining: port(),
  };
  const input = {
    sessionCredential: "a".repeat(43),
    csrfCredential: "b".repeat(43),
    query: { cartReference: id(820), cartVersion: 2 },
  };
  return {
    options,
    input,
    session,
    authorize,
    result: createCustomerCheckoutDetailsChannel(options),
  };
}
it.each(["Pickup", "DineIn"] as const)(
  "routes all checkout details actions for %s",
  async (channel) => {
    const f = await setup(channel);
    const selected = channel === "Pickup" ? f.options.pickup : f.options.dining;
    const other = channel === "Pickup" ? f.options.dining : f.options.pickup;
    for (const method of ["read", "policy", "save"] as const) {
      const input = method === "save" ? { ...f.input, command: {} } : f.input;
      expect(await f.result[method](input as never)).toEqual({ marker: method });
      expect(selected[method]).toHaveBeenCalledWith(input);
      expect(other[method]).not.toHaveBeenCalled();
    }
    expect(f.authorize).toHaveBeenCalledWith({
      sessionCredential: f.input.sessionCredential,
      csrfCredential: f.input.csrfCredential,
      observedAt: now,
    });
  },
);
it("never invokes an owner for revoked, foreign or unbound sessions", async () => {
  const f = await setup();
  f.authorize.mockRejectedValueOnce(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  await expect(f.result.read(f.input)).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  f.authorize.mockResolvedValueOnce({ ...f.session, storeReference: id(999) } as never);
  await expect(f.result.policy(f.input)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  f.authorize.mockResolvedValueOnce({
    ...f.session,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
  } as never);
  await expect(f.result.save({ ...f.input, command: {} } as never)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  for (const port of [f.options.pickup, f.options.dining])
    for (const method of ["read", "policy", "save"] as const)
      expect(port[method]).not.toHaveBeenCalled();
});
it("preserves owner errors and rejects backwards clocks", async () => {
  const f = await setup();
  const error = new Error("owner unavailable");
  f.options.dining.read.mockRejectedValue(error);
  await expect(f.result.read(f.input)).rejects.toBe(error);
  f.options.now
    .mockReturnValueOnce(now)
    .mockReturnValueOnce(new Date(Date.parse(now) - 1).toISOString());
  await expect(f.result.read(f.input)).rejects.toThrow("LOCAL_CHECKOUT_CLOCK_INVALID");
  expect(f.options.dining.read).toHaveBeenCalledTimes(1);
});
it("rejects incompatible quote versions and incomplete owner ports", async () => {
  const f = await setup();
  expect(() =>
    createCustomerCheckoutDetailsChannel({
      ...f.options,
      dining: { ...f.options.dining, quoteVersion: 1 },
    }),
  ).toThrow("LOCAL_CHECKOUT_DETAILS_CONFIGURATION_INVALID");
  expect(() =>
    createCustomerCheckoutDetailsChannel({
      ...f.options,
      pickup: { ...f.options.pickup, policy: undefined } as never,
    }),
  ).toThrow("LOCAL_CHECKOUT_DETAILS_CONFIGURATION_INVALID");
});
