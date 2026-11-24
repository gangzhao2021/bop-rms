import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantDiningTableQr, storeLocalDay } from "./merchant-dining-table-qr.js";

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  listTables: vi.fn(),
  loadTable: vi.fn(),
  resolveTableOperation: vi.fn(),
  commitTable: vi.fn(),
  loadLatestForTables: vi.fn(),
  loadLatestForTable: vi.fn(),
  loadByOperation: vi.fn(),
  service: vi.fn(),
  executeTable: vi.fn(),
  appendAudit: vi.fn(),
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: m.appendAudit,
}));
vi.mock("@rms/store", async (original) => ({
  ...(await original<typeof import("@rms/store")>()),
  createPostgresPublicStoreProfilePublisher: () => ({ readCurrent: async () => null }),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => m.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningTableStore: () => ({
    listTables: m.listTables,
    loadTable: m.loadTable,
    resolveTableOperation: m.resolveTableOperation,
    commitTable: m.commitTable,
  }),
  createPostgresDiningTableQrStore: () => ({
    loadLatestForTables: m.loadLatestForTables,
    loadLatestForTable: m.loadLatestForTable,
    loadByOperation: m.loadByOperation,
  }),
  transitionDiningTable: (table: object) => ({ ...table, qrStatus: "Revoked" }),
  createDiningTableService: m.service,
}));

const id = (n: number) => "0190fa43-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-15T12:00:00.000Z";
type Options = Parameters<typeof createMerchantDiningTableQr>[0];
const table = {
  tableReference: id(4),
  stableLabel: "T1",
  areaCode: "MAIN",
  aggregateVersion: 3,
  activeDiningSessionReference: null,
  lifecycle: "Published",
  qrStatus: "Active",
  qrVersion: 1,
};

function setup() {
  const tx = { query: vi.fn() },
    allowed = vi.fn(async () => true);
  let thrownInside = false;
  m.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) }, resolvedAt: at },
    store: { storeReference: id(3) },
    actorReference: id(5),
    allowed,
  });
  m.listTables.mockResolvedValue({ items: [table], nextAfterTableReference: null });
  m.loadLatestForTables.mockResolvedValue(new Map());
  m.resolveTableOperation.mockResolvedValue(null);
  m.loadTable.mockResolvedValue(table);
  m.loadLatestForTable.mockResolvedValue(null);
  m.service.mockReturnValue({ executeTable: m.executeTable });
  const qr = createMerchantDiningTableQr({
    persistence: {
      transactions: {
        run: async (work: (tx: unknown) => Promise<unknown>) => {
          try {
            return await work(tx);
          } catch (error) {
            thrownInside = true;
            throw error;
          }
        },
      },
    } as unknown as Options["persistence"],
    authentication: {
      authorize: async () => ({ sessionReference: id(9) }),
    } as unknown as Options["authentication"],
    newReference: () => id(10),
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
    signer: { sign: vi.fn() },
    publicStore: async () => null,
    customerOrigin: "https://order.example.test",
  });
  return { qr, tx, allowed, thrownInside: () => thrownInside };
}
const turnOff = {
  sessionCookie: "synthetic",
  csrf: "synthetic",
  command: {
    action: "TurnOff",
    tableReference: id(4),
    expectedAggregateVersion: 3,
    operationReference: id(6),
  },
};
beforeEach(() => vi.clearAllMocks());

it("WP-2423: the table list resolves the caller in full twice; table pages take the run's guard", async () => {
  const f = setup();
  const during: boolean[] = [];
  m.listTables.mockImplementation(async (request: { authorize(): Promise<boolean> }) => {
    during.push(await request.authorize());
    return { items: [table], nextAfterTableReference: null };
  });
  const result = await f.qr.list({ sessionCookie: "synthetic", csrf: "synthetic", query: {} });
  expect(result.items).toMatchObject([{ tableReference: id(4), codeState: "NotPrintable" }]);
  expect(m.resolve).toHaveBeenCalledWith(f.tx, "synthetic", "dining.table.qr.manage", id(9));
  expect(during).toEqual([true]);
  // v15 b12: retired tables are left out in the query, so they never use up the 500-table limit.
  expect(m.listTables).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "InUse" }));
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // The guard ends with the run.
  expect(await m.listTables.mock.calls[0]?.[0].authorize()).toBe(false);
});

it("WP-2423: a permission withdrawn during the table list refuses it inside the transaction", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    f.qr.list({ sessionCookie: "synthetic", csrf: "synthetic", query: {} }),
  ).rejects.toThrow("TABLE_QR_PERMISSION_DENIED");
  expect(m.listTables).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  expect(f.thrownInside()).toBe(true);
});

it("refuses before any table read when the permission is denied at the start", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.qr.command(turnOff)).rejects.toThrow("TABLE_QR_PERMISSION_DENIED");
  expect(m.resolveTableOperation).not.toHaveBeenCalled();
  expect(m.service).not.toHaveBeenCalled();
});

it("WP-2423: turning a code off resolves the caller twice; owner callbacks take the run's guard", async () => {
  const f = setup();
  const during: unknown[] = [];
  m.executeTable.mockImplementation(async (request: { observedAt: string }) => {
    const ports = m.service.mock.calls[0]?.[0];
    const authorization = await ports.authorization.authorize({
      action: "RevokeQr",
      targetReference: id(4),
      observedAt: request.observedAt,
    });
    during.push(authorization?.actorReference ?? null);
    during.push(
      await ports.authorization.authorize({
        action: "RevokeQr",
        targetReference: id(99),
        observedAt: request.observedAt,
      }),
    );
    await ports.repository.commitTable({});
    return { status: "Applied", table: { ...table, qrStatus: "Revoked", aggregateVersion: 4 } };
  });
  await expect(f.qr.command(turnOff)).resolves.toMatchObject({
    status: "Applied",
    item: { codeState: "TurnedOff", aggregateVersion: 4 },
  });
  expect(during).toEqual([id(5), null]);
  expect(m.commitTable).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // After the run the owner callbacks refuse without a query.
  const ports = m.service.mock.calls[0]?.[0];
  expect(
    await ports.authorization.authorize({
      action: "RevokeQr",
      targetReference: id(4),
      observedAt: at,
    }),
  ).toBeNull();
  await expect(ports.repository.commitTable({})).rejects.toThrow("DINING_TABLE_PERMISSION_DENIED");
  expect(f.allowed).toHaveBeenCalledTimes(2);
});

