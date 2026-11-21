import { expect, it, vi } from "vitest";
import {
  createDiningSessionClient,
  readAllTables,
  type StaffDiningTable,
} from "./dining-session-client.js";
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const table: StaffDiningTable = {
  tableReference: id(1),
  stableLabel: "T1",
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  aggregateVersion: 2,
  currentDiningSessionReference: null,
  elapsedMinutes: null,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
  paymentTiming: "PayFirst",
  staffRoundsAwaitingPayment: [],
  guestRoundsAwaitingPayment: [],
  roundsAwaitingAcceptance: [],
};
const response = (r: unknown) =>
  new Response(JSON.stringify(r), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
it("freezes start request across lost response and suppresses replayed credential", async () => {
  const f = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(
      response({
        status: "AlreadyApplied",
        tableReference: id(1),
        tableAssignmentVersion: 2,
        diningSessionReference: id(3),
        sessionVersion: 1,
        joinKind: "HumanCode",
        joinCredential: "123456",
      }),
    );
  const t = { ...table },
    op = createDiningSessionClient(f).prepareStart(t, id(4));
  t.aggregateVersion = 3;
  await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "Unknown" });
  expect((await op.execute("A".repeat(43))).joinCredential).toBeNull();
  expect(f.mock.calls[1]?.[1]?.body).toBe(f.mock.calls[0]?.[1]?.body);
  expect(JSON.parse(String(f.mock.calls[0]?.[1]?.body)).expectedAssignmentVersion).toBe(2);
});
it("rejects occupied table before transport", () => {
  expect(() =>
    createDiningSessionClient().prepareStart(
      { ...table, currentDiningSessionReference: id(3) },
      id(4),
    ),
  ).toThrow();
});
it("treats wrong session assignment result as unknown", async () => {
  const f = vi.fn(async () =>
    response({
      status: "Issued",
      tableReference: id(1),
      tableAssignmentVersion: 9,
      diningSessionReference: id(3),
      sessionVersion: 1,
      joinKind: "HumanCode",
      joinCredential: "123456",
    }),
  );
  await expect(
    createDiningSessionClient(f).prepareStart(table, id(4)).execute("A".repeat(43)),
  ).rejects.toMatchObject({ code: "Unknown" });
});
it("rejects duplicate table rows and mismatched next cursor", async () => {
  const f = vi.fn(async () =>
    response({ canOperateTables: false, items: [table, table], nextAfterTableReference: null }),
  );
  await expect(createDiningSessionClient(f).tables("A".repeat(43))).rejects.toThrow();
});
/**
 * v15 b12 (tables-list-paging): Test Merchant 2 (21 tables in use, 30 retired) got 21 tables and a
 * next reference; the page was refused and Tables read "Tables unavailable" for every staff member.
 */
