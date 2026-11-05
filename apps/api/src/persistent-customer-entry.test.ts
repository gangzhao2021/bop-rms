import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, id } from "../test-support/customer-entry-composition-fixture.js";
import {
  RetiredTableQrError,
  createPersistentCustomerEntryComposition,
} from "./persistent-customer-entry.js";
import { guestServiceModes } from "./merchant-store-features.js";
const owner = vi.hoisted(() => ({
  profile: vi.fn(),
  session: vi.fn(),
  open: vi.fn(),
  guestStarted: vi.fn(),
  offer: vi.fn(),
}));
vi.mock("./persistent-public-store-profile.js", () => ({
  createPersistentPublicStoreProfilePorts: (...args: unknown[]) => owner.profile(...args),
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresGuestSessionEntryStore: (...args: unknown[]) => owner.session(...args),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  loadDiningTableOpen: (...args: unknown[]) => owner.open(...args),
  loadDiningGuestStartedSessionAtTable: (...args: unknown[]) => owner.guestStarted(...args),
  loadDiningGuestTableOffer: (...args: unknown[]) => owner.offer(...args),
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
it("WP-2423 Q11: answers a replaced or turned-off table code without a session", async () => {
  for (const reason of ["Replaced", "TurnedOff"] as const) {
    const x = setup();
    x.sources.mockImplementationOnce(async () => {
      x.events.push("sources");
      throw new RetiredTableQrError(reason);
    });
    expect(await x.service.establish(x.f.input())).toEqual({ status: "QrRetired", reason });
    expect(x.events).toEqual(["begin", "sources", "rollback"]);
    expect(x.f.create).not.toHaveBeenCalled();
  }
  const other = setup();
  other.sources.mockRejectedValueOnce(new Error("ENTRY_UNAVAILABLE"));
  expect(await other.service.establish(other.f.input())).toEqual({ status: "EntryUnavailable" });
});
it("WP-2423 item 8 ⑦ 1b: a pickup code at a Store that turned pickup off answers dine-in only, through rollback", async () => {
  const x = setup();
  x.f.payload.channel = x.f.context.channel = "Pickup";
  x.f.payload.publicTableReference =
    x.f.context.publicTableReference =
    x.f.context.tableReference =
      null;
  x.f.context.tableLifecycle = x.f.context.assignmentState = null;
  // The Store's feature setting as the pilot reads it (pickup off), in the entry transaction.
  x.tx.query.mockImplementation(async (sql: string) =>
    sql.includes("FROM rms_store.store_feature_setting")
      ? {
          rows: [
            {
              version: 2,
              template_code: "FullService",
              counter_order: false,
              pickup: false,
              inventory: false,
              loyalty: false,
              compliance_documents: false,
              occurred_at: "2026-10-29T15:00:00.000Z",
            },
          ],
        }
      : sql.includes("current_setting")
        ? { rows: [{ brand: id(1), store: id(2) }] }
        : { rows: [] },
  );
  x.sources.mockImplementationOnce(async () => {
    x.events.push("sources");
    return {
      qr: x.f.options.qr,
      operatingReader: {
        readCurrent: async () =>
          guestServiceModes(
            x.tx,
            { tenantReference: id(3), brandReference: id(1), storeReference: id(2) },
            {
              brandReference: id(1),
              storeReference: id(2),
              evaluatedAt: x.f.input().requestedAt,
              state: "Open" as const,
              availableServiceModes: ["DineIn", "Pickup"] as ("DineIn" | "Pickup")[],
            },
          ),
      },
      admission: x.f.options.admission,
      binding: x.f.options.session.binding,
    } as never;
  });
  expect(await x.service.establish(x.f.input())).toEqual({
    status: "ServiceNotOffered",
    storeDisplayName: expect.any(String),
  });
  expect(x.events).toEqual(["begin", "sources", "rollback"]);
  expect(x.f.admission).not.toHaveBeenCalled();
  expect(x.f.create).not.toHaveBeenCalled();
});

describe("DEC-DINING-GUEST-TABLE-START: a scan at a table a guest started", () => {
  /** A fixed number of connections, as the process's pool: one that never frees is a failure. */
  function pool(size: number) {
    let free = size;
    const waiting: (() => void)[] = [];
    return {
      async run<T>(work: () => Promise<T>): Promise<T> {
        if (free === 0)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(
                Object.assign(new Error("no connection"), {
                  code: "TENANT_DATABASE_ACQUIRE_FAILED",
                }),
              );
            }, 300);
            waiting.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        else free -= 1;
        try {
          return await work();
        } finally {
          const next = waiting.shift();
          if (next) next();
          else free += 1;
        }
      },
    };
  }
  function scan(
    changes: {
      asks?: (table: string) => Promise<boolean>;
      run?: <T>(work: (tx: { query: ReturnType<typeof vi.fn> }) => Promise<T>) => Promise<T>;
    } = {},
  ) {
    const f = fixture();
    owner.profile.mockReturnValue(f.options.profile);
    owner.session.mockReturnValue(f.options.session.store);
    owner.open.mockResolvedValue(true);
    owner.guestStarted.mockResolvedValue(id(70));
    const tx = { query: vi.fn(async () => ({ rows: [] })) };
    const events: string[] = [];
    const inputs: { intent?: string; requestedAt: string }[] = [];
    const run =
      changes.run ??
      (async <T>(work: (value: typeof tx) => Promise<T>) => {
        events.push("begin");
        try {
          const result = await work(tx);
          events.push("commit");
          return result;
        } catch (error) {
          events.push("rollback");
          throw error;
        }
      });
    const service = createPersistentCustomerEntryComposition({
      transactions: { run: run as never },
      profile: { binding: { brandReference: id(1), storeReference: id(2) } } as never,
      session: f.options.session,
      guestTables: {
        asksNewParty: async (table) => {
          events.push("asks");
          return (changes.asks ?? (async () => true))(table);
        },
      },
      now: () => "2026-01-15T12:00:01.000Z",
      sources: async (_tx, input) => {
        events.push("sources");
        inputs.push(input);
        return {
          qr: f.options.qr,
          operating: f.options.operating,
          admission: f.options.admission,
          binding: f.options.session.binding,
        };
      },
    });
    return { f, events, inputs, service };
  }
  it("asks with nothing held: the scan's transaction ended first, and no visit started", async () => {
    const x = scan();
    expect((await x.service.establish(x.f.input())).status).toBe("TableAskNewParty");
    expect(x.events).toEqual(["begin", "sources", "rollback", "asks"]);
    expect(x.f.admission).not.toHaveBeenCalled();
    expect(x.f.create).not.toHaveBeenCalled();
  });
  it("nothing to ask: this phone joins as at any open table, in a transaction of its own", async () => {
    const x = scan({ asks: async () => false });
    expect(await x.service.establish(x.f.input())).toMatchObject({
      status: "Established",
      tableOpen: true,
    });
    expect(x.events).toEqual([
      "begin",
      "sources",
      "rollback",
      "asks",
      "begin",
      "sources",
      "commit",
    ]);
    expect(x.inputs[1]?.intent).toBe("Join");
    expect(x.f.create).toHaveBeenCalledOnce();
  });
  it("any other open table pays one read and never asks", async () => {
    const x = scan();
    owner.guestStarted.mockResolvedValue(null);
    expect((await x.service.establish(x.f.input())).status).toBe("Established");
    expect(x.events).toEqual(["begin", "sources", "commit"]);
  });
  it("a phone that already answered isn't asked again", async () => {
    const x = scan();
    expect((await x.service.establish({ ...x.f.input(), intent: "Join" })).status).toBe(
      "Established",
    );
    expect(x.events).toEqual(["begin", "sources", "commit"]);
    expect(owner.guestStarted).not.toHaveBeenCalled();
  });
  it("as many scans at once as the pool has connections all answer: none waits holding one", async () => {
    const connections = pool(2);
    const scans = [0, 1].map(() => {
      const tx = { query: vi.fn(async () => ({ rows: [] })) };
      return scan({
        run: (work) => connections.run(() => work(tx)),
        asks: () => connections.run(async () => true),
      });
    });
    const answers = await Promise.all(scans.map((x) => x.service.establish(x.f.input())));
    expect(answers.map((answer) => answer.status)).toEqual([
      "TableAskNewParty",
      "TableAskNewParty",
    ]);
  });
  it("a database that can't answer the question is a retry; anything else joins as before", async () => {
    const down = scan({
      asks: async () => {
        throw Object.assign(new Error("down"), { code: "TENANT_DATABASE_ACQUIRE_FAILED" });
      },
    });
    await expect(down.service.establish(down.f.input())).rejects.toMatchObject({
      code: "TENANT_DATABASE_ACQUIRE_FAILED",
    });
    expect(down.f.create).not.toHaveBeenCalled();
    const unreadable = scan({
      asks: async () => {
        throw new Error("DINING_GUEST_TABLE_CLOSE_UNAVAILABLE");
      },
    });
    expect((await unreadable.service.establish(unreadable.f.input())).status).toBe("Established");
  });
  it("a table read that refused this instant is read again with a later one, bounded", async () => {
    const x = scan();
    owner.guestStarted.mockResolvedValue(null);
    const resolve = x.f.options.qr.contexts.resolve as ReturnType<typeof vi.fn>;
    resolve.mockImplementationOnce(async () => null);
    expect((await x.service.establish(x.f.input())).status).toBe("Established");
    expect(x.inputs.map((input) => input.requestedAt)).toEqual([
      "2026-01-15T12:00:00.000Z",
      "2026-01-15T12:00:01.000Z",
    ]);
    expect(x.f.create).toHaveBeenCalledOnce();
    // A code that really can't be used refuses every time, and stops.
    const y = scan();
    (y.f.options.qr.contexts.resolve as ReturnType<typeof vi.fn>).mockImplementation(
      async () => null,
    );
    expect(await y.service.establish(y.f.input())).toEqual({ status: "EntryUnavailable" });
    expect(y.events.filter((event) => event === "sources")).toHaveLength(3);
    expect(y.f.create).not.toHaveBeenCalled();
  });
  it("a pickup code has no table to read again", async () => {
    const x = scan();
    x.f.payload.channel = x.f.context.channel = "Pickup";
    x.f.payload.publicTableReference =
      x.f.context.publicTableReference =
      x.f.context.tableReference =
        null;
    x.f.context.tableLifecycle = x.f.context.assignmentState = null;
    (x.f.options.qr.contexts.resolve as ReturnType<typeof vi.fn>).mockImplementation(
      async () => null,
    );
    expect(await x.service.establish(x.f.input())).toEqual({ status: "EntryUnavailable" });
    expect(x.events.filter((event) => event === "sources")).toHaveLength(1);
  });
  it("no start left: the scan answers as at any table nobody opened, and staff hear why", async () => {
    owner.open.mockResolvedValue(false);
    owner.offer.mockResolvedValue({ kind: "Spent" });
    const spent = vi.fn();
    const f = fixture();
    owner.profile.mockReturnValue(f.options.profile);
    owner.session.mockReturnValue(f.options.session.store);
    const tx = { query: vi.fn(async () => ({ rows: [] })) };
    const service = createPersistentCustomerEntryComposition({
      transactions: {
        run: (async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) as never,
      },
      profile: { binding: { brandReference: id(1), storeReference: id(2) } } as never,
      session: f.options.session,
      guestTables: { asksNewParty: async () => false, startsSpent: spent },
      sources: async () => ({
        qr: f.options.qr,
        operating: f.options.operating,
        admission: f.options.admission,
        binding: f.options.session.binding,
      }),
    });
    expect((await service.establish(f.input())).status).toBe("TableNotOpen");
    expect(spent).toHaveBeenCalledOnce();
    // Nothing was admitted and no visit started: the scan only answered.
    expect(f.admission).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
});
