import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantDiningTableQr } from "./merchant-dining-table-qr.js";

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
