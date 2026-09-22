import { createGuestSession, GuestSessionError } from "@bop/identity";
import { expect, it, vi } from "vitest";
import { createCustomerOrderSubmissionChannel } from "./customer-order-submission-channel.js";
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
    create: vi.fn(async () => ({ marker: "created" }) as never),
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
    submissionReference: id(821),
    cartReference: id(820),
    expectedCartVersion: 2,
    quoteReference: id(822),
  };
  return {
    options,
    input,
    session,
    authorize,
    result: createCustomerOrderSubmissionChannel(options),
  };
}
it.each(["Pickup", "DineIn"] as const)(
  "routes current %s submission without changing intent",
  async (channel) => {
    const f = await setup(channel);
    const selected = channel === "Pickup" ? f.options.pickup : f.options.dining;
    const other = channel === "Pickup" ? f.options.dining : f.options.pickup;
    expect(await f.result.create(f.input)).toEqual({ marker: "created" });
    expect(selected.create).toHaveBeenCalledWith(f.input);
    expect(other.create).not.toHaveBeenCalled();
    expect(f.authorize).toHaveBeenCalledWith({
      sessionCredential: f.input.sessionCredential,
      csrfCredential: f.input.csrfCredential,
      observedAt: now,
    });
  },
);
it("does not dispatch revoked, foreign or unbound identity", async () => {
  const f = await setup();
  f.authorize.mockRejectedValueOnce(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  await expect(f.result.create(f.input)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  f.authorize.mockResolvedValueOnce({ ...f.session, storeReference: id(999) } as never);
  await expect(f.result.create(f.input)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  f.authorize.mockResolvedValueOnce({
    ...f.session,
    diningState: "ContextOnly",
    diningSessionReference: null,
    diningParticipantReference: null,
  } as never);
  await expect(f.result.create(f.input)).rejects.toMatchObject({
    code: "GUEST_SESSION_UNAVAILABLE",
  });
  expect(f.options.pickup.create).not.toHaveBeenCalled();
  expect(f.options.dining.create).not.toHaveBeenCalled();
});
it("preserves owner errors and captures intent before awaiting authorization", async () => {
  const f = await setup();
  const original = structuredClone(f.input);
  const error = new Error("synthetic owner unavailable");
  f.authorize.mockImplementationOnce(async () => {
    f.input.submissionReference = id(999);
    return f.session;
  });
  f.options.dining.create.mockRejectedValueOnce(error);
  await expect(f.result.create(f.input)).rejects.toBe(error);
  expect(f.options.dining.create).toHaveBeenCalledWith(original);
});
it("rejects backwards clock and incompatible owner configuration", async () => {
  const f = await setup();
  f.options.now
    .mockReturnValueOnce(now)
    .mockReturnValueOnce(new Date(Date.parse(now) - 1).toISOString());
  await expect(f.result.create(f.input)).rejects.toThrow("LOCAL_CHECKOUT_CLOCK_INVALID");
  expect(f.options.dining.create).not.toHaveBeenCalled();
  expect(() =>
    createCustomerOrderSubmissionChannel({
      ...f.options,
      dining: { ...f.options.dining, quoteVersion: 1 },
    }),
  ).toThrow("LOCAL_ORDER_SUBMISSION_CONFIGURATION_INVALID");
});