it("reads every page of tables, a short one that points on included, as one list", async () => {
  const page = (from: number, count: number, next: number | null) =>
    response({
      canOperateTables: true,
      canCloseSessions: from > 1,
      items: Array.from({ length: count }, (_, n) => ({
        ...table,
        tableReference: id(from + n),
        stableLabel: "T" + (from + n),
      })),
      nextAfterTableReference: next === null ? null : id(next),
    });
  const f = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(page(1, 21, 21))
    .mockResolvedValueOnce(page(22, 100, 121))
    .mockResolvedValueOnce(page(122, 7, null));
  const all = await readAllTables(createDiningSessionClient(f), "A".repeat(43));
  expect(all.items.map((t) => t.stableLabel)).toEqual(
    Array.from({ length: 128 }, (_, n) => "T" + (n + 1)),
  );
  expect(all.next).toBeNull();
  // What the staff member may do is the latest page's.
  expect(all.canCloseSessions).toBe(true);
  expect(f.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
    { afterTableReference: null, limit: 100 },
    { afterTableReference: id(21), limit: 100 },
    { afterTableReference: id(121), limit: 100 },
  ]);
});
it("refuses a page that points on from nowhere, and fails the whole list when a page fails", async () => {
  const empty = vi.fn(async () =>
    response({ canOperateTables: true, items: [], nextAfterTableReference: id(5) }),
  );
  await expect(createDiningSessionClient(empty).tables("A".repeat(43))).rejects.toThrow();
  const elsewhere = vi.fn(async () =>
    response({ canOperateTables: true, items: [table], nextAfterTableReference: id(5) }),
  );
  await expect(createDiningSessionClient(elsewhere).tables("A".repeat(43))).rejects.toThrow();
  const second = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      response({ canOperateTables: true, items: [table], nextAfterTableReference: id(1) }),
    )
    .mockResolvedValueOnce(new Response("", { status: 503 }));
  await expect(
    readAllTables(createDiningSessionClient(second), "A".repeat(43)),
  ).rejects.toMatchObject({ code: "ServerProblem" });
});
it("accepts elapsed minutes only when a current Session is linked", async () => {
  const f = vi.fn(async () =>
    response({
      canOperateTables: true,
      items: [{ ...table, currentDiningSessionReference: id(3), elapsedMinutes: 0 }],
      nextAfterTableReference: null,
    }),
  );
  expect((await createDiningSessionClient(f).tables("A".repeat(43))).items[0]?.elapsedMinutes).toBe(
    0,
  );
  const inconsistent = vi.fn(async () =>
    response({
      canOperateTables: true,
      items: [{ ...table, currentDiningSessionReference: id(3), elapsedMinutes: null }],
      nextAfterTableReference: null,
    }),
  );
  await expect(createDiningSessionClient(inconsistent).tables("A".repeat(43))).rejects.toThrow();
});
it("retries the identical table availability command after an unknown result", async () => {
  const f = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce(
      response({
        status: "AlreadyApplied",
        tableReference: id(1),
        operationalState: "TemporarilyBlocked",
        aggregateVersion: 3,
      }),
    );
  const command = createDiningSessionClient(f).prepareAvailability(
    table,
    "SetBlock",
    "MAINTENANCE",
    id(4),
  );
  await expect(command.execute("A".repeat(43))).rejects.toMatchObject({ code: "Unknown" });
  await expect(command.execute("A".repeat(43))).resolves.toMatchObject({
    status: "AlreadyApplied",
    operationalState: "TemporarilyBlocked",
    aggregateVersion: 3,
  });
  expect(f.mock.calls[1]?.[1]?.body).toBe(f.mock.calls[0]?.[1]?.body);
});
it("binds replacement generation and kind", async () => {
  const f = vi.fn(async () =>
    response({
      status: "Issued",
      generation: 3,
      capabilityVersion: 1,
      joinKind: "HumanCode",
      joinCredential: "123456",
    }),
  );
  const op = createDiningSessionClient(f).prepareRegenerate(
    {
      diningSessionReference: id(3),
      tableReference: id(1),
      sessionVersion: 1,
      tableAssignmentVersion: 2,
      capabilityVersion: 1,
      generation: 1,
      joinKind: "HumanCode",
    },
    id(4),
  );
  await expect(op.execute("A".repeat(43))).rejects.toMatchObject({ code: "Unknown" });
});
it("WP-2423 Q11: reads until when each table's printed code works, or that it has none", async () => {
  const f = vi.fn(async () =>
    response({
      canOperateTables: false,
      items: [{ ...table, qrCodeValidUntil: null }],
      nextAfterTableReference: null,
    }),
  );
  expect(
    (await createDiningSessionClient(f).tables("A".repeat(43))).items[0]?.qrCodeValidUntil,
  ).toBe(null);
  const malformed = vi.fn(async () =>
    response({
      canOperateTables: false,
      items: [{ ...table, qrCodeValidUntil: "soon" }],
      nextAfterTableReference: null,
    }),
  );
  await expect(createDiningSessionClient(malformed).tables("A".repeat(43))).rejects.toThrow();
});
it("WP-2423 D4: reads each open session's closing facts and whether this staff member may close", async () => {
  const occupied = { ...table, currentDiningSessionReference: id(3), elapsedMinutes: 5000 };
  const read = (body: Record<string, unknown>) =>
    createDiningSessionClient(vi.fn(async () => response(body))).tables("A".repeat(43));
  const view = await read({
    canOperateTables: true,
    canCloseSessions: true,
    items: [{ ...occupied, session: { phase: "Active", version: 4, orderReference: id(7) } }],
    nextAfterTableReference: null,
  });
  expect(view.canCloseSessions).toBe(true);
  expect(view.items[0]?.session).toEqual({ phase: "Active", version: 4, orderReference: id(7) });
  // An older server: nothing to close with.
  const older = await read({
    canOperateTables: true,
    items: [occupied],
    nextAfterTableReference: null,
  });
  expect(older.canCloseSessions).toBe(false);
  expect(older.items[0]?.session).toBeNull();
  // Facts for a free table, or a closed session, are refused.
  for (const item of [
    { ...table, session: { phase: "Active", version: 4, orderReference: null } },
    { ...occupied, session: { phase: "Closed", version: 4, orderReference: null } },
  ])
    await expect(
      read({ canOperateTables: true, items: [item], nextAfterTableReference: null }),
    ).rejects.toThrow();
});
it("WP-2423: offers the Order host section only when the server says this staff member may transfer it", async () => {
  const read = (extra: Record<string, unknown>) =>
    createDiningSessionClient(
      vi.fn(async () =>
        response({
          canOperateTables: true,
          items: [table],
          nextAfterTableReference: null,
          ...extra,
        }),
      ),
    ).tables("A".repeat(43));
  expect((await read({ canTransferHost: true })).canTransferHost).toBe(true);
  // Front of House: hidden, so "Refresh participants" never asks for a read it is refused.
  expect((await read({ canTransferHost: false })).canTransferHost).toBe(false);
  // An older server sends nothing: offered as before; the server decides.
  expect((await read({})).canTransferHost).toBe(true);
});
it("WP-2423 M08: reads whether this staff member may add a round for a table, or that the server didn't say", async () => {
  const read = (extra: Record<string, unknown>) =>
    createDiningSessionClient(
      vi.fn(async () =>
        response({
          canOperateTables: true,
          items: [table],
          nextAfterTableReference: null,
          ...extra,
        }),
      ),
    ).tables("A".repeat(43));
  expect((await read({ canTakeTableRounds: true })).canTakeTableRounds).toBe(true);
  // A kitchen-only role: no "Take order for table".
  expect((await read({ canTakeTableRounds: false })).canTakeTableRounds).toBe(false);
  // An older server sends nothing: null, so the page falls back to its own rule.
  expect((await read({})).canTakeTableRounds).toBeNull();
});
it("WP-2423 item 8 ⑤: reads rounds waiting for staff and phones that just joined, only at open tables", async () => {
  const open = {
    ...table,
    currentDiningSessionReference: id(3),
    elapsedMinutes: 12,
    heldRounds: [
      {
        orderReference: id(40),
        orderBatchReference: id(41),
        roundNumber: null,
        reason: "TableRapid",
        heldAt: "2026-10-28T19:00:00.000Z",
      },
    ],
    newPhones: [{ phoneNumber: 2, joinedAt: "2026-10-28T18:58:00.000Z" }],
  };
  const read = (item: unknown) =>
    createDiningSessionClient(
      vi.fn(async () =>
        response({ canOperateTables: true, items: [item], nextAfterTableReference: null }),
      ),
    ).tables("A".repeat(43));
  const [listed] = (await read(open)).items;
  expect(listed?.heldRounds?.[0]?.reason).toBe("TableRapid");
  expect(listed?.newPhones).toEqual([{ phoneNumber: 2, joinedAt: "2026-10-28T18:58:00.000Z" }]);
  // A free table has neither; an unknown reason or an extra field is refused.
  await expect(
    read({ ...open, currentDiningSessionReference: null, elapsedMinutes: null }),
  ).rejects.toThrow();
  await expect(
    read({ ...open, heldRounds: [{ ...open.heldRounds[0], reason: "Suspicious" }] }),
  ).rejects.toThrow();
  await expect(
    read({
      ...open,
      newPhones: [{ phoneNumber: 2, joinedAt: "2026-10-28T18:58:00.000Z", guest: "x" }],
    }),
  ).rejects.toThrow();
});

