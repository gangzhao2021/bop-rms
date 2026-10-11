import { beforeEach, expect, it, vi } from "vitest";
import { fixture, id } from "../test-support/customer-entry-composition-fixture.js";
import { createPersistentCustomerEntryComposition } from "./persistent-customer-entry.js";
const owner = vi.hoisted(() => ({ profile: vi.fn(), session: vi.fn() }));
vi.mock("./persistent-public-store-profile.js", () => ({
  createPersistentPublicStoreProfilePorts: (...args: unknown[]) => owner.profile(...args),
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresGuestSessionEntryStore: (...args: unknown[]) => owner.session(...args),
}));
beforeEach(() => vi.resetAllMocks());
function setup() {
  const f = fixture();
  owner.profile.mockReturnValue(f.options.profile);
  owner.session.mockReturnValue(f.options.session.store);
  const tx = { query: vi.fn() };
  const events: string[] = [];
  let failCommit = false;
  const run = async <T>(work: (value: typeof tx) => Promise<T>) => {
    events.push("begin");
    try {
      const result = await work(tx);
      if (failCommit) throw new Error("synthetic commit failure");
      events.push("commit");
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    }
  };
  const sources = vi.fn(async () => {
    events.push("sources");
    return {
      qr: f.options.qr,
      operating: f.options.operating,
      admission: f.options.admission,
      binding: f.options.session.binding,
    };
  });
  const profile = { binding: { brandReference: id(1), storeReference: id(2) } } as Parameters<
    typeof createPersistentCustomerEntryComposition
  >[0]["profile"];
  const service = createPersistentCustomerEntryComposition({
    transactions: { run },
    profile,
    session: f.options.session,
    sources,
  });
  return {
    f,
    tx,
    events,
    sources,
    run,
    service,
    failCommit: () => {
      failCommit = true;
    },
  };
}
it("binds all request sources and session writes to one transaction, returning only after commit", async () => {
  const x = setup();
  const input = x.f.input();
  const result = await x.service.establish(input);
  expect(result.status).toBe("Established");
  expect(x.events).toEqual(["begin", "sources", "commit"]);
  expect(x.sources).toHaveBeenCalledExactlyOnceWith(x.tx, input);
  expect(owner.profile.mock.calls[0]?.[0]).toBe(x.tx);
  const invocation = owner.session.mock.calls[0];
  if (!invocation) throw new Error("session store not composed");
  await invocation[0].run(async (tx: unknown) => expect(tx).toBe(x.tx));
  expect(invocation[1]).toEqual({ brandReference: id(1), storeReference: id(2) });
});
it("rolls back failed admission and withholds credentials when commit fails", async () => {
  const denied = setup();
  denied.f.admission.mockResolvedValueOnce(null);
  expect(await denied.service.establish(denied.f.input())).toEqual({ status: "EntryUnavailable" });
  expect(denied.events).toEqual(["begin", "sources", "rollback"]);
  expect(denied.f.create).not.toHaveBeenCalled();
  const failed = setup();
  failed.failCommit();
  expect(await failed.service.establish(failed.f.input())).toEqual({ status: "EntryUnavailable" });
  expect(failed.events).toEqual(["begin", "sources", "rollback"]);
});
it("rejects foreign QR scope and invalid clocks without issuing a session", async () => {
  const x = setup();
  x.f.context.storeReference = id(99);
  expect(await x.service.establish(x.f.input())).toEqual({ status: "EntryUnavailable" });
  expect(x.f.create).not.toHaveBeenCalled();
  expect(x.events).toEqual(["begin", "sources", "rollback"]);
  const invalid = setup();
  expect(await invalid.service.establish({ ...invalid.f.input(), requestedAt: "invalid" })).toEqual(
    { status: "EntryUnavailable" },
  );
  expect(invalid.events).toEqual([]);
});
it("WP-2423 Q4: rolls back a closed Store's entry but keeps its not-accepting answer", async () => {
  const x = setup();
  x.f.operating.weeklySchedule.forEach((day) => {
    day.intervals = [];
  });
  expect(await x.service.establish(x.f.input())).toMatchObject({
    status: "NotAccepting",
    operatingState: "Closed",
  });
  expect(x.events).toEqual(["begin", "sources", "rollback"]);
  expect(x.f.admission).not.toHaveBeenCalled();
  expect(x.f.create).not.toHaveBeenCalled();
});