it("WP-2423: a permission withdrawn during a code change refuses it before commit", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  m.executeTable.mockResolvedValue({
    status: "Applied",
    table: { ...table, qrStatus: "Revoked", aggregateVersion: 4 },
  });
  await expect(f.qr.command(turnOff)).rejects.toThrow("TABLE_QR_PERMISSION_DENIED");
  expect(m.executeTable).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // Thrown inside the transaction callback, so the table change does not commit.
  expect(f.thrownInside()).toBe(true);
});

it("WP-2423 M150: the printed QR file is named by the Store's own date, not UTC's", () => {
  // 23:22 in Toronto on Nov 4 is already Nov 5 in UTC.
  expect(storeLocalDay("2026-11-05T04:22:00.000Z", "America/Toronto")).toBe("2026-11-04");
  expect(storeLocalDay("2026-11-05T04:22:00.000Z", "UTC")).toBe("2026-11-05");
});

describe("batch 58: Print all codes prints every table the page lists in one sheet", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...table,
      tableReference: id(1000 + i),
      stableLabel: "Hall " + (i + 1),
    }));
  const issue = (reference: string) => ({
    tableReference: reference,
    qrVersion: 1,
    qrToken: "h.p" + reference.slice(-6) + "." + "s".repeat(86),
    issuedAt: at,
    expiresAt: "2027-04-12T03:30:00.000Z",
  });
  function store(count: number) {
    const all = many(count);
    // The Store's tables come in pages of 100, as the table store pages them.
    m.listTables.mockImplementation(async (request: { afterTableReference: string | null }) => {
      const start =
        request.afterTableReference === null
          ? 0
          : all.findIndex((row) => row.tableReference === request.afterTableReference) + 1;
      const items = all.slice(start, start + 100);
      return {
        items,
        nextAfterTableReference:
          start + 100 < all.length ? (items[items.length - 1]?.tableReference ?? null) : null,
      };
    });
    m.loadLatestForTables.mockImplementation(async (references: string[]) => {
      // The real code store refuses more than 200 tables in one read.
      if (references.length > 200) throw new Error("DINING_TABLE_QR_UNAVAILABLE");
      return new Map(references.map((reference) => [reference, issue(reference)]));
    });
    return all.map((row) => row.tableReference);
  }
  const print = (f: ReturnType<typeof setup>, tableReferences: unknown) =>
    f.qr.sheet({ sessionCookie: "synthetic", csrf: "synthetic", query: { tableReferences } });

  for (const count of [100, 101, 500])
    it(`prints ${count} tables in one file and one audited print`, async () => {
      const f = setup();
      const references = store(count);
      const sheet = await print(f, references);
      expect(sheet.html.split('<article class="card">').length - 1).toBe(count);
      // A few table pages, never one read per printed table.
      expect(m.loadTable).not.toHaveBeenCalled();
      expect(m.listTables.mock.calls.length).toBe(Math.ceil(count / 100));
      // The audit names every printed table, in parts that fit an audit summary, under one sheet.
      const audits = m.appendAudit.mock.calls.map(
        (call) => call[1] as { targetId: string; afterSummary: Record<string, unknown> },
      );
      expect(audits).toHaveLength(Math.ceil(count / 100));
      expect(new Set(audits.map((audit) => audit.targetId)).size).toBe(1);
      expect(audits.flatMap((audit) => audit.afterSummary.tableReferences as string[])).toEqual(
        references,
      );
      // The Store's audit chain is taken last: after every read and after the codes are drawn.
      expect(Math.min(...m.appendAudit.mock.invocationCallOrder)).toBeGreaterThan(
        Math.max(...f.tx.query.mock.invocationCallOrder),
      );
      for (const audit of audits) {
        expect(audit.afterSummary.tableCount).toBe(count);
        expect(JSON.stringify(audit.afterSummary).length).toBeLessThan(16_384);
        expect(JSON.stringify(audit.afterSummary)).not.toContain("#qr=");
      }
    });

  it("refuses more than 500 tables as too many, before any read or audit", async () => {
    const f = setup();
    const references = [...store(500), id(5000)];
    await expect(print(f, references)).rejects.toThrow("TABLE_QR_TOO_MANY");
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.appendAudit).not.toHaveBeenCalled();
  });

  it("refuses an empty or repeated list as invalid input, not as an outage", async () => {
    const f = setup();
    store(2);
    await expect(print(f, [])).rejects.toThrow("TABLE_QR_INVALID");
    await expect(print(f, [id(1000), id(1000)])).rejects.toThrow("TABLE_QR_INVALID");
    await expect(print(f, "all")).rejects.toThrow("TABLE_QR_INVALID");
  });

  it("refuses a table that is not one of the Store's tables in use as changed", async () => {
    const f = setup();
    store(3);
    await expect(print(f, [id(1000), id(4040)])).rejects.toThrow("TABLE_QR_CONFLICT");
    expect(m.appendAudit).not.toHaveBeenCalled();
  });
});