it("DEC-DINING-GUEST-TABLE-START: reads a table a guest started, and a table with no such key", async () => {
  const row = (changes: object) => ({
    tableReference: "01909968-0000-7000-8000-000000000001",
    stableLabel: "T1",
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 2,
    currentDiningSessionReference: null,
    elapsedMinutes: null,
    qrCodeValidUntil: null,
    ...changes,
  });
  const read = (body: object) =>
    createDiningSessionClient(
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          }),
      ),
    ).tables("a".repeat(43));
  const plain = await read({
    canOperateTables: true,
    items: [row({})],
    nextAfterTableReference: null,
  });
  expect(plain.guestTableStart).toBeNull();
  expect(plain.items[0]?.guestStart).toBeUndefined();
  const at = "2026-11-05T12:00:00.000Z";
  const started = await read({
    canOperateTables: true,
    guestTableStart: { version: 4, canTurnOff: true },
    items: [
      row({
        currentDiningSessionReference: "01909968-0000-7000-8000-000000000002",
        elapsedMinutes: 3,
        guestStart: { closesByItselfAt: at },
      }),
      row({
        tableReference: "01909968-0000-7000-8000-000000000003",
        operationalState: "TemporarilyBlocked",
        blockReasonCode: "CLEANING",
        blockedSince: at,
      }),
    ],
    nextAfterTableReference: null,
  });
  expect(started.guestTableStart).toEqual({ version: 4, canTurnOff: true, startsBusy: false });
  expect(started.items[0]?.guestStart).toEqual({ closesByItselfAt: at });
  expect(started.items[1]?.blockedSince).toBe(at);
});
